/**
 * main.ts — Point d'entrée du système de trading modulaire
 *
 * Architecture :
 *   PolymarketConnector  →  connexion API + retry
 *   HighProbStrategy     →  détection signaux (scan)
 *   OrderExecutor        →  validation + placement ordres
 *   PriceFeed            →  prix BTC/ETH/SOL (Binance + CoinGecko)
 *   Logger (Winston)     →  logs structurés → /logs/
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { getLogger }          from './utils/logger';
import { PolymarketConnector } from './connectors/PolymarketConnector';
import { HighProbStrategy }   from './strategies/HighProbStrategy';
import { OrderExecutor }      from './executor/OrderExecutor';

const log = getLogger('Main');

// ── Config depuis .env ───────────────────────────────────────────
const {
  PRIVATE_KEY, ALCHEMY_URL,
  CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE,
} = process.env;

if (!PRIVATE_KEY || !ALCHEMY_URL || !CLOB_API_KEY || !CLOB_SECRET || !CLOB_PASSPHRASE) {
  console.error('❌ Variables .env manquantes. Vérifie /root/polybot/.env');
  process.exit(1);
}

// ── Paramètres runtime ───────────────────────────────────────────
const SCAN_INTERVAL_S = parseInt(process.env.SCAN_INTERVAL_S ?? '60', 10);
const DRY_RUN         = process.env.DRY_RUN === 'true';
const LOG_LEVEL       = process.env.LOG_LEVEL ?? 'info';

async function main() {
  log.info('╔══════════════════════════════════════════════════╗');
  log.info('║  🤖 POLYBOT — Système Modulaire de Trading       ║');
  log.info(`║  Mode       : ${DRY_RUN ? 'DRY-RUN (simulation)' : 'LIVE (ordres réels)  '}  ║`);
  log.info(`║  Log level  : ${LOG_LEVEL.padEnd(6)} | Scan : /${SCAN_INTERVAL_S}s          ║`);
  log.info('╚══════════════════════════════════════════════════╝');

  // ── 1. Instanciation ─────────────────────────────────────────
  const connector = new PolymarketConnector(
    PRIVATE_KEY!,
    ALCHEMY_URL!,
    { key: CLOB_API_KEY!, secret: CLOB_SECRET!, passphrase: CLOB_PASSPHRASE! },
  );

  const strategy = new HighProbStrategy(connector, {
    yesMin:          parseFloat(process.env.YES_MIN   ?? '0.88'),
    yesMax:          parseFloat(process.env.YES_MAX   ?? '0.94'),
    stakeUsdc:       parseFloat(process.env.STAKE_USDC ?? '0.80'),
    expiryMaxHours:  parseInt(process.env.EXPIRY_MAX_H ?? '48', 10),
    cryptoBufferUsd: parseInt(process.env.CRYPTO_BUFFER ?? '60', 10),
  });

  const executor = new OrderExecutor(connector, strategy, {
    maxOpenTrades: parseInt(process.env.MAX_TRADES ?? '3', 10),
    maxTotalLoss:  parseFloat(process.env.MAX_LOSS ?? '2.00'),
    dryRun:        DRY_RUN,
  });

  // ── 2. Connexion ─────────────────────────────────────────────
  try {
    await connector.connect();
  } catch (e: any) {
    log.error('Connexion échouée — arrêt', { error: e.message });
    process.exit(1);
  }

  // Affiche le solde initial
  try {
    const balance = await connector.getUsdcBalance();
    log.info('Solde USDC.e au démarrage', { balance: balance.toFixed(4) });
  } catch { /* non bloquant */ }

  // ── 3. Boucle principale ──────────────────────────────────────
  let scanCount = 0;

  const loop = async () => {
    if (executor.stopped) {
      log.warn('Bot arrêté (stop-loss). Relance manuelle requise.');
      process.exit(0);
    }

    scanCount++;
    const { tradeCount, openTrades, totalLoss } = executor.stats;
    log.info(`🔍 Scan #${scanCount}`, { openTrades, tradeCount, totalLoss: totalLoss.toFixed(2) });

    try {
      const signals = await strategy.scan();

      if (signals.length === 0) {
        log.info('Aucun signal — conditions non réunies, attente...');
      } else {
        log.info(`${signals.length} signal(s) trouvé(s)`, {
          domains: [...new Set(signals.map(s => s.domain))].join(', '),
        });
        await executor.processSignals(signals);
      }
    } catch (e: any) {
      log.error('Erreur dans la boucle', { error: e.message });
    }
  };

  // Premier scan immédiat puis intervalle
  await loop();
  const interval = setInterval(loop, SCAN_INTERVAL_S * 1_000);

  // ── Arrêt propre ──────────────────────────────────────────────
  const shutdown = (sig: string) => {
    log.info(`Signal ${sig} reçu — arrêt propre en cours...`);
    clearInterval(interval);
    const { tradeCount, totalLoss } = executor.stats;
    log.info('Statistiques finales', {
      scans:       scanCount,
      trades:      tradeCount,
      totalLoss:   totalLoss.toFixed(2) + ' USDC.e',
    });
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  console.error('❌ Erreur fatale :', e.message);
  process.exit(1);
});
