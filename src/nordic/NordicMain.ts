/**
 * NordicMain.ts — Orchestrateur Nordic HFT (Stat-Arb Lead-Lag)
 *
 * Architecture :
 *
 *   IBKRConnector (WS streaming)
 *       │
 *       ├─ quote index  → PriceSeries (OMXH25 / OMXS30)
 *       └─ quote stock  → StatArbStrategy.onQuote()
 *                              │
 *                         signal? ─── Guard risque ──→ placeOrder (LMT IOC)
 *                                                            │
 *                                                     openPositions
 *                                                            │
 *                                               Monitor (500ms)
 *                                                  ├─ z-reversion → close (MKT)
 *                                                  └─ timeout 30s → close (MKT)
 *
 * Edge géographique :
 *   Serveur Helsinki → Nasdaq Helsinki : ~1ms
 *   Concurrents EU   : 5–20ms de retard
 *   Concurrents US   : 80–150ms de retard
 *   → Fenêtre d'opportunité capturée avant tout le monde
 *
 * Variables .env requises :
 *   IBKR_GATEWAY_URL=https://localhost:5000
 *   IBKR_ACCOUNT_ID=DUxxxxxxx
 *   IBKR_DRY_RUN=true          (paper trading par défaut)
 *
 * Variables .env optionnelles :
 *   NORDIC_STAKE_EUR=500        Mise par position (€)
 *   NORDIC_MAX_POSITIONS=3      Positions simultanées max
 *   NORDIC_MAX_DRAWDOWN=1000    Stop-loss global (€)
 *   NORDIC_MONITOR_MS=500       Fréquence de contrôle positions
 *   NORDIC_SUMMARY_S=3600       Résumé Telegram toutes les N secondes
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { getLogger }        from '../utils/logger';
import { TelegramNotifier } from '../utils/TelegramNotifier';
import { IBKRConnector }    from './connectors/IBKRConnector';
import { StatArbStrategy, Z_EXIT } from './strategies/StatArbStrategy';
import { ALL_STOCKS, INDICES }     from './NordicUniverse';
import type { SignalSide }         from './strategies/StatArbStrategy';
import type { MarketQuote }        from './connectors/IBKRConnector';
import type { NordicStock }        from './NordicUniverse';

const log = getLogger('Nordic');

// ── Configuration ──────────────────────────────────────────────────
const STAKE_EUR       = parseFloat(process.env.NORDIC_STAKE_EUR       ?? '500');
const MAX_POSITIONS   = parseInt  (process.env.NORDIC_MAX_POSITIONS   ?? '3',    10);
const MAX_DRAWDOWN    = parseFloat(process.env.NORDIC_MAX_DRAWDOWN    ?? '1000');
const MONITOR_MS      = parseInt  (process.env.NORDIC_MONITOR_MS      ?? '500',   10);
const SUMMARY_S       = parseInt  (process.env.NORDIC_SUMMARY_S       ?? '3600',  10);
const DRY_RUN         = process.env.IBKR_DRY_RUN !== 'false';

// ── Position ouverte ───────────────────────────────────────────────
interface OpenPosition {
  stock:      NordicStock;
  side:       SignalSide;
  entryPrice: number;
  qty:        number;
  openedAt:   number;
  orderId:    string;
}

// ── État global ────────────────────────────────────────────────────
const openPositions = new Map<number, OpenPosition>();  // conid → position
let totalPnl    = 0;
let tradeWins   = 0;
let tradeLosses = 0;
let tradeCount  = 0;
let signalCount = 0;
let stopped     = false;

async function main() {
  const mode = DRY_RUN ? 'DRY-RUN (paper)' : 'LIVE';

  log.info('╔══════════════════════════════════════════════════════════╗');
  log.info('║  🏔️  POLYBOT NORDIC — Stat-Arb Lead-Lag HFT             ║');
  log.info(`║  Mode : ${mode.padEnd(49)}║`);
  log.info(`║  Mise : ${`${STAKE_EUR}€ / position`.padEnd(49)}║`);
  log.info(`║  Max  : ${`${MAX_POSITIONS} positions | drawdown max ${MAX_DRAWDOWN}€`.padEnd(49)}║`);
  log.info('╚══════════════════════════════════════════════════════════╝');

  const ibkr     = new IBKRConnector();
  const strategy = new StatArbStrategy(ALL_STOCKS);
  const telegram = new TelegramNotifier();

  // ── Connexion IBKR ───────────────────────────────────────────────
  log.info('Connexion au Client Portal Gateway IBKR...');
  try {
    await ibkr.connect();
  } catch (e: any) {
    log.error('Impossible de joindre le Gateway IBKR', {
      error:  e.message,
      advice: 'Lance: java -jar ibclientportal/root/dist/ibclientportal.jar conf.yaml',
    });
    process.exit(1);
  }

  // Abonnement aux quotes après connexion WS
  ibkr.on('connected', () => {
    const allConids = [
      ...ALL_STOCKS.map(s => s.conid),
      ...Object.values(INDICES).map(i => i.conid),
    ];
    ibkr.subscribeQuotes(allConids);
    log.info(`Abonné à ${allConids.length} instruments`, {
      stocks:  ALL_STOCKS.length,
      indices: Object.keys(INDICES).length,
    });
  });

  ibkr.on('disconnected', () => {
    log.warn('IBKR WS — reconnexion automatique en cours...');
  });

  // ── Notification de démarrage ────────────────────────────────────
  telegram.send(
    `🏔️ <b>Nordic HFT démarré — ${mode}</b>\n\n` +
    `Univers : <code>${ALL_STOCKS.length} actions</code> (Helsinki + Stockholm)\n` +
    `Mise : <code>${STAKE_EUR}€ / position</code>  |  Max : <code>${MAX_POSITIONS}</code>\n` +
    `Drawdown max : <code>${MAX_DRAWDOWN}€</code>\n` +
    `Edge : <code>~1ms Nasdaq Helsinki</code>`,
  ).catch(() => {});

  // ── Handler quote → évaluation signal ───────────────────────────
  ibkr.on('quote', async (quote: MarketQuote) => {
    if (stopped) return;

    // Alimente la stratégie (index + stocks)
    const signal = strategy.onQuote(quote);
    if (!signal) return;

    signalCount++;

    // ── Guard 1 : positions max ──────────────────────────────────
    if (openPositions.size >= MAX_POSITIONS) {
      log.debug('Plafond positions atteint — signal ignoré', {
        open: openPositions.size, max: MAX_POSITIONS, stock: signal.stock.symbol,
      });
      return;
    }

    // ── Guard 2 : stock déjà en position ────────────────────────
    if (openPositions.has(signal.stock.conid)) return;

    // ── Calcul de la taille ──────────────────────────────────────
    const qty = Math.floor(STAKE_EUR / signal.entryPrice);
    if (qty < 1) {
      log.warn('Quantité < 1 — signal ignoré', {
        stock: signal.stock.symbol, price: signal.entryPrice, stake: STAKE_EUR,
      });
      return;
    }

    const tradeId = `#${++tradeCount}`;
    log.info(`⚡ Signal ${tradeId} — ${signal.side} ${signal.stock.symbol}`, {
      reason: signal.reason,
      qty,
      entry:  signal.entryPrice,
      target: signal.targetPrice.toFixed(4),
    });

    // ── Placement ordre ──────────────────────────────────────────
    strategy.markOpened(signal.stock.conid, signal.side, signal.entryPrice);

    let orderId: string;
    try {
      const result = await ibkr.placeOrder({
        conid:     signal.stock.conid,
        side:      signal.side,
        quantity:  qty,
        orderType: 'LMT',
        price:     signal.entryPrice,
        tif:       'IOC',  // Immediate-Or-Cancel : critique pour HFT
      });
      orderId = result.orderId;
    } catch (e: any) {
      strategy.markClosed(signal.stock.conid);
      log.error(`Trade ${tradeId} — Erreur placement ordre`, { error: e.message });
      return;
    }

    const pos: OpenPosition = {
      stock:      signal.stock,
      side:       signal.side,
      entryPrice: signal.entryPrice,
      qty,
      openedAt:   Date.now(),
      orderId,
    };
    openPositions.set(signal.stock.conid, pos);

    const stake = (qty * signal.entryPrice).toFixed(2);
    log.info(`Trade ${tradeId} — Position ouverte`, {
      stock:   signal.stock.symbol,
      side:    signal.side,
      qty,
      price:   signal.entryPrice,
      stake:   stake + '€',
      orderId,
    });

    telegram.send(
      `⚡ <b>Nordic HFT — ${signal.side} ${signal.stock.symbol} ${tradeId}</b>\n\n` +
      `📊 ${signal.reason}\n\n` +
      `Qty : <code>${qty}</code>  |  Entrée : <code>${signal.entryPrice}</code>\n` +
      `Cible : <code>${signal.targetPrice.toFixed(4)}</code>  |  Mise : <code>${stake}€</code>\n` +
      `Open : <code>${openPositions.size}/${MAX_POSITIONS}</code>  |  P&amp;L total : <code>${_pnlStr()}</code>`,
    ).catch(() => {});
  });

  // ── Monitor : vérification des sorties ──────────────────────────
  const monitorPositions = async () => {
    if (stopped || openPositions.size === 0) return;

    // Positions expirées (timeout 30s géré par strategy)
    const expired = strategy.getExpiredPositions();
    for (const conid of expired) {
      await _closePosition(conid, 'TIMEOUT');
    }

    // Z-score revenu à la moyenne
    for (const [conid, pos] of openPositions) {
      const z = strategy.currentZScore(pos.stock);
      if (Math.abs(z) <= Z_EXIT) {
        await _closePosition(conid, `Z-reversion z=${z.toFixed(2)}σ`);
      }
    }
  };

  // ── Fermeture d'une position ─────────────────────────────────────
  const _closePosition = async (conid: number, reason: string) => {
    const pos = openPositions.get(conid);
    if (!pos) return;

    openPositions.delete(conid);
    strategy.markClosed(conid);

    const closeSide: SignalSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const quote = ibkr.getQuote(conid);
    const exitPrice = quote
      ? (closeSide === 'SELL' ? quote.bid : quote.ask) || quote.last || pos.entryPrice
      : pos.entryPrice;

    // P&L estimé (avant frais)
    const pnl = pos.side === 'BUY'
      ? (exitPrice - pos.entryPrice) * pos.qty
      : (pos.entryPrice - exitPrice) * pos.qty;

    totalPnl += pnl;
    if (pnl >= 0) tradeWins++; else tradeLosses++;

    const holdMs = Date.now() - pos.openedAt;

    log.info(`📉 Fermeture ${pos.side === 'BUY' ? 'SELL' : 'BUY'} ${pos.stock.symbol} — ${reason}`, {
      entry:   pos.entryPrice,
      exit:    exitPrice,
      qty:     pos.qty,
      holdMs,
      pnl:     (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '€',
      totalPnl: _pnlStr(),
    });

    // Ordre de clôture (MKT pour sortir immédiatement)
    try {
      await ibkr.placeOrder({
        conid,
        side:      closeSide,
        quantity:  pos.qty,
        orderType: 'MKT',
        tif:       'DAY',
      });
    } catch (e: any) {
      log.error('Erreur ordre de clôture', { error: e.message, stock: pos.stock.symbol });
    }

    telegram.send(
      `${pnl >= 0 ? '✅' : '❌'} <b>Nordic HFT — Clôture ${pos.stock.symbol}</b>\n\n` +
      `Raison : <code>${reason}</code>\n` +
      `Entrée : <code>${pos.entryPrice}</code>  |  Sortie : <code>${exitPrice.toFixed(4)}</code>\n` +
      `Durée : <code>${(holdMs / 1000).toFixed(1)}s</code>  |  Qty : <code>${pos.qty}</code>\n` +
      `P&amp;L trade : <code>${(pnl >= 0 ? '+' : '') + pnl.toFixed(2)}€</code>\n` +
      `P&amp;L total : <code>${_pnlStr()}</code>  (${tradeWins}W / ${tradeLosses}L)`,
    ).catch(() => {});

    // ── Guard drawdown global ────────────────────────────────────
    if (totalPnl < -MAX_DRAWDOWN) {
      log.error('🛑 DRAWDOWN MAXIMUM ATTEINT — arrêt du bot', {
        totalPnl: totalPnl.toFixed(2) + '€', max: MAX_DRAWDOWN + '€',
      });
      telegram.send(
        `🛑 <b>Nordic HFT — DRAWDOWN MAX ATTEINT</b>\n\n` +
        `Perte totale : <code>${totalPnl.toFixed(2)}€</code>\n` +
        `Seuil : <code>${MAX_DRAWDOWN}€</code>\n\n` +
        `Bot suspendu. Relance manuelle requise.`,
      ).catch(() => {});
      stopped = true;
    }
  };

  // ── Helper format P&L ────────────────────────────────────────────
  function _pnlStr(): string {
    return (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '€';
  }

  // ── Résumé périodique ────────────────────────────────────────────
  const sendSummary = () => {
    const wr = tradeWins + tradeLosses > 0
      ? ((tradeWins / (tradeWins + tradeLosses)) * 100).toFixed(1) + '%' : 'N/A';
    const uptime = (() => {
      const s = Math.floor(process.uptime());
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`;
    })();

    telegram.send(
      `${totalPnl >= 0 ? '📈' : '📉'} <b>Nordic HFT — Résumé ${uptime}</b>\n\n` +
      `Trades : <code>${tradeCount}</code>  |  Win Rate : <code>${wr}</code>\n` +
      `Wins : <code>${tradeWins}</code>  /  Losses : <code>${tradeLosses}</code>\n` +
      `P&amp;L : <code>${_pnlStr()}</code>\n` +
      `Signaux : <code>${signalCount}</code>  |  Open : <code>${openPositions.size}</code>`,
    ).catch(() => {});

    log.info('📊 Résumé Nordic', {
      trades: tradeCount, wins: tradeWins, losses: tradeLosses,
      winRate: wr, pnl: _pnlStr(), signals: signalCount,
      openPositions: openPositions.size,
    });
  };

  // ── Timers ───────────────────────────────────────────────────────
  const monitorInterval = setInterval(monitorPositions, MONITOR_MS);
  const summaryInterval = setInterval(sendSummary, SUMMARY_S * 1_000);

  // Premier résumé après 5min
  setTimeout(sendSummary, 5 * 60_000);

  // ── Arrêt propre ─────────────────────────────────────────────────
  const shutdown = async (sig: string) => {
    log.info(`${sig} — arrêt propre...`);
    clearInterval(monitorInterval);
    clearInterval(summaryInterval);

    // Fermer toutes les positions ouvertes
    if (openPositions.size > 0) {
      log.info(`Fermeture de ${openPositions.size} position(s) en cours...`);
      for (const conid of [...openPositions.keys()]) {
        await _closePosition(conid, `${sig} shutdown`);
      }
    }

    ibkr.destroy();

    const wr = tradeWins + tradeLosses > 0
      ? ((tradeWins / (tradeWins + tradeLosses)) * 100).toFixed(1) + '%' : 'N/A';

    log.info('📊 Bilan final Nordic HFT', {
      trades:   tradeCount,
      wins:     tradeWins,
      losses:   tradeLosses,
      winRate:  wr,
      pnl:      _pnlStr(),
      signals:  signalCount,
    });

    telegram.send(
      `🔴 <b>Nordic HFT — Arrêt (${sig})</b>\n\n` +
      `Trades : <code>${tradeCount}</code>  |  ${wr} win rate\n` +
      `P&amp;L final : <code>${_pnlStr()}</code>`,
    ).catch(() => {});

    setTimeout(() => process.exit(0), 1_500);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  console.error('❌ Erreur fatale Nordic HFT :', e.message);
  process.exit(1);
});
