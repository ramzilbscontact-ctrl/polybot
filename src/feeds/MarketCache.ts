/**
 * MarketCache.ts — Cache in-memory des marchés candidats
 *
 * Rôle :
 *   - Stocke les marchés pré-validés par le scan HTTP
 *   - Met à jour leurs prix en temps réel via les events WebSocket
 *   - Fournit une lookup rapide tokenId → marché pour le hot path WS
 *   - Gère l'expiry automatique des marchés résolus
 *
 * Design : aucune dépendance externe, O(1) sur toutes les opérations.
 */
import { getLogger } from '../utils/logger';

const log = getLogger('MarketCache');

// ── Structure d'un marché en cache ───────────────────────────────
export interface CachedMarket {
  conditionId:   string;
  tokenId:       string;
  question:      string;
  domain:        string;
  endDate:       string;    // ISO string → Date.parse()
  liquidity:     number;
  validated:     boolean;   // a passé la validation domaine (buffer crypto, liquidité…)
  lastPrice:     number;    // bestAsk le plus récent
  lastUpdated:   number;    // timestamp ms
  reasoning:     string;    // raison de la validation initiale
}

export class MarketCache {
  // conditionId → CachedMarket
  private readonly markets          = new Map<string, CachedMarket>();
  // tokenId → conditionId (reverse lookup O(1))
  private readonly tokenToCondition = new Map<string, string>();
  // tokenId → timestamp dernière évaluation (anti-spam)
  private readonly lastEvalAt       = new Map<string, number>();

  // ── Gestion des marchés ──────────────────────────────────────
  set(market: CachedMarket): void {
    // Evite d'écraser lastPrice si déjà suivi et prix plus récent
    const existing = this.markets.get(market.conditionId);
    if (existing && existing.lastUpdated > market.lastUpdated) return;

    this.markets.set(market.conditionId, market);
    this.tokenToCondition.set(market.tokenId, market.conditionId);
    log.debug('MarketCache — marché ajouté', {
      conditionId: market.conditionId.substring(0, 12) + '…',
      domain:      market.domain,
      question:    market.question.substring(0, 50),
    });
  }

  getByConditionId(conditionId: string): CachedMarket | null {
    return this.markets.get(conditionId) ?? null;
  }

  getByTokenId(tokenId: string): CachedMarket | null {
    const cid = this.tokenToCondition.get(tokenId);
    return cid ? (this.markets.get(cid) ?? null) : null;
  }

  has(conditionId: string): boolean {
    return this.markets.has(conditionId);
  }

  remove(conditionId: string): void {
    const m = this.markets.get(conditionId);
    if (m) {
      this.tokenToCondition.delete(m.tokenId);
      this.lastEvalAt.delete(m.tokenId);
    }
    this.markets.delete(conditionId);
  }

  all(): CachedMarket[] {
    return [...this.markets.values()];
  }

  getTrackedTokenIds(): string[] {
    return [...this.tokenToCondition.keys()];
  }

  get size(): number { return this.markets.size; }

  // ── Mise à jour de prix (hot path WS) ────────────────────────
  updatePrice(tokenId: string, price: number): CachedMarket | null {
    const cid = this.tokenToCondition.get(tokenId);
    if (!cid) return null;

    const m = this.markets.get(cid);
    if (!m) return null;

    m.lastPrice   = price;
    m.lastUpdated = Date.now();
    return m;
  }

  // ── Anti-spam : debounce par tokenId ─────────────────────────
  canEvaluate(tokenId: string, debounceMs: number): boolean {
    const last = this.lastEvalAt.get(tokenId) ?? 0;
    const now  = Date.now();
    if (now - last < debounceMs) return false;
    this.lastEvalAt.set(tokenId, now);
    return true;
  }

  // ── Purge des marchés expirés ─────────────────────────────────
  purgeExpired(): number {
    const now     = Date.now();
    let   removed = 0;

    for (const [cid, m] of this.markets) {
      const expiryMs = Date.parse(m.endDate);
      if (!isNaN(expiryMs) && expiryMs < now) {
        this.remove(cid);
        removed++;
      }
    }

    if (removed > 0) {
      log.info(`MarketCache — purge : ${removed} marché(s) expiré(s) retiré(s)`, {
        remaining: this.size,
      });
    }
    return removed;
  }
}
