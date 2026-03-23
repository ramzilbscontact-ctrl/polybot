/**
 * HighProbStrategy.ts — Stratégie "Favoris Haute Probabilité"
 *
 * Principe : scanner les marchés Polymarket où l'option YES est
 * très probable (0.88–0.94) sur des actifs dont on peut vérifier
 * le prix réel (BTC/ETH/SOL) ou dont la probabilité seule suffit
 * (Politics/Sports/PopCulture avec liquidité suffisante).
 *
 * Architecture : cette classe ANALYSE seulement. L'Executor place les ordres.
 */
import { getLogger }      from '../utils/logger';
import { getPrice, detectTicker, parseThreshold } from '../price/PriceFeed';
import type { PolymarketConnector } from '../connectors/PolymarketConnector';

const log = getLogger('HighProbStrategy');

// ── Configuration de la stratégie ────────────────────────────────
export interface StrategyConfig {
  yesMin:         number;   // Prix YES minimum (bestAsk)
  yesMax:         number;   // Prix YES maximum (bestAsk)
  expiryMaxHours: number;   // Fenêtre d'expiry max
  expiryMinMins:  number;   // Fenêtre d'expiry min
  cryptoBufferUsd:number;   // Buffer prix réel vs seuil ($)
  minLiquidity:   number;   // Liquidité CLOB minimale (USDC)
  stakeUsdc:      number;   // Mise par trade
  safetyMargin:   number;   // Marge de sécurité sur la mise (ex: 0.02 = 2%)
}

export const DEFAULT_CONFIG: StrategyConfig = {
  yesMin:          0.88,
  yesMax:          0.94,
  expiryMaxHours:  48,
  expiryMinMins:   10,
  cryptoBufferUsd: 60,
  minLiquidity:    500,
  stakeUsdc:       0.80,
  safetyMargin:    0.02,  // 2% de marge → mise effective = 0.80 * 0.98 = 0.784
};

// ── Domaines surveillés ──────────────────────────────────────────
const DOMAIN_PATTERNS: Record<string, RegExp> = {
  Crypto:      /\bbitcoin\b|\bbtc\b|\bethereum\b|\beth\b|\bsolana\b|\bsol\b|\bxrp\b|\bdoge\b/i,
  Politics:    /\belection\b|\bpresident\b|\bminister\b|\bsenate\b|\bcongress\b|\bvote\b|\bwar\b|\bceasefire\b|\btrump\b|\bputin\b|\bmacron\b/i,
  Sports:      /\bnba\b|\bnfl\b|\bfifa\b|\bchampionship\b|\btournament\b|\bfinal\b|\bplayoff\b|\btennis\b|\bf1\b|\bolympic\b/i,
  PopCulture:  /\balbum\b|\boscars?\b|\bgrammy\b|\bbillboard\b|\bnetflix\b|\bmovie\b|\btaylor swift\b|\brihanna\b/i,
};

export interface MarketSignal {
  conditionId: string;
  question:    string;
  domain:      string;
  yesPrice:    number;     // bestAsk
  tokenId:     string;
  minsLeft:    number;
  liquidity:   number;
  stakeUsdc:   number;     // mise calculée avec safetyMargin
  shares:      number;
  reasoning:   string;
}

// ── Classe Stratégie ─────────────────────────────────────────────
export class HighProbStrategy {
  private readonly cfg: StrategyConfig;
  private readonly firedIds = new Set<string>();

  constructor(
    private readonly connector: PolymarketConnector,
    config: Partial<StrategyConfig> = {}
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    log.info('HighProbStrategy initialisée', {
      yesRange:    `${this.cfg.yesMin}–${this.cfg.yesMax}`,
      expiry:      `${this.cfg.expiryMinMins}min – ${this.cfg.expiryMaxHours}h`,
      stake:       `${this.cfg.stakeUsdc} USDC.e (margin -${this.cfg.safetyMargin*100}%)`,
      cryptoBuf:   `+${this.cfg.cryptoBufferUsd}$`,
    });
  }

  // ── Scan principal ───────────────────────────────────────────
  async scan(): Promise<MarketSignal[]> {
    const now    = Date.now();
    const minMs  = this.cfg.expiryMinMins  * 60_000;
    const maxMs  = this.cfg.expiryMaxHours * 3_600_000;
    const signals: MarketSignal[] = [];

    let markets: any[];
    try {
      markets = await this.connector.getGammaMarkets();
    } catch (e: any) {
      log.error('Impossible de récupérer les marchés', { error: e.message });
      return [];
    }

    log.debug(`${markets.length} marchés bruts récupérés`);

    for (const m of markets) {
      if (!m.active || m.closed || !m.endDate || !m.acceptingOrders) continue;

      const left = new Date(m.endDate).getTime() - now;
      if (left < minMs || left > maxMs) continue;
      if (this.firedIds.has(m.conditionId)) continue;

      // Prix temps réel = bestAsk
      const yesPrice = parseFloat(m.bestAsk ?? '0');
      if (isNaN(yesPrice) || yesPrice < this.cfg.yesMin || yesPrice > this.cfg.yesMax) continue;

      // Domaine
      const domain = this.detectDomain(m.question ?? '');
      if (!domain) continue;

      // Token ID
      const tokenIds: string[] = JSON.parse(m.clobTokenIds ?? m.clob_token_ids ?? '[]');
      if (!tokenIds.length) continue;

      // Liquidité
      const liquidity = parseFloat(m.liquidityClob ?? m.liquidityNum ?? m.liquidity ?? '0');

      // Validation domaine-spécifique
      const validation = await this.validate(m, domain, yesPrice, liquidity);
      if (!validation.ok) {
        log.debug('Marché rejeté', { question: m.question?.substring(0,50), reason: validation.reason });
        continue;
      }

      // Calcul de la mise avec safety margin
      const effectiveStake = parseFloat(
        (this.cfg.stakeUsdc * (1 - this.cfg.safetyMargin)).toFixed(4)
      );
      const shares = parseFloat((effectiveStake / yesPrice).toFixed(2));

      signals.push({
        conditionId: m.conditionId,
        question:    m.question ?? '',
        domain,
        yesPrice,
        tokenId:     tokenIds[0],
        minsLeft:    Math.round(left / 60_000),
        liquidity,
        stakeUsdc:   effectiveStake,
        shares,
        reasoning:   validation.reason,
      });

      log.info('Signal détecté', {
        domain,
        question: m.question?.substring(0, 60),
        yesPrice,
        minsLeft: Math.round(left / 60_000),
        reasoning: validation.reason,
      });
    }

    return signals;
  }

  // ── Validation par domaine ───────────────────────────────────
  private async validate(
    market: any,
    domain: string,
    yesPrice: number,
    liquidity: number
  ): Promise<{ ok: boolean; reason: string }> {

    if (domain === 'Crypto') {
      // 1. Vérifie que le threshold est parseable
      const threshold = parseThreshold(market.question ?? '');
      if (!threshold)
        return { ok: false, reason: 'Seuil $ non trouvé dans la question' };

      // 2. Vérifie le buffer prix réel
      const ticker = detectTicker(market.question ?? '');
      if (!ticker)
        return { ok: false, reason: 'Ticker crypto non identifié' };

      let realPrice: number;
      try {
        const feed = await getPrice(ticker);
        realPrice  = feed.price;
        log.debug(`Prix ${ticker}`, { realPrice, source: feed.source });
      } catch (e: any) {
        return { ok: false, reason: `Feed prix indisponible: ${e.message}` };
      }

      const buffer = realPrice - threshold;
      if (buffer < this.cfg.cryptoBufferUsd)
        return { ok: false, reason: `Buffer ${buffer.toFixed(0)}$ < seuil ${this.cfg.cryptoBufferUsd}$ (${ticker}=${realPrice.toFixed(0)}$, pari>=${threshold}$)` };

      return { ok: true, reason: `Buffer +${buffer.toFixed(0)}$ (${ticker}=${realPrice.toFixed(0)}$ vs pari ${threshold}$)` };
    }

    // Autres domaines : liquidité suffisante
    if (liquidity < this.cfg.minLiquidity)
      return { ok: false, reason: `Liquidité ${liquidity.toFixed(0)} USDC < seuil ${this.cfg.minLiquidity}` };

    return { ok: true, reason: `${domain} — liq=${liquidity.toFixed(0)} USDC, YES=${yesPrice}` };
  }

  // ── Détection domaine ────────────────────────────────────────
  private detectDomain(question: string): string | null {
    for (const [domain, rx] of Object.entries(DOMAIN_PATTERNS))
      if (rx.test(question)) return domain;
    return null;
  }

  // ── Marquer un marché comme traité ───────────────────────────
  markFired(conditionId: string) { this.firedIds.add(conditionId); }

  get config() { return { ...this.cfg }; }
}
