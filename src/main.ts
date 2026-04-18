/**
 * main.ts — Orchestrateur event-driven (Stack 1)
 *
 * Architecture :
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  Rescan HTTP (toutes les RESCAN_INTERVAL_S)      │
 *   │  → Trouve candidats 0.88-0.94                    │
 *   │  → Remplit MarketCache                           │
 *   │  → Abonne ClobWebSocket aux nouveaux tokenIds    │
 *   └──────────────────────┬───────────────────────────┘
 *                          │
 *   ┌──────────────────────▼───────────────────────────┐
 *   │  ClobWebSocket (temps réel, <200ms)              │
 *   │  price_update → MarketCache.updatePrice()        │
 *   │  Si prix dans [yesMin, yesMax] + debounce 5s     │
 *   │  → strategy.buildSignalFromCache()               │
 *   │  → executor.processSignals()   ← IMMÉDIAT        │
 *   └──────────────────────────────────────────────────┘
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { getLogger }           from './utils/logger';
import { PolymarketConnector } from './connectors/PolymarketConnector';
import { HighProbStrategy }    from './strategies/HighProbStrategy';
import { OrderExecutor }       from './executor/OrderExecutor';
import { ClobWebSocket }       from './feeds/ClobWebSocket';
import { MarketCache }         from './feeds/MarketCache';
import type { PriceUpdate }    from './feeds/ClobWebSocket';
import type { CachedMarket }   from './feeds/MarketCache';

const log = getLogger('Main');

// ── Config ────────────────────────────────────────────────────
const {
  PRIVATE_KEY, ALCHEMY_URL,
  CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE,
} = process.env;

if (!PRIVATE_KEY || !ALCHEMY_URL || !CLOB_API_KEY || !CLOB_SECRET || !CLOB_PASSPHRASE) {
  console.error('❌ Variables .env manquantes. Vérifie /root/polybot/.env');
  process.exit(1);
}

const RESCAN_INTERVAL_S = parseInt(process.env.RESCAN_INTERVAL_S  ?? '300',  10); // 5 min
const PURGE_INTERVAL_S  = parseInt(process.env.PURGE_INTERVAL_S   ?? '600',  10); // 10 min
const DEBOUNCE_MS       = parseInt(process.env.WS_DEBOUNCE_MS     ?? '5000', 10); // 5s anti-spam
const DRY_RUN           = process.env.DRY_RUN === 'true';
const LOG_LEVEL         = process.env.LOG_LEVEL ?? 'info';

async function main() {
  log.info('╔══════════════════════════════════════════════════════╗');
  log.info('║  🤖 POLYBOT v2 — Event-Driven Stack 1               ║');
  log.info(`║  Mode     : ${DRY_RUN ? 'PAPER TRADING (DRY-RUN)     ' : 'LIVE (ordres réels)          '}  ║`);
  log.info(`║  Rescan   : /${RESCAN_INTERVAL_S}s  |  Debounce WS : ${DEBOUNCE_MS}ms      ║`);
  log.info('╚══════════════════════════════════════════════════════╝');

  const creds = { key: CLOB_API_KEY!, secret: CLOB_SECRET!, passphrase: CLOB_PASSPHRASE! };

  // ── Instanciation ─────────────────────────────────────────────
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

  const cache  = new MarketCache();
  const clobWs = new ClobWebSocket(creds);

  // ── Connexion ─────────────────────────────────────────────────
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

  // ── Rescan HTTP : découverte de nouveaux marchés ───────────────
  let rescanCount = 0;
  let wsSignalCount = 0;

  const rescan = async () => {
    rescanCount++;
    const stats = executor.stats;

    if (DRY_RUN) {
      const wr = stats.paperResolved > 0
        ? ((stats.paperWins / stats.paperResolved) * 100).toFixed(1) + '%'
        : 'N/A';
      log.info(`🔄 Rescan #${rescanCount} [PAPER]`, {
        cached: cache.size,
        wsSignals: wsSignalCount,
        paperTrades: stats.paperTrades,
        paperPnl: (stats.paperPnl >= 0 ? '+' : '') + stats.paperPnl.toFixed(4) + ' USDC.e',
        winRate: wr,
      });
    } else {
      log.info(`🔄 Rescan #${rescanCount}`, {
        cached:    cache.size,
        wsSignals: wsSignalCount,
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

    // Ajoute les nouveaux marchés en cache et abonne le WS
    const newTokenIds: string[] = [];

    for (const sig of signals) {
      if (!cache.has(sig.conditionId)) {
        const cached: CachedMarket = {
          conditionId:  sig.conditionId,
          tokenId:      sig.tokenId,
          question:     sig.question,
          domain:       sig.domain,
          endDate:      new Date(Date.now() + sig.minsLeft * 60_000).toISOString(),
          liquidity:    sig.liquidity,
          validated:    true,
          lastPrice:    sig.yesPrice,
          lastUpdated:  Date.now(),
          reasoning:    sig.reasoning,
        };
        cache.set(cached);
        newTokenIds.push(sig.tokenId);
      }
    }

    if (newTokenIds.length > 0) {
      clobWs.subscribe(newTokenIds);
      log.info(`Rescan — ${newTokenIds.length} nouveau(x) marché(s) ajouté(s) au WS`, {
        total: cache.size,
        subscriptions: clobWs.subscriptionCount,
      });
    }
  };

  // ── Handler WebSocket : hot path <200ms ───────────────────────
  clobWs.on('price_update', async (update: PriceUpdate) => {
    const { tokenId, price } = update;

    // Met à jour le cache (toujours, même hors range)
    const market = cache.updatePrice(tokenId, price);
    if (!market) return;

    // Range filter
    const cfg = strategy.config;
    if (price < cfg.yesMin || price > cfg.yesMax) return;

    // Anti-spam : une évaluation max par marché par DEBOUNCE_MS
    if (!cache.canEvaluate(tokenId, DEBOUNCE_MS)) return;

    const signal = strategy.buildSignalFromCache(market, price);
    if (!signal) return;

    wsSignalCount++;
    log.info('⚡ Signal WS détecté', {
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

  clobWs.on('connected', () =>
    log.info('WebSocket CLOB — connecté', { subscriptions: clobWs.subscriptionCount }),
  );
  clobWs.on('disconnected', (code: number) =>
    log.warn('WebSocket CLOB — déconnecté', { code }),
  );

  // ── Démarrage ─────────────────────────────────────────────────
  // 1. Premier scan HTTP immédiat
  await rescan();

  // 2. Connexion WebSocket (après avoir les premiers tokenIds)
  clobWs.connect();

  // 3. Rescan périodique
  const rescanInterval = setInterval(rescan, RESCAN_INTERVAL_S * 1_000);

  // 4. Purge des marchés expirés
  const purgeInterval = setInterval(() => cache.purgeExpired(), PURGE_INTERVAL_S * 1_000);

  // ── Arrêt propre ──────────────────────────────────────────────
  const shutdown = (sig: string) => {
    log.info(`Signal ${sig} reçu — arrêt propre...`);
    clearInterval(rescanInterval);
    clearInterval(purgeInterval);
    clobWs.destroy();

    const stats = executor.stats;

    if (DRY_RUN) {
      const wr = stats.paperResolved > 0
        ? ((stats.paperWins / stats.paperResolved) * 100).toFixed(1) + '%'
        : 'N/A';
      log.info('📊 Statistiques finales [PAPER TRADING]', {
        rescans:       rescanCount,
        wsSignals:     wsSignalCount,
        trades:        stats.paperTrades,
        resolved:      stats.paperResolved,
        wins:          stats.paperWins,
        losses:        stats.paperLosses,
        winRate:       wr,
        paperPnl:      (stats.paperPnl >= 0 ? '+' : '') + stats.paperPnl.toFixed(4) + ' USDC.e',
      });
    } else {
      log.info('📊 Statistiques finales', {
        rescans:   rescanCount,
        wsSignals: wsSignalCount,
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
