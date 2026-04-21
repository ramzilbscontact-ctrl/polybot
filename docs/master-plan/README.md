# MASTER PLAN — Polybot Trading System

Plan complet d'analyse, benchmark, architecture et roadmap pour **maximiser le P&L** avec les contraintes physiques du serveur (Google Cloud Iowa).

## Table des matières

1. **[00_EXECUTIVE_SUMMARY.md](00_EXECUTIVE_SUMMARY.md)** — Résumé exécutif, objectif, cible P&L
2. **[01_PHYSICAL_CONSTRAINTS.md](01_PHYSICAL_CONSTRAINTS.md)** — Latences mesurées, ce qu'on peut/ne peut pas faire
3. **[02_STRATEGY_PORTFOLIO.md](02_STRATEGY_PORTFOLIO.md)** — 5 stratégies sélectionnées + rationale
4. **[03_UNIFIED_ARCHITECTURE.md](03_UNIFIED_ARCHITECTURE.md)** — Mono-repo, services, schemas DB
5. **[04_FEATURE_BREAKDOWN.md](04_FEATURE_BREAKDOWN.md)** — Chaque feature, chaque choix justifié
6. **[05_BENCHMARK_METHODOLOGY.md](05_BENCHMARK_METHODOLOGY.md)** — Critères Go/No-Go, validation 7 étapes
7. **[06_IMPLEMENTATION_ROADMAP.md](06_IMPLEMENTATION_ROADMAP.md)** — 16 semaines, jalons, risques
8. **[07_ANTI_VIBETRADING_FRAMEWORK.md](07_ANTI_VIBETRADING_FRAMEWORK.md)** — ⚠️ Priorité N°1 — Framework Longmore, théorie de l'edge avant tout backtest

## TL;DR

| Quoi | Où | Pourquoi |
|------|-----|----------|
| **Polymarket favorites** (S1) | TypeScript polybot serveur | Edge retail-beat, déjà 95% ready |
| **PEAD** (S2) | Python + Alpaca | 40 ans de littérature, robuste |
| **Funding arb** (S3) | Python + ccxt | Edge asymétrique demande leverage |
| **Momentum + News** (S4) | Python + Alpaca | Underreaction + sentiment overlay |
| **Cross-market arb** (S5) | TypeScript multi-connector | Edge de fragmentation |

**Portefeuille composite cible** : Sharpe 1.4-1.8, return +18-25% sur 12 mois, max DD -12%.

## Framework de benchmark

Situé dans `scripts/benchmark/` :
- `metrics.py` — métriques standards (Sharpe, Sortino, Calmar, VaR, CVaR…)
- `walk_forward.py` — rolling IS/OOS pour détecter l'overfit
- `monte_carlo.py` — bootstrap pour tester la robustesse
- `run_full_suite.py` — orchestrateur Go/No-Go auto

Commande type :
```bash
python scripts/benchmark/run_full_suite.py \
  --symbol SPY --strategy momentum \
  --is-start 2022-01-01 --is-end 2025-12-31
```

Sortie : rapport `.md` + JSON dans `scripts/benchmark/reports/`, décision GO/NO-GO automatique.

## Les 4 interdictions absolues

1. ❌ **Pas de HFT Nordic/NYSE/NASDAQ** — latence Iowa trop haute
2. ❌ **Pas de stratégie en live sans passer les 7 étapes de validation** (backtest → walk-forward → MC → paper → live-reduced → live-full)
3. ❌ **Pas de secrets en `.env` committé** — tous en Secret Manager
4. ❌ **Pas de backtest sans théorie de l'edge écrite** — répondre à "qui me paye et pourquoi ?" avant tout code (framework Longmore, doc 07)

## Les 4 principes directeurs

1. ✅ **Edge structurel > complexité technique** — préférer 5 stratégies simples décorrélées à 1 stratégie sophistiquée
2. ✅ **Kelly sizing ¼ cap** — maximise croissance log-wealth sans ruine
3. ✅ **Kill-switch partout** — drawdown 12% = arrêt automatique, pas de discussion
4. ✅ **Humain → théorie, IA → implémentation** — l'IA ne génère jamais la stratégie, seulement le code qui teste une hypothèse humaine

---

*Dernière mise à jour : 2026-04-21. À actualiser après chaque jalon.*
