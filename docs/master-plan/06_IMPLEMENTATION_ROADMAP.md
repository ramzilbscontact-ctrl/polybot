# 06 — Roadmap d'Implémentation

## Vue d'ensemble : 16 semaines

```
S01-S02 : Foundation         (sécurité, DB, CI, monitoring)
S03-S04 : Gateway + S1       (Polymarket en paper sur serveur)
S05-S07 : Benchmarking infra (backtest, walk-forward, MC)
S08-S10 : S2 PEAD + S4 Momentum (Python, Alpaca data)
S11-S12 : S3 Funding arb     (ccxt, crypto exchanges)
S13     : S5 Cross-arb       (Manifold + Kalshi)
S14     : Risk engine v2     (Kelly, corrélations, regimes)
S15-S16 : Go-live progressif (live-reduced puis live-full)
```

---

## Phase 1 — Foundation (Semaines 1-2)

### Objectifs
- Sécurité : rotation des credentials, secret manager
- Infra : Postgres + base schemas
- Monitoring : Grafana + Telegram throttle
- Dev ops : CI GitHub Actions

### Deliverables S1
- [ ] `.env` retiré de git, remplacé par Secret Manager
- [ ] Tous les tokens (Alpaca, Telegram, Polymarket) régénérés
- [ ] Postgres Cloud SQL créé avec schemas (voir 03_UNIFIED_ARCHITECTURE)
- [ ] Telegram bot rate-limited (max 50 msg/jour)
- [ ] Kill-switch endpoint testé

### Deliverables S2
- [ ] Grafana dashboard minimal (P&L, trades count, errors)
- [ ] GitHub Actions : lint + type-check + unit tests
- [ ] Docker image build automatique
- [ ] Alerting : email/Slack si bot crash

---

## Phase 2 — Gateway + S1 Polymarket (Semaines 3-4)

### Objectifs
- Gateway service minimal en place
- Strategy polymarket (TypeScript existant) wrappée comme service
- EV engine porté depuis Rust
- Calibration par domaine fonctionnelle

### Deliverables S3
- [ ] `apps/gateway/api-server.ts` : POST /signals, GET /positions
- [ ] Strategy polymarket pousse signaux au gateway
- [ ] Executor polymarket existant branché derrière
- [ ] Signals et trades écrits en Postgres

### Deliverables S4
- [ ] EV engine porté de Rust → TypeScript
- [ ] Calibration courbe par (domain × price_range)
- [ ] Anti-slippage amélioré (cache Binance WS dans scan)
- [ ] Resolution polling exponential backoff
- [ ] **MVP paper trading tourne 24/7 sur serveur**

---

## Phase 3 — Benchmarking Infrastructure (Semaines 5-7)

### Objectifs
- Framework complet pour valider les futures stratégies
- Les 6 scripts de benchmark + rapport auto

### Deliverables S5
- [ ] `scripts/benchmark/run_backtest.py` — existe déjà, étendre
- [ ] `scripts/benchmark/walk_forward.py` — rolling IS/OOS
- [ ] `scripts/benchmark/monte_carlo.py` — bootstrap returns

### Deliverables S6
- [ ] `scripts/benchmark/sensitivity_analysis.py`
- [ ] `scripts/benchmark/compare_strategies.py`
- [ ] Template rapport Go/No-Go

### Deliverables S7
- [ ] Slippage model réaliste (order book depth → price impact)
- [ ] Fees model par venue (Alpaca, Polymarket, Binance)
- [ ] Latency model (délai scan → fill)
- [ ] **Tous les backtests produisent des .md avec tous les metrics**

---

## Phase 4 — S2 PEAD + S4 Momentum (Semaines 8-10)

### Deliverables S8 (PEAD)
- [ ] Earnings calendar ingestion (Alpaca)
- [ ] Earnings surprise calculator
- [ ] Backtest complet 2020-2025 → rapport Go/No-Go
- [ ] Si GO : deploy en paper

### Deliverables S9 (Momentum + News)
- [ ] Universe screener (SP500 + filters)
- [ ] Momentum score + News sentiment overlay
- [ ] Backtest → rapport Go/No-Go
- [ ] Si GO : deploy en paper

### Deliverables S10
- [ ] Régime filter actif (VIX + SPY trend)
- [ ] Risk engine v1 (stop-loss, position sizing)
- [ ] Daily email de performance

---

## Phase 5 — S3 Funding Arb (Semaines 11-12)

### Deliverables S11
- [ ] ccxt wrapper pour Binance Futures + Spot
- [ ] Funding rate monitor
- [ ] Delta-neutral execution logic
- [ ] Backtest historical funding rates

### Deliverables S12
- [ ] Basis blow-up protection
- [ ] Paper trading 30 jours
- [ ] Rapport Go/No-Go

---

## Phase 6 — S5 Cross-arb + Risk v2 (Semaines 13-14)

### Deliverables S13
- [ ] Kalshi connector
- [ ] Fuzzy matching (sentence-transformers)
- [ ] Spread monitor Poly vs Manifold vs Kalshi
- [ ] Arb executor avec timeout protection

### Deliverables S14
- [ ] Kelly sizer avec cap 0.25
- [ ] Correlation matrix temps réel entre stratégies
- [ ] Auto-deallocation si corrélation > 0.7
- [ ] Regime detector (HMM ou rule-based)

---

## Phase 7 — Go-Live Progressif (Semaines 15-16)

### Deliverables S15
- [ ] Review complet de toutes les stratégies, Go/No-Go final
- [ ] Funding $5k par stratégie GO
- [ ] Mode `live-reduced` actif
- [ ] Daily monitoring intensif

### Deliverables S16
- [ ] Analyse 2 semaines paper-to-live divergence
- [ ] Si OK → scale up progressif
- [ ] Documentation finale (runbook ops)

---

## Jalons critiques (Go/No-Go)

### Jalon 1 (fin S2) : Foundation Ready
**Critère** : tous les secrets rotated, Postgres up, Telegram throttled, CI green.
**Si raté** : retarder phase 2 d'une semaine, audit sécurité.

### Jalon 2 (fin S4) : S1 en Paper
**Critère** : S1 tourne 24/7 depuis 5+ jours sans crash, trades loggés DB, P&L visible.
**Si raté** : debug S1, retarder le reste.

### Jalon 3 (fin S7) : Benchmark Infra Ready
**Critère** : peut valider n'importe quelle stratégie en 1 jour avec rapport auto.
**Si raté** : stop everything, fix benchmark d'abord.

### Jalon 4 (fin S10) : 2-3 stratégies GO
**Critère** : au moins 2 stratégies sur 4 backtested ont passé Go/No-Go.
**Si raté** : soit stratégies pourries (pivot), soit benchmark trop strict (revoir thresholds).

### Jalon 5 (fin S14) : Portefeuille complet en paper
**Critère** : 3-5 stratégies tournent en paper, P&L composite mesuré, Sharpe > 1.0.
**Si raté** : extend paper period 2-4 semaines.

### Jalon 6 (fin S16) : Live réduit stable
**Critère** : 2+ semaines de live-reduced sans incidents majeurs.
**Si raté** : revenir en paper, debug divergence.

---

## Budget temps hebdomadaire

Hypothèse : **15-20h/semaine** développement + maintenance.

- 60% dev features (nouveaux)
- 20% bug fixing / ops
- 15% analysis / tuning
- 5% docs / refactor

Pour accélérer, considérer :
- 2h/jour dev concentré (matin)
- Review daily 30min (soir) 
- Deep work samedi (4-6h backtest + analysis)

---

## Risques et mitigations

| Risque | Prob | Impact | Mitigation |
|--------|------|--------|------------|
| Stratégie ne passe pas Go/No-Go | Haute | Moyen | Avoir 5+ stratégies en pipeline, garder les meilleures 3 |
| Bug en live → perte réelle | Moyen | Haut | Phase live-reduced 1/20 taille, kill-switch |
| Divergence paper-live trop grande | Moyen | Moyen | Slippage model réaliste, post-mortem systématique |
| Infra Cloud down | Faible | Haut | Multi-region fallback (future), alertes 24/7 |
| Compte API banni (Alpaca, Polymarket) | Faible | Moyen | Respect des rate limits, rotation clés possible |
| Capital perdu sur bug | Moyen | Haut | Max DD hard stop 12%, kill-switch auto |

---

## Succès mesurable

**Après 16 semaines**, on considère le projet un succès si :
- Au moins 3 stratégies en live avec P&L positif net
- Sharpe composite > 1.0 sur 4+ semaines de live
- Max drawdown < 15%
- Infrastructure stable (uptime > 99%)
- Coût infra < $200/mois

**Échec** : si Sharpe < 0.5 sur 6 semaines de live, arrêter, retour en paper, audit complet.
