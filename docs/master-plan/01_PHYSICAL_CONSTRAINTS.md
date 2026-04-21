# 01 — Contraintes Physiques & Edge Géographique

## Localisation du serveur
**Google Cloud `us-central1`** (Council Bluffs, Iowa) — datacenter majeur.

## Latences mesurées / estimées

| Destination | Latence aller-retour | Viable pour HFT ? |
|-------------|---------------------|-------------------|
| CME (Chicago Data Center, Aurora IL) | **3-5 ms** | ⚠️ Limite, face à <0.5ms colo |
| NYSE (Mahwah NJ) | 15-20 ms | ❌ Trop lent |
| NASDAQ (Carteret NJ) | 15-20 ms | ❌ Trop lent |
| Alpaca API (AWS us-east-1) | 20-30 ms | ✅ Pas besoin HFT |
| Polygon blockchain (Polymarket) | 30-50 ms | ✅ Finalité > latence |
| Binance (AWS Tokyo) | 150-180 ms | ✅ Pas HFT ordre book |
| Coinbase (AWS us-east-1) | 20-30 ms | ✅ Pas HFT |
| Nasdaq Helsinki | 80-100 ms | ❌ **Nordic HFT MORT** |
| Nasdaq Stockholm | 80-100 ms | ❌ Nordic HFT MORT |

## Ce que ça implique

### ❌ Stratégies NON viables depuis Iowa
1. **HFT order book NYSE/NASDAQ** — colocateurs à 0.1ms, on est à 15ms. Mort.
2. **Nordic HFT stat-arb lead-lag** — 80ms de latence vs fenêtre 4-150ms. Mort.
3. **Market making haute fréquence** — requiert colo + quotes en microsecondes.
4. **Arbitrage d'exchange intra-seconde** — même topologie que market making.

### ⚠️ Stratégies PARTIELLEMENT viables
1. **CME futures HFT** (3-5ms) — possible mais extrêmement compétitif. Skip.
2. **Triangular arb crypto** — dépend du nombre d'exchanges et de leur localisation.

### ✅ Stratégies PLEINEMENT viables
1. **Polymarket prediction markets** — finalité 2-5s, latence irrelevante.
2. **News sentiment trading** (stocks/crypto) — event-driven, fenêtres de minutes.
3. **PEAD — Post-Earnings Announcement Drift** — holding days/weeks.
4. **Pairs trading cointégré** — holding hours/days.
5. **Momentum cross-sectional** — holding days/weeks.
6. **Funding rate arbitrage crypto** — holding days, latence irrelevante.
7. **Volatility risk premium** (short vol sur VIX / ETH vol) — hedging daily.
8. **Merger arbitrage** — holding weeks/months.
9. **Options IV skew / unusual activity** — signal daily, execute daily.

## Edge structurel possible par stratégie

Un "edge structurel" signifie une raison fondamentale pour laquelle l'alpha persiste.

| Stratégie | Edge structurel | Persistance |
|-----------|----------------|-------------|
| Polymarket | Marchés illiquides, peu de bots sophistiqués, retail biased | **Forte** |
| PEAD | Bias comportemental institutionnel, attention limitée | **Forte** (40+ ans) |
| Pairs trading | Relations fondamentales stables court terme | Moyenne |
| Funding arb | Demande asymétrique de leverage long | Forte |
| News sentiment | Dispersion information, traitement NLP non trivial | Moyenne |
| Momentum | Underreaction comportementale | Moyenne |
| VIX short vol | Peur payée > réalisée en moyenne | Forte (dangereuse) |
| Merger arb | Capital limité, spreads rémunèrent attente | Forte |

## Conclusion opérationnelle

**Notre portefeuille cible** doit combiner :
- 40% Polymarket (edge le plus fort)
- 25% PEAD + momentum US equities (Alpaca paper ready)
- 20% Funding arb crypto (simple, robuste)
- 10% News sentiment (augmente les autres)
- 5% R&D / expérimentations

**Interdit** : tout ce qui nécessite <10ms de latence côté exchange.
