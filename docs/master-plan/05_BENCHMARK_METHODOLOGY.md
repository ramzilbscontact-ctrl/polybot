# 05 — Benchmarking & Validation

## Principe général

**Une stratégie n'a pas d'edge tant qu'elle n'a pas survécu :**
1. Backtest in-sample (2 ans minimum)
2. Backtest out-of-sample (12 mois séparés)
3. Walk-forward rolling (6 x 3 mois)
4. Monte Carlo de robustesse (1000 bootstraps)
5. Paper trading live (30-60 jours)
6. Live réduit ($5k) (30 jours)
7. Only then → live full ($100k)

**Aucune stratégie ne passe en live full sans les 7 étapes.**

## Métriques de référence

### Métriques de performance
| Métrique | Formule | Cible min | Cible good |
|----------|---------|-----------|-----------|
| Sharpe ratio | (return - rf) / σ × √252 | 0.8 | 1.5+ |
| Sortino ratio | (return - rf) / σ_downside × √252 | 1.0 | 2.0+ |
| Calmar ratio | annual_return / max_drawdown | 0.8 | 2.0+ |
| Max drawdown | max peak-to-trough | -20% | -10% |
| Max DD duration | jours sous-peak | 90 | 30 |
| Win rate | wins / total trades | 40% | 55%+ |
| Profit factor | sum(wins) / sum(|losses|) | 1.3 | 2.0+ |
| Avg R-multiple | avg_pnl / avg_risk | 0.3 | 1.0+ |
| Exposure time | time_in_market / total_time | — | — |

### Métriques de risque
| Métrique | Cible |
|----------|-------|
| VaR 95% 1-day | < 4% capital |
| CVaR 95% | < 6% capital |
| Tail ratio (99th / 1st perc) | > 1.5 |
| Beta vs SPY | -0.3 to +0.5 |
| Correlation to other strategies | < 0.4 |

### Métriques de robustesse
| Métrique | Méthode |
|----------|---------|
| Walk-forward ratio | oos_sharpe / is_sharpe (> 0.5) |
| Parameter sensitivity | Sharpe range sur ±20% params (< 50% drop) |
| Bootstrap 5% CI Sharpe | Monte Carlo 1000 resamples |
| Regime consistency | Sharpe par régime (bull/bear/choppy) |

---

## Framework de benchmark (scripts/benchmark/)

### Script 1 : `run_backtest.py`
Lance une stratégie sur une période, retourne rapport `.md` + artefacts.

### Script 2 : `walk_forward.py`
Rolling windows IS/OOS. Vérifie qu'il n'y a pas de look-ahead / overfitting.
```
Window 1: IS=2022Q1-Q3, OOS=2022Q4 → Sharpe_oos_1
Window 2: IS=2022Q2-Q4, OOS=2023Q1 → Sharpe_oos_2
...
Walk-forward ratio = mean(Sharpe_oos) / mean(Sharpe_is)
```

### Script 3 : `monte_carlo.py`
Bootstrap les returns 1000 fois → distribution de Sharpe, DD, return.
Rejet si 5th percentile Sharpe < 0.

### Script 4 : `sensitivity_analysis.py`
Grid search ±20% sur chaque paramètre. Retourne heatmap Sharpe.
Rejet si paramètre "sweet spot" — signe d'overfit.

### Script 5 : `paper_to_live_analysis.py`
Compare distribution paper vs live pour détecter :
- Slippage excessif
- Signaux qui marchent pas en vrai
- Bugs d'exécution

### Script 6 : `compare_strategies.py`
Charge N stratégies, sort un tableau comparatif avec toutes les métriques + corrélations.

---

## Protocole de validation 90 jours

### Semaine 1-2 : Backtest complet
Chaque stratégie doit passer :
- [ ] Sharpe IS > 1.0 sur 2 ans
- [ ] Sharpe OOS > 0.8
- [ ] Walk-forward ratio > 0.5
- [ ] Monte Carlo 5% CI Sharpe > 0
- [ ] Sensibilité paramètres < 50% drop

### Semaine 3-4 : Paper trading
- [ ] Déploiement sur serveur, mode paper
- [ ] Signaux loggés dans Postgres
- [ ] Daily P&L tracké, email envoyé
- [ ] Slippage simulé mesuré réaliste (avec ordre book snapshots)

### Semaine 5-8 : Paper trading live (données live, pas simulées)
- [ ] Signaux exécutés contre live prices (ordres fantômes)
- [ ] Comparison realistic fills vs expected
- [ ] Catch bugs (timezone, market holidays, feed glitches)

### Semaine 9-12 : Live réduit ($5k)
- [ ] 1/20 de la taille normale des positions
- [ ] Mesure de divergence paper vs live
- [ ] Si divergence > 20% → retour en paper

### Semaine 13+ : Live full
- [ ] Scale progressif : semaine 13 = $10k, 14 = $25k, 15 = $50k, 16+ = $100k
- [ ] Daily review, weekly deep review, monthly strategy review

---

## Red flags qui disqualifient une stratégie

1. **Sharpe IS > 3.0 mais OOS < 1.0** → overfit
2. **Max DD < 1%** → soit trade jamais, soit bug
3. **Win rate > 95%** → bias de survivance ou look-ahead
4. **Returns en escalier** (pas de variance) → data artifact
5. **Toutes les perfo dans 1 régime** (ex: bull only) → va mourir dans l'autre
6. **Paramètres très sensibles** (±10% = Sharpe div/2) → non-robuste
7. **Exposure time > 98%** → pas vraiment de signal, juste long
8. **Trades trop petits pour couvrir les frais** → négatif en live

---

## Décision go/no-go par stratégie

Après la phase backtest (semaines 1-2), chaque stratégie doit avoir un **rapport signé** :

```markdown
# Strategy S1 — Go/No-Go Report

## Metrics
- Sharpe IS: X.XX
- Sharpe OOS: X.XX  
- Walk-forward ratio: X.XX
- Max DD: -X.X%
- ...

## Red Flags
- [ ] Overfit risk
- [ ] Regime dependence
- [ ] Capacity limit
- [ ] Slippage sensitivity

## Decision
[ ] GO — proceed to paper trading
[ ] NO-GO — reason: ...
[ ] CONDITIONAL — fix X before proceeding

Signed: 2026-MM-DD
```

**Seules les stratégies marquées GO** passent à la phase suivante.
