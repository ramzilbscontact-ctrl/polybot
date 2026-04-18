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
import { EventEmitter }           from 'events';
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

// ── Position paper trading ────────────────────────────────────────
interface PaperTrade {
  tradeId:    string;
  conditionId:string;
  question:   string;
  domain:     string;
  entryPrice: number;
  shares:     number;
  stake:      number;
  entryTime:  number;
  expiryMs:   number;   // timestamp absolu d'expiry
  resolved:   boolean;
  won:        boolean | null;
  pnl:        number | null;
}

export class OrderExecutor extends EventEmitter {
  private readonly cfg: ExecutorConfig;
  private openTrades   = 0;
  private totalLoss    = 0;
  private tradeCount   = 0;
  private cancelCount  = 0;
  public  stopped      = false;

  // Paper trading P&L
  private paperTrades:  PaperTrade[] = [];
  private paperPnl      = 0;
  private paperWins     = 0;
  private paperLosses   = 0;

  constructor(
    private readonly connector: PolymarketConnector,
    private readonly strategy:  HighProbStrategy,
    config: Partial<ExecutorConfig> = {}
  ) {
    super();
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
      this.emit('stop-loss', { totalLoss: this.totalLoss, maxLoss: this.cfg.maxTotalLoss });
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

    // ── Paper Trading ────────────────────────────────────────
    if (this.cfg.dryRun) {
      const paperTrade: PaperTrade = {
        tradeId,
        conditionId: signal.conditionId,
        question:    signal.question,
        domain,
        entryPrice:  yesPrice,
        shares,
        stake:       stakeUsdc,
        entryTime:   Date.now(),
        expiryMs:    Date.now() + minsLeft * 60_000,
        resolved:    false,
        won:         null,
        pnl:         null,
      };

      this.paperTrades.push(paperTrade);
      this.openTrades++;
      this.strategy.markFired(signal.conditionId);

      const potentialWin = ((1 - yesPrice) * shares).toFixed(4);
      this.emit('paper:opened', {
        tradeId, domain, question: signal.question,
        entryPrice: yesPrice, shares, stake: stakeUsdc,
        minsLeft, potentialWin: parseFloat(potentialWin),
      });
      log.info(`Trade ${tradeId} [PAPER] — 📋 Position ouverte`, {
        domain,
        question:     label,
        entryPrice:   yesPrice,
        shares:       shares.toFixed(4),
        stake:        stakeUsdc.toFixed(4) + ' USDC.e',
        expiresIn:    `${minsLeft} min`,
        potentialWin: '+' + potentialWin + ' USDC.e',
        paperPnl:     (this.paperPnl >= 0 ? '+' : '') + this.paperPnl.toFixed(4) + ' USDC.e',
      });

      this.schedulePaperResolution(paperTrade, minsLeft);
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
      const reason = (outcome as { ok: false; reason: string }).reason;
      log.warn(`Trade ${tradeId} — ❌ NON REMPLI — ${reason}`, {
        orderId, question: label,
      });
      this.cancelCount++;
      // On ne comptabilise PAS dans totalLoss : l'ordre a été annulé,
      // aucun USDC n'a été dépensé
    }
  }

  // ── Résolution asynchrone d'un paper trade ───────────────────
  private schedulePaperResolution(trade: PaperTrade, minsLeft: number): void {
    const CHECK_INTERVAL_MS = 5 * 60_000;    // retry toutes les 5 min
    const MAX_WAIT_EXTRA_MS = 2 * 3_600_000; // abandon 2h après expiry

    const attempt = async (extraWaitedMs: number) => {
      const result = await this.connector.getMarketResolution(trade.conditionId);

      if (result === 'pending' || result === 'error') {
        if (extraWaitedMs >= MAX_WAIT_EXTRA_MS) {
          log.warn(`Trade ${trade.tradeId} [PAPER] — ⚠️  Résolution introuvable après 2h`, {
            question: trade.question.substring(0, 60),
          });
          this.openTrades = Math.max(0, this.openTrades - 1);
          return;
        }
        setTimeout(() => attempt(extraWaitedMs + CHECK_INTERVAL_MS), CHECK_INTERVAL_MS);
        return;
      }

      const won = result === 'yes';
      const pnl = won
        ? parseFloat(((1 - trade.entryPrice) * trade.shares).toFixed(4))
        : -trade.stake;

      trade.resolved = true;
      trade.won      = won;
      trade.pnl      = pnl;
      this.paperPnl += pnl;
      if (won) this.paperWins++; else this.paperLosses++;
      this.openTrades = Math.max(0, this.openTrades - 1);
      this.emit('paper:resolved', {
        tradeId:    trade.tradeId,
        won,        domain: trade.domain,
        question:   trade.question,
        entryPrice: trade.entryPrice,
        pnl,
        totalPnl:   this.paperPnl,
        wins:       this.paperWins,
        losses:     this.paperLosses,
      });

      const resolved = this.paperTrades.filter(t => t.resolved).length;
      const winRate  = resolved > 0
        ? ((this.paperWins / resolved) * 100).toFixed(1) + '%'
        : 'N/A';

      log.info(`Trade ${trade.tradeId} [PAPER] — ${won ? '✅ WIN' : '❌ LOSS'}`, {
        question:     trade.question.substring(0, 60),
        domain:       trade.domain,
        entryPrice:   trade.entryPrice,
        outcome:      result.toUpperCase(),
        pnl:          (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' USDC.e',
        totalPaperPnl:(this.paperPnl >= 0 ? '+' : '') + this.paperPnl.toFixed(4) + ' USDC.e',
        wins:         this.paperWins,
        losses:       this.paperLosses,
        winRate,
      });
    };

    // Premier check : expiry + 30s de buffer pour lag API
    const delay = minsLeft * 60_000 + 30_000;
    setTimeout(() => attempt(0), delay);
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
    const paperResolved = this.paperTrades.filter(t => t.resolved).length;
    return {
      tradeCount:    this.tradeCount,
      openTrades:    this.openTrades,
      cancelCount:   this.cancelCount,
      totalLoss:     this.totalLoss,
      stopped:       this.stopped,
      // Paper trading P&L
      paperTrades:   this.paperTrades.length,
      paperResolved,
      paperWins:     this.paperWins,
      paperLosses:   this.paperLosses,
      paperPnl:      this.paperPnl,
    };
  }
}
