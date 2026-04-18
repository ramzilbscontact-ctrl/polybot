/**
 * main.ts — Orchestrateur Stack 2 (sans Kalshi)
 *
 * Flux de données :
 *
 *  BinanceWebSocket ── prix crypto live ──────────────────────────┐
 *                                                                  │
 *  ClobWebSocket ── price_update ──→ CrossSignal? ──→ Executor ───┘
 *                                                                  │
 *  Rescan HTTP (5min) ──→ MarketCache ──→ subscribe WS ───────────┘
 *        │
 *        └──→ ManifoldConnector ──→ CrossSignalDetector (validation)
 *
 *  NewsFeed (RSS, 60s) ──→ match marché ──→ rééval immédiate
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { getLogger }              from './utils/logger';
import { PolymarketConnector }    from './connectors/PolymarketConnector';
import { ManifoldConnector }      from './connectors/ManifoldConnector';
import { HighProbStrategy }       from './strategies/HighProbStrategy';
import { OrderExecutor }          from './executor/OrderExecutor';
import { ClobWebSocket }          from './feeds/ClobWebSocket';
import { MarketCache }            from './feeds/MarketCache';
import { NewsFeed }               from './feeds/NewsFeed';
import { BinanceWebSocket }       from './price/BinanceWebSocket';
import { CrossSignalDetector }    from './arbitrage/CrossSignalDetector';
import type { PriceUpdate }       from './feeds/ClobWebSocket';
import type { CachedMarket }      from './feeds/MarketCache';
import type { NewsMatch }         from './feeds/NewsFeed';

const log = getLogger('Main');

// ── Config ──────────────────────────────────────────────────────
const {
  PRIVATE_KEY, ALCHEMY_URL,
  CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE,
} = process.env;

if (!PRIVATE_KEY || !ALCHEMY_URL || !CLOB_API_KEY || !CLOB_SECRET || !CLOB_PASSPHRASE) {
  console.error('❌ Variables .env manquantes. Vérifie /root/polybot/.env');
  process.exit(1);
}

const RESCAN_INTERVAL_S   = parseInt(process.env.RESCAN_INTERVAL_S   ?? '300',  10);  // 5 min
const MANIFOLD_INTERVAL_S = parseInt(process.env.MANIFOLD_INTERVAL_S ?? '180',  10);  // 3 min
const PURGE_INTERVAL_S    = parseInt(process.env.PURGE_INTERVAL_S    ?? '600',  10);  // 10 min
const DEBOUNCE_MS         = parseInt(process.env.WS_DEBOUNCE_MS      ?? '5000', 10);  // 5s
const DRY_RUN             = process.env.DRY_RUN === 'true';

async function main() {
  log.info('╔══════════════════════════════════════════════════════════╗');
  log.info('║  🤖 POLYBOT v2 — Multi-Feed : WS + Manifold + News     ║');
  log.info(`║  Mode      : ${DRY_RUN ? 'PAPER TRADING (DRY-RUN)        ' : 'LIVE (ordres réels)             '}║`);
  log.info(`║  Rescan    : /${RESCAN_INTERVAL_S}s  Manifold: /${MANIFOLD_INTERVAL_S}s  News: /${process.env.NEWS_POLL_S ?? '60'}s    ║`);
  log.info('╚══════════════════════════════════════════════════════════╝');

  const creds = { key: CLOB_API_KEY!, secret: CLOB_SECRET!, passphrase: CLOB_PASSPHRASE! };

  // ── Instanciation ────────────────────────────────────────────────
  const connector   = new PolymarketConnector(PRIVATE_KEY!, ALCHEMY_URL!, creds);
  const strategy    = new HighProbStrategy(connector, {
    yesMin:          parseFloat(process.env.YES_MIN      ?? '0.88'),
    yesMax:          parseFloat(process.env.YES_MAX      ?? '0.94'),
    stakeUsdc:       parseFloat(process.env.STAKE_USDC   ?? '0.80'),
    expiryMaxHours:  parseInt(process.env.EXPIRY_MAX_H   ?? '48',  10),
    cryptoBufferUsd: parseInt(process.env.CRYPTO_BUFFER  ?? '60',  10),
  });
  const executor    = new OrderExecutor(connector, strategy, {
    maxOpenTrades:   parseInt(process.env.MAX_TRADES ?? '3', 10),
    maxTotalLoss:    parseFloat(process.env.MAX_LOSS  ?? '2.00'),
    dryRun:          DRY_RUN,
  });

  const cache       = new MarketCache();
  const clobWs      = new ClobWebSocket(creds);
  const binanceWs   = new BinanceWebSocket();
  const manifold    = new ManifoldConnector();
  const crossSignal = new CrossSignalDetector();
  const newsFeed    = new NewsFeed();

  // ── Connexion Polygon ────────────────────────────────────────────
  try {
    await connector.connect();
  } catch (e: any) {
    log.error('Connexion Polygon échouée', { error: e.message });
    process.exit(1);
  }

  try {
    const balance = await connector.getUsdcBalance();
    log.info('Solde USDC.e', { balance: balance.toFixed(4) });
  } catch { /* non bloquant */ }

  // ── Compteurs ────────────────────────────────────────────────────
  let rescanCount   = 0;
  let wsSignalCount = 0;
  let newsHitCount  = 0;
  let confirmedCount = 0;

  // ── Rescan HTTP Polymarket ───────────────────────────────────────
  const rescan = async () => {
    rescanCount++;
    const stats = executor.stats;

    if (DRY_RUN) {
      const wr = stats.paperResolved > 0
        ? ((stats.paperWins / stats.paperResolved) * 100).toFixed(1) + '%' : 'N/A';
      log.info(`🔄 Rescan #${rescanCount} [PAPER]`, {
        cached: cache.size, wsSignals: wsSignalCount,
        newsHits: newsHitCount, confirmed: confirmedCount,
        paperTrades: stats.paperTrades,
        pnl: (stats.paperPnl >= 0 ? '+' : '') + stats.paperPnl.toFixed(4) + ' USDC.e',
        winRate: wr,
      });
    } else {
      log.info(`🔄 Rescan #${rescanCount}`, {
        cached: cache.size, wsSignals: wsSignalCount,
        newsHits: newsHitCount, trades: stats.tradeCount,
        loss: stats.totalLoss.toFixed(2),
      });
    }

    if (executor.stopped) { log.warn('Bot arrêté (stop-loss).'); process.exit(0); }

    let signals;
    try { signals = await strategy.scan(); }
    catch (e: any) { log.error('Erreur rescan', { error: e.message }); return; }

    if (signals.length === 0) { log.info('Rescan — aucun candidat'); return; }

    const newTokenIds: string[] = [];
    for (const sig of signals) {
      if (!cache.has(sig.conditionId)) {
        cache.set({
          conditionId: sig.conditionId, tokenId: sig.tokenId,
          question: sig.question,       domain: sig.domain,
          endDate: sig.endDate,         liquidity: sig.liquidity,
          validated: true,              lastPrice: sig.yesPrice,
          lastUpdated: Date.now(),      reasoning: sig.reasoning,
        } satisfies CachedMarket);
        newTokenIds.push(sig.tokenId);
      }
    }

    if (newTokenIds.length > 0) {
      clobWs.subscribe(newTokenIds);
      log.info(`Rescan — ${newTokenIds.length} nouveau(x) marché(s)`, {
        total: cache.size, subscriptions: clobWs.subscriptionCount,
      });
    }
  };

  // ── Validation croisée Manifold (toutes les 3 min) ───────────────
  const manifoldScan = async () => {
    if (cache.size === 0) return;
    try {
      const manifoldMarkets = await manifold.getOpenBinaryMarkets();
      if (manifoldMarkets.length === 0) return;

      const results = crossSignal.analyze(cache.all(), manifoldMarkets);
      const confirmed  = results.filter(r => r.confidence === 'CONFIRMED').length;
      const divergent  = results.filter(r => r.confidence === 'DIVERGENT').length;
      confirmedCount  += confirmed;

      if (confirmed > 0 || divergent > 0) {
        log.info('🧭 Manifold cross-validation', {
          analyzed: results.length, confirmed, divergent,
          neutral: results.length - confirmed - divergent,
        });
      }
    } catch (e: any) {
      log.error('Erreur Manifold scan', { error: e.message });
    }
  };

  // ── Helper : exécuter un signal (utilisé par WS + News) ──────────
  const executeIfValid = async (
    market:  CachedMarket,
    price:   number,
    source:  string,
  ) => {
    const signal = strategy.buildSignalFromCache(market, price);
    if (!signal) return;

    // Enrichit le log avec la confiance Manifold si connue
    const confidence = crossSignal.getConfidence(market.conditionId);

    if (confidence === 'DIVERGENT') {
      log.warn(`Signal ${source} ignoré — Manifold divergent`, {
        question: signal.question.substring(0, 60),
        polyPrice: price,
      });
      return;
    }

    const tag = confidence === 'CONFIRMED' ? '⚡✅' : '⚡';
    log.info(`${tag} Signal ${source}${confidence === 'CONFIRMED' ? ' [CONFIRMÉ Manifold]' : ''}`, {
      domain: signal.domain, question: signal.question.substring(0, 60),
      livePrice: price, minsLeft: signal.minsLeft,
    });

    try { await executor.processSignals([signal]); }
    catch (e: any) { log.error('Erreur processSignals', { error: e.message }); }
  };

  // ── Handler WebSocket CLOB ───────────────────────────────────────
  clobWs.on('price_update', async (update: PriceUpdate) => {
    const { tokenId, price } = update;
    const market = cache.updatePrice(tokenId, price);
    if (!market) return;

    const cfg = strategy.config;
    if (price < cfg.yesMin || price > cfg.yesMax) return;
    if (!cache.canEvaluate(tokenId, DEBOUNCE_MS)) return;

    // Buffer crypto via Binance WS (0 HTTP)
    if (market.domain === 'Crypto') {
      const { detectTicker, parseThreshold } = await import('./price/PriceFeed');
      const ticker    = detectTicker(market.question);
      const threshold = parseThreshold(market.question);
      if (ticker && threshold) {
        const livePrice = binanceWs.getPrice(ticker);
        if (livePrice !== null && (livePrice - threshold) < cfg.cryptoBufferUsd) return;
      }
    }

    wsSignalCount++;
    await executeIfValid(market, price, 'WS');
  });

  // ── Handler NewsFeed ─────────────────────────────────────────────
  newsFeed.on('match', async (nm: NewsMatch) => {
    newsHitCount++;
    const market = cache.getByConditionId(nm.market.conditionId);
    if (!market) return;

    // Contourne le debounce WS — une news est un événement fort
    log.info('📰 News trigger — réévaluation forcée', {
      headline: nm.item.title.substring(0, 70),
      market:   market.question.substring(0, 60),
      score:    (nm.score * 100).toFixed(0) + '%',
    });
    await executeIfValid(market, market.lastPrice, 'NEWS');
  });

  // ── Events connexion ─────────────────────────────────────────────
  clobWs.on('connected',    () => log.info('ClobWS ✓',    { subs: clobWs.subscriptionCount }));
  clobWs.on('disconnected', (c: number) => log.warn('ClobWS ✗', { code: c }));
  binanceWs.on('connected', () => log.info('BinanceWS ✓', { pairs: 'BTC/ETH/SOL/XRP/DOGE' }));

  // ── Démarrage ────────────────────────────────────────────────────
  await rescan();
  clobWs.connect();
  binanceWs.connect();
  newsFeed.start(() => cache.all());

  const rescanInterval   = setInterval(rescan,       RESCAN_INTERVAL_S   * 1_000);
  const manifoldInterval = setInterval(manifoldScan, MANIFOLD_INTERVAL_S * 1_000);
  const purgeInterval    = setInterval(() => cache.purgeExpired(), PURGE_INTERVAL_S * 1_000);

  setTimeout(manifoldScan, 45_000);   // 1er scan Manifold 45s après démarrage

  // ── Arrêt propre ─────────────────────────────────────────────────
  const shutdown = (sig: string) => {
    log.info(`${sig} — arrêt propre...`);
    clearInterval(rescanInterval);
    clearInterval(manifoldInterval);
    clearInterval(purgeInterval);
    clobWs.destroy();
    binanceWs.destroy();
    newsFeed.stop();

    const stats = executor.stats;
    if (DRY_RUN) {
      const wr = stats.paperResolved > 0
        ? ((stats.paperWins / stats.paperResolved) * 100).toFixed(1) + '%' : 'N/A';
      log.info('📊 Bilan final [PAPER TRADING]', {
        rescans: rescanCount, wsSignals: wsSignalCount,
        newsHits: newsHitCount, manifoldConfirmed: confirmedCount,
        trades: stats.paperTrades, resolved: stats.paperResolved,
        wins: stats.paperWins, losses: stats.paperLosses,
        winRate: wr,
        pnl: (stats.paperPnl >= 0 ? '+' : '') + stats.paperPnl.toFixed(4) + ' USDC.e',
      });
    } else {
      log.info('📊 Bilan final', {
        rescans: rescanCount, wsSignals: wsSignalCount, newsHits: newsHitCount,
        trades: stats.tradeCount, totalLoss: stats.totalLoss.toFixed(2) + ' USDC.e',
      });
    }
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => { console.error('❌ Erreur fatale :', e.message); process.exit(1); });
