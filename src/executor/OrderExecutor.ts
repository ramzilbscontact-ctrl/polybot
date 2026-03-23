/**
 * OrderExecutor.ts — Garde-fou et exécution des ordres
 * Responsabilités :
 *   - Vérifier le solde avant chaque trade
 *   - Appliquer les limites (max trades simultanés, stop-loss global)
 *   - Déléguer le placement à PolymarketConnector
 *   - Logger chaque trade dans les fichiers de logs
 */
import { getLogger }           from '../utils/logger';
import type { PolymarketConnector } from '../connectors/PolymarketConnector';
import type { HighProbStrategy, MarketSignal } from '../strategies/HighProbStrategy';

const log = getLogger('Executor');

export interface ExecutorConfig {
  maxOpenTrades: number;   // Trades simultanés max
  maxTotalLoss:  number;   // Stop-loss global (USDC.e perdus)
  dryRun:        boolean;  // Si true : simule sans passer d'ordre réel
}

export const DEFAULT_EXECUTOR: ExecutorConfig = {
  maxOpenTrades: 3,
  maxTotalLoss:  2.00,
  dryRun:        false,
};

export class OrderExecutor {
  private readonly cfg: ExecutorConfig;
  private openTrades  = 0;
  private totalLoss   = 0;
  private tradeCount  = 0;
  public  stopped     = false;

  constructor(
    private readonly connector: PolymarketConnector,
    private readonly strategy:  HighProbStrategy,
    config: Partial<ExecutorConfig> = {}
  ) {
    this.cfg = { ...DEFAULT_EXECUTOR, ...config };
    if (this.cfg.dryRun) log.warn('Mode DRY-RUN actif — aucun ordre réel ne sera passé');
  }

  // ── Point d'entrée : traite les signaux d'un scan ────────────
  async processSignals(signals: MarketSignal[]): Promise<void> {
    if (this.stopped) {
      log.warn('Executor arrêté (stop-loss atteint)');
      return;
    }

    for (const signal of signals) {
      if (this.stopped) break;
      if (this.openTrades >= this.cfg.maxOpenTrades) {
        log.info('Max trades simultanés atteint', {
          open: this.openTrades, max: this.cfg.maxOpenTrades,
        });
        break;
      }
      await this.execute(signal);
    }
  }

  // ── Exécution d'un signal ────────────────────────────────────
  private async execute(signal: MarketSignal): Promise<void> {
    const { question, domain, yesPrice, tokenId, stakeUsdc, shares, minsLeft } = signal;
    const tradeId = `#${++this.tradeCount}`;

    log.info(`Trade ${tradeId} — Analyse`, {
      domain,
      question: question.substring(0, 65),
      yesPrice,
      stake:    stakeUsdc,
      shares,
      minsLeft,
    });

    // ── Guard 1 : solde suffisant ────────────────────────────
    let balance: number;
    try {
      balance = await this.connector.getUsdcBalance();
    } catch (e: any) {
      log.error(`Trade ${tradeId} — Impossible de lire le solde`, { error: e.message });
      return;
    }

    if (balance < stakeUsdc) {
      log.warn(`Trade ${tradeId} — Solde insuffisant`, { balance, required: stakeUsdc });
      return;
    }

    // ── Guard 2 : stop-loss global ───────────────────────────
    if (this.totalLoss >= this.cfg.maxTotalLoss) {
      log.warn(`Trade ${tradeId} — Stop-loss global atteint`, {
        totalLoss: this.totalLoss, max: this.cfg.maxTotalLoss,
      });
      this.stopped = true;
      return;
    }

    // ── Dry-run ─────────────────────────────────────────────
    if (this.cfg.dryRun) {
      log.info(`Trade ${tradeId} [DRY-RUN] — Ordre simulé`, {
        question: question.substring(0, 50),
        yesPrice, shares, stakeUsdc,
      });
      this.strategy.markFired(signal.conditionId);
      return;
    }

    // ── Placement réel ──────────────────────────────────────
    try {
      const result = await this.connector.placeOrder({
        tokenId,
        price: yesPrice,
        size:  shares,
        side:  'BUY',
      });

      log.info(`Trade ${tradeId} — ✅ Ordre accepté`, {
        orderId:  result.orderId,
        status:   result.status,
        question: question.substring(0, 50),
        domain,
        cost:     (shares * yesPrice).toFixed(4) + ' USDC.e',
      });

      this.strategy.markFired(signal.conditionId);
      this.openTrades++;

      // Décrémente openTrades à l'expiration estimée
      setTimeout(() => {
        this.openTrades = Math.max(0, this.openTrades - 1);
        log.info(`Trade ${tradeId} — Expiré`, { question: question.substring(0, 50) });
      }, minsLeft * 60_000 + 10_000);

    } catch (e: any) {
      const cost = parseFloat((shares * yesPrice).toFixed(4));
      this.totalLoss += cost;
      log.error(`Trade ${tradeId} — ❌ Ordre refusé`, {
        error:      e.message?.split('\n')[0],
        totalLoss:  this.totalLoss.toFixed(2),
        stopLossAt: this.cfg.maxTotalLoss,
      });

      if (this.totalLoss >= this.cfg.maxTotalLoss) {
        log.warn('🔴 STOP-LOSS GLOBAL ATTEINT — Bot suspendu');
        this.stopped = true;
      }
    }
  }

  get stats() {
    return {
      tradeCount: this.tradeCount,
      openTrades: this.openTrades,
      totalLoss:  this.totalLoss,
      stopped:    this.stopped,
    };
  }
}
