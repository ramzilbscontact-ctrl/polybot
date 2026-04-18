/**
 * IBKRConnector.ts — Client Interactive Brokers (Client Portal Gateway)
 *
 * Prérequis :
 *   1. Compte IBKR (paper ou live) : https://www.interactivebrokers.com
 *   2. IBKR Client Portal Gateway installé sur le serveur
 *      → https://www.interactivebrokers.com/en/trading/ib-api.php
 *      → java -jar ibclientportal/root/dist/ibclientportal.jar conf.yaml
 *   3. Variables .env :
 *        IBKR_GATEWAY_URL=https://localhost:5000   (défaut)
 *        IBKR_ACCOUNT_ID=DU1234567                (paper: DUxxxxxx, live: Uxxxxxx)
 *        IBKR_DRY_RUN=true                        (paper trading sans ordres réels)
 *
 * Architecture Client Portal :
 *   - Le Gateway tourne localement (localhost:5000)
 *   - Certificat auto-signé → on ignore les erreurs SSL en dev
 *   - La session est maintenue par tickle() toutes les 60s
 *   - WebSocket ws://localhost:5000/v1/api/ws pour streaming temps réel
 *
 * Docs : https://ibkr.info/node/3335
 */
import { EventEmitter }  from 'events';
import WebSocket         from 'ws';
import { getLogger }     from '../../utils/logger';
import { stockByConid }  from '../NordicUniverse';

const log = getLogger('IBKR');

// ── Types publics ──────────────────────────────────────────────────
export interface MarketQuote {
  conid:    number;
  symbol:   string;
  bid:      number;
  ask:      number;
  last:     number;
  midpoint: number;
  change:   number;    // variation % vs close précédent
  volume:   number;
  updatedAt:number;
}

export interface IBKROrder {
  conid:     number;
  side:      'BUY' | 'SELL';
  quantity:  number;
  orderType: 'MKT' | 'LMT' | 'MOC';
  price?:    number;     // requis pour LMT
  tif:       'DAY' | 'GTC' | 'IOC';
}

export interface IBKROrderResult {
  orderId:  string;
  status:   string;
  message?: string;
}

// ── Champs IBKR (numéros de topic pour le streaming WS) ───────────
const FIELDS = {
  BID:     '84',
  ASK:     '86',
  LAST:    '31',
  CHANGE:  '82',
  VOLUME:  '7762',
  BIDSIZE: '88',
  ASKSIZE: '85',
};

export class IBKRConnector extends EventEmitter {
  private ws:             WebSocket | null = null;
  private tickleTimer:    ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout>  | null = null;
  private reconnectDelay  = 2_000;
  private destroyed       = false;
  private sessionValid    = false;

  private readonly baseUrl:  string;
  private readonly accountId:string;
  private readonly dryRun:   boolean;

  // Cache des quotes en mémoire
  private readonly quotes = new Map<number, MarketQuote>();

  constructor() {
    super();
    this.baseUrl   = process.env.IBKR_GATEWAY_URL ?? 'https://localhost:5000';
    this.accountId = process.env.IBKR_ACCOUNT_ID  ?? '';
    this.dryRun    = process.env.IBKR_DRY_RUN !== 'false';

    if (!this.accountId) {
      log.warn('IBKR — IBKR_ACCOUNT_ID manquant dans .env');
    }
    log.info('IBKRConnector initialisé', {
      gateway: this.baseUrl,
      account: this.accountId || '(non configuré)',
      dryRun:  this.dryRun,
    });
  }

  // ── Initialisation de la session ──────────────────────────────
  async connect(): Promise<void> {
    // Vérifie/initialise la session Client Portal
    try {
      const auth = await this._rest('/v1/api/iserver/auth/status');
      if (auth.authenticated) {
        this.sessionValid = true;
        log.info('IBKR — session active ✓', { account: auth.competing });
      } else {
        log.warn('IBKR — session non authentifiée. Lance le Client Portal Gateway et connecte-toi via https://localhost:5000');
      }
    } catch (e: any) {
      log.error('IBKR — gateway inaccessible', {
        error:  e.message,
        advice: 'Lance: java -jar ibclientportal/root/dist/ibclientportal.jar conf.yaml',
      });
      throw e;
    }

    // Tickle toutes les 60s pour maintenir la session
    this.tickleTimer = setInterval(() => this._tickle(), 60_000);

    // Connexion WebSocket pour streaming
    this._connectWs();
  }

  // ── Abonnement au streaming temps réel ───────────────────────
  subscribeQuotes(conids: number[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn('IBKR WS — pas encore connecté, subscription différée');
      return;
    }
    for (const conid of conids) {
      const fieldList = Object.values(FIELDS).join(',');
      this.ws.send(`smd+${conid}+{"fields":["${Object.values(FIELDS).join('","')}"]}`);
    }
    log.info(`IBKR WS — abonné à ${conids.length} contrat(s)`);
  }

  unsubscribeQuotes(conids: number[]): void {
    for (const conid of conids) {
      this.ws?.send(`umd+${conid}+{}`);
    }
  }

  // ── Quote en cache (O(1)) ─────────────────────────────────────
  getQuote(conid: number): MarketQuote | null {
    return this.quotes.get(conid) ?? null;
  }

  getAllQuotes(): MarketQuote[] {
    return [...this.quotes.values()];
  }

  // ── Placement d'ordre ─────────────────────────────────────────
  async placeOrder(order: IBKROrder): Promise<IBKROrderResult> {
    if (this.dryRun) {
      const fake: IBKROrderResult = {
        orderId: `DRY-${Date.now()}`,
        status:  'simulated',
        message: `[DRY-RUN] ${order.side} ${order.quantity} @ ${order.price ?? 'MKT'}`,
      };
      log.info('IBKR [DRY-RUN] — ordre simulé', {
        side: order.side, qty: order.quantity, price: order.price, conid: order.conid,
      });
      this.emit('order:placed', { ...order, ...fake });
      return fake;
    }

    if (!this.accountId) throw new Error('IBKR_ACCOUNT_ID requis pour passer des ordres');

    const body = {
      orders: [{
        conid:     order.conid,
        secType:   `${order.conid}:STK`,
        orderType: order.orderType,
        side:      order.side,
        quantity:  order.quantity,
        tif:       order.tif,
        ...(order.price ? { price: order.price } : {}),
      }],
    };

    const res = await this._rest(`/v1/api/iserver/account/${this.accountId}/orders`, 'POST', body);

    // IBKR retourne parfois un challenge de confirmation
    if (Array.isArray(res) && res[0]?.id) {
      // Confirme l'ordre si requis
      await this._rest(`/v1/api/iserver/reply/${res[0].id}`, 'POST', { confirmed: true });
    }

    const orderId = res?.[0]?.order_id ?? res?.order_id ?? String(Date.now());
    const result: IBKROrderResult = { orderId: String(orderId), status: 'submitted' };

    log.info('IBKR — ordre soumis', {
      orderId, side: order.side, qty: order.quantity, conid: order.conid,
    });
    this.emit('order:placed', { ...order, ...result });
    return result;
  }

  // ── Recherche de contrat par symbole ──────────────────────────
  async searchContract(symbol: string, exchange?: string): Promise<{ conid: number; description: string }[]> {
    const data = await this._rest(`/v1/api/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}&secType=STK`);
    return (data ?? []).map((c: any) => ({
      conid:       c.conid,
      description: `${c.companyName ?? ''} (${c.symbol ?? ''}) — ${c.primaryExch ?? ''}`,
    }));
  }

  // ── Solde du compte ───────────────────────────────────────────
  async getAccountSummary(): Promise<{ cashBalance: number; netLiquidation: number }> {
    if (!this.accountId) return { cashBalance: 0, netLiquidation: 0 };
    const data = await this._rest(`/v1/api/portfolio/${this.accountId}/summary`);
    return {
      cashBalance:     parseFloat(data?.cashbalance?.amount ?? '0'),
      netLiquidation:  parseFloat(data?.netliquidation?.amount ?? '0'),
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.tickleTimer)    clearInterval(this.tickleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'shutdown');
  }

  // ── WebSocket interne ─────────────────────────────────────────
  private _connectWs(): void {
    const wsUrl = this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/v1/api/ws';
    log.info('IBKR WS — connexion...', { url: wsUrl });

    this.ws = new WebSocket(wsUrl, {
      rejectUnauthorized: false,   // Certificat auto-signé du gateway
      handshakeTimeout:   10_000,
    });

    this.ws.on('open', () => {
      log.info('IBKR WS — connecté ✓');
      this.reconnectDelay = 2_000;
      this.emit('connected');
      // Ping IBKR pour activer la session WS
      this.ws?.send('session');
    });

    this.ws.on('message', (raw: Buffer) => {
      try { this._handleWsMessage(raw.toString()); } catch { /* ignoré */ }
    });

    this.ws.on('close', (code: number) => {
      log.warn('IBKR WS — déconnecté', { code });
      this.emit('disconnected');
      if (!this.destroyed) this._scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      log.error('IBKR WS — erreur', { error: err.message });
    });
  }

  // ── Parsing messages WS IBKR ──────────────────────────────────
  // Format : {"topic":"smd+conid","data":{"31":"12.34","84":"12.33","86":"12.35",...}}
  private _handleWsMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    const topic = msg.topic ?? '';

    // Quote update
    if (topic.startsWith('smd+')) {
      const conid  = parseInt(topic.split('+')[1] ?? '0', 10);
      const data   = msg.data ?? {};
      const stock  = stockByConid.get(conid);

      const bid  = parseFloat(data[FIELDS.BID]  ?? '0');
      const ask  = parseFloat(data[FIELDS.ASK]  ?? '0');
      const last = parseFloat(data[FIELDS.LAST] ?? '0');

      if (conid && (bid || ask || last)) {
        const existing = this.quotes.get(conid);
        const quote: MarketQuote = {
          conid,
          symbol:    stock?.symbol ?? `conid:${conid}`,
          bid:       bid  || existing?.bid  || 0,
          ask:       ask  || existing?.ask  || 0,
          last:      last || existing?.last || 0,
          midpoint:  bid && ask ? (bid + ask) / 2 : (existing?.midpoint ?? 0),
          change:    parseFloat(data[FIELDS.CHANGE]  ?? String(existing?.change  ?? 0)),
          volume:    parseFloat(data[FIELDS.VOLUME]  ?? String(existing?.volume  ?? 0)),
          updatedAt: Date.now(),
        };
        this.quotes.set(conid, quote);
        this.emit('quote', quote);
      }
    }

    // Notification système
    if (topic === 'system') {
      log.debug('IBKR WS system', { msg: JSON.stringify(msg).substring(0, 100) });
    }
  }

  // ── REST helper ───────────────────────────────────────────────
  private async _rest(path: string, method: 'GET' | 'POST' = 'GET', body?: object): Promise<any> {
    const url = this.baseUrl + path;
    const res  = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'polybot/2.0' },
      body:    body ? JSON.stringify(body) : undefined,
      signal:  AbortSignal.timeout(10_000),
      // @ts-ignore — nécessaire pour ignorer le certificat auto-signé
      ...(this.baseUrl.startsWith('https://localhost') ? { agent: false } : {}),
    });
    if (!res.ok && res.status !== 400) {
      throw new Error(`IBKR REST ${method} ${path} → HTTP ${res.status}`);
    }
    return res.json().catch(() => null);
  }

  private async _tickle(): Promise<void> {
    try { await this._rest('/v1/api/tickle', 'POST'); }
    catch { /* non bloquant */ }
  }

  private _scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this._connectWs();
    }, this.reconnectDelay);
  }
}
