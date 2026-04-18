/**
 * ClobWebSocket.ts — Connexion WebSocket temps réel au CLOB Polymarket
 *
 * Remplace le polling HTTP 60s par une écoute événementielle sub-seconde.
 *
 * Protocole Polymarket WS :
 *   1. Connexion à wss://ws-subscriptions.polymarket.com/ws/
 *   2. Envoi {"type":"Market","assets_ids":["tokenId1",...]}
 *   3. Réception events: price_change | book | last_trade_price
 *   4. Ping toutes les 10s pour keepalive
 *   5. Reconnexion automatique avec backoff exponentiel
 *
 * Events émis :
 *   'connected'     — WebSocket établi
 *   'disconnected'  — WebSocket fermé
 *   'price_update'  — PriceUpdate (prix live d'un marché)
 *   'book_update'   — BookUpdate  (snapshot order book)
 *   'error'         — Error
 */
import { EventEmitter }  from 'events';
import WebSocket         from 'ws';
import { getLogger }     from '../utils/logger';
import type { ApiCreds } from '../connectors/PolymarketConnector';

const log = getLogger('ClobWebSocket');

const WS_URL            = 'wss://ws-subscriptions.polymarket.com/ws/';
const PING_INTERVAL_MS  = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 30_000;

export interface PriceUpdate {
  tokenId:   string;
  price:     number;
  side:      'BUY' | 'SELL';
  size:      number;
  timestamp: number;
}

export interface BookUpdate {
  tokenId: string;
  bestAsk: number | null;
  bestBid: number | null;
}

export class ClobWebSocket extends EventEmitter {
  private ws:             WebSocket | null = null;
  private pingTimer:      ReturnType<typeof setInterval>  | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout>   | null = null;
  private reconnectDelay  = RECONNECT_BASE_MS;
  private subscribedIds   = new Set<string>();
  private destroyed       = false;

  constructor(private readonly creds: ApiCreds) {
    super();
  }

  // ── API publique ─────────────────────────────────────────────
  connect(): void {
    if (this.destroyed) return;
    this._connect();
  }

  subscribe(tokenIds: string[]): void {
    const newIds = tokenIds.filter(id => !this.subscribedIds.has(id));
    if (newIds.length === 0) return;

    for (const id of newIds) this.subscribedIds.add(id);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this._send({ type: 'Market', assets_ids: newIds });
      log.info(`WebSocket — abonné à ${newIds.length} marché(s)`, {
        total: this.subscribedIds.size,
      });
    }
  }

  unsubscribe(tokenIds: string[]): void {
    for (const id of tokenIds) this.subscribedIds.delete(id);
    log.debug(`WebSocket — désabonné, reste ${this.subscribedIds.size} marchés`);
  }

  get subscriptionCount(): number { return this.subscribedIds.size; }

  destroy(): void {
    this.destroyed = true;
    this._cleanup();
    this.ws?.close(1000, 'shutdown');
  }

  // ── Connexion interne ─────────────────────────────────────────
  private _connect(): void {
    log.info('WebSocket — connexion en cours...', { url: WS_URL });
    this.ws = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });

    this.ws.on('open', () => {
      log.info('WebSocket — connecté ✓');
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.emit('connected');
      this._startPing();

      if (this.subscribedIds.size > 0) {
        this._send({ type: 'Market', assets_ids: [...this.subscribedIds] });
        log.info(`WebSocket — réabonnement à ${this.subscribedIds.size} marchés`);
      }
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());
        this._handleMessage(data);
      } catch { /* non-JSON ignoré */ }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log.warn('WebSocket — déconnecté', {
        code,
        reason: reason.toString() || 'inconnu',
      });
      this._cleanup();
      this.emit('disconnected', code);
      if (!this.destroyed) this._scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      log.error('WebSocket — erreur socket', { error: err.message });
      this.emit('error', err);
    });
  }

  // ── Parsing des messages Polymarket ──────────────────────────
  private _handleMessage(msg: unknown): void {
    // Polymarket envoie soit un tableau soit un objet unique
    const events = Array.isArray(msg) ? msg : [msg];

    for (const ev of events as any[]) {
      const type: string = ev.event_type ?? ev.type ?? '';

      switch (type) {
        case 'price_change': {
          const price = parseFloat(ev.price);
          if (isNaN(price)) break;
          this.emit('price_update', {
            tokenId:   ev.asset_id,
            price,
            side:      ev.side === 'SELL' ? 'SELL' : 'BUY',
            size:      parseFloat(ev.size ?? '0'),
            timestamp: Date.now(),
          } satisfies PriceUpdate);
          break;
        }

        case 'book': {
          // Snapshot complet de l'order book
          const asks: any[] = ev.asks ?? [];
          const bids: any[] = ev.bids ?? [];

          // CLOB trie asks ASC, bids DESC → premier = meilleur
          const bestAsk = asks.length ? parseFloat(asks[0].price) : null;
          const bestBid = bids.length ? parseFloat(bids[0].price) : null;

          const bookUpdate: BookUpdate = {
            tokenId: ev.asset_id,
            bestAsk: bestAsk !== null && !isNaN(bestAsk) ? bestAsk : null,
            bestBid: bestBid !== null && !isNaN(bestBid) ? bestBid : null,
          };
          this.emit('book_update', bookUpdate);

          // Synthetic price_update depuis le bestAsk (référence pour signaux)
          if (bookUpdate.bestAsk !== null) {
            this.emit('price_update', {
              tokenId:   ev.asset_id,
              price:     bookUpdate.bestAsk,
              side:      'BUY' as const,
              size:      0,
              timestamp: Date.now(),
            } satisfies PriceUpdate);
          }
          break;
        }

        case 'last_trade_price': {
          const price = parseFloat(ev.price);
          if (!isNaN(price)) {
            this.emit('price_update', {
              tokenId:   ev.asset_id,
              price,
              side:      'BUY' as const,
              size:      parseFloat(ev.size ?? '0'),
              timestamp: Date.now(),
            } satisfies PriceUpdate);
          }
          break;
        }

        case 'pong':
          log.debug('WebSocket — pong reçu');
          break;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────
  private _send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private _startPing(): void {
    this.pingTimer = setInterval(
      () => this._send({ type: 'ping' }),
      PING_INTERVAL_MS,
    );
  }

  private _cleanup(): void {
    if (this.pingTimer)      { clearInterval(this.pingTimer);    this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private _scheduleReconnect(): void {
    log.info(`WebSocket — reconnexion dans ${(this.reconnectDelay / 1000).toFixed(1)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this._connect();
    }, this.reconnectDelay);
  }
}
