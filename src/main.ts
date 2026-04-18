/**
 * main.ts — Orchestrateur Stack 2
 *
 * Flux de données :
 *
 *  BinanceWebSocket ──── prix crypto live ────────────────────────┐
 *                                                                  │
 *  ClobWebSocket ──── price_update ──→ buildSignalFromCache() ────┤→ OrderExecutor
 *                                                                  │
 *  Rescan HTTP (5min) ──→ MarketCache ──→ subscribe WS ───────────┘
 *      │
 *      └──→ KalshiConnector ──→ ArbDetector ──→ log opportunités arb
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { getLogger }           from './utils/logger';
import { PolymarketConnector } from './connectors/PolymarketConnector';
import { KalshiConnector }     from './connectors/KalshiConnector';
import { HighProbStrategy }    from './strategies/HighProbStrategy';
import { OrderExecutor }       from './executor/OrderExecutor';
import { ClobWebSocket }       from './feeds/ClobWebSocket';
import { MarketCache }         from './feeds/MarketCache';
import { BinanceWebSocket }    from './price/BinanceWebSocket';
import { ArbDetector }         from './arbitrage/ArbDetector';
import type { PriceUpdate }    from './feeds/ClobWebSocket';
import type { CachedMarket }   from './feeds/MarketCache';

const log = getLogger('Main');

// ── Config ─────────────────────────────────────────────────────
const {
  PRIVATE_KEY, ALCHEMY_URL,
  CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE,
} = process.env;

if (!PRIVATE_KEY || !ALCHEMY_URL || !CLOB_API_KEY || !CLOB_SECRET || !CLOB_PASSPHRASE) {
  console.error('❌ Variables .env manquantes. Vérifie /root/polybot/.env');
  process.exit(1);
}

const RESCAN_INTERVAL_S  = parseInt(process.env.RESCAN_INTERVAL_S  ?? '300',  10);
const ARB_INTERVAL_S     = parseInt(process.env.ARB_INTERVAL_S     ?? '120',  10);
const PURGE_INTERVAL_S   = parseInt(process.env.PURGE_INTERVAL_S   ?? '600',  10);
const DEBOUNCE_MS        = parseInt(process.env.WS_DEBOUNCE_MS     ?? '5000', 10);
const DRY_RUN            = process.env.DRY_RUN === 'true';
const LOG_LEVEL          = process.env.LOG_LEVEL ?? 'info';

async function main() {
  log.info('╔══════════════════════════════════════════════════════════╗');
  log.info('║  🤖 POLYBOT v2 — Stack 2 : Multi-Feed + Arb            ║');
  log.info(`║  Mode     : ${DRY_RUN ? 'PAPER TRADING (DRY-RUN)         ' : 'LIVE (ordres réels)              '}║`);
  log.info(`║  Rescan   : /${RESCAN_INTERVAL_S}s  |  Arb scan : /${ARB_INTERVAL_S}s  |  WS debounce: ${DEBOUNCE_MS}ms  ║`);
  log.info('╚══════════════════════════════════════════════════════════╝');

  const creds = { key: CLOB_API_KEY!, secret: CLOB_SECRET!, passphrase: CLOB_PASSPHRASE! };

  // ── Instanciation ───────────────────────────────────────────────
  const connector = new PolymarketConnector(PRIVATE_KEY!, ALCHEMY_URL!, creds);

  const strategy = new HighProbStrategy(connector, {
    yesMin:          parseFloat(process.env.YES_MIN      ?? '0.88'),
    yesMax:          parseFloat(process.env.YES_MAX      ?? '0.94'),
    stakeUsdc:       parseFloat(process.env.STAKE_USDC   ?? '0.80'),
    expiryMaxHours:  parseInt(process.env.EXPIRY_MAX_H   ?? '48',  10),
    cryptoBufferUsd: parseInt(process.env.CRYPTO_BUFFER  ?? '60',  10),
  });

  const executor = new OrderExecutor(connector, strategy, {
    maxOpenTrades: parseInt(process.env.MAX_TRADES ?? '3', 10),
    maxTotalLoss:  parseFloat(process.env.MAX_LOSS  ?? '2.00'),
    dryRun:        DRY_RUN,
  });

  const cache      = new MarketCache();
  const clobWs     = new ClobWebSocket(creds);
  const binanceWs  = new BinanceWebSocket();
  const kalshi     = new KalshiConnector();
  const arbDetect  = new ArbDetector();

  // ── Connexion Polygon ────────────────────────────────────────────
  try {
    await connector.connect();
  } catch (e: any) {
    log.error('Connexion Polygon échouée — arrêt', { error: e.message });
    process.exit(1);
  }

  try {
    const balance = await connector.getUsdcBalance();
    log.info('Solde USDC.e au démarrage', { balance: balance.toFixed(4) });
  } catch { /* non bloquant */ }

  // ── Compteurs ────────────────────────────────────────────────────
  let rescanCount   = 0;
  let wsSignalCount = 0;
  let arbCount      = 0;

  // ── Rescan HTTP Polymarket : découverte marchés candidats ────────
  const rescan = async () => {
    rescanCount++;
    const stats = executor.stats;

    if (DRY_RUN) {
      const wr = stats.paperResolved > 0
        ? ((stats.paperWins / stats.paperResolved) * 100).toFixed(1) + '%' : 'N/A';
      log.info(`🔄 Rescan #${rescanCount} [PAPER]`, {
        cached:      cache.size,
        wsSignals:   wsSignalCount,
        arbOpp:      arbCount,
        paperTrades: stats.paperTrades,
        paperPnl:    (stats.paperPnl >= 0 ? '+' : '') + stats.paperPnl.toFixed(4) + ' USDC.e',
        winRate:     wr,
      });
    } else {
      log.info(`🔄 Rescan #${rescanCount}`, {
        cached:    cache.size,
        wsSignals: wsSignalCount,
        arbOpp:    arbCount,
        trades:    stats.tradeCount,
        loss:      stats.totalLoss.toFixed(2),
      });
    }

    if (executor.stopped) {
      log.warn('Bot arrêté (stop-loss). Relance manuelle requise.');
      process.exit(0);
    }

    let signals;
    try {
      signals = await strategy.scan();
    } catch (e: any) {
      log.error('Erreur rescan HTTP', { error: e.message });
      return;
    }

    if (signals.length === 0) {
      log.info('Rescan — aucun candidat trouvé');
      return;
    }

    const newTokenIds: string[] = [];
    for (const sig of signals) {
      if (!cache.has(sig.conditionId)) {
        const cached: CachedMarket = {
          conditionId: sig.conditionId,
          tokenId:     sig.tokenId,
          question:    sig.question,
          domain:      sig.domain,
          endDate:     sig.endDate,
          liquidity:   sig.liquidity,
          validated:   true,
          lastPrice:   sig.yesPrice,
          lastUpdated: Date.now(),
          reasoning:   sig.reasoning,
        };
        cache.set(cached);
        newTokenIds.push(sig.tokenId);
      }
    }

    if (newTokenIds.length > 0) {
      clobWs.subscribe(newTokenIds);
      log.info(`Rescan — ${newTokenIds.length} nouveau(x) marché(s) → WS abonné`, {
        total:         cache.size,
        subscriptions: clobWs.subscriptionCount,
      });
    }
  };

  // ── Scan d'arbitrage Kalshi ──────────────────────────────────────
  const arbScan = async () => {
    if (!kalshi.isAvailable) return;
    if (cache.size === 0) return;

    try {
      const kalshiMarkets = await kalshi.getOpenMarkets();
      if (kalshiMarkets.length === 0) return;

      const opportunities = arbDetect.detect(cache.all(), kalshiMarkets);
      if (opportunities.length === 0) return;

      arbCount += opportunities.length;

      for (const opp of opportunities.slice(0, 5)) {
        log.info('🔀 Opportunité d\'arbitrage', {
          type:       opp.type,
          spread:     (opp.spread * 100).toFixed(2) + '%',
          cheapSide:  opp.cheapSide,
          pnl:        '+' + (opp.expectedPnl * 100).toFixed(2) + '¢/share',
          polyPrice:  opp.polyYesPrice,
          kalshiAsk:  opp.kalshiYesAsk,
          poly:       opp.polyQuestion.substring(0, 50),
          kalshi:     opp.kalshiTitle.substring(0, 50),
          confidence: (opp.matchScore * 100).toFixed(0) + '%',
        });
      }
    } catch (e: any) {
      log.error('Erreur scan arbitrage', { error: e.message });
    }
  };

  // ── Handler WebSocket CLOB : hot path <200ms ────────────────────
  clobWs.on('price_update', async (update: PriceUpdate) => {
    const { tokenId, price } = update;

    const market = cache.updatePrice(tokenId, price);
    if (!market) return;

    const cfg = strategy.config;
    if (price < cfg.yesMin || price > cfg.yesMax) return;
    if (!cache.canEvaluate(tokenId, DEBOUNCE_MS)) return;

    // Pour les marchés Crypto : valide le buffer avec prix Binance live
    if (market.domain === 'Crypto') {
      const { detectTicker, parseThreshold } = await import('./price/PriceFeed');
      const ticker    = detectTicker(market.question);
      const threshold = parseThreshold(market.question);
      if (ticker && threshold) {
        const livePrice = binanceWs.getPrice(ticker);
        if (livePrice !== null) {
          const buffer = livePrice - threshold;
          const minBuf = strategy.config.cryptoBufferUsd;
          if (buffer < minBuf) {
            log.debug(`WS crypto — buffer insuffisant`, {
              ticker, livePrice, threshold, buffer: buffer.toFixed(0),
            });
            return;
          }
        }
      }
    }

    const signal = strategy.buildSignalFromCache(market, price);
    if (!signal) return;

    wsSignalCount++;
    log.info('⚡ Signal WS', {
      domain:    signal.domain,
      question:  signal.question.substring(0, 60),
      livePrice: price,
      minsLeft:  signal.minsLeft,
    });

    try {
      await executor.processSignals([signal]);
    } catch (e: any) {
      log.error('Erreur traitement signal WS', { error: e.message });
    }
  });

  // ── BinanceWS : log quand les prix crypto arrivent ───────────────
  binanceWs.on('connected', () =>
    log.info('BinanceWS — connecté ✓', {
      tracking: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'].join(', '),
    }),
  );

  clobWs.on('connected', () =>
    log.info('ClobWS — connecté ✓', { subscriptions: clobWs.subscriptionCount }),
  );

  // ── Démarrage ────────────────────────────────────────────────────
  await rescan();          // Scan initial pour alimenter le cache

  clobWs.connect();        // WS Polymarket
  binanceWs.connect();     // WS Binance (prix crypto)

  const rescanInterval = setInterval(rescan,  RESCAN_INTERVAL_S * 1_000);
  const arbInterval    = setInterval(arbScan, ARB_INTERVAL_S    * 1_000);
  const purgeInterval  = setInterval(() => cache.purgeExpired(), PURGE_INTERVAL_S * 1_000);

  // Premier scan arb 30s après démarrage (laisser le temps au cache)
  setTimeout(arbScan, 30_000);

  // ── Arrêt propre ─────────────────────────────────────────────────
  const shutdown = (sig: string) => {
    log.info(`Signal ${sig} — arrêt propre...`);
    clearInterval(rescanInterval);
    clearInterval(arbInterval);
    clearInterval(purgeInterval);
    clobWs.destroy();
    binanceWs.destroy();

    const stats = executor.stats;
    if (DRY_RUN) {
      const wr = stats.paperResolved > 0
        ? ((stats.paperWins / stats.paperResolved) * 100).toFixed(1) + '%' : 'N/A';
      log.info('📊 Statistiques finales [PAPER TRADING]', {
        rescans:    rescanCount,
        wsSignals:  wsSignalCount,
        arbOpp:     arbCount,
        trades:     stats.paperTrades,
        resolved:   stats.paperResolved,
        wins:       stats.paperWins,
        losses:     stats.paperLosses,
        winRate:    wr,
        paperPnl:   (stats.paperPnl >= 0 ? '+' : '') + stats.paperPnl.toFixed(4) + ' USDC.e',
      });
    } else {
      log.info('📊 Statistiques finales', {
        rescans:   rescanCount,
        wsSignals: wsSignalCount,
        arbOpp:    arbCount,
        trades:    stats.tradeCount,
        totalLoss: stats.totalLoss.toFixed(2) + ' USDC.e',
      });
    }
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  console.error('❌ Erreur fatale :', e.message);
  process.exit(1);
});
