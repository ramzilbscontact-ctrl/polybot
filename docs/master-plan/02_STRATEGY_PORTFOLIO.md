# 02 — Portefeuille de Stratégies

## Méthodologie de sélection

Chaque stratégie est évaluée selon 6 critères :
1. **Edge structurel** — raison fondamentale de l'alpha
2. **Capacité** — capital maximum avant saturation du marché
3. **Sharpe réaliste** — après frais, slippage, impact
4. **Corrélation aux autres** — diversification
5. **Complexité tech** — effort d'implémentation
6. **Adéquation Iowa** — compatible avec notre latence

Score composite = moyenne pondérée (edge × Sharpe × 1/corrélation)

---

## Portefeuille cible : 5 stratégies

### S1 — Polymarket High-Probability Favorites ⭐ PRIORITÉ 1

**Principe** : acheter des parts YES à 0.88-0.94 sur des marchés très probables, sortir à résolution.

**Edge structurel** :
- Marchés retail-dominated, mispricing fréquent
- Peu de bots sophistiqués (barrière crypto + API)
- Calibration YES>0.90 → win rate 93%+ historiquement

**Metrics attendues** (d'après le doc PERFORMANCE_ANALYSIS existant) :
- Sharpe : 1.5-2.5
- Win rate : 88-95%
- Capacité : $50-100k avant impact
- Max drawdown : -8%
- Corrélation marché : ~0

**Implementation** : existe déjà à 95% dans le TypeScript polybot sur le serveur.

**Fixes à appliquer** :
1. Activer Telegram (fait)
2. Ajouter enforcement max-loss en USDC réels (pas seulement matched orders)
3. Exponential backoff sur le polling de résolution
4. Cache Binance WS dans le scan initial
5. Fuzzy string matching Manifold

---

### S2 — PEAD (Post-Earnings Announcement Drift) ⭐ PRIORITÉ 2

**Principe** : long les stocks qui beat sur earnings (EPS + revenue + guidance), tenir 20-60 jours.

**Edge structurel** :
- Littérature académique 40+ ans (Bernard & Thomas 1989, etc.)
- Institutionnels limités par mandate/attention
- Drift moyen de 3-7% sur les stocks qui beat ≥5% sur EPS

**Metrics attendues** :
- Sharpe : 0.8-1.2
- Win rate : 58-65%
- Capacité : plusieurs millions $
- Max drawdown : -15%
- Corrélation marché : 0.3 (long-biased)

**Implementation requise** :
- Flux earnings calendar (Alpaca fournit)
- Filter earnings surprise ≥ 5%
- Volume > moyenne (éviter thin trades)
- Entry : J+1 à l'open, exit J+45 ou stop -8%

---

### S3 — Crypto Funding Rate Arbitrage ⭐ PRIORITÉ 3

**Principe** : quand funding rate > seuil, short perp + long spot (ou vice versa). Capturer le funding payment.

**Edge structurel** :
- Demande asymétrique de leverage long (traders retail long-biased)
- Funding annualisé 10-40% quand marché bull
- Edge dure des heures à des jours

**Metrics attendues** :
- Sharpe : 1.0-1.8 (selon régime)
- Win rate : 70-85%
- Capacité : $20-50k par paire
- Max drawdown : -3% (vraiment low-risk si bien hedgé)
- Corrélation marché : ~0

**Implementation requise** :
- Connecteurs Binance Futures + Spot (ou FTX alternative)
- Monitor funding rates (8h cycles)
- Entry si |funding| > 0.05% (annualisé 50%)
- Hedge delta-neutral parfait
- Exit si funding revient à 0 ou inversé

---

### S4 — US Equity Momentum + News Sentiment ⭐ PRIORITÉ 4

**Principe** : long les stocks avec momentum 20-jours positif ET sentiment news positif récent.

**Edge structurel** :
- Underreaction comportementale (Jegadeesh & Titman 1993)
- News sentiment accélère les mouvements
- Combinaison filtrée > momentum pur

**Metrics attendues** :
- Sharpe : 1.0-1.4
- Win rate : 55-62%
- Capacité : millions $
- Max drawdown : -18%
- Corrélation marché : 0.5

**Implementation requise** :
- Alpaca News API (gratuit, déjà on a les clés)
- Sentiment score par ticker (Alpaca retourne positive/negative/neutral)
- Momentum filter 20-jour return > 0
- Univers : Russell 1000 ou SP500
- Rebalancing hebdomadaire

---

### S5 — Manifold/Kalshi/Polymarket Cross-Market Arbitrage ⭐ BONUS

**Principe** : même évènement coté sur plusieurs prediction markets → arb si écart > frais.

**Edge structurel** :
- Marchés segmentés (différentes audiences)
- Peu d'acteurs arbitrent cross-platform
- Edge persiste car friction d'onboarding chaque plateforme

**Metrics attendues** :
- Sharpe : 2.0-3.5 quand ça trigger
- Win rate : 95%+ (arb pur)
- Capacité : **très limitée** ($500-2000 par trade)
- Max drawdown : -2%
- Corrélation marché : ~0

**Implementation requise** :
- Manifold connector existe déjà (TypeScript polybot)
- Ajouter Kalshi connector (API publique)
- Matching fuzzy improved entre questions
- Trigger si spread > 4% (couvre frais des 2 plateformes)

---

## Allocation capital et poids

Avec **$10k paper puis $100k live** :

| Stratégie | Poids $ | Capital | Trades/mois | Trade size |
|-----------|---------|---------|-------------|------------|
| S1 Polymarket favorites | 35% | $3.5k → $35k | 100-200 | $35-350 |
| S2 PEAD | 25% | $2.5k → $25k | 20-40 | $500-5000 |
| S3 Funding arb | 20% | $2k → $20k | 30-60 | $500-3500 |
| S4 Momentum+News | 15% | $1.5k → $15k | 20-40 | $300-3000 |
| S5 Cross-market arb | 5% | $0.5k → $5k | 5-15 | $100-1000 |

## Portefeuille composite attendu

Si les stratégies sont décorrélées (hypothèse réaliste si on calibre bien) :

```
Sharpe composite = sqrt(sum(w_i² × sharpe_i²)) / sum(w_i)
                 ≈ sqrt(0.35²×2.0² + 0.25²×1.0² + 0.20²×1.4² + 0.15²×1.2² + 0.05²×2.5²)
                 ≈ sqrt(0.49 + 0.0625 + 0.0784 + 0.0324 + 0.0156)
                 ≈ sqrt(0.679)
                 ≈ 0.82 (conservateur)
```

Avec de la diversification bonus réelle (corrélations < 0.3) :
```
Sharpe effectif ≈ 1.4-1.8
```

**Cible P&L 12 mois** : +18-25% net sur $100k = $18-25k.
