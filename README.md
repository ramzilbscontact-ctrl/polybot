<div align="center">

# 🤖 Polybot

### Modular Prediction Market Trading Bot for Polymarket

[![Node.js](https://img.shields.io/badge/Node.js-22.x-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Polygon](https://img.shields.io/badge/Network-Polygon_Mainnet-8247E5?logo=polygon&logoColor=white)](https://polygon.technology)
[![Polymarket](https://img.shields.io/badge/Market-Polymarket_CLOB-00C2FF)](https://polymarket.com)
[![PM2](https://img.shields.io/badge/Daemon-PM2-2B037A?logo=pm2)](https://pm2.keymetrics.io)
[![Telegram](https://img.shields.io/badge/Alerts-Telegram-26A5E4?logo=telegram&logoColor=white)](https://telegram.org)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

*Automatically scans Polymarket for high-probability opportunities across Crypto, Politics, Sports & Pop Culture — with real-time price validation, anti-slippage protection, limit order watchdog, Telegram alerts, and daemon deployment.*

---

</div>

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Strategy](#-strategy)
- [Execution Flow](#-execution-flow)
- [Project Structure](#-project-structure)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Running the Bot](#-running-the-bot)
- [Monitoring & Logs](#-monitoring--logs)
- [Telegram Notifications](#-telegram-notifications)
- [Safety Features](#-safety-features)
- [API Reference](#-api-reference)
- [Disclaimer](#-disclaimer)

---

## 🔍 Overview

Polybot is a **modular, production-ready** trading bot for [Polymarket](https://polymarket.com) — the world's largest prediction market platform. It scans the CLOB (Central Limit Order Book) API continuously, identifies high-probability opportunities, validates them against live market data, and executes orders automatically.

```
Market Scan  →  Signal Detection  →  Price Validation  →  Anti-Slippage  →  Order Execution
    ↑                                                                               |
    └──────────────────────────────── 60s loop ─────────────────────────────────────┘
```

### ✨ Key Features

| Feature | Description |
|---|---|
| 🌍 **Multi-domain** | Crypto · Politics · Sports · Pop Culture |
| 🔁 **Auto-retry** | Exponential backoff on all API calls |
| 💰 **Price validation** | Real-time Binance → CoinGecko fallback |
| 🛡️ **Anti-slippage** | Live bestAsk re-checked before every order (2% tolerance) |
| ⏱️ **Order watchdog** | 5s limit order timeout + automatic cancellation |
| 📊 **Structured logs** | Winston · daily rotation · JSON format |
| 📱 **Telegram alerts** | Real-time notifications: signals, fills, cancels, stop-loss |
| 👻 **Daemon mode** | PM2 · auto-restart · survives reboots |
| 🧪 **Dry-run mode** | Simulate without placing real orders |

---

## 🏗 Architecture

Polybot follows a clean **Connector / Strategy / Executor** pattern inspired by institutional algo-trading frameworks:

```
┌─────────────────────────────────────────────────────────────────┐
│                           main.ts                               │
│                (Orchestrator — wires everything)                │
└──────────┬──────────────────┬──────────────────┬────────────────┘
           │                  │                  │
    ┌──────▼──────┐    ┌──────▼──────────┐  ┌───▼──────────────┐
    │  Connector  │    │    Strategy      │  │ TelegramNotifier │
    │             │◄───│                  │  │                  │
    │ Polymarket  │    │ HighProbStrategy │  │ Startup alerts   │
    │ CLOB API    │    │ - Multi-domain   │  │ Signal alerts    │
    │             │    │ - Signal detect  │  │ Fill alerts      │
    │ + Retry     │    │ - Domain valid.  │  │ Cancel alerts    │
    │ + Timeout   │    └──────────┬───────┘  │ Stop-loss alerts │
    └──────┬──────┘               │          └──────────────────┘
           │               ┌──────▼──────┐
           │               │  Price Feed │
           │               │  Binance    │
           │               │     ↓       │
           │               │  CoinGecko  │
           │               │  (fallback) │
           │               └─────────────┘
    ┌──────▼──────────────────────────────────┐
    │              Executor                   │
    │                                         │
    │  OrderExecutor.ts                       │
    │  - Guard 1: Balance check               │
    │  - Guard 2: Global stop-loss            │
    │  - Guard 3: Anti-slippage (live ask)    │
    │  - Limit Order GTC placement            │
    │  - 5s watchdog + auto-cancel            │
    └──────────────────────────────────────────┘
           │
    ┌──────▼──────┐
    │   Logger    │
    │  (Winston)  │
    │  /logs/     │
    └─────────────┘
```

---

## 📈 Strategy

### High-Probability Favorites (`HighProbStrategy`)

The bot targets markets where the **YES option** is priced between **0.88 and 0.94** on the Polymarket CLOB (using live `bestAsk` price), expiring within **48 hours**.

```
Filter Pipeline:
  ├── ✅ Active market, accepting orders
  ├── ✅ Expiry: 10 minutes → 48 hours
  ├── ✅ bestAsk (YES price): 0.88 – 0.94
  ├── ✅ Domain detected: Crypto / Politics / Sports / Pop Culture
  └── ✅ Domain-specific validation:
         Crypto    → Real price buffer ≥ +$60 above bet threshold (Binance)
         Others    → CLOB liquidity ≥ 500 USDC
```

### Domain Detection (keyword-based)

| Domain | Keywords |
|---|---|
| 🪙 Crypto | `bitcoin`, `btc`, `ethereum`, `eth`, `solana`, `sol`, `xrp`, `doge` |
| 🗳 Politics | `election`, `president`, `senate`, `war`, `ceasefire`, `trump`, `putin`... |
| 🏆 Sports | `NBA`, `NFL`, `FIFA`, `championship`, `tournament`, `F1`, `Olympic`... |
| 🎬 Pop Culture | `album`, `Oscars`, `Grammy`, `Netflix`, `Billboard`, `Taylor Swift`... |

### Risk Profile (per trade)

| YES Price | Profit if WIN | Loss if LOSE | Win Rate Needed |
|---|---|---|---|
| 0.88 | +0.094 USDC.e | -0.784 USDC.e | 89%+ |
| 0.91 | +0.063 USDC.e | -0.784 USDC.e | 92%+ |
| 0.94 | +0.034 USDC.e | -0.784 USDC.e | 95%+ |

> ⚠️ A 2% safety margin is applied to each stake: `effectiveStake = 0.80 × 0.98 = 0.784 USDC.e`

---

## ⚡ Execution Flow

Every signal goes through a 3-guard pipeline before an order is placed:

```
Signal reçu
  │
  ├─ Guard 1 : Solde USDC.e suffisant ?
  │              Non → SKIP (log warning)
  │
  ├─ Guard 2 : Stop-loss global atteint ?
  │              Oui → HALT (bot suspendu + Telegram alert)
  │
  ├─ Guard 3 : Anti-slippage — re-vérifie le bestAsk live
  │              |liveAsk - scanPrice| / scanPrice > 2% → ANNULÉ
  │              OK → on continue
  │
  ├─ Placement Limit Order GTC au prix exact du scan
  │
  └─ Watchdog 5 secondes (polling 800ms)
        ├─ Ordre matched  → ✅ succès + Telegram "REMPLI"
        ├─ Ordre live     → ❌ cancelOrder() + Telegram "ANNULÉ"
        └─ Ordre annulé   → log + on passe
```

### Anti-Slippage Logic

```typescript
const liveAsk  = await connector.getLiveBestAsk(tokenId);
const driftPct = Math.abs(liveAsk - scanPrice) / scanPrice;

if (driftPct > 0.02) {
  // ⛔ Prix a bougé de plus de 2% depuis le scan — on n'entre pas
  return;
}
```

This prevents entering positions where the market has already moved against you between scan and execution.

---

## 📁 Project Structure

```
polybot/
│
├── src/
│   ├── main.ts                      # Entry point & main loop
│   │
│   ├── connectors/
│   │   └── PolymarketConnector.ts   # CLOB API client
│   │                                  (retry · timeout · reconnect)
│   ├── strategies/
│   │   └── HighProbStrategy.ts      # Signal detection & validation
│   │
│   ├── executor/
│   │   └── OrderExecutor.ts         # Order placement, guards & watchdog
│   │
│   ├── price/
│   │   └── PriceFeed.ts             # Live prices (Binance + CoinGecko)
│   │
│   └── utils/
│       ├── logger.ts                # Winston structured logging
│       └── TelegramNotifier.ts      # Real-time Telegram alerts
│
├── logs/                            # Auto-created at runtime
│   ├── polybot-YYYY-MM-DD.log       # All events (JSON, rotated daily)
│   └── errors-YYYY-MM-DD.log        # Errors only (kept 14 days)
│
├── ecosystem.config.js              # PM2 daemon configuration
├── tsconfig.json
├── package.json
├── .env.example                     # ← copy to .env and fill in
└── .gitignore
```

---

## 📦 Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 22.x | `node --version` |
| npm | ≥ 10.x | bundled with Node |
| PM2 | ≥ 6.x | `npm install -g pm2` |
| Polygon wallet | — | MetaMask or similar |
| Alchemy account | — | Free tier works |
| Polymarket account | — | L2 keys via `setup.ts` |
| Telegram Bot | — | Optional — create via @BotFather |

---

## ⚙️ Installation

```bash
# 1. Clone the repository
git clone https://github.com/ramzilbscontact-ctrl/polybot.git
cd polybot

# 2. Install dependencies
npm install

# 3. Install PM2 globally
npm install -g pm2

# 4. Configure environment
cp .env.example .env
nano .env   # Fill in your keys — never share this file
```

---

## 🔧 Configuration

All configuration lives in `.env` (runtime) and `ecosystem.config.js` (PM2):

### Core Variables (`.env`)

```bash
# Wallet
PRIVATE_KEY=<64-char hex>          # Your private key (NO 0x prefix)
POLY_ADDRESS=<0x...>               # Your wallet address
ALCHEMY_URL=<https://...>          # Polygon RPC endpoint

# Polymarket CLOB (generate with: npx ts-node --transpile-only setup.ts)
CLOB_API_KEY=
CLOB_SECRET=
CLOB_PASSPHRASE=

# Telegram (optional — create a bot via @BotFather)
TELEGRAM_BOT_TOKEN=<bot_token>     # Format: 123456:ABC-xyz...
TELEGRAM_CHAT_ID=<chat_id>         # Your personal or group chat ID
```

### Strategy Tuning

```bash
YES_MIN=0.88           # Lower = more opportunities, higher risk
YES_MAX=0.94           # Upper bound on YES price
STAKE_USDC=0.80        # Fixed stake per trade
EXPIRY_MAX_H=48        # Scan markets expiring within 48h
CRYPTO_BUFFER=60       # Minimum $60 buffer above bet threshold
MAX_TRADES=3           # Max concurrent open positions
MAX_LOSS=2.00          # Global stop-loss in USDC.e
DRY_RUN=false          # true = paper trading mode
```

### Anti-Slippage & Order Timing

```bash
MAX_SLIPPAGE=0.02      # 2% max drift between scan price and live ask
ORDER_TIMEOUT_MS=5000  # Cancel limit order after 5 seconds if unfilled
POLL_INTERVAL_MS=800   # Check order status every 800ms
```

### Generate Polymarket API Keys

Before running the bot, generate your L2 CLOB credentials:

```bash
# Make sure .env has PRIVATE_KEY, POLY_ADDRESS, ALCHEMY_URL filled in
npx ts-node --transpile-only setup.ts
# → Writes CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE to .env
```

---

## 🚀 Running the Bot

### Option A — Interactive (recommended for first run)

```bash
npx ts-node --transpile-only src/main.ts
```

### Option B — Daemon mode with PM2

```bash
# Start
pm2 start ecosystem.config.js

# Check status
pm2 status

# View live logs
pm2 logs polybot

# Restart
pm2 restart polybot

# Stop
pm2 stop polybot
```

### Option C — Dry-run (paper trading)

```bash
DRY_RUN=true npx ts-node --transpile-only src/main.ts
# or
DRY_RUN=true pm2 restart polybot
```

### Auto-start on server reboot

```bash
pm2 startup          # Generates systemd/init.d command — run it
pm2 save             # Saves current process list
```

---

## 📊 Monitoring & Logs

### PM2 Dashboard

```bash
pm2 monit            # Real-time CPU/memory/logs dashboard
pm2 status           # Quick process overview
```

### Log Files

```bash
# Live tail — all events
tail -f logs/polybot-$(date +%Y-%m-%d).log

# Errors only
tail -f logs/errors-$(date +%Y-%m-%d).log

# PM2 output
pm2 logs polybot --lines 100
```

### Log Format (JSON)

```json
{
  "ts": "15:32:07",
  "level": "info",
  "context": "HighProbStrategy",
  "message": "Signal détecté",
  "domain": "Crypto",
  "question": "Will BTC be above $80,000 at 5PM ET?",
  "yesPrice": 0.91,
  "minsLeft": 23,
  "reasoning": "Buffer +$1247 (BTC=81247$ vs pari 80000$)"
}
```

---

## 📱 Telegram Notifications

Polybot sends real-time alerts to your Telegram account for every meaningful event:

| Event | Trigger | Message |
|---|---|---|
| 🟢 **Startup** | Bot starts | Version, config summary, wallet address |
| 🎯 **Signal** | Market opportunity found | Domain, question, price, expiry, potential gain |
| ⛔ **Slippage** | Price drifted > 2% | Scan price vs live ask, drift % |
| ✅ **Filled** | Order matched | Fill price, cost, market question |
| ❌ **Cancelled** | Watchdog timeout | Order ID, reason |
| 🛑 **Stop-Loss** | Global loss limit hit | Total loss, configured max |

### Setup

1. Open Telegram → search **@BotFather** → `/newbot`
2. Copy the token (format: `123456:ABC-xyz...`)
3. Start a chat with your new bot
4. Add to `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=your_token_here
   TELEGRAM_CHAT_ID=your_chat_id_here
   ```

> **Finding your Chat ID**: Message [@userinfobot](https://t.me/userinfobot) on Telegram — it replies with your numeric ID.

### Example Telegram Message

```
🎯 Signal détecté

📌 Will BTC close above $85,000 today?
🌐 Crypto
💵 Prix YES : 0.91¢
⏱ Expire dans : 23 min
📊 Mise : 0.784 USDC.e → 0.862 parts
💰 Gain potentiel : +0.078 USDC.e
```

---

## 🛡️ Safety Features

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SAFETY LAYERS                               │
├─────────────────────────────────────────────────────────────────────┤
│  1. Balance check      → Aborts if USDC.e < stake before trade      │
│  2. Safety margin      → Effective stake = stake × 0.98             │
│  3. Max open trades    → Never more than 3 concurrent positions      │
│  4. Global stop-loss   → Bot halts if total loss ≥ 2.00 USDC.e     │
│  5. Crypto buffer      → Only enters if real price $60+ above       │
│                           the bet threshold (Binance verified)       │
│  6. Liquidity filter   → Min 500 USDC CLOB depth required           │
│  7. Anti-slippage      → Rejects order if live ask drifted > 2%     │
│                           from scan price (Guard 3 pre-flight)       │
│  8. Order watchdog     → Cancels unfilled limit orders after 5s     │
│  9. Dry-run mode       → Full simulation without real orders         │
│ 10. Retry + timeout    → 4 retries, 12s timeout per API call        │
│ 11. Graceful shutdown  → SIGTERM/SIGINT caught, stats + Telegram     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🔌 API Reference

### `PolymarketConnector`

```typescript
const connector = new PolymarketConnector(privateKey, alchemyUrl, apiCreds);
await connector.connect();

await connector.getGammaMarkets();                    // Fetch active markets
await connector.getOrderBook(tokenId);                // Order book depth
await connector.placeOrder({ tokenId, price, size, side });
await connector.getUsdcBalance();                     // USDC.e balance
await connector.getLiveBestAsk(tokenId);              // Live ask (anti-slippage)
await connector.getOrderStatus(orderId);              // 'live' | 'matched' | 'cancelled' | 'unknown'
await connector.cancelOrder(orderId);                 // Cancel + returns boolean
```

### `HighProbStrategy`

```typescript
const strategy = new HighProbStrategy(connector, {
  yesMin: 0.88, yesMax: 0.94, stakeUsdc: 0.80, ...
});
const signals = await strategy.scan();   // Returns MarketSignal[]
strategy.markFired(conditionId);         // Prevent duplicate trades
```

### `OrderExecutor`

```typescript
const executor = new OrderExecutor(connector, strategy, {
  maxOpenTrades:       3,
  maxTotalLoss:        2.00,
  dryRun:              false,
  maxSlippagePct:      0.02,    // 2% tolerance
  limitOrderTimeoutMs: 5_000,   // Cancel after 5s
  pollIntervalMs:      800,     // Check status every 800ms
}, telegramNotifier);

await executor.processSignals(signals);
console.log(executor.stats);
// → { tradeCount, openTrades, cancelCount, totalLoss, stopped }
```

### `TelegramNotifier`

```typescript
const tg = new TelegramNotifier(botToken, chatId);

await tg.notifyStartup(config);
await tg.notifySignal(signal);
await tg.notifySlippage(signal, liveAsk, driftPct);
await tg.notifyFilled(signal, orderId, fillPrice);
await tg.notifyCancelled(signal, orderId, reason);
await tg.notifyStopLoss(totalLoss, maxLoss);
await tg.notifyTest();  // Connectivity check
```

### `PriceFeed`

```typescript
const { price, source } = await getPrice('BTC');              // Binance → CoinGecko
const ticker    = detectTicker('Will BTC hit $90k?');         // → 'BTC'
const threshold = parseThreshold('Will BTC hit $90,000?');    // → 90000
```

---

## ⚠️ Disclaimer

> **This software is provided for educational purposes only.**
>
> Prediction market trading involves substantial risk of financial loss. Past performance does not guarantee future results. The bot's strategy does not guarantee profitability — high-probability markets can and do resolve incorrectly.
>
> - Never trade with funds you cannot afford to lose
> - Always test with `DRY_RUN=true` before using real money
> - Start with minimal stakes to validate the system
> - The authors are not responsible for any financial losses
>
> **Use at your own risk.**

---

<div align="center">

Built with ❤️ using [Polymarket CLOB API](https://docs.polymarket.com) · [ethers.js](https://docs.ethers.org) · [Winston](https://github.com/winstonjs/winston) · [PM2](https://pm2.keymetrics.io) · [Telegram Bot API](https://core.telegram.org/bots/api)

</div>
