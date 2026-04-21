# MASTER PLAN — Polybot Trading System
## Executive Summary

**Objectif unique** : maximiser le P&L net après frais/slippage, sur un horizon de 12 mois, avec le capital et l'infrastructure disponibles.

**Capital cible** : démarrer à $10k paper, scaler à $100k live après 90 jours de validation.

**Contrainte physique principale** : serveur Google Cloud `us-central1` (Council Bluffs, Iowa). Cette localisation détermine TOUT.

---

## Les 4 vérités brutales

1. **Le HFT co-localisé est mort pour nous**. Nasdaq Stockholm à 80ms, NYSE à 15ms, CME à 3-5ms. Seul le CME Chicago est exploitable pour du HFT, et même là nous sommes face à des concurrents co-localisés à <0.5ms. **Abandonner le HFT d'ordre book**.

2. **Polymarket n'a aucune contrainte de latence**. La finalité blockchain est de 2-5 secondes. Iowa ou Tokyo, même combat. C'est **notre meilleur edge structurel**.

3. **Les stratégies event-driven et daily sont agnostiques à la latence**. News sentiment, PEAD, pairs trading, funding arb crypto — tout ça marche aussi bien depuis Iowa que depuis un datacenter co-lo.

4. **Le vrai edge retail vient de la combinaison de signaux indépendants**, pas d'une seule stratégie magique. Un Sharpe 1.0 × 3 stratégies décorrélées = Sharpe composite ~1.7.

---

## Cible P&L réaliste

| Horizon | Stratégie | Capital | Sharpe | Return | Drawdown |
|---------|-----------|---------|--------|--------|----------|
| Mois 1-3 | Paper validation | $10k virtuel | 0.8-1.2 | +3-8% | -5% |
| Mois 4-6 | Live réduit | $5k réel | 1.0-1.5 | +5-15% | -8% |
| Mois 7-12 | Scale-up | $25-100k | 1.5-2.0 | +15-30% | -12% |

**Objectif 12 mois** : +25% net sur $100k = **+$25k**, Sharpe 1.5, max DD -12%.

C'est ambitieux mais réalisable. Beaucoup de fonds professionnels font moins.
