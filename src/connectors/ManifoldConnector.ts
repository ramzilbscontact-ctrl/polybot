/**
 * ManifoldConnector.ts — API publique Manifold Markets (aucune auth requise)
 *
 * Manifold = plateforme de marchés de prédiction communautaire (play money "mana").
 * Ses forecasters incluent des Superforecasters, chercheurs, data scientists.
 * Les probabilités sont pertinentes comme signal de consensus expert.
 *
 * API : https://api.manifold.markets/v0/
 *   - Aucune authentification pour la lecture
 *   - Rate limit : ~1 req/s (on poll toutes les 2min donc OK)
 *   - Docs : https://docs.manifold.markets/api
 */
import { getLogger } from '../utils/logger';
import type { ManifoldMarket } from '../arbitrage/CrossSignalDetector';

const log = getLogger('ManifoldConnector');

const BASE_URL    = 'https://api.manifold.markets/v0';
const REQ_TIMEOUT = 12_000;
const PAGE_SIZE   = 500;
const MAX_PAGES   = 4;     // 2000 marchés max

export class ManifoldConnector {

  // ── Marchés binaires ouverts ──────────────────────────────────
  async getOpenBinaryMarkets(): Promise<ManifoldMarket[]> {
    const markets: ManifoldMarket[] = [];

    try {
      let before = '';   // cursor de pagination

      for (let page = 0; page < MAX_PAGES; page++) {
        const qs = new URLSearchParams({
          contractType: 'BINARY',
          isResolved:   'false',
          limit:        String(PAGE_SIZE),
          sort:         'liquidity',
          order:        'desc',
        });
        if (before) qs.set('before', before);

        const res = await this._fetch(`/markets?${qs}`);
        if (!res.ok) {
          log.warn('Manifold API — erreur HTTP', { status: res.status });
          break;
        }

        const raw = await res.json() as any[];
        if (!Array.isArray(raw) || raw.length === 0) break;

        for (const m of raw) {
          const prob = parseFloat(m.probability ?? m.prob ?? '0');
          if (isNaN(prob) || prob <= 0 || prob >= 1) continue;
          if (m.isResolved) continue;

          markets.push({
            id:          m.id     ?? m.slug ?? '',
            question:    m.question ?? '',
            probability: prob,
            closeTime:   typeof m.closeTime === 'number' ? m.closeTime : Date.parse(m.closeTime ?? '') || 0,
            volume:      parseFloat(m.volume ?? m.totalLiquidity ?? '0'),
            isResolved:  !!m.isResolved,
          });
        }

        // Pagination : dernier ID du batch comme curseur
        const lastId = raw[raw.length - 1]?.id;
        if (!lastId || raw.length < PAGE_SIZE) break;
        before = lastId;
      }

      log.info(`Manifold — ${markets.length} marchés binaires récupérés`);
    } catch (e: any) {
      log.error('Manifold — impossible de récupérer les marchés', { error: e.message });
    }

    return markets;
  }

  // ── HTTP helper ───────────────────────────────────────────────
  private async _fetch(path: string): Promise<Response> {
    return fetch(`${BASE_URL}${path}`, {
      headers: { 'User-Agent': 'polybot/2.0', 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(REQ_TIMEOUT),
    });
  }
}
