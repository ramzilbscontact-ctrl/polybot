/**
 * PriceFeed.ts — Flux de prix en temps réel
 * Sources  : Binance (primaire) → CoinGecko (fallback)
 * Tickers  : BTC, ETH, SOL, XRP, DOGE
 * Cache    : 15 secondes pour éviter le rate-limiting
 */
import { getLogger } from '../utils/logger';

const log = getLogger('PriceFeed');

interface PriceCache { price: number; ts: number; source: string; }
const CACHE_TTL  = 15_000; // ms
const cache      = new Map<string, PriceCache>();

const BINANCE_MAP: Record<string, string> = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT',
  XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
};
const COINGECKO_MAP: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana',
  XRP: 'ripple',  DOGE: 'dogecoin',
};

async function fetchBinance(ticker: string): Promise<number> {
  const symbol = BINANCE_MAP[ticker];
  if (!symbol) throw new Error(`Ticker inconnu: ${ticker}`);
  const r = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  const d = await r.json() as { price: string };
  return parseFloat(d.price);
}

async function fetchCoinGecko(ticker: string): Promise<number> {
  const id = COINGECKO_MAP[ticker];
  if (!id) throw new Error(`Ticker inconnu: ${ticker}`);
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
  const d = await r.json() as Record<string, { usd: number }>;
  return d[id]?.usd ?? 0;
}

/**
 * Retourne le prix spot USD d'un ticker.
 * Tente Binance en premier, CoinGecko en fallback.
 * Répond depuis le cache si < 15s.
 */
export async function getPrice(ticker: string): Promise<{ price: number; source: string }> {
  const key     = ticker.toUpperCase();
  const cached  = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return { price: cached.price, source: cached.source + ' (cache)' };
  }

  let price  = 0;
  let source = 'unknown';

  // Binance (primaire)
  try {
    price  = await fetchBinance(key);
    source = 'Binance';
    log.debug(`Prix ${key} via Binance`, { price });
  } catch (e: any) {
    log.warn(`Binance indisponible pour ${key}, fallback CoinGecko`, { error: e.message });
    // CoinGecko (fallback)
    try {
      price  = await fetchCoinGecko(key);
      source = 'CoinGecko';
      log.debug(`Prix ${key} via CoinGecko`, { price });
    } catch (e2: any) {
      log.error(`Toutes les sources de prix ont échoué pour ${key}`, { error: e2.message });
      throw new Error(`Prix ${key} indisponible (Binance + CoinGecko down)`);
    }
  }

  cache.set(key, { price, ts: Date.now(), source });
  return { price, source };
}

/** Extrait le ticker depuis une question Polymarket */
export function detectTicker(question: string): string | null {
  const q = question.toLowerCase();
  if (/\bbitcoin\b|\bbtc\b/.test(q))    return 'BTC';
  if (/\bethereum\b|\beth\b/.test(q))   return 'ETH';
  if (/\bsolana\b|\bsol\b/.test(q))     return 'SOL';
  if (/\bxrp\b|\bripple\b/.test(q))     return 'XRP';
  if (/\bdogecoin\b|\bdoge\b/.test(q))  return 'DOGE';
  return null;
}

/** Parse le seuil $ dans une question ("above $83,500") */
export function parseThreshold(question: string): number | null {
  const m = question.match(/\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}
