/**
 * OrderExecutor.ts — Exécution des ordres avec protection Anti-Slippage
 *
 * Flux d'exécution :
 *
 *   Signal reçu
 *     │
 *     ├─ Guard 1 : Solde USDC.e suffisant ?
 *     ├─ Guard 2 : Stop-loss global atteint ?
 *     ├─ Guard 3 : Anti-slippage — re-vérifie le bestAsk live
 *     │               Si drift > maxSlippagePct → ANNULÉ (prix a bougé)
 *     │
 *     ├─ Placement Limit Order GTC au prix exact du scan
 *     │
 *     └─ Watchdog 5s
 *           ├─ Ordre rempli (matched)  → ✅ succès
 *           ├─ Ordre en attente (live) → ❌ cancelOrder() + log slippage
 *           └─ Ordre déjà annulé       → log + on passe
 */
import { getLogger }             from '../utils/logger';
import type { PolymarketConnector } from '../connectors/PolymarketConnector';
import type { HighProbStrategy, MarketSignal } from '../strategies/HighProbStrategy';

const log = getLogger('Executor');

// ── Configuration ─────────────────────────────────────────────────
export interface ExecutorConfig {
  maxOpenTrades:       number;  // Trades simultanés max
  maxTotalLoss:        number;  // Stop-loss global (USDC.e)
  dryRun:              boolean; // Simulation sans ordres réels
  maxSlippagePct:      number;  // Glissement prix max accepté (ex: 0.02 = 2%)
  limitOrderTimeoutMs: number;  // Délai avant annulation si non rempli (ms)
  pollIntervalMs:      number;  // Fréquence de polling du statut d'ordre (ms)
}

export const DEFAULT_EXECUTOR: ExecutorConfig = {
  maxOpenTrades:       3,
  maxTotalLoss:        2.00,
  dryRun:              false,
  maxSlippagePct:      0.02,    // 2% de tolérance
  limitOrderTimeoutMs: 5_000,   // Annulation après 5 secondes
  pollIntervalMs:      800,     // Polling toutes les 800ms
};

// ── Résultat interne d'un trade ───────────────────────────────────
type TradeOutcome =
  | { ok: true;  orderId: string; fillPrice: number }
  | { ok: false; reason: string };

export class OrderExecutor {
  private readonly cfg: ExecutorConfig;
  private openTrades  = 0;
  private totalLoss   = 0;
  private tradeCount  = 0;
  private cancelCount = 0;
  public  stopped     = false;

  constructor(
    private readonly connector: PolymarketConnector,
    private readonly strategy:  HighProbStrategy,
    config: Partial<ExecutorConfig> = {}
  ) {
    this.cfg = { ...DEFAULT_EXECUTOR, ...config };

    log.info('OrderExecutor initialisé', {
      maxSlippage:  `${(this.cfg.maxSlippagePct * 100).toFixed(1)}%`,
      orderTimeout: `${this.cfg.limitOrderTimeoutMs / 1000}s`,
      stopLoss:     `${this.cfg.maxTotalLoss} USDC.e`,
      dryRun:       this.cfg.dryRun,
    });

    if (this.cfg.dryRun)
      log.warn('⚠️  Mode DRY-RUN — aucun ordre réel ne sera passé');
  }

  // ── Point d'entrée ────────────────────────────────────────────
  async processSignals(signals: MarketSignal[]): Promise<void> {
    if (this.stopped) {
      log.warn('Executor suspendu (stop-loss global atteint)');
      return;
    }

    for (const signal of signals) {
      if (this.stopped) break;
      if (this.openTrades >= this.cfg.maxOpenTrades) {
        log.info('Plafond trades simultanés atteint', {
          open: this.openTrades, max: this.cfg.maxOpenTrades,
        });
        break;
      }
      await this.execute(signal);
    }
  }

  // ── Exécution d'un signal ─────────────────────────────────────
  private async execute(signal: MarketSignal): Promise<void> {
    const { question, domain, yesPrice, tokenId, stakeUsdc, shares, minsLeft } = signal;
    const tradeId = `#${++this.tradeCount}`;
    const label   = question.substring(0, 60);

    log.info(`Trade ${tradeId} — Analyse`, {
      domain, question: label, scanPrice: yesPrice, stake: stakeUsdc, shares, minsLeft,
    });

    // ── Guard 1 : Solde ──────────────────────────────────────
    let balance: number;
    try {
      balance = await this.connector.getUsdcBalance();
    } catch (e: any) {
      log.error(`Trade ${tradeId} — Lecture solde impossible`, { error: e.message });
      return;
    }
    if (balance < stakeUsdc) {
      log.warn(`Trade ${tradeId} — Solde insuffisant`, {
        balance: balance.toFixed(4), required: stakeUsdc,
      });
      return;
    }

    // ── Guard 2 : Stop-loss global ───────────────────────────
    if (this.totalLoss >= this.cfg.maxTotalLoss) {
      log.warn(`Trade ${tradeId} — Stop-loss global atteint`, {
        totalLoss: this.totalLoss, max: this.cfg.maxTotalLoss,
      });
      this.stopped = true;
      return;
    }

    // ── Guard 3 : Anti-slippage ──────────────────────────────
    //    Re-vérifie le bestAsk live juste avant de passer l'ordre.
    //    Si le marché a bougé au-delà du seuil, on n'entre pas.
    if (!this.cfg.dryRun) {
      const liveAsk = await this.connector.getLiveBestAsk(tokenId);

      if (liveAsk === null) {
        log.warn(`Trade ${tradeId} — BestAsk live indisponible, ordre annulé par précaution`, {
          question: label,
        });
        return;
      }

      const drift    = liveAsk - yesPrice;          // positif = prix a monté
      const driftPct = Math.abs(drift) / yesPrice;

      if (driftPct > this.cfg.maxSlippagePct) {
        log.warn(`Trade ${tradeId} — ⛔ SLIPPAGE DÉTECTÉ — ordre ignoré`, {
          scanPrice:  yesPrice,
          liveAsk,
          drift:      `${drift >= 0 ? '+' : ''}${drift.toFixed(4)}`,
          driftPct:   `${(driftPct * 100).toFixed(2)}%`,
          threshold:  `${(this.cfg.maxSlippagePct * 100).toFixed(1)}%`,
          question:   label,
        });
        return;
      }

      log.info(`Trade ${tradeId} — Slippage OK`, {
        scanPrice: yesPrice,
        liveAsk,
        drift:     `${drift >= 0 ? '+' : ''}${(driftPct * 100).toFixed(2)}%`,
      });
    }

    // ── Dry-run ──────────────────────────────────────────────
    if (this.cfg.dryRun) {
      log.info(`Trade ${tradeId} [DRY-RUN] — Limit order simulé`, {
        question: label, price: yesPrice, shares, timeout: `${this.cfg.limitOrderTimeoutMs / 1000}s`,
      });
      this.strategy.markFired(signal.conditionId);
      return;
    }

    // ── Placement du Limit Order ─────────────────────────────
    let orderId: string;
    try {
      const result = await this.connector.placeOrder({
        tokenId,
        price: yesPrice,   // Prix exact du scan → Limit Order
        size:  shares,
        side:  'BUY',
      });
      orderId = result.orderId;
      log.info(`Trade ${tradeId} — 📋 Limit order soumis`, {
        orderId,
        price:   yesPrice,
        shares,
        timeout: `${this.cfg.limitOrderTimeoutMs / 1000}s`,
        question: label,
      });
    } catch (e: any) {
      log.error(`Trade ${tradeId} — Impossible de soumettre l'ordre`, {
        error: e.message?.split('\n')[0],
      });
      return;
    }

    // ── Watchdog : surveille le fill pendant limitOrderTimeoutMs ─
    const outcome = await this.watchOrder(tradeId, orderId, yesPrice);

    if (outcome.ok) {
      // ✅ Ordre rempli
      log.info(`Trade ${tradeId} — ✅ REMPLI`, {
        orderId,
        fillPrice: outcome.fillPrice,
        cost:      (shares * outcome.fillPrice).toFixed(4) + ' USDC.e',
        question:  label,
        domain,
      });

      this.strategy.markFired(signal.conditionId);
      this.openTrades++;

      // Décrémente à l'expiration du marché
      setTimeout(() => {
        this.openTrades = Math.max(0, this.openTrades - 1);
        log.info(`Trade ${tradeId} — Marché expiré`, { question: label });
      }, minsLeft * 60_000 + 10_000);

    } else {
      // ❌ Ordre non rempli → annulation déjà faite dans watchOrder
      log.warn(`Trade ${tradeId} — ❌ NON REMPLI — ${outcome.reason}`, {
        orderId, question: label,
      });
      this.cancelCount++;
      // On ne comptabilise PAS dans totalLoss : l'ordre a été annulé,
      // aucun USDC n'a été dépensé
    }
  }

  // ── Watchdog : polling + annulation si non rempli ─────────────
  private async watchOrder(
    tradeId: string,
    orderId: string,
    scanPrice: number,
  ): Promise<{ ok: true; fillPrice: number } | { ok: false; reason: string }> {

    const deadline = Date.now() + this.cfg.limitOrderTimeoutMs;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, this.cfg.pollIntervalMs));

      const status = await this.connector.getOrderStatus(orderId);

      log.debug(`Trade ${tradeId} — Statut ordre`, { orderId, status });

      if (status === 'matched') {
        return { ok: true, fillPrice: scanPrice };
      }

      if (status === 'cancelled') {
        return { ok: false, reason: 'Annulé par le CLOB avant le watchdog' };
      }
      // 'live' → on continue à attendre
    }

    // ── Timeout atteint : on annule ──────────────────────────
    log.warn(`Trade ${tradeId} — ⏱️  Timeout ${this.cfg.limitOrderTimeoutMs / 1000}s atteint — annulation en cours`, {
      orderId,
    });

    const cancelled = await this.connector.cancelOrder(orderId);

    if (cancelled) {
      return {
        ok:     false,
        reason: `Timeout ${this.cfg.limitOrderTimeoutMs / 1000}s — ordre annulé (prix ${scanPrice} non atteint)`,
      };
    } else {
      // L'annulation elle-même a échoué → peut-être rempli entre-temps
      const finalStatus = await this.connector.getOrderStatus(orderId);
      if (finalStatus === 'matched')
        return { ok: true, fillPrice: scanPrice };

      return {
        ok:     false,
        reason: `Timeout + échec annulation (statut final: ${finalStatus})`,
      };
    }
  }

  // ── Stats ─────────────────────────────────────────────────────
  get stats() {
    return {
      tradeCount:  this.tradeCount,
      openTrades:  this.openTrades,
      cancelCount: this.cancelCount,
      totalLoss:   this.totalLoss,
      stopped:     this.stopped,
    };
  }
}
