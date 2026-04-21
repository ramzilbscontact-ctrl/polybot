# 04 — Feature Breakdown (chaque choix, justifié)

## Gateway Service

### F1.1 — REST API server (Node/Express)
**Pourquoi** : chaque stratégie doit pouvoir pousser des signaux et lire le state (positions, pnl).
**Alternative rejetée** : gRPC (overkill, Express suffit). Python FastAPI (devrait partager le runtime avec stratégies).
**Endpoints** : `POST /signals`, `GET /positions`, `GET /pnl/daily`, `POST /kill-switch`.

### F1.2 — WebSocket hub pour notifications
**Pourquoi** : dashboard temps réel sans polling.
**Protocol** : ws standard (pas socket.io, on veut léger).

### F1.3 — Telegram bus avec rate-limit
**Pourquoi** : on a appris que 5000 notifs = user unhappy. Il FAUT throttle.
**Design** :
- Filter par niveau : `INFO` / `WARN` / `CRIT`
- Batch les `INFO` toutes les 30min (digest)
- `WARN` et `CRIT` envoyés immédiatement
- Hard cap : **50 messages/jour max**
- Bouton "mute 1h" via command `/mute 1h`

### F1.4 — PnL Aggregator (1Hz)
**Pourquoi** : on veut voir la courbe en temps réel, pas après close.
**Design** : poll Postgres `positions` table toutes les secondes, recalcule unrealized via last prices.

### F1.5 — Kill-switch global
**Pourquoi** : en cas de bug, tout stopper instantanément.
**Trigger** : endpoint + commande Telegram `/kill` + auto-trigger si drawdown > 15%.

---

## Risk Engine

### F2.1 — Kelly fraction avec cap
**Pourquoi** : Kelly maximise la croissance log-wealth. Sans cap, variance trop haute.
**Formule** : `position_size = min(kelly_full * 0.25, max_size_abs)` — on utilise quart-Kelly.
**Inputs** : win_prob, avg_win, avg_loss (fenêtres rolling 30j).

### F2.2 — Position sizing par volatilité (ATR)
**Pourquoi** : un stock à 30% vol ne devrait pas avoir la même taille qu'un à 10%.
**Formule** : `size = risk_budget / ATR_14`.
**Applicable à** : S2 PEAD, S4 Momentum.

### F2.3 — Stop-loss par position
**Design** :
- Hard stop : -2x ATR depuis entry
- Time stop : max_hold_sec dépassé → close
- Trail stop : pour gains > 2R, suivre avec 1.5x ATR

### F2.4 — Circuit breakers portefeuille
**Design** :
- Perte intraday > 3% → pause toutes stratégies 1h
- Perte hebdo > 6% → pause toutes 24h
- Drawdown > 12% → kill-switch, nécessite relance manuelle
- Corrélation réalisée > 0.7 entre 2 stratégies → scale down la moins perfo

### F2.5 — Margin / Exposure limits
**Design** :
- Gross exposure < 150% du capital
- Net exposure ∈ [-50%, +100%] (biais long)
- Concurrent positions per strategy ≤ N_max (défini par strat)

---

## Signal Engine

### F3.1 — Feature store
**Pourquoi** : chaque trade doit avoir un snapshot des features pour post-mortem.
**Design** : `trades.features JSONB` stocke {rsi, macd, momentum, vol, news_sent, ...}.
**Usage** : requête SQL pour voir "quelles features corrèlent avec les wins ?".

### F3.2 — Signal deduplication
**Pourquoi** : bug classique = re-trigger signal = double position.
**Design** : hash(strategy + symbol + timestamp_rounded_to_minute) = signal_id déterministe. INSERT ON CONFLICT DO NOTHING.

### F3.3 — Confidence scoring
**Pourquoi** : tous les signaux ne se valent pas.
**Design** : chaque signal produit `confidence ∈ [0, 1]`. Sizer multiplie par confidence avant Kelly.

### F3.4 — Regime filter
**Pourquoi** : momentum marche mal en régime mean-reverting et vice-versa.
**Design** :
- VIX < 20 + SPY trend positif 50j → "bull trending"
- VIX > 25 + SPY trend négatif → "bear"
- VIX entre 15-25 + trend flat → "choppy"
- Chaque stratégie déclare dans quels régimes elle est active.

---

## Stratégie S1 — Polymarket

### F4.1.1 — EV engine amélioré
**Porter depuis Rust** : la logique dans `ev_engine.rs`.
**Principe** :
```
EV = P(win) × profit_if_win - (1 - P(win)) × loss_if_lose
où P(win) vient de :
  - CLOB price (baseline)
  - Manifold cross-check (si disponible)
  - News sentiment
  - Historical calibration (courbe de bias des prix YES par domaine)
```
Place si EV > threshold ET confidence > 0.85.

### F4.1.2 — Calibration par domaine
**Pourquoi** : les prix YES sont biaisés différemment en Politics vs Crypto vs Sports.
**Design** : stocker historique résolu, calculer bias par bucket (domain × price_range × time_to_resolution). Appliquer correction.

### F4.1.3 — Limit order + watchdog
**Déjà implémenté**. Garder tel quel.

### F4.1.4 — Resolution polling exponential backoff
**Nouveau** : remplacer le polling fixe 5min.
```
checks at: expiry+30s, +60s, +2min, +5min, +15min, +1h, +3h
```

### F4.1.5 — Liquidity filter dynamique
**Nouveau** : ne pas entrer si orderbook depth < 3x our size, même si price est dans la range.

---

## Stratégie S2 — PEAD

### F4.2.1 — Earnings calendar feed
**Source** : Alpaca calendar endpoint.
**Cache** : refresh quotidien à 04:00 UTC.

### F4.2.2 — Earnings surprise calculator
**Inputs** : reported EPS, consensus EPS, revenue actual/estimate, guidance update.
**Output** : composite surprise score 0-100.

### F4.2.3 — Entry logic
```python
if surprise_score > 70 and volume_ratio > 1.5 and price_gap > 2%:
    size = risk_budget / (ATR_14 * price)
    enter long at J+1 open
    stop_loss = entry - 2*ATR
    take_profit = entry + 5*ATR or J+45
```

### F4.2.4 — Post-trade analysis
Chaque trade clôturé → update bucket stats (by sector, by surprise magnitude, by market regime).

---

## Stratégie S3 — Funding Arbitrage

### F4.3.1 — Funding monitor
**Design** : toutes les 5min, scan funding rates sur Binance Futures, Coinbase INTX, OKX.
**Trigger** : si |funding_8h| > 0.03% (soit 33% annualisé), investigate.

### F4.3.2 — Delta-neutral execution
**Design** : pour short perp + long spot, sizes calculées pour delta=0.
```
perp_size = -base_size
spot_size = +base_size
total_funding_payment = base_size * funding_rate * 3 (par jour)
```

### F4.3.3 — Risk : basis blow-up
**Risque** : si spot et perp décorrèlent, MtM loss peut dépasser funding gained.
**Mitigation** : stop si |basis_spread| > 0.5% sur 1h.

---

## Stratégie S4 — Momentum + News

### F4.4.1 — Universe screening
**Weekly screen** : SP500 ∩ avg_volume > $10M ∩ price > $5 → ~300 names.

### F4.4.2 — Momentum score
**Formule** : `score = z_score(return_20d) * 0.6 + z_score(return_60d) * 0.4`.

### F4.4.3 — News overlay (Alpaca News API)
**Query** : headlines last 24h par ticker, sentiment score.
**Filter** : prends les top 20 momentum ET avg_sentiment > 0.3.

### F4.4.4 — Portfolio construction
- Equal weight le top 10.
- Rebalancer chaque lundi 16:00 UTC (après close vendredi).
- Pas de short (biais long en regime bull-trending seulement).

---

## Stratégie S5 — Cross-Market Arbitrage

### F4.5.1 — Fuzzy matching questions
**Algo** : embed toutes les questions avec sentence-transformers (local), cosine similarity > 0.85 = match candidate.
**Validation** : LLM check (Claude API) pour confirmer que c'est la même question.

### F4.5.2 — Spread monitoring
**Design** : pour chaque paire matched, calcul spread = |P_poly - P_manifold|.
**Trigger** : si spread > 5% ET liquidité suffisante → trade.

### F4.5.3 — Execution synchrone
**Design** : simultanément BUY sur marché sous-priced + SELL sur marché sur-priced.
**Risque** : si un leg fail, on a un naked risk. Mitigation : timeout 10s, unwind l'autre leg.

---

## Data Providers

### F5.1 — Alpaca (market data + news + earnings)
**Usage** : S2, S4. Clés déjà en place.
**Limits** : 200 req/min, largement suffisant.

### F5.2 — Polymarket CLOB (markets + prices + orders)
**Usage** : S1, S5.

### F5.3 — Manifold API
**Usage** : S1 (validation), S5 (arb).

### F5.4 — Binance / Coinbase (crypto)
**Usage** : S3, future crypto strategies.
**Library** : ccxt (Python).

### F5.5 — FRED (VIX, rates, macro)
**Usage** : regime filter (F3.4).
**Gratuit**.

### F5.6 — SEC EDGAR (Form 4 insider trades)
**Usage** : S6 (future) — insider buy cluster signal.
**Gratuit**.

---

## Observability

### F6.1 — Structured logging (JSON)
**Tous les services** loggent en JSON avec fields : `{time, level, service, event, details}`.

### F6.2 — Grafana dashboards
- Overview : P&L cumulé, par stratégie, drawdown
- Per-strategy : win rate, avg trade, Sharpe daily
- Execution : slippage réalisé, fills missed, latence par venue
- Alerts : signaux générés, trades bloqués par risk

### F6.3 — Daily performance email (HTML)
**Contenu** :
- P&L net jour / semaine / mois
- Top/bottom 5 trades
- Signaux non exécutés (et pourquoi)
- Anomalies (slippage > 2x median, etc.)

### F6.4 — Post-mortem automatique
Chaque trade fermé > 30min après → job background qui :
- Compare prix exit vs best-possible (plus haut après entry pour long)
- Calcule "alpha laissé sur la table"
- Logge dans `trade_analysis` table

---

## Tooling / DevOps

### F7.1 — CI/CD GitHub Actions
**Pipeline** : lint → type-check → unit tests → backtest validation → docker build → push.
**Deploy** : manuel (pour sécurité) via `gcloud run deploy`.

### F7.2 — Secret management
**Outil** : Google Secret Manager.
**Règle** : aucun secret en `.env` commité. Injection runtime uniquement.

### F7.3 — Paper → live toggle
**Mécanisme** : variable env `MODE=paper|live-reduced|live-full`.
**Safety** : `live-full` requiert confirmation manuelle via endpoint `/confirm-live` avec token OTP.
