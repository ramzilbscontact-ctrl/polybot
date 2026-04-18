/**
 * main.ts — Orchestrateur Stack 2 + Monitoring
 *
 * Flux complet :
 *
 *  BinanceWebSocket ── prix crypto live ────────────────────────────┐
 *                                                                    │
 *  ClobWebSocket ── price_update ──→ CrossSignal? ──→ Executor ─────┘
 *                                                         │
 *  Rescan HTTP (5min) ──→ MarketCache ──→ subscribe WS   ├─ emit paper:opened  → Telegram
 *        │                                               ├─ emit paper:resolved → Telegram
 *        └──→ ManifoldConnector ──→ CrossSignalDetector  └─ emit stop-loss      → Telegram
 *
 *  NewsFeed RSS (60s) ──→ match ──→ rééval + Telegram
 *
 *  Dashboard HTTP ──→ GET / (HTML) · GET /stats (JSON)
 *  Telegram hourly P&L summary
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { getLogger }              from './utils/logger';
import { TelegramNotifier }       from './utils/TelegramNotifier';
import { PolymarketConnector }    from './connectors/PolymarketConnector';
import { ManifoldConnector }      from './connectors/ManifoldConnector';
import { HighProbStrategy }       from './strategies/HighProbStrategy';
import { OrderExecutor }          from './executor/OrderExecutor';
import { ClobWebSocket }          from './feeds/ClobWebSocket';
import { MarketCache }            from './feeds/MarketCache';
import { NewsFeed }               from './feeds/NewsFeed';
import { BinanceWebSocket }       from './price/BinanceWebSocket';
import { CrossSignalDetector }    from './arbitrage/CrossSignalDetector';
import { Dashboard, EventLog }    from './monitoring/Dashboard';
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

const RESCAN_INTERVAL_S   = parseInt(process.env.RESCAN_INTERVAL_S   ?? '300',  10);
const MANIFOLD_INTERVAL_S = parseInt(process.env.MANIFOLD_INTERVAL_S ?? '180',  10);
const PURGE_INTERVAL_S    = parseInt(process.env.PURGE_INTERVAL_S    ?? '600',  10);
const SUMMARY_INTERVAL_S  = parseInt(process.env.SUMMARY_INTERVAL_S  ?? '3600', 10);  // 1h
const DEBOUNCE_MS         = parseInt(process.env.WS_DEBOUNCE_MS      ?? '5000', 10);
const DRY_RUN             = process.env.DRY_RUN === 'true';

async function main() {
  const mode = DRY_RUN ? 'PAPER TRADING' : 'LIVE';

  log.info('╔══════════════════════════════════════════════════════════╗');
  log.info('║  🤖 POLYBOT v2 — WS + Manifold + News + Dashboard      ║');
  log.info(`║  Mode : ${mode.padEnd(49)}║`);
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
    maxOpenTrades: parseInt(process.env.MAX_TRADES ?? '3', 10),
    maxTotalLoss:  parseFloat(process.env.MAX_LOSS  ?? '2.00'),
    dryRun:        DRY_RUN,
  });

  const cache       = new MarketCache();
  const clobWs      = new ClobWebSocket(creds);
  const binanceWs   = new BinanceWebSocket();
  const manifold    = new ManifoldConnector();
  const crossSignal = new CrossSignalDetector();
  const newsFeed    = new NewsFeed();
  const telegram    = new TelegramNotifier();
  const eventLog    = new EventLog(60);
  const dashboard   = new Dashboard();

  const startedAt = new Date().toISOString();

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

  // ── Compteurs ─────────────────────────────────────────────────────
  let rescanCount    = 0;
  let wsSignalCount  = 0;
  let newsHitCount   = 0;
  let confirmedCount = 0;

  const cfg  = strategy.config;
  const mcfg = executor.stats; // référence live

  // ── Helper uptime ────────────────────────────────────────────────
  const uptimeStr = () => {
    const s = Math.floor(process.uptime());
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`;
  };

  // ── Stats pour dashboard ─────────────────────────────────────────
  const getStats = () => {
    const st  = executor.stats;
    const wr  = st.paperResolved > 0
      ? ((st.paperWins / st.paperResolved) * 100).toFixed(1) + '%' : 'N/A';
    const pnl = st.paperPnl;

    return {
      mode,
      uptime:        uptimeStr(),
      startedAt,
      cachedMarkets: cache.size,
      subscriptions: clobWs.subscriptionCount,
      wsSignals:     wsSignalCount,
      newsHits:      newsHitCount,
      manifoldConf:  confirmedCount,
      rescans:       rescanCount,
      paperTrades:   st.paperTrades,
      paperResolved: st.paperResolved,
      paperWins:     st.paperWins,
      paperLosses:   st.paperLosses,
      paperWinRate:  wr,
      paperPnl:      pnl,
      paperPnlStr:   (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' USDC.e',
      binancePrices: Object.fromEntries(
        binanceWs.all().map(q => [q.ticker, q.mid]),
      ),
      recentEvents:  eventLog.entries,
    };
  };

  // ── Notifications Executor → Telegram + EventLog ─────────────────
  executor.on('paper:opened', (d: any) => {
    eventLog.push('signal',
      `[${d.domain}] ${d.question.substring(0, 60)} @ ${d.entryPrice} — ${d.minsLeft}min`);
    telegram.notifyPaperOpened(d).catch(() => {});
  });

  executor.on('paper:resolved', (d: any) => {
    const type = d.won ? 'win' : 'loss';
    const pnlStr = (d.pnl >= 0 ? '+' : '') + d.pnl.toFixed(4);
    eventLog.push(type,
      `${d.won ? '✅' : '❌'} ${d.question.substring(0, 60)} → ${pnlStr} USDC.e`);
    telegram.notifyPaperResolved(d).catch(() => {});
  });

  executor.on('stop-loss', (d: any) => {
    eventLog.push('system', `🛑 STOP-LOSS atteint — ${d.totalLoss.toFixed(4)} USDC.e`);
    telegram.notifyStopLoss(d).catch(() => {});
  });

  // ── Rescan HTTP Polymarket ───────────────────────────────────────
  const rescan = async () => {
    rescanCount++;
    const st = executor.stats;

    if (DRY_RUN) {
      const wr = st.paperResolved > 0
        ? ((st.paperWins / st.paperResolved) * 100).toFixed(1) + '%' : 'N/A';
      log.info(`🔄 Rescan #${rescanCount} [PAPER]`, {
        cached: cache.size, wsSignals: wsSignalCount,
        newsHits: newsHitCount, confirmed: confirmedCount,
        paperTrades: st.paperTrades,
        pnl: (st.paperPnl >= 0 ? '+' : '') + st.paperPnl.toFixed(4) + ' USDC.e',
        winRate: wr,
      });
    } else {
      log.info(`🔄 Rescan #${rescanCount}`, {
        cached: cache.size, wsSignals: wsSignalCount,
        trades: st.tradeCount, loss: st.totalLoss.toFixed(2),
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
      eventLog.push('system',
        `Rescan #${rescanCount} — ${newTokenIds.length} nouveau(x) marché(s), cache=${cache.size}`);
      log.info(`Rescan — ${newTokenIds.length} nouveau(x)`, {
        total: cache.size, subs: clobWs.subscriptionCount,
      });
    }
  };

  // ── Validation croisée Manifold ──────────────────────────────────
  const manifoldScan = async () => {
    if (cache.size === 0) return;
    try {
      const mMarkets = await manifold.getOpenBinaryMarkets();
      if (!mMarkets.length) return;

      const results   = crossSignal.analyze(cache.all(), mMarkets);
      const confirmed = results.filter(r => r.confidence === 'CONFIRMED');
      confirmedCount += confirmed.length;

      for (const r of confirmed) {
        eventLog.push('manifold',
          `Manifold +${((r.delta ?? 0) * 100).toFixed(1)}% — ${r.polyQuestion.substring(0, 55)}`);
        if (r.delta !== null && r.manifoldProba !== null) {
          telegram.notifyManifoldConfirmed({
            question:     r.polyQuestion,
            polyPrice:    r.polyPrice,
            manifoldProba:r.manifoldProba,
            delta:        r.delta,
          }).catch(() => {});
        }
      }

      if (confirmed.length > 0) {
        log.info('🧭 Manifold', {
          confirmed: confirmed.length,
          divergent: results.filter(r => r.confidence === 'DIVERGENT').length,
        });
      }
    } catch (e: any) {
      log.error('Erreur Manifold scan', { error: e.message });
    }
  };

  // ── Helper : exécuter un signal ──────────────────────────────────
  const executeIfValid = async (market: CachedMarket, price: number, source: string) => {
    const signal = strategy.buildSignalFromCache(market, price);
    if (!signal) return;

    const confidence = crossSignal.getConfidence(market.conditionId);
    if (confidence === 'DIVERGENT') {
      log.warn(`Signal ${source} ignoré — Manifold divergent`, {
        question: signal.question.substring(0, 60),
      });
      return;
    }

    const tag = confidence === 'CONFIRMED' ? '⚡✅' : '⚡';
    log.info(`${tag} Signal ${source}${confidence === 'CONFIRMED' ? ' [CONFIRMÉ]' : ''}`, {
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

    if (price < cfg.yesMin || price > cfg.yesMax) return;
    if (!cache.canEvaluate(tokenId, DEBOUNCE_MS)) return;

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

    eventLog.push('news',
      `[${nm.item.source}] ${nm.item.title.substring(0, 70)}`);

    telegram.notifyNewsHit({
      headline: nm.item.title,
      source:   nm.item.source,
      market:   market.question,
      score:    nm.score,
    }).catch(() => {});

    log.info('📰 News trigger', {
      headline: nm.item.title.substring(0, 70),
      market:   market.question.substring(0, 60),
    });
    await executeIfValid(market, market.lastPrice, 'NEWS');
  });

  // ── Events connexion ─────────────────────────────────────────────
  clobWs.on('connected', () => {
    eventLog.push('system', `ClobWS connecté — ${clobWs.subscriptionCount} abonnements`);
    log.info('ClobWS ✓', { subs: clobWs.subscriptionCount });
  });
  clobWs.on('disconnected', (c: number) => {
    eventLog.push('system', `ClobWS déconnecté (code ${c})`);
    log.warn('ClobWS ✗', { code: c });
  });
  binanceWs.on('connected', () => {
    eventLog.push('system', 'BinanceWS connecté — BTC/ETH/SOL/XRP/DOGE');
    log.info('BinanceWS ✓');
  });

  // ── Résumé P&L horaire via Telegram ──────────────────────────────
  const sendPnlSummary = () => {
    const st = executor.stats;
    telegram.notifyPnlSummary({
      trades:    st.paperTrades,
      resolved:  st.paperResolved,
      wins:      st.paperWins,
      losses:    st.paperLosses,
      pnl:       st.paperPnl,
      wsSignals: wsSignalCount,
      newsHits:  newsHitCount,
      uptime:    uptimeStr(),
    }).catch(() => {});
  };

  // ── Notification de démarrage ─────────────────────────────────────
  telegram.notifyStartup({
    mode,
    yesMin:    cfg.yesMin,
    yesMax:    cfg.yesMax,
    stake:     cfg.stakeUsdc,
    maxTrades: parseInt(process.env.MAX_TRADES ?? '3', 10),
    maxLoss:   parseFloat(process.env.MAX_LOSS  ?? '2.00'),
  }).catch(() => {});

  eventLog.push('system', `Bot démarré — mode ${mode}`);

  // ── Démarrage ─────────────────────────────────────────────────────
  await rescan();
  clobWs.connect();
  binanceWs.connect();
  newsFeed.start(() => cache.all());
  dashboard.start(getStats);

  const rescanInterval   = setInterval(rescan,       RESCAN_INTERVAL_S   * 1_000);
  const manifoldInterval = setInterval(manifoldScan, MANIFOLD_INTERVAL_S * 1_000);
  const purgeInterval    = setInterval(() => cache.purgeExpired(), PURGE_INTERVAL_S * 1_000);
  const summaryInterval  = setInterval(sendPnlSummary, SUMMARY_INTERVAL_S * 1_000);

  setTimeout(manifoldScan, 45_000);

  // ── Arrêt propre ──────────────────────────────────────────────────
  const shutdown = (sig: string) => {
    log.info(`${sig} — arrêt propre...`);
    [rescanInterval, manifoldInterval, purgeInterval, summaryInterval]
      .forEach(clearInterval);
    clobWs.destroy();
    binanceWs.destroy();
    newsFeed.stop();
    dashboard.stop();

    const st = executor.stats;
    const wr = st.paperResolved > 0
      ? ((st.paperWins / st.paperResolved) * 100).toFixed(1) + '%' : 'N/A';
    const pnl = (st.paperPnl >= 0 ? '+' : '') + st.paperPnl.toFixed(4);

    if (DRY_RUN) {
      log.info('📊 Bilan final [PAPER]', {
        rescans: rescanCount, wsSignals: wsSignalCount,
        newsHits: newsHitCount, manifoldConf: confirmedCount,
        trades: st.paperTrades, resolved: st.paperResolved,
        wins: st.paperWins, losses: st.paperLosses,
        winRate: wr, pnl: pnl + ' USDC.e',
      });
      sendPnlSummary();
    } else {
      log.info('📊 Bilan final', {
        rescans: rescanCount, wsSignals: wsSignalCount,
        trades: st.tradeCount, totalLoss: st.totalLoss.toFixed(2) + ' USDC.e',
      });
    }
    setTimeout(() => process.exit(0), 2_000); // laisse Telegram envoyer
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => { console.error('❌ Erreur fatale :', e.message); process.exit(1); });
