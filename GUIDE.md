# myTradingBot — Complete Guide

> ⚠️ This is a research tool. Past performance does not guarantee future results.
> Never risk money you cannot afford to lose.

---

## What this bot does

```
RESEARCH → BACKTEST → DEMO TRADE → (optionally) LIVE TRADE
```

| Step | Command | What happens |
|------|---------|-------------|
| 1. List Markets | `npm run trade:demo -- --list-markets` | Displays complete catalog of all Deriv synthetic & forex markets |
| 2. Research | `npm run research` | Collects live ticks, runs market-type tests, ranks symbols |
| 3. Backtest | `npm run backtest` | Replays collected data through strategies, validates edge |
| 4. Demo trade | `npm run trade:demo` | Places real contracts on your Deriv DEMO account |
| 5. Live trade | `npm run trade:live` | Places real contracts on your Deriv REAL account |

---

## How to Trade Forex, Commodities, Crypto & Stocks

The bot fully supports **Forex pairs** (e.g. `frxEURUSD`, `frxGBPUSD`, `frxUSDJPY`), **Commodities** (`frxXAUUSD` Gold, `frxXAGUSD` Silver), **Cryptocurrencies** (`cryBTCUSD`, `cryETHUSD`), and **Stock Indices** (`US500`, `UT100`).

### 1. View all available symbols:
```bash
npm run trade:demo -- --list-markets
```

### 2. Configure Forex & Commodity symbols in `.env`:
```env
SYMBOLS=frxEURUSD,frxGBPUSD,frxUSDJPY,frxXAUUSD,cryBTCUSD,1HZ10V,BOOM500
```

### 3. Research & Backtest Forex markets:
```bash
npm run research
npm run backtest
```

---

## How to Trade REAL Accounts (Live Trading with Real Money)

To switch from Demo trading to **Real Money Live Trading**:

### Step 1: Get your REAL Deriv API Token
1. Log in at **[app.deriv.com](https://app.deriv.com)** with your **Real Account** (login ID starting with `CR...`).
2. Go to **Account Settings → API Token**.
3. Create a new token named `LiveTradingToken` with **Read + Trade** permissions.
4. Copy the token string (starts with `pat_...`).

### Step 2: Configure `.env` for Live Safety
In `myTradingBot/.env`, update the safety switches:
```env
# 1. Paste your REAL account API token
DERIV_API_TOKEN=pat_your_real_account_token_here

# 2. Disable demo and enable live safety switches
DEMO_TRADING=false
LIVE_TRADING=true
LIVE_CONFIRMATION=true

# 3. Set conservative risk limits
STAKE_AMOUNT=1.00                          # $1 USD per trade to start
MAX_STAKE_PERCENT=0.01                     # Max 1% of balance per trade
MAX_DAILY_LOSS_PERCENT=0.05                # Stop trading if 5% lost in a day
RISK_MAX_DRAWDOWN_FRACTION=0.10            # Emergency kill switch at 10% drawdown
```

### Step 3: Launch Live Trading
Run the dedicated live execution script:
```bash
npm run trade:live
```

> [!WARNING]
> Live trading uses **real money** from your Deriv balance. Always run `npm run research` and `npm run backtest` first to confirm strategy edge before launching live trading.

---

## Supported Contract Types & Options

Set `CONTRACT_TYPE` in `.env` or run with CLI environment overrides:

| Contract Type | `.env` setting | What it trades |
|--------------|---------------|----------------|
| **Auto (Default)** | `CONTRACT_TYPE=AUTO` | Pairs strategies and contract types automatically per market |
| **Rise / Fall** | `CONTRACT_TYPE=RISE_FALL` | `CALL` (Rise) and `PUT` (Fall) directional contracts |
| **Even / Odd** | `CONTRACT_TYPE=EVEN_ODD` | `DIGITEVEN` and `DIGITODD` based on last digit parity |
| **Over / Under** | `CONTRACT_TYPE=OVER_UNDER` | `DIGITOVER` and `DIGITUNDER` based on target barrier (e.g. `DIGIT_BARRIER=5`) |
| **Matches / Differs** | `CONTRACT_TYPE=MATCHES_DIFFERS` | `DIGITDIFF` and `DIGITMATCH` based on digit recurrence frequency |
