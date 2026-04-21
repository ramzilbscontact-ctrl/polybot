# 03 — Architecture Unifiée

## Problème actuel

On a **3 codebases distincts** :
1. TypeScript `polybot` sur le serveur (Polymarket + Nordic stubs) — actif
2. Rust `polymarket-bot` sur Mac (EV engine, calibration) — local
3. Rust `agenzia-core` sur Mac (crypto OFI/VPIN) — local

Plus ma framework Python de backtesting.

**Conséquence** : code dupliqué, configs éclatées, pas de vue unifiée du P&L.

## Architecture cible : mono-repo, multi-runtime

```
polybot/                                        (GitHub, git-tracked)
├── apps/
│   ├── gateway/              # Service central (TypeScript/Node)
│   │   ├── api-server.ts     # REST + WS pour les stratégies
│   │   ├── pnl-aggregator.ts # P&L temps réel consolidé
│   │   └── telegram-bus.ts   # Routing toutes les notifs
│   │
│   ├── strategy-polymarket/  # S1 (TypeScript, existe déjà)
│   ├── strategy-pead/        # S2 (Python — vectorbt)
│   ├── strategy-funding/     # S3 (Python — ccxt async)
│   ├── strategy-momentum/    # S4 (Python — pandas + Alpaca)
│   └── strategy-xarb/        # S5 (TypeScript — cross Manifold/Kalshi)
│
├── libs/
│   ├── broker-alpaca/        # Wrapper Alpaca (Python + TS)
│   ├── broker-polymarket/    # Wrapper CLOB
│   ├── broker-crypto/        # Wrapper Binance/Coinbase (ccxt)
│   ├── data-providers/       # News API, EDGAR, FRED, earnings
│   ├── signal-engine/        # Framework commun signaux
│   ├── risk-engine/          # Kelly, position sizing, stop-loss
│   ├── backtest/             # Framework backtest (existe)
│   └── db/                   # Postgres schemas + migrations
│
├── infra/
│   ├── docker/               # Dockerfiles par app
│   ├── terraform/            # Cloud Run + Cloud SQL + Secrets
│   └── monitoring/           # Grafana dashboards, alertes
│
├── scripts/
│   ├── benchmark/            # Framework benchmark (ce dir)
│   └── paper-loop/           # Launcher paper trading
│
└── docs/
    └── master-plan/          # Ce dossier
```

## Communication inter-services

Chaque **stratégie** est un **service indépendant** qui :
- Consomme des données de marché (via libs)
- Produit des **signaux** (buy/sell/size/reason)
- Envoie les signaux au **gateway**
- Le gateway route vers l'**executor** approprié (Alpaca, CLOB, Binance)
- L'executor répond avec **fills réels ou simulés**
- Le **pnl-aggregator** consolide tout dans Postgres
- Le **telegram-bus** route les notifs importantes

### Format signal standardisé

```typescript
interface Signal {
  id: string;              // UUID
  strategy: string;        // 's1-polymarket' | 's2-pead' | ...
  timestamp: number;       // ms epoch
  
  action: 'BUY' | 'SELL' | 'CLOSE';
  symbol: string;          // 'AAPL' | '0x123...tokenId' | 'BTC-PERP'
  venue: 'alpaca' | 'polymarket' | 'binance';
  
  size_usd: number;        // Kelly-sized
  confidence: number;      // 0-1
  
  entry_price: number;
  stop_loss?: number;
  take_profit?: number;
  max_hold_sec: number;
  
  reason: string;          // Human-readable pour logs + Telegram
  features: Record<string, number>;  // Tous les inputs qui ont déclenché
}
```

## Modèle de données unifié (Postgres)

```sql
CREATE TABLE strategies (
  name TEXT PRIMARY KEY,
  description TEXT,
  active BOOLEAN DEFAULT true,
  max_capital_usd NUMERIC,
  max_drawdown_usd NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE signals (
  id UUID PRIMARY KEY,
  strategy TEXT REFERENCES strategies(name),
  timestamp TIMESTAMPTZ NOT NULL,
  action TEXT,
  symbol TEXT,
  venue TEXT,
  size_usd NUMERIC,
  confidence NUMERIC,
  entry_price NUMERIC,
  features JSONB,
  reason TEXT
);

CREATE TABLE trades (
  id UUID PRIMARY KEY,
  signal_id UUID REFERENCES signals(id),
  strategy TEXT REFERENCES strategies(name),
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  symbol TEXT,
  venue TEXT,
  side TEXT,
  size_usd NUMERIC,
  entry_price NUMERIC,
  exit_price NUMERIC,
  pnl_gross NUMERIC,
  fees NUMERIC,
  slippage NUMERIC,
  pnl_net NUMERIC,
  status TEXT  -- 'open' | 'closed' | 'cancelled'
);

CREATE TABLE positions (
  strategy TEXT,
  symbol TEXT,
  venue TEXT,
  size_units NUMERIC,
  entry_price_avg NUMERIC,
  unrealized_pnl NUMERIC,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (strategy, symbol, venue)
);

CREATE TABLE daily_pnl (
  date DATE,
  strategy TEXT,
  realized_pnl NUMERIC,
  unrealized_pnl NUMERIC,
  gross_exposure NUMERIC,
  num_trades INT,
  win_rate NUMERIC,
  sharpe_daily NUMERIC,
  PRIMARY KEY (date, strategy)
);

CREATE INDEX idx_trades_strategy_closed ON trades(strategy, closed_at);
CREATE INDEX idx_signals_strategy_ts ON signals(strategy, timestamp);
```

## Environnements

| Env | Data source | Broker | Usage |
|-----|-------------|--------|-------|
| `dev` | Historical CSV | Mock broker | Backtest |
| `paper` | Live data | Paper Alpaca / Polymarket paper | Validation 30j |
| `live-reduced` | Live data | Real $5k capital | Phase ramp-up |
| `live-full` | Live data | Real $100k capital | Production |

## Principes d'architecture

1. **Fail-safe par défaut** : tout circuit breaker en bas, tout DRY_RUN=true par défaut
2. **Idempotence** : un signal réémit ne doit pas produire un second trade (dedup par `signal_id`)
3. **Observability** : chaque trade log features JSONB → on peut tout rejouer/analyser
4. **Seperation of concerns** : stratégies ne connaissent pas les brokers (passent par gateway)
5. **Language pragmatism** : Python pour data/ML, TypeScript pour I/O-heavy, Rust nulle part (complexité > bénéfice pour notre usage)

## Migration depuis l'existant

**Étape 1** — Garder le TypeScript polybot tel quel, wrapper comme service `strategy-polymarket` derrière le gateway.

**Étape 2** — Porter la logique **EV engine** du Rust polymarket-bot en TypeScript (les 200-300 lignes qui comptent). Pas besoin de garder le Rust.

**Étape 3** — Développer les 4 autres stratégies en Python (plus rapide, meilleurs libs data science).

**Étape 4** — Retirer le code Rust dead (agenzia-core) — ses features (OFI/VPIN) nécessitent du HFT qui est mort pour nous.

**Le Rust agenzia-core n'apporte rien depuis Iowa**. Il est conçu pour du market making qui requiert colo. On le mettra en archive.
