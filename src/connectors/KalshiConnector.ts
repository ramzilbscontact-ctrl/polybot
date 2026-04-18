/**
 * KalshiConnector.ts — Accès aux marchés Kalshi (US prediction market)
 *
 * Kalshi est la plateforme de marchés de prédiction régulée CFTC aux US.
 * Elle trade les mêmes événements que Polymarket (politique, crypto, sports)
 * avec des prix souvent différents → opportunités d'arbitrage.
 *
 * API : https://trading-api.kalshi.com/trade-api/v2
 *   - Lecture marchés : authentification requise (KALSHI_EMAIL + KALSHI_PASSWORD)
 *   - Si non configuré : mode dégradé (stub vide, arb désactivé)
 *
 * Configuration .env :
 *   KALSHI_EMAIL=your@email.com
 *   KALSHI_PASSWORD=yourpassword
 *
 * Ref : https://trading-api.kalshi.com/trade-api/v2/docs
 */
import { getLogger } from '../utils/logger';

const log = getLogger('KalshiConnector');

const BASE_URL    = 'https://trading-api.kalshi.com/trade-api/v2';
const REQ_TIMEOUT = 10_000;
const MAX_RETRIES = 3;

export interface KalshiMarket {
  ticker:      string;   // ex: "KXBTCD-25JUL-T80000"
  title:       string;   // ex: "Will BTC be above $80,000 on Jul 25?"
  yesAsk:      number;   // prix pour acheter YES (0–1)
  yesBid:      number;   // prix pour vendre YES
  noAsk:       number;
  noBid:       number;
  closeTime:   string;   // ISO date
  volume:      number;   // volume 24h (USDC)
  openInterest:number;
  status:      string;   // 'open' | 'closed' | 'settled'
}

export class KalshiConnector {
  private token:      string | null = null;
  private tokenExp:   number        = 0;
  private available   = false;

  private readonly email:    string;
  private readonly password: string;

  constructor() {
    this.email    = process.env.KALSHI_EMAIL    ?? '';
    this.password = process.env.KALSHI_PASSWORD ?? '';
    this.available = !!(this.email && this.password);

    if (!this.available) {
      log.warn('KalshiConnector — KALSHI_EMAIL / KALSHI_PASSWORD non configurés. Arbitrage Kalshi désactivé.');
    } else {
      log.info('KalshiConnector — credentials détectés, arb cross-exchange activé');
    }
  }

  get isAvailable(): boolean { return this.available; }

  // ── Authentification (JWT, expire 24h) ────────────────────────
  private async _login(): Promise<void> {
    const res = await this._fetch('/login', {
      method: 'POST',
      body:   JSON.stringify({ email: this.email, password: this.password }),
    }, false);

    if (!res.ok) throw new Error(`Kalshi login failed: HTTP ${res.status}`);

    const data = await res.json() as any;
    this.token    = data.token ?? data.access_token ?? null;
    this.tokenExp = Date.now() + 23 * 3_600_000; // 23h (expire dans 24h)

    if (!this.token) throw new Error('Kalshi: token absent de la réponse login');
    log.info('KalshiConnector — authentifié ✓');
  }

  private async _ensureAuth(): Promise<void> {
    if (!this.available) return;
    if (!this.token || Date.now() > this.tokenExp) await this._login();
  }

  // ── Récupération des marchés ouverts ──────────────────────────
  async getOpenMarkets(): Promise<KalshiMarket[]> {
    if (!this.available) return [];

    try {
      await this._ensureAuth();
      const markets: KalshiMarket[] = [];
      let cursor = '';

      // Pagination — max 3 pages de 200 marchés
      for (let page = 0; page < 3; page++) {
        const qs   = new URLSearchParams({ status: 'open', limit: '200' });
        if (cursor) qs.set('cursor', cursor);

        const res  = await this._fetch(`/markets?${qs}`, {}, true);
        if (!res.ok) {
          log.warn('Kalshi — HTTP erreur', { status: res.status });
          break;
        }

        const data = await res.json() as any;
        const raw  = data.markets ?? data.data ?? [];

        for (const m of raw) {
          const yesAsk = parseFloat(m.yes_ask ?? m.yesAsk ?? '0');
          const yesBid = parseFloat(m.yes_bid ?? m.yesBid ?? '0');
          const noAsk  = parseFloat(m.no_ask  ?? m.noAsk  ?? '0');
          const noBid  = parseFloat(m.no_bid  ?? m.noBid  ?? '0');

          if (isNaN(yesAsk) || yesAsk <= 0) continue;

          markets.push({
            ticker:       m.ticker       ?? m.market_id ?? '',
            title:        m.title        ?? m.question  ?? '',
            yesAsk:       yesAsk / 100,   // Kalshi utilise des centimes (0-100)
            yesBid:       yesBid / 100,
            noAsk:        noAsk  / 100,
            noBid:        noBid  / 100,
            closeTime:    m.close_time   ?? m.expiration_time ?? '',
            volume:       parseFloat(m.volume ?? '0'),
            openInterest: parseFloat(m.open_interest ?? '0'),
            status:       m.status ?? 'open',
          });
        }

        cursor = data.cursor ?? '';
        if (!cursor || raw.length < 200) break;
      }

      log.info(`Kalshi — ${markets.length} marchés récupérés`);
      return markets;

    } catch (e: any) {
      log.error('Kalshi — impossible de récupérer les marchés', { error: e.message });
      return [];
    }
  }

  // ── HTTP helper avec retry ────────────────────────────────────
  private async _fetch(
    path:    string,
    options: RequestInit = {},
    withAuth = true,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent':   'polybot/2.0',
    };
    if (withAuth && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    let lastErr: Error = new Error('unknown');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${BASE_URL}${path}`, {
          ...options,
          headers: { ...headers, ...(options.headers as any ?? {}) },
          signal:  AbortSignal.timeout(REQ_TIMEOUT),
        });
        return res;
      } catch (e: any) {
        lastErr = e;
        const delay = 500 * Math.pow(2, attempt - 1);
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }
}
