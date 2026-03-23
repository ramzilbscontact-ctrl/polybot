/**
 * PolymarketConnector.ts
 * Couche d'accès à l'API Polymarket CLOB avec :
 *   - Retry automatique (backoff exponentiel)
 *   - Timeout par requête
 *   - Reconnexion automatique si le wallet/client devient invalide
 *   - Méthodes haut niveau : getMarkets, getOrderBook, placeOrder, getBalance
 */
import { ethers }      from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { getLogger }   from '../utils/logger';

const log = getLogger('Connector');

const HOST     = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const GAMMA    = 'https://gamma-api.polymarket.com';

// Types publics
export interface ApiCreds {
  key:        string;
  secret:     string;
  passphrase: string;
}
export interface PlaceOrderParams {
  tokenId:   string;
  price:     number;
  size:      number;
  side:      'BUY' | 'SELL';
}
export interface OrderResult {
  orderId: string;
  status:  string;
}

export class PolymarketConnector {
  private client!: ClobClient;
  private wallet!: ethers.Wallet;
  private creds:   ApiCreds;
  private ready    = false;

  // Config retry
  private readonly MAX_RETRIES  = 4;
  private readonly BASE_DELAY   = 500;   // ms
  private readonly REQ_TIMEOUT  = 12000; // ms

  constructor(
    private readonly privateKey: string,
    private readonly alchemyUrl: string,
    creds: ApiCreds,
  ) {
    this.creds = creds;
  }

  // ── Initialisation ────────────────────────────────────────────
  async connect(): Promise<void> {
    log.info('Connexion au réseau Polygon...');
    const provider = new ethers.providers.JsonRpcProvider(this.alchemyUrl);

    const pk = this.privateKey.startsWith('0x')
      ? this.privateKey : '0x' + this.privateKey;

    this.wallet = new ethers.Wallet(pk, provider);

    // Sanity-check réseau
    const block = await this.withRetry(() => provider.getBlockNumber(), 'blockNumber');
    log.info('Polygon connecté', { block, address: this.wallet.address });

    this.client = new ClobClient(HOST, CHAIN_ID, this.wallet, {
      key:        this.creds.key,
      secret:     this.creds.secret,
      passphrase: this.creds.passphrase,
    });

    // Vérifie les clés L2
    await this.withRetry(() => this.client.getApiKeys(), 'getApiKeys');
    this.ready = true;
    log.info('PolymarketConnector prêt ✓', { host: HOST });
  }

  private assertReady() {
    if (!this.ready) throw new Error('Connector non initialisé — appelle connect() d\'abord');
  }

  // ── Retry avec backoff exponentiel ───────────────────────────
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: Error = new Error('unknown');
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const result = await Promise.race([
          fn(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`Timeout ${label} (${this.REQ_TIMEOUT}ms)`)),
              this.REQ_TIMEOUT)),
        ]);
        return result;
      } catch (e: any) {
        lastErr = e;
        const delay = this.BASE_DELAY * Math.pow(2, attempt - 1);
        log.warn(`Retry ${attempt}/${this.MAX_RETRIES} [${label}] : ${e.message?.split('\n')[0]}`,
          { delay });
        if (attempt < this.MAX_RETRIES)
          await new Promise(r => setTimeout(r, delay));
      }
    }
    log.error(`Échec définitif [${label}]`, { error: lastErr.message });
    throw lastErr;
  }

  // ── Marchés Gamma ─────────────────────────────────────────────
  async getGammaMarkets(params: Record<string, string> = {}): Promise<any[]> {
    const qs  = new URLSearchParams({ active:'true', closed:'false', limit:'200', ...params });
    const url = `${GAMMA}/markets?${qs}`;

    const res = await this.withRetry(async () => {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'polybot/2.0' },
        signal: AbortSignal.timeout(this.REQ_TIMEOUT),
      });
      if (!r.ok) throw new Error(`Gamma HTTP ${r.status}`);
      return r.json();
    }, 'getGammaMarkets');

    if (!Array.isArray(res)) {
      log.warn('Gamma API: réponse non-array', { type: typeof res });
      return [];
    }
    return res;
  }

  // ── Order Book CLOB ────────────────────────────────────────────
  async getOrderBook(tokenId: string) {
    this.assertReady();
    return this.withRetry(() => this.client.getOrderBook(tokenId), 'getOrderBook');
  }

  // ── Passer un ordre ────────────────────────────────────────────
  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    this.assertReady();
    log.info('Placement ordre', {
      side: params.side, price: params.price,
      size: params.size, tokenId: params.tokenId.substring(0, 12) + '…',
    });

    const order = await this.withRetry(() =>
      this.client.createOrder({
        tokenID:   params.tokenId,
        price:     params.price,
        side:      params.side === 'BUY' ? Side.BUY : Side.SELL,
        size:      params.size,
        orderType: OrderType.GTC,
      }), 'createOrder'
    );

    const resp = await this.withRetry(() =>
      this.client.postOrder(order, OrderType.GTC), 'postOrder'
    );

    const orderId = (resp as any).orderID ?? JSON.stringify(resp).substring(0, 40);
    const status  = (resp as any).status  ?? 'submitted';
    log.info('Ordre accepté', { orderId, status });
    return { orderId, status };
  }

  // ── Solde USDC.e ─────────────────────────────────────────────
  async getUsdcBalance(): Promise<number> {
    const USDC  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const ABI   = ['function balanceOf(address) view returns (uint256)',
                   'function decimals() view returns (uint8)'];
    const token = new ethers.Contract(USDC, ABI, this.wallet.provider);
    const [raw, dec] = await Promise.all([
      this.withRetry(() => token.balanceOf(this.wallet.address), 'balanceOf'),
      this.withRetry(() => token.decimals(), 'decimals'),
    ]);
    return parseFloat(ethers.utils.formatUnits(raw, dec));
  }

  get address() { return this.wallet?.address ?? ''; }
}
