/**
 * CrossSignalDetector.ts — Validation croisée Polymarket ↔ Manifold
 *
 * Principe :
 *   Manifold Markets est une plateforme de prédiction à "mana" (monnaie fictive)
 *   mais ses prix reflètent le consensus de forecasters experts (Superforecasters,
 *   chercheurs, etc.). Quand Manifold dit 95% mais Polymarket dit 88%, c'est un
 *   signal que Polymarket est sous-pricé → la position est plus solide.
 *
 * Ce module ne fait PAS d'arb réel (Manifold = play money), il :
 *   - Confirme les signaux Polymarket quand Manifold est en accord
 *   - Signale les divergences pour éviter les mauvais trades
 *   - Détecte les marchés Polymarket sans équivalent Manifold (signal neutre)
 *
 * Seuils :
 *   CONFIRM_THRESHOLD  = +3% : Manifold > Poly → signal renforcé
 *   DIVERGE_THRESHOLD  = -5% : Manifold < Poly → signal affaibli (skip)
 */
import { getLogger }      from '../utils/logger';
import { detectTicker, parseThreshold } from '../price/PriceFeed';
import type { CachedMarket } from '../feeds/MarketCache';

const log = getLogger('CrossSignal');

const CONFIRM_THRESHOLD = 0.03;   // Manifold > Poly + 3% → confirme
const DIVERGE_THRESHOLD = -0.05;  // Manifold < Poly - 5% → diverge

export interface ManifoldMarket {
  id:          string;
  question:    string;
  probability: number;   // 0–1
  closeTime:   number;   // timestamp ms
  volume:      number;   // mana
  isResolved:  boolean;
}

export type SignalConfidence = 'CONFIRMED' | 'NEUTRAL' | 'DIVERGENT';

export interface CrossSignalResult {
  polyConditionId: string;
  polyQuestion:    string;
  polyPrice:       number;
  manifoldId:      string | null;
  manifoldTitle:   string | null;
  manifoldProba:   number | null;
  delta:           number | null;   // manifoldProba - polyPrice
  confidence:      SignalConfidence;
  matchScore:      number;
}

export class CrossSignalDetector {
  private lastResults: CrossSignalResult[] = [];

  // ── Analyse de la cohérence cross-plateforme ─────────────────
  analyze(
    polyMarkets:    CachedMarket[],
    manifoldMarkets: ManifoldMarket[],
  ): CrossSignalResult[] {
    const results: CrossSignalResult[] = [];

    for (const poly of polyMarkets) {
      const match = this._findBestMatch(poly, manifoldMarkets);

      if (!match) {
        results.push({
          polyConditionId: poly.conditionId,
          polyQuestion:    poly.question,
          polyPrice:       poly.lastPrice,
          manifoldId:      null,
          manifoldTitle:   null,
          manifoldProba:   null,
          delta:           null,
          confidence:      'NEUTRAL',
          matchScore:      0,
        });
        continue;
      }

      const delta      = match.market.probability - poly.lastPrice;
      let   confidence: SignalConfidence = 'NEUTRAL';
      if      (delta >=  CONFIRM_THRESHOLD) confidence = 'CONFIRMED';
      else if (delta <= DIVERGE_THRESHOLD)  confidence = 'DIVERGENT';

      results.push({
        polyConditionId: poly.conditionId,
        polyQuestion:    poly.question,
        polyPrice:       poly.lastPrice,
        manifoldId:      match.market.id,
        manifoldTitle:   match.market.question,
        manifoldProba:   match.market.probability,
        delta,
        confidence,
        matchScore:      match.score,
      });

      if (confidence === 'CONFIRMED') {
        log.info('✅ Signal cross-confirmé', {
          poly:     poly.question.substring(0, 50),
          polyP:    poly.lastPrice,
          manifold: match.market.question.substring(0, 50),
          manifoldP: match.market.probability,
          delta:    '+' + (delta * 100).toFixed(1) + '%',
        });
      } else if (confidence === 'DIVERGENT') {
        log.warn('⚠️  Signal divergent — Manifold en désaccord', {
          poly:     poly.question.substring(0, 50),
          polyP:    poly.lastPrice,
          manifoldP: match.market.probability,
          delta:    (delta * 100).toFixed(1) + '%',
        });
      }
    }

    this.lastResults = results;
    return results;
  }

  getConfidence(conditionId: string): SignalConfidence {
    return this.lastResults.find(r => r.polyConditionId === conditionId)?.confidence ?? 'NEUTRAL';
  }

  get lastAnalysis(): CrossSignalResult[] { return this.lastResults; }

  // ── Matching Polymarket ↔ Manifold ────────────────────────────
  private _findBestMatch(
    poly:      CachedMarket,
    manifolds: ManifoldMarket[],
  ): { market: ManifoldMarket; score: number } | null {
    let best: { market: ManifoldMarket; score: number } | null = null;

    for (const m of manifolds) {
      if (m.isResolved) continue;
      const score = poly.domain === 'Crypto'
        ? this._matchCrypto(poly.question, m.question)
        : this._matchKeywords(poly.question, m.question);

      if (score > 0.6 && (!best || score > best.score)) {
        best = { market: m, score };
      }
    }
    return best;
  }

  private _matchCrypto(polyQ: string, manifoldQ: string): number {
    const polyTicker  = detectTicker(polyQ);
    const manTicker   = detectTicker(manifoldQ);
    if (!polyTicker || !manTicker || polyTicker !== manTicker) return 0;

    const polyThresh = parseThreshold(polyQ);
    const manThresh  = parseThreshold(manifoldQ);
    if (!polyThresh || !manThresh) return 0.45;

    const diff = Math.abs(polyThresh - manThresh) / polyThresh;
    return diff <= 0.01 ? 0.95 : 0;
  }

  private _matchKeywords(polyQ: string, manifoldQ: string): number {
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter(w => w.length > 3 && !STOPWORDS.has(w));

    const pw = new Set(norm(polyQ));
    const mw = norm(manifoldQ);
    if (!pw.size || !mw.length) return 0;

    const common = mw.filter(w => pw.has(w));
    return common.length / Math.max(pw.size, mw.length);
  }
}

const STOPWORDS = new Set([
  'will', 'the', 'that', 'this', 'with', 'from', 'have', 'been',
  'than', 'more', 'some', 'when', 'what', 'which', 'there', 'their',
  'before', 'after', 'above', 'below', 'over', 'under', 'into', 'onto',
]);
