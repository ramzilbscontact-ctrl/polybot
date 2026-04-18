/**
 * BinanceWebSocket.ts — Prix crypto temps réel via Binance bookTicker
 *
 * Remplace les appels HTTP dans PriceFeed.ts pour les marchés crypto :
 *   - Latence < 100ms au lieu de 400-800ms HTTP
 *   - Prix toujours à jour en mémoire → zéro latence dans le hot path WS
 *   - Reconnexion automatique avec backoff exponentiel
 *
 * Stream Binance : wss://stream.binance.com:9443/ws/<sym>@bookTicker
 * bookTicker = meilleur bid/ask live, mis à jour ~100ms
 *
 * Usage :
 *   const feed = new BinanceWebSocket();
 *   feed.connect();
 *   feed.getPrice('BTC')   // → 81450.23 | null
 *   feed.on('price', ({ ticker, price }) => ...)
 */
import { EventEmitter } from 'events';
import WebSocket        from 'ws';
import { getLogger }    from '../utils/logger';

const log = getLogger('BinanceWS');

// Symbols trackés : ticker Polymarket → symbol Binance
const TICKER_MAP: Record<string, string> = {
  BTC:  'btcusdt',
  ETH:  'ethusdt',
  SOL:  'solusdt',
  XRP:  'xrpusdt',
  DOGE: 'dogeusdt',
  BNB:  'bnbusdt',
  MATIC:'maticusdt',
};

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;

export interface CryptoPrice {
  ticker:    string;   // 'BTC', 'ETH'...
  bid:       number;
  ask:       number;
  mid:       number;   // (bid + ask) / 2
  updatedAt: number;   // timestamp ms
}

export class BinanceWebSocket extends EventEmitter {
  private ws:             WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay  = RECONNECT_BASE_MS;
  private destroyed       = false;

  // Prices en mémoire : ticker → CryptoPrice
  private readonly prices = new Map<string, CryptoPrice>();

  // ── API publique ──────────────────────────────────────────────
  connect(): void {
    if (this.destroyed) return;
    this._connect();
  }

  /** Retourne le mid-price le plus récent, ou null si non disponible */
  getPrice(ticker: string): number | null {
    return this.prices.get(ticker.toUpperCase())?.mid ?? null;
  }

  /** Retourne le bid/ask complet, ou null */
  getQuote(ticker: string): CryptoPrice | null {
    return this.prices.get(ticker.toUpperCase()) ?? null;
  }

  /** Toutes les paires disponibles */
  all(): CryptoPrice[] {
    return [...this.prices.values()];
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'shutdown');
  }

  // ── Connexion ─────────────────────────────────────────────────
  private _connect(): void {
    const streams = Object.values(TICKER_MAP).map(s => `${s}@bookTicker`).join('/');
    const url     = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    log.info('BinanceWS — connexion...', { streams: Object.keys(TICKER_MAP).join(', ') });
    this.ws = new WebSocket(url, { handshakeTimeout: 10_000 });

    this.ws.on('open', () => {
      log.info('BinanceWS — connecté ✓');
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.emit('connected');
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        // Combined stream wraps en { stream, data }
        const msg  = JSON.parse(raw.toString());
        const tick = msg.data ?? msg;
        this._handleTick(tick);
      } catch { /* ignoré */ }
    });

    this.ws.on('close', (code: number) => {
      log.warn('BinanceWS — déconnecté', { code });
      this.emit('disconnected');
      if (!this.destroyed) this._scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      log.error('BinanceWS — erreur', { error: err.message });
    });
  }

  // ── Parsing bookTicker ────────────────────────────────────────
  // Format : { s: 'BTCUSDT', b: '81450.10', B: '0.5', a: '81451.00', A: '0.3' }
  private _handleTick(tick: any): void {
    const symbol = (tick.s ?? '').toLowerCase();

    // Reverse lookup : symbol → ticker
    const ticker = Object.entries(TICKER_MAP).find(([, v]) => v === symbol)?.[0];
    if (!ticker) return;

    const bid = parseFloat(tick.b);
    const ask = parseFloat(tick.a);
    if (isNaN(bid) || isNaN(ask)) return;

    const quote: CryptoPrice = {
      ticker,
      bid,
      ask,
      mid:       (bid + ask) / 2,
      updatedAt: Date.now(),
    };

    this.prices.set(ticker, quote);
    this.emit('price', quote);
  }

  private _scheduleReconnect(): void {
    log.info(`BinanceWS — reconnexion dans ${(this.reconnectDelay / 1000).toFixed(0)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this._connect();
    }, this.reconnectDelay);
  }
}
