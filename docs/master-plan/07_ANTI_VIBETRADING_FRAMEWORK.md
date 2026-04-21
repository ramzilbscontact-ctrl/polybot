# Anti-Vibe-Trading Framework
*Basé sur les travaux de Kris Longmore (Robot Wealth) — Priorité N°1*

> *"The scarce resource is not code. It's skepticism, research discipline, statistical thinking that recognises uncertainty, and market intuition."*
> — Kris Longmore

---

## Pourquoi ce document existe

Avec les LLMs, il est désormais trivial de générer un backtest qui "marche". C'est précisément le problème. Longmore identifie une pathologie systémique : le **vibe quanting** — utiliser l'IA pour produire des stratégies backtestées sans jamais comprendre pourquoi elles fonctionnent.

Ce framework est notre garde-fou contre cette pathologie. **Chaque stratégie de ce projet doit y répondre avant d'exister.**

---

## Les 3 maladies identifiées par Longmore

### 1. Le Backtest Cycle of Doom
Optimiser les paramètres → ajouter des filtres → changer de timeframe → changer d'univers → combiner des indicateurs → jusqu'à obtenir un "backtest incroyable".

**Mécanisme de l'illusion** : chaque tweak est un test d'hypothèse implicite. Avec suffisamment d'itérations, la chance statistique garantit de trouver quelque chose qui "marche" sur les données historiques sans aucune signification réelle.

### 2. Le Mode Collapse des LLMs
Tous les LLMs convergent vers les mêmes outputs. En trading, ça produit des stratégies "conventional wisdom" — RSI + MACD + SMA crossover — qui sont les pires idées d'internet en code propre. Ces stratégies sont :
- Connues de tout le monde → pas d'edge
- Backtestées à mort → overfittées sur le passé
- Sans mécanisme économique → aucune raison de persister

### 3. Le Problème des Données d'Entraînement
Les LLMs sont entraînés sur internet. Internet en matière de trading, c'est 95% de bruit. Le LLM ne sait pas distinguer une vraie recherche d'une affirmation populaire. Il reproduit la médiocrité avec confiance.

---

## La Question Fondamentale

**Avant tout backtest, répondre à :**

> **"Qui me paye, et pourquoi continueront-ils à le faire ?"**

Si tu ne peux pas répondre à cette question sans regarder un backtest, la stratégie n'existe pas encore. Elle n'est qu'une série de paramètres.

### Questions de vérification

| Question | Réponse requise avant backtesting |
|----------|----------------------------------|
| Quel est le mécanisme économique ? | Identifier pourquoi l'edge existe structurellement |
| Qui est la contrepartie ? | Nommer le type d'acteur qui perd de l'argent sur ce trade |
| Pourquoi continueront-ils à perdre ? | Contrainte institutionnelle, biais comportemental, ou prime de risque |
| L'edge est-il dans la littérature académique ? | Vérifier la robustesse et l'ancienneté |
| L'edge est-il "obvious" ou "conventional wisdom" ? | Si oui → méfiance maximale (crowded) |
| Est-ce que tu aurais pu prédire la direction avant de voir le backtest ? | Si non → data mining |

---

## Les 4 Sources d'Edge Légitimes

Longmore identifie 4 catégories où les edges réels vivent :

### 1. Primes de Risque
Le marché paye pour porter des risques que d'autres évitent.
- Exemples : volatility risk premium (vendre de la vol), carry trade, credit risk
- Signal : l'edge existe même quand tout le monde le connaît (le risque est réel)

### 2. Provision de Liquidité
Faciliter des transactions pour des participants insensibles au prix.
- Exemples : market making, arb entre venues, absorber les flux d'index rebalancing
- Signal : contrepartie clairement identifiable (fonds indiciels, retail flow)

### 3. Biais Comportementaux
Sous- ou sur-réactions systématiques documentées académiquement.
- Exemples : PEAD (sous-réaction aux earnings), momentum (underreaction), reversal (overreaction)
- Signal : 30+ ans de littérature, mécanisme psychologique identifié

### 4. Contraintes Institutionnelles
Opportunités créées par les règles, mandats, ou structures des grands acteurs.
- Exemples : window dressing, contraintes de compliance autour des earnings, règles d'éligibilité des indices
- Signal : la contrainte est documentée, stable, et non-arbitrable facilement

---

## Division du Travail Homme/IA

Longmore prescrit explicitement :

```
Humain → Théorie de l'edge (POURQUOI ça marche)
  ↓
IA    → Implémentation (CODE, data wrangling, backtest)
  ↓
Humain → Évaluation (EST-CE que les résultats confirment la théorie ?)
```

**L'IA ne doit JAMAIS générer la théorie.** Elle peut seulement implémenter une théorie que l'humain a développée.

### Ce que l'IA fait bien ici
- Écrire le code de backtest
- Nettoyer les données
- Calculer les métriques
- Chercher dans la littérature académique ce que l'humain lui demande
- Générer du code pour tester une hypothèse spécifique

### Ce que l'IA fait MAL ici (et ne doit pas faire)
- "Trouver une stratégie qui marche"
- Proposer des indicateurs à combiner
- Optimiser des paramètres sans contrainte théorique
- Interpréter si un backtest est "bon" sans critères pré-établis

---

## Audit de nos 5 Stratégies

### S1 — Polymarket Favorites

**Mécanisme** : Les marchés de prédiction retail ont des teneurs de marché peu sophistiqués. Les favoris sont systématiquement sous-pricés car les parieurs retail surpondèrent les outsiders (biais de longshot).

**Qui paye** : Les parieurs retail qui overweightent les événements surprenants. Les LPs du marché qui ne font pas de market making sophistiqué.

**Pourquoi ça persiste** : Le biais longshot est documenté depuis Kahneman & Tversky (1979). Les marchés de prédiction sont encore immatures — peu de capital sophistiqué y est déployé.

**Verdict** : ✅ Edge structurel réel. Mécanisme comportemental + structural (plateforme jeune).

**Red flags à surveiller** : Si Polymarket attire du capital institutionnel → edge se ferme.

---

### S2 — PEAD (Post-Earnings Announcement Drift)

**Mécanisme** : Les prix ne s'ajustent pas instantanément aux surprises de résultats à cause de contraintes institutionnelles (fenêtres de compliance, window dressing, slow capital reallocation) et de sous-réaction psychologique (anchoring au prix pré-annonce).

**Qui paye** : Les fonds institutionnels qui ne peuvent pas trader dans les 72h autour des earnings (compliance). Les gestionnaires qui ajustent leurs positions lentement (bureaucratie).

**Pourquoi ça persiste** : Bernard & Thomas (1989), Frazzini (2006), littérature académique de 40 ans. Les contraintes institutionnelles ne disparaissent pas même quand l'effet est connu.

**Verdict** : ✅ L'un des edges les plus solides de la littérature. Robuste précisément parce que le mécanisme (contrainte institutionnelle) ne disparaît pas avec la connaissance.

**Red flags** : Périodes de grande volatilité macro → signal noyé dans le bruit.

---

### S3 — Funding Rate Arbitrage

**Mécanisme** : Sur les marchés de futures perpétuels crypto, les longs paient les shorts quand le marché est bullish (funding rate > 0). C'est une prime de risque payée par ceux qui veulent du levier long sans livraison.

**Qui paye** : Les traders retail leveragés longs qui préfèrent les perps aux futures classiques pour leur commodité. Ils paient une prime pour ne pas gérer les rollovers.

**Pourquoi ça persiste** : Demande structurelle de levier long par retail crypto. Asymétrie documentée — le funding rate est historiquement positif en moyenne.

**Verdict** : ✅ Prime de risque claire. Similaire au carry trade forex.

**Red flags** : Bear market prolongé → funding rate négatif → stratégie inversée.

---

### S4 — Momentum + News

**Mécanisme** : Les investisseurs sous-réagissent aux nouvelles car leur attention est limitée. Le sentiment positif/négatif diffuse lentement dans les prix.

**Qui paye** : Les investisseurs passifs et lents qui ne rééquilibrent pas immédiatement. Les gestionnaires de fonds dont le mandat interdit la réactivité (comités d'investissement).

**Pourquoi ça persiste** : Biais d'attention documenté (Hirshleifer & Teoh, 2003). Momentum académique depuis Jegadeesh & Titman (1993).

**Verdict** : ⚠️ Edge réel MAIS très connu → potentiellement crowded. Notre walk-forward a donné NO-GO (IS Sharpe 1.69, OOS Sharpe -0.34) → **preuve concrète de l'overfitting que Longmore décrit**.

**Action requise** : Ne déployer qu'avec news sentiment réel (edge supplémentaire non-crowded) + universe selection plus ciblé.

---

### S5 — Cross-Market Arb

**Mécanisme** : La fragmentation des marchés crée des prix différents pour le même actif sur des venues différentes. Les coûts de transaction et la latence empêchent l'arbitrage instantané.

**Qui paye** : Les teneurs de marché sur les venues moins liquides qui ne peuvent pas monitorer toutes les venues. Le retail qui trade sur une seule venue sans comparaison.

**Pourquoi ça persiste** : Fragmentation structurelle réglementaire (chaque venue a ses règles). Coûts de connexion et latence limitent qui peut faire l'arb.

**Verdict** : ✅ Edge structurel mais dépend fortement de la latence. Depuis Iowa → arb haute fréquence impossible, mais arb sur quelques secondes/minutes viable sur actifs peu liquides.

---

## Le Test de Longmore : 5 Questions Avant Tout Backtest

Avant de coder quoi que ce soit, répondre à ces 5 questions par écrit :

```
1. En une phrase : quel est le mécanisme qui génère cet edge ?
   → Répondre sans mentionner de paramètres techniques (pas "quand RSI < 30")

2. Qui perd de l'argent sur la contrepartie de ce trade ?
   → Nommer le type d'acteur : retail, institutionnel contraint, market maker lent, etc.

3. Pourquoi continueront-ils à perdre de l'argent dans 5 ans ?
   → La contrainte/biais est-elle structurelle ou temporaire ?

4. Cet edge est-il dans la littérature académique sérieuse ?
   → Chercher les papers (pas les blogs). Note : si c'est dans un blog populaire → méfiance.

5. Si on te donnait les données futures, tu parierais dans quelle direction AVANT de backtest ?
   → Si tu ne sais pas → c'est du data mining, pas de la recherche.
```

**Si tu ne peux pas répondre à toutes les 5 questions → ne pas coder le backtest.**

---

## Checklist Anti-Overfitting (complément à 05_BENCHMARK_METHODOLOGY.md)

En plus des 7 étapes de validation existantes :

- [ ] Théorie de l'edge écrite avant le premier backtest
- [ ] Nombre de paramètres ≤ 3 (chaque paramètre = 1 degré de liberté perdu)
- [ ] Aucun paramètre optimisé sans hypothèse préalable sur sa valeur
- [ ] Universe de test fixé AVANT backtest (pas changé après avoir vu les résultats)
- [ ] Walk-forward ratio > 0.5 (OOS/IS Sharpe) — notre critère existant
- [ ] Résultats cohérents avec la théorie de l'edge (pas juste statistiquement OK)
- [ ] Backtest reproduit sur données d'un autre pays/période si possible (robustesse out-of-domain)
- [ ] Capacité estimée : l'edge s'évapore-t-il si on déploie plus de capital ?

---

## Ce que Longmore dit sur l'Usage des LLMs en Trading

| Usage | Verdict |
|-------|---------|
| Générer une stratégie de trading | ❌ Interdit — mode collapse + data mining garanti |
| Optimiser des paramètres | ❌ Dangereux — fournit de l'overfitting industriel |
| Interpréter si un backtest est bon | ❌ Partial — le LLM dira oui si les métriques semblent bonnes |
| Implémenter une stratégie qu'on a théorisée | ✅ Excellent — c'est pour ça qu'il est fait |
| Chercher des papers sur un mécanisme précis | ✅ Bon outil |
| Nettoyer des données, écrire du code de calcul | ✅ Parfait |
| Critiquer une stratégie qu'on lui présente | ✅ Utile si les questions sont bien posées |

---

## Application Immédiate au Projet

### Ce qui change

1. **Chaque nouvelle stratégie** doit avoir une fiche "Théorie de l'Edge" rédigée dans `02_STRATEGY_PORTFOLIO.md` avant tout code
2. **Le walk-forward NO-GO** de S4 Momentum confirme exactement ce que Longmore prédit : IS/OOS collapse = backtest sans mécanisme réel
3. **L'optimisation de grille** dans `run_full_suite.py` est dangereuse sans contraintes théoriques — limiter à ≤3 paramètres avec valeurs motivées
4. **S4 Momentum** ne peut pas aller en production dans sa forme actuelle — besoin d'un news sentiment layer réel pour justifier l'edge différenciateur

### Prochaines Actions

- [ ] Ajouter la question "Who pays?" dans le rapport Go/No-Go auto (`run_full_suite.py`)
- [ ] Créer template `EDGE_THEORY.md` à remplir avant tout nouveau backtest
- [ ] Limiter param_grid dans walk_forward.py à max 3 paramètres par défaut
- [ ] Documenter la théorie de l'edge pour S2 (PEAD) avant implémentation Python

---

*Sources : [AI Will Create Millions of Quants](https://edgealchemy.robotwealth.com/p/ai-will-create-millions-of-quants) · [Brave New Backtest](https://robotwealth.com/brave-new-backtest/) · [More of the Disease, Faster](https://robotwealth.com/more-of-the-disease-faster-what-happens-when-you-ask-an-llm-to-find-you-an-edge/) — Kris Longmore, Robot Wealth*

*Dernière mise à jour : 2026-04-21*
