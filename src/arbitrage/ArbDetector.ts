/**
 * ArbDetector.ts — Détection d'arbitrage cross-exchange Polymarket ↔ Kalshi
 *
 * Principe :
 *   Si le même événement est coté à des prix différents sur deux plateformes,
 *   acheter le YES le moins cher + vendre le YES le plus cher = profit sans risque.
 *
 *   Ex: BTC > $80k → Polymarket YES = 0.91, Kalshi YES = 0.87
 *       → Acheter sur Kalshi à 0.87, vendre sur Polymarket à 0.91 = +0.04 / share
 *
 * Matching algorithmique (sans ML) :
 *   1. Crypto : ticker + threshold numériques (très fiable)
 *   2. Politique/Sport : mots-clés normalisés + fenêtre temporelle
 *
 * Output :
 *   ArbOpportunity[] — triée par spread décroissant
 */
import { getLogger }        from '../utils/logger';
import { detectTicker, parseThreshold } from '../price/PriceFeed';
import type { CachedMarket }  from '../feeds/MarketCache';
import type { KalshiMarket }  from '../connectors/KalshiConnector';

const log = getLogger('ArbDetector');

// Spread minimum net de frais pour signaler une opportunité
const MIN_SPREAD         = 0.03;   // 3%
const EXPIRY_WINDOW_DAYS = 2;      // les deux marchés doivent expirer dans les 2 jours l'un de l'autre

export interface ArbOpportunity {
  type:           'CRYPTO' | 'OTHER';
  // Polymarket
  polyConditionId:string;
  polyQuestion:   string;
  polyYesPrice:   number;   // bestAsk Polymarket
  // Kalshi
  kalshiTicker:   string;
  kalshiTitle:    string;
  kalshiYesAsk:   number;
  kalshiYesBid:   number;
  // Arb
  spread:         number;   // |polyPrice - kalshiYesAsk|
  cheapSide:      'POLYMARKET' | 'KALSHI';   // où acheter YES
  expectedPnl:    number;   // par share, net
  matchScore:     number;   // confiance du matching (0-1)
  detectedAt:     number;
}

export class ArbDetector {
  private lastOpportunities: ArbOpportunity[] = [];

  // ── Point d'entrée ────────────────────────────────────────────
  detect(
    polyMarkets:  CachedMarket[],
    kalshiMarkets: KalshiMarket[],
  ): ArbOpportunity[] {
    const opportunities: ArbOpportunity[] = [];

    for (const poly of polyMarkets) {
      const matches = this._findKalshiMatches(poly, kalshiMarkets);

      for (const { kalshi, score } of matches) {
        const polyPrice    = poly.lastPrice;
        const kalshiAsk    = kalshi.yesAsk;
        const spread       = Math.abs(polyPrice - kalshiAsk);

        if (spread < MIN_SPREAD) continue;

        const cheapSide: 'POLYMARKET' | 'KALSHI' =
          polyPrice < kalshiAsk ? 'POLYMARKET' : 'KALSHI';

        // P&L estimé : spread - frais estimés (0.5% total)
        const expectedPnl = parseFloat((spread - 0.005).toFixed(4));
        if (expectedPnl <= 0) continue;

        opportunities.push({
          type:            poly.domain === 'Crypto' ? 'CRYPTO' : 'OTHER',
          polyConditionId: poly.conditionId,
          polyQuestion:    poly.question,
          polyYesPrice:    polyPrice,
          kalshiTicker:    kalshi.ticker,
          kalshiTitle:     kalshi.title,
          kalshiYesAsk:    kalshi.yesAsk,
          kalshiYesBid:    kalshi.yesBid,
          spread,
          cheapSide,
          expectedPnl,
          matchScore:      score,
          detectedAt:      Date.now(),
        });
      }
    }

    // Trier par spread décroissant
    opportunities.sort((a, b) => b.spread - a.spread);
    this.lastOpportunities = opportunities;

    if (opportunities.length > 0) {
      log.info(`🔀 Arb détecté : ${opportunities.length} opportunité(s)`, {
        best: opportunities[0]
          ? `${opportunities[0].polyQuestion.substring(0, 40)} | spread=${(opportunities[0].spread * 100).toFixed(2)}%`
          : 'N/A',
      });
    }

    return opportunities;
  }

  get lastResults(): ArbOpportunity[] { return this.lastOpportunities; }

  // ── Matching Polymarket ↔ Kalshi ─────────────────────────────
  private _findKalshiMatches(
    poly:     CachedMarket,
    kalshis:  KalshiMarket[],
  ): Array<{ kalshi: KalshiMarket; score: number }> {
    const results: Array<{ kalshi: KalshiMarket; score: number }> = [];

    for (const kalshi of kalshis) {
      const score = this._matchScore(poly, kalshi);
      if (score >= 0.6) results.push({ kalshi, score });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  private _matchScore(poly: CachedMarket, kalshi: KalshiMarket): number {
    // ── Matching Crypto (plus fiable) ────────────────────────────
    if (poly.domain === 'Crypto') {
      return this._matchCrypto(poly.question, kalshi.title);
    }

    // ── Matching générique par mots-clés ────────────────────────
    return this._matchKeywords(poly.question, kalshi.title);
  }

  // Crypto : même ticker + même threshold numérique
  private _matchCrypto(polyQ: string, kalshiTitle: string): number {
    const polyTicker  = detectTicker(polyQ);
    const kalTicker   = detectTicker(kalshiTitle);
    if (!polyTicker || !kalTicker || polyTicker !== kalTicker) return 0;

    const polyThresh = parseThreshold(polyQ);
    const kalThresh  = parseThreshold(kalshiTitle);
    if (!polyThresh || !kalThresh) return 0.4; // même ticker mais pas de threshold

    // Tolérance 1% sur le seuil (ex: $80,000 vs $80k)
    const threshDiff = Math.abs(polyThresh - kalThresh) / polyThresh;
    if (threshDiff > 0.01) return 0;

    return 0.95; // même crypto + même seuil = match quasi-certain
  }

  // Générique : proportion de mots communs importants
  private _matchKeywords(polyQ: string, kalshiTitle: string): number {
    const normalize = (s: string) =>
      s.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOPWORDS.has(w));

    const polyWords  = new Set(normalize(polyQ));
    const kalWords   = normalize(kalshiTitle);

    if (polyWords.size === 0 || kalWords.length === 0) return 0;

    const common = kalWords.filter(w => polyWords.has(w));
    return common.length / Math.max(polyWords.size, kalWords.length);
  }
}

// Mots vides à ignorer pour le matching générique
const STOPWORDS = new Set([
  'will', 'the', 'that', 'this', 'with', 'from', 'have', 'been',
  'than', 'more', 'some', 'when', 'what', 'which', 'there', 'their',
  'before', 'after', 'above', 'below', 'over', 'under', 'into', 'onto',
]);
