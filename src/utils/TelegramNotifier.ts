/**
 * TelegramNotifier.ts — Alertes temps réel sur Telegram
 *
 * Configuration .env :
 *   TELEGRAM_BOT_TOKEN=123456:ABC...
 *   TELEGRAM_CHAT_ID=123456789
 *
 * Si non configuré → mode silencieux (no-op), pas d'erreur.
 *
 * Events couverts :
 *   startup        — démarrage bot (config résumée)
 *   paper:opened   — position ouverte en paper trading
 *   paper:resolved — résolution WIN ✅ / LOSS ❌
 *   ws:signal      — signal WebSocket détecté
 *   news:hit       — news correspondant à un marché
 *   manifold:conf  — signal confirmé par Manifold
 *   pnl:summary    — résumé P&L périodique
 *   stop:loss      — stop-loss global atteint
 */
import { getLogger } from './logger';

const log = getLogger('Telegram');

const API = 'https://api.telegram.org/bot';
const TIMEOUT = 8_000;
const MAX_RETRIES = 2;

export class TelegramNotifier {
  private readonly token:   string;
  private readonly chatId:  string;
  readonly enabled:         boolean;

  constructor() {
    this.token  = process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.chatId = process.env.TELEGRAM_CHAT_ID   ?? '';
    this.enabled = !!(this.token && this.chatId);

    if (this.enabled) {
      log.info('TelegramNotifier — activé ✓', { chatId: this.chatId });
    } else {
      log.info('TelegramNotifier — désactivé (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID manquants)');
    }
  }

  // ── Envoi générique ───────────────────────────────────────────
  async send(html: string): Promise<void> {
    if (!this.enabled) return;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const res = await fetch(`${API}${this.token}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            chat_id:    this.chatId,
            text:       html,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (res.ok) return;
        const err = await res.text();
        log.warn(`Telegram — HTTP ${res.status}`, { err: err.substring(0, 100) });
      } catch (e: any) {
        if (i === MAX_RETRIES - 1) log.warn('Telegram — envoi échoué', { error: e.message });
      }
    }
  }

  // ── Templates ─────────────────────────────────────────────────
  async notifyStartup(config: {
    mode: string; yesMin: number; yesMax: number;
    stake: number; maxTrades: number; maxLoss: number;
  }): Promise<void> {
    await this.send(
      `🤖 <b>POLYBOT démarré</b>\n\n` +
      `Mode : <code>${config.mode}</code>\n` +
      `Range YES : <code>${config.yesMin}–${config.yesMax}</code>\n` +
      `Mise : <code>${config.stake} USDC.e</code>\n` +
      `Max trades : <code>${config.maxTrades}</code>  |  Stop-loss : <code>${config.maxLoss} USDC.e</code>`,
    );
  }

  async notifyPaperOpened(opts: {
    tradeId: string; domain: string; question: string;
    entryPrice: number; shares: number; stake: number;
    minsLeft: number; potentialWin: number;
  }): Promise<void> {
    await this.send(
      `📋 <b>[PAPER] Position ouverte ${opts.tradeId}</b>\n\n` +
      `🌐 ${opts.domain}\n` +
      `📌 ${opts.question.substring(0, 100)}\n\n` +
      `💵 Prix entrée : <code>${opts.entryPrice}</code>\n` +
      `📊 Shares : <code>${opts.shares.toFixed(4)}</code>  |  Mise : <code>${opts.stake.toFixed(4)} USDC.e</code>\n` +
      `⏱ Expire dans : <code>${opts.minsLeft} min</code>\n` +
      `💰 Gain potentiel : <code>+${opts.potentialWin.toFixed(4)} USDC.e</code>`,
    );
  }

  async notifyPaperResolved(opts: {
    tradeId: string; won: boolean; domain: string; question: string;
    entryPrice: number; pnl: number; totalPnl: number;
    wins: number; losses: number;
  }): Promise<void> {
    const icon    = opts.won ? '✅' : '❌';
    const outcome = opts.won ? 'WIN' : 'LOSS';
    const pnlStr  = (opts.pnl >= 0 ? '+' : '') + opts.pnl.toFixed(4);
    const totalStr= (opts.totalPnl >= 0 ? '+' : '') + opts.totalPnl.toFixed(4);
    const wr      = opts.wins + opts.losses > 0
      ? ((opts.wins / (opts.wins + opts.losses)) * 100).toFixed(1) + '%'
      : 'N/A';

    await this.send(
      `${icon} <b>[PAPER] ${outcome} — ${opts.tradeId}</b>\n\n` +
      `🌐 ${opts.domain}\n` +
      `📌 ${opts.question.substring(0, 100)}\n\n` +
      `P&amp;L trade : <code>${pnlStr} USDC.e</code>\n` +
      `P&amp;L total : <code>${totalStr} USDC.e</code>\n` +
      `Win Rate : <code>${wr}</code>  (<code>${opts.wins}W / ${opts.losses}L</code>)`,
    );
  }

  async notifyNewsHit(opts: {
    headline: string; source: string;
    market: string; score: number;
  }): Promise<void> {
    await this.send(
      `📰 <b>News → Marché lié</b>\n\n` +
      `Source : <code>${opts.source}</code>\n` +
      `Titre : ${opts.headline.substring(0, 120)}\n\n` +
      `Marché : ${opts.market.substring(0, 80)}\n` +
      `Score match : <code>${(opts.score * 100).toFixed(0)}%</code>`,
    );
  }

  async notifyManifoldConfirmed(opts: {
    question: string; polyPrice: number;
    manifoldProba: number; delta: number;
  }): Promise<void> {
    await this.send(
      `✅ <b>Signal confirmé — Manifold</b>\n\n` +
      `📌 ${opts.question.substring(0, 100)}\n\n` +
      `Polymarket : <code>${opts.polyPrice}</code>  |  Manifold : <code>${opts.manifoldProba.toFixed(3)}</code>\n` +
      `Delta : <code>+${(opts.delta * 100).toFixed(1)}%</code> ← Polymarket sous-pricé`,
    );
  }

  async notifyPnlSummary(opts: {
    trades: number; resolved: number; wins: number; losses: number;
    pnl: number; wsSignals: number; newsHits: number; uptime: string;
  }): Promise<void> {
    const wr  = opts.resolved > 0
      ? ((opts.wins / opts.resolved) * 100).toFixed(1) + '%' : 'N/A';
    const pnl = (opts.pnl >= 0 ? '+' : '') + opts.pnl.toFixed(4);
    const icon = opts.pnl >= 0 ? '📈' : '📉';

    await this.send(
      `${icon} <b>Résumé P&amp;L — ${opts.uptime}</b>\n\n` +
      `Trades : <code>${opts.trades}</code>  (${opts.resolved} résolus)\n` +
      `Wins/Losses : <code>${opts.wins}W / ${opts.losses}L</code>  (${wr})\n` +
      `P&amp;L : <code>${pnl} USDC.e</code>\n\n` +
      `Signaux WS : <code>${opts.wsSignals}</code>  |  News hits : <code>${opts.newsHits}</code>`,
    );
  }

  async notifyStopLoss(opts: { totalLoss: number; maxLoss: number }): Promise<void> {
    await this.send(
      `🛑 <b>STOP-LOSS ATTEINT — Bot suspendu</b>\n\n` +
      `Perte totale : <code>${opts.totalLoss.toFixed(4)} USDC.e</code>\n` +
      `Seuil configuré : <code>${opts.maxLoss} USDC.e</code>\n\n` +
      `Relance manuelle requise.`,
    );
  }
}
