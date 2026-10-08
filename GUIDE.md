# Quantitative research workstation

The intended workflow is research → backtesting → validated demo evaluation → explicitly eligible live execution. Automated runners enforce registered strategy eligibility; prospective demo evaluation for live promotion remains pending. See [the milestone review](docs/MILESTONE_REVIEW.md) for evidence and remaining work.

| Command | Behavior |
|---|---|
| `npm run doctor` | Read-only configuration and database diagnostics |
| `npm run doctor -- --connectivity` | Public market-data connection check |
| `npm run doctor -- --demo-connectivity --proposal 1HZ10V` | Demo authentication, balance, portfolio and configured CALL quote; no orders |
| `npm run migrate` | Transactional, versioned SQLite migrations and integrity check |
| `npm run markets` | Cached catalogue or public discovery; distinct market categories |
| `npm run research:daemon` | Continuously persist raw ticks for open instruments in the active scope; replay recomputes causal features |
| `npm run research` | Exploratory survey; saves profiles, not raw survey ticks |
| `npm run backtest -- --symbols 1HZ10V` | Registered validation study with development walk-forward, declared parameter neighbors and a one-time final holdout |
| `npm run lifecycle` | List hypothesis states; evidence-backed transitions require an explicit reason |
| `npm run experiments` | List recent experiment/study IDs |
| `npm run experiments -- --id HASH --output PATH` | Export a verified input/code/attempt bundle without overwriting an existing file |
| `npm run trade:demo` | Options runner loading only exact registered demo-eligible hypotheses, with durable accounting and reconciliation |
| `npm run trade:live` | Options runner requiring explicit live switches; deployment validation remains incomplete |

`SYMBOLS` selects instruments. Discovery does not establish contract availability, strategy suitability or CFD access. Options capabilities are checked for the requested type and duration before quoting. Unsupported durations are rejected; there is no automatic duration substitution. CFD demo execution uses the separate cTrader adapter and `cfd:execution` command; automated strategy eligibility is not established.

`CONTRACT_DURATION`, `CONTRACT_DURATION_UNIT` and `BACKTEST_PAYOUT_MULTIPLIER` define simulation assumptions. A fixed payout and declared tick entry delay do not reproduce historical broker quotes. Operational money/risk handling currently supports USD. `MAX_SYMBOL_EXPOSURE_FRACTION` and `MAX_STRATEGY_EXPOSURE_FRACTION` cap combined reserved/open costs; both default to 0.05.

`MAX_TICK_GAP_SECONDS` defaults to 60. Larger gaps block a symbol, and a public-feed disconnect blocks all active streams. Restarting creates fresh state and repeats warm-up; settlement reconciliation continues while the runner stays open. Backtests reject interrupted periods. Segment or recollect data deliberately; increasing the threshold to obtain a pass does not repair missing ticks.

The validation CLI reserves the last 20% of observations before development evaluation. It requires sufficient trades, a positive block-bootstrap lower confidence bound, declared family-neighbor robustness, and DSR/BY selection correction before consuming the holdout. A holdout interval cannot be reused by changing its prices or taking an overlapping subset. Attempts and failures remain recorded. Missing search history or undefined statistics yields insufficient evidence. The registry counts recorded hypotheses conservatively; it cannot account for experiments performed outside it. PBO remains unavailable without aligned multi-candidate return paths. Results do not automatically promote a strategy.

## Python research model

Use a Python 3 virtual environment, install `python/requirements.txt`, then activate it before running the npm sidecar commands. `npm run sidecar:train -- --pair PAIR_ID` fits normalization only on the raw chronological training split. Validation selects the epoch; the separate final split is evaluated once. Windows and label horizons stay inside each split. A unique research checkpoint records normalization, seed, source/data hashes and losses; repeated use of the same dataset holdout is refused.

Set `MODEL_CHECKPOINT` to that checkpoint before `npm run sidecar:serve`. Prediction input is `{ "pairId": "A-B", "observations": [[epoch, priceA, priceB], ...] }` with exactly 50 synchronized, ordered observations. Training and serving share frozen normalization and identical channels. Old checkpoints and `spreadHistory` requests are incompatible and fail visibly. The model is research-only and is not connected to order eligibility.

Run `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, and `npm run test:python`. Model integration tests require the Python dependencies; otherwise they report skips. Tests do not establish trading edge. Keep credentials in the untracked `.env`; diagnostics redact tokens.

## Active scope: real markets

`MARKET_SCOPE=REAL` and `SYMBOLS=ALL` select discovered forex, metals, commodities, crypto, stock indices and stocks. This instrument scope is independent of the account mode: REAL does **not** enable real-money execution. Synthetic instruments and unclassified symbols are excluded from surveys, daemon collection, backtest selection and eligible strategy loading. Existing synthetic data and code are retained for later work. `npm run markets -- --all` can inspect the full catalogue without enabling those instruments for trading.

`npm run markets -- --refresh` refreshes classifications and open/closed flags from the provider. Instruments not offered through this API will not be invented. Discovery does not imply that a particular Options contract is supported; CFD execution uses its separate cTrader adapter and account catalogue.

Run `npm run research:daemon` for continuous collection across selected open markets. Subscriptions stay active instead of rotating away from a symbol. The collector flushes raw ticks every five seconds or 1,000 buffered observations and checks market availability every five minutes. `--duration 60` performs a bounded run. Closed markets are skipped until they reopen. Feed outages remain visible gaps; collection cannot reconstruct missing history. Storage errors stop collection visibly. Features are recomputed during replay instead of persisting potentially mismatched tick-feature rows.

`npm run research` performs exploratory surveys of selected open instruments. `npm run backtest` applies the same scope to stored datasets. Old discontinuous datasets remain unsuitable for continuous replay; collect sufficient new data before validation. Neither command automatically promotes a strategy.

Use `npm run experiments -- --id HASH --replay` to reconstruct a supported catalogue experiment and compare its trade observations with completed attempts. Source, dependencies and resolved settings must match. Runners load the same catalogue factories, preserve hypothesis identity, apply the declared one-tick entry delay, and reject revoked eligibility before a reservation. Live promotion currently refuses requests because a prospective demo validation protocol has not been completed.

### CFD setup checkpoint

CFD support is under implementation. See [the research adherence audit](docs/RESEARCH_ADHERENCE.md) for implemented components and remaining requirements.

The selected connection target is cTrader Open API. Create a Deriv cTrader **demo** account and authorize a cTrader Open API application, then configure these locally (never paste secrets into chat):

- `CTRADER_CLIENT_ID`
- `CTRADER_CLIENT_SECRET`
- `CTRADER_ACCESS_TOKEN`
- `CTRADER_DEMO_ACCOUNT_ID`

Run `npm run cfd:doctor` for local configuration checks, or `npm run cfd:doctor -- --connect` for read-only demo authorization and symbol/position counts. These commands do not submit orders. The Deriv Options token does not replace cTrader OAuth credentials. The CFD simulator is a research component, not a connected broker or validated trading strategy.

### Real-market symbol coverage

Run `npm run markets -- --refresh --coverage` to discover every real symbol returned by the public Options feed and show its research candidates, stored tick count and outstanding requirements. Closed markets remain in this report. The collector subscribes to open selected markets and refreshes discovery; keep `MARKET_SCOPE=REAL` and `SYMBOLS=ALL` to include newly discovered real instruments.

Forex, metals, commodities, crypto, stock indices and individual stocks have separate predeclared research plans. Each symbol is evaluated independently; a plan is not a validated strategy or permission to trade. The survey and backtest share these plans. Stale provider symbols are retired from the active catalogue while their history is retained.

The verified public-feed snapshot on 2026-09-22 contained 43 real symbols (25 forex, 4 metals, 12 indices, 2 crypto). Individual stocks and non-metal commodities were not returned by this feed. See [the complete per-symbol report](docs/REAL_MARKET_COVERAGE_2026-09-22.json). Only two symbols had stored ticks at this checkpoint. CFD availability must be discovered from the authorized cTrader account; Options feed membership does not prove CFD execution support. Corporate actions, financing, sessions and category-specific data requirements listed in the report remain evidence requirements, not implemented data feeds.

Symbol reports include the provider's display name and market/submarket, not just opaque codes. In the public catalogue, `OTC_SPC` is **US 500 (S&P 500)**; it already has momentum, mean-reversion and breakout research candidates. Search it using `npm run markets -- --search 'S&P500' --coverage`. Use the actual provider identifier for data collection/backtesting (`--symbols OTC_SPC`); search aliases are not execution symbols, and this Options-feed identifier must not be assumed to identify a cTrader CFD or an ETF such as SPY. Deriv's [US 500 page](https://deriv.com/markets/stock-indices/us-indices/sp-500) documents the index name.

### Collect recent historical prices

Run `npm run collect:history` to request recent public price ticks for **every discovered real symbol**, including markets that are currently closed. To target the S&P 500, use `npm run collect:history -- --symbols OTC_SPC --count 5000`. Requests are paced and rate-limit responses receive bounded retries. Invalid, unordered, duplicate-timestamp or misaligned response batches are rejected before insertion; collection failures are reported per symbol and cause a nonzero exit status. Repeated imports use the existing database duplicate protection.

The requested count is a maximum, not a promise: the provider may return fewer ticks. This command downloads one recent batch per symbol, not a complete multi-year archive. It preserves gaps and does not fabricate missing observations. These public price ticks support the existing Options research pipeline, not CFD spread/financing simulation. Continue `research:daemon` for continuous raw history. A successful download is not validation or trading eligibility.


### CFD offline workflow

Bid/ask CFD replay and per-symbol research validation are available through `npm run cfd:backtest -- --data DATASET.json --config CONFIG.json [--validate]`. A runnable, clearly labelled software fixture lives in `examples/cfd/`. See [CFD_WORKFLOW.md](docs/CFD_WORKFLOW.md) for input requirements, reconciliation/position-management components, demo verification harness and remaining integration limits. Imported longer bid/ask history must include explicit conversion, margin and financing assumptions; the Options price-history collector is not a substitute. cTrader application approval and actual broker verification remain pending.


### CFD historical research commands

Use `npm run cfd:download -- --help`, `npm run cfd:import -- --help`, `npm run cfd:prepare -- --help`, and `npm run cfd:research -- --help`. [The CFD workflow](docs/CFD_WORKFLOW.md#historical-acquisition-import-and-batch-research) documents the selected Dukascopy source, bounded/resumable acquisition, mandatory cost data, explicitly hypothetical scenarios and per-symbol reports. The CFD plan now requires an account-specific cTrader catalogue; the old 43-symbol Options list is not a CFD universe. After approval, use `npm run cfd:markets -- --refresh --out data/cfd-account-plan.json` to obtain actual broker names and IDs. A missing dataset is an explicit blocker, never silently dropped. cTrader integration and actual broker verification remain pending; none of these commands submits orders.

CFD checkpoint (2026-10-08): `npm run cfd:execution -- --symbol BTCUSD` inspects the configured demo account; `--reconcile` recovers durable order outcomes without submitting trades. The prior minimum-volume BTCUSD test is confirmed closed, but the complete reconnect round-trip harness has not passed. A foreign XAUUSD position currently blocks verification. The refreshed catalogue has 430 entries and 201 real-market candidates; all strategies remain blocked pending historical data/cost evidence. See [CFD workflow](docs/CFD_WORKFLOW.md).

Shared-account update (2026-10-08): the complete `cfd:execution --verify-demo` workflow now passed alongside the existing phone trade, including physical reconnect. The bot manages only its ledger-owned positions. Manual positions remain untouched and do not count against bot stop-risk/position-count limits; shared equity, margin and daily-loss limits still apply. Strategies still require research validation before automated trading.
