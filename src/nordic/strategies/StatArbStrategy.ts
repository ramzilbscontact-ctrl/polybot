/**
 * StatArbStrategy.ts — Arbitrage Statistique Nordic
 *
 * Principe :
 *   L'OMX Helsinki 25 bouge en premier (gros ordres institutionnels).
 *   Les actions individuelles suivent avec un délai de 50-500ms.
 *   Notre serveur Helsinki détecte le mouvement de l'index ET réagit
 *   AVANT que les market makers des actions individuelles aient ajusté.
 *
 * Algorithme :
 *   1. Calcule le retour de l'index sur les N derniers ticks
 *   2. Calcule le retour attendu pour chaque action : expected = beta × indexReturn
 *   3. Calcule le retour réel de l'action
 *   4. Z-score = (réel - attendu) / σ_historique
 *   5. Si |z-score| > THRESHOLD → signal (le spread va se refermer)
 *
 * Signal :
 *   z < -THRESHOLD → l'action est EN RETARD par rapport à l'index
 *     → BUY si l'index monte (l'action va rattraper)
 *     → SELL si l'index baisse (l'action va suivre)
 *   z > +THRESHOLD → l'action a SURRÉAGI → trade de retour à la moyenne
 *
 * Edge géographique :
 *   Nasdaq Helsinki → serveur Helsinki : ~1ms
 *   Autres traders en Europe : 5-20ms
 *   Traders US : 80-150ms
 *   → Fenêtre d'opportunité : 4-150ms
 */
import { getLogger }   from '../../utils/logger';
import type { MarketQuote } from '../connectors/IBKRConnector';
import type { NordicStock } from '../NordicUniverse';
import { INDICES }         from '../NordicUniverse';

const log = getLogger('StatArb');

// ── Paramètres ────────────────────────────────────────────────────
const WINDOW_TICKS   = 20;    // Fenêtre de calcul (20 derniers ticks)
const Z_THRESHOLD    = 2.0;   // Seuil d'entrée en σ
export const Z_EXIT  = 0.5;   // Seuil de sortie (retour à la moyenne)
const MIN_INDEX_MOVE = 0.001; // Mouvement index minimum pour déclencher (0.1%)
const MAX_HOLD_MS    = 30_000;// Durée max de tenue de position (30s)

// ── Types ──────────────────────────────────────────────────────────
export type SignalSide = 'BUY' | 'SELL';

export interface StatArbSignal {
  type:          'STAT_ARB';
  stock:         NordicStock;
  side:          SignalSide;
  indexReturn:   number;    // retour de l'index sur la fenêtre
  expectedReturn:number;    // retour attendu (beta * indexReturn)
  actualReturn:  number;    // retour réel de l'action
  deviation:     number;    // actualReturn - expectedReturn
  zScore:        number;    // z-score de la déviation
  entryPrice:    number;    // prix d'entrée recommandé (ask pour BUY, bid pour SELL)
  targetPrice:   number;    // prix de sortie (retour à la moyenne)
  reason:        string;
  detectedAt:    number;
}

// ── Historique de prix pour une série temporelle ───────────────────
class PriceSeries {
  private readonly buf: number[] = [];
  constructor(private readonly maxLen: number) {}

  push(price: number): void {
    this.buf.push(price);
    if (this.buf.length > this.maxLen) this.buf.shift();
  }

  get length(): number { return this.buf.length; }
  get latest(): number { return this.buf[this.buf.length - 1] ?? 0; }
  get oldest(): number { return this.buf[0] ?? 0; }

  /** Retour % entre le plus ancien et le plus récent */
  return(): number {
    if (this.buf.length < 2 || this.oldest === 0) return 0;
    return (this.latest - this.oldest) / this.oldest;
  }

  /** Écart-type des retours tick-à-tick */
  stddev(): number {
    if (this.buf.length < 3) return 0.001; // valeur plancher
    const returns: number[] = [];
    for (let i = 1; i < this.buf.length; i++) {
      returns.push((this.buf[i] - this.buf[i-1]) / this.buf[i-1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance) || 0.001;
  }
}

// ── Stratégie principale ───────────────────────────────────────────
export class StatArbStrategy {
  // Séries de prix : conid → PriceSeries
  private readonly series  = new Map<number, PriceSeries>();
  // Positions ouvertes : conid → timestamp d'entrée
  private readonly openPositions = new Map<number, { side: SignalSide; entryPrice: number; openedAt: number }>();
  // Conids des index
  private readonly indexConids   = new Set<number>(Object.values(INDICES).map(i => i.conid));

  constructor(private readonly stocks: NordicStock[]) {
    // Initialise les séries pour index + stocks
    for (const idx of Object.values(INDICES)) this.series.set(idx.conid, new PriceSeries(WINDOW_TICKS));
    for (const s of stocks)                    this.series.set(s.conid,   new PriceSeries(WINDOW_TICKS));

    log.info('StatArbStrategy initialisée', {
      stocks:    stocks.length,
      window:    WINDOW_TICKS,
      threshold: `±${Z_THRESHOLD}σ`,
      maxHold:   `${MAX_HOLD_MS / 1000}s`,
    });
  }

  // ── Mise à jour d'un quote → évalue les signaux ────────────────
  onQuote(quote: MarketQuote): StatArbSignal | null {
    const series = this.series.get(quote.conid);
    if (!series) return null;

    // Enregistre le prix médian
    const mid = quote.midpoint || quote.last || (quote.bid + quote.ask) / 2;
    if (!mid) return null;
    series.push(mid);

    // On n'évalue que les actions (pas les index directement)
    if (this.indexConids.has(quote.conid)) return null;

    // Trouve le stock
    const stock = this.stocks.find(s => s.conid === quote.conid);
    if (!stock) return null;

    return this._evaluate(stock, quote);
  }

  // ── Évaluation du signal pour un stock donné ───────────────────
  private _evaluate(stock: NordicStock, quote: MarketQuote): StatArbSignal | null {
    // Index de référence du stock
    const indexDef    = INDICES[stock.index];
    const indexSeries = this.series.get(indexDef.conid);
    const stockSeries = this.series.get(stock.conid);

    if (!indexSeries || !stockSeries) return null;
    if (indexSeries.length < 5 || stockSeries.length < 5) return null;

    const indexReturn   = indexSeries.return();
    const actualReturn  = stockSeries.return();
    const expectedReturn= stock.beta * indexReturn;
    const deviation     = actualReturn - expectedReturn;

    // Filtre : mouvement index minimum requis (évite le bruit)
    if (Math.abs(indexReturn) < MIN_INDEX_MOVE) return null;

    // Z-score de la déviation
    const sigma  = stockSeries.stddev() * Math.sqrt(WINDOW_TICKS);
    const zScore = sigma > 0 ? deviation / sigma : 0;

    if (Math.abs(zScore) <= Z_THRESHOLD) return null;

    // Ne pas ouvrir une seconde position sur le même stock
    if (this.openPositions.has(stock.conid)) return null;

    // Détermine le sens du trade
    //  zScore < -THRESHOLD : stock en retard → BUY si index monte, SELL si index baisse
    //  zScore > +THRESHOLD : stock a surréagi → trade inverse
    let side: SignalSide;
    if (zScore < -Z_THRESHOLD) {
      side = indexReturn > 0 ? 'BUY' : 'SELL';  // stock va rattraper l'index
    } else {
      side = indexReturn > 0 ? 'SELL' : 'BUY';  // stock a trop bougé, va revenir
    }

    const entryPrice = side === 'BUY'  ? quote.ask : quote.bid;
    // Cible = prix qui rapproche de la moyenne (déviation divisée par 2)
    const targetPrice = side === 'BUY'
      ? entryPrice * (1 + Math.abs(deviation) * 0.5)
      : entryPrice * (1 - Math.abs(deviation) * 0.5);

    const signal: StatArbSignal = {
      type:   'STAT_ARB',
      stock,
      side,
      indexReturn,
      expectedReturn,
      actualReturn,
      deviation,
      zScore,
      entryPrice,
      targetPrice,
      reason: `${stock.index} ${(indexReturn * 100).toFixed(3)}% → attendu ${stock.symbol} ${(expectedReturn * 100).toFixed(3)}% ` +
              `(β=${stock.beta}) | réel ${(actualReturn * 100).toFixed(3)}% | z=${zScore.toFixed(2)}σ → ${side}`,
      detectedAt: Date.now(),
    };

    log.info(`⚡ StatArb signal`, {
      stock:    stock.symbol,
      side,
      zScore:   zScore.toFixed(2) + 'σ',
      index:    stock.index,
      idxMove:  (indexReturn * 100).toFixed(3) + '%',
      stockLag: (deviation  * 100).toFixed(3) + '%',
      entry:    entryPrice,
    });

    return signal;
  }

  // ── Gestion des positions ──────────────────────────────────────
  markOpened(conid: number, side: SignalSide, entryPrice: number): void {
    this.openPositions.set(conid, { side, entryPrice, openedAt: Date.now() });
  }

  markClosed(conid: number): void {
    this.openPositions.delete(conid);
  }

  /** Positions qui ont dépassé MAX_HOLD_MS → à fermer */
  getExpiredPositions(): number[] {
    const now = Date.now();
    const expired: number[] = [];
    for (const [conid, pos] of this.openPositions) {
      if (now - pos.openedAt > MAX_HOLD_MS) expired.push(conid);
    }
    return expired;
  }

  /** Z-score actuel d'un stock (pour décider si sortir) */
  currentZScore(stock: NordicStock): number {
    const indexDef    = INDICES[stock.index];
    const indexSeries = this.series.get(indexDef.conid);
    const stockSeries = this.series.get(stock.conid);
    if (!indexSeries || !stockSeries) return 0;

    const deviation = stockSeries.return() - stock.beta * indexSeries.return();
    const sigma     = stockSeries.stddev() * Math.sqrt(WINDOW_TICKS);
    return sigma > 0 ? deviation / sigma : 0;
  }

  get openCount(): number { return this.openPositions.size; }
}
