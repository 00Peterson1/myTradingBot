# Quantitative research workstation

The intended workflow is research → backtesting → validated demo evaluation → explicitly eligible live execution. Lifecycle promotion gates are still pending. See [the milestone review](docs/MILESTONE_REVIEW.md) for evidence and remaining work.

| Command | Behavior |
|---|---|
| `npm run doctor` | Read-only configuration and database diagnostics |
| `npm run doctor -- --connectivity` | Public market-data connection check |
| `npm run doctor -- --demo-connectivity --proposal 1HZ10V` | Demo authentication, balance, portfolio and configured CALL quote; no orders |
| `npm run migrate` | Transactional, versioned SQLite migrations and integrity check |
| `npm run markets` | Cached catalogue or public discovery; distinct market categories |
| `npm run research:daemon` | Persist tick batches and derived features |
| `npm run research` | Exploratory survey; saves profiles, not raw survey ticks |
| `npm run backtest -- --symbols 1HZ10V` | Registered validation study with development walk-forward, declared parameter neighbors and a one-time final holdout |
| `npm run experiments` | List recent experiment/study IDs |
| `npm run experiments -- --id HASH --output PATH` | Export a verified input/code/attempt bundle without overwriting an existing file |
| `npm run trade:demo` | Options runner with durable accounting, capability checks and settlement reconciliation; eligibility gates still pending |
| `npm run trade:live` | Options runner requiring explicit live switches; deployment validation remains incomplete |

`SYMBOLS` selects instruments. Discovery does not establish contract availability, strategy suitability or CFD access. Options capabilities are checked for the requested type and duration before quoting. Unsupported durations are rejected; there is no automatic duration substitution. CFD execution requires a separate adapter and is not implemented.

`CONTRACT_DURATION`, `CONTRACT_DURATION_UNIT` and `BACKTEST_PAYOUT_MULTIPLIER` define simulation assumptions. A fixed payout and declared tick entry delay do not reproduce historical broker quotes. Operational money/risk handling currently supports USD. `MAX_SYMBOL_EXPOSURE_FRACTION` and `MAX_STRATEGY_EXPOSURE_FRACTION` cap combined reserved/open costs; both default to 0.05.

`MAX_TICK_GAP_SECONDS` defaults to 60. Larger gaps block a symbol, and a public-feed disconnect blocks all active streams. Restarting creates fresh state and repeats warm-up; settlement reconciliation continues while the runner stays open. Backtests reject interrupted periods. Segment or recollect data deliberately; increasing the threshold to obtain a pass does not repair missing ticks.

The validation CLI reserves the last 20% of observations before development evaluation. It requires sufficient trades, a positive block-bootstrap lower confidence bound, declared family-neighbor robustness, and DSR/BY selection correction before consuming the holdout. A holdout interval cannot be reused by changing its prices or taking an overlapping subset. Attempts and failures remain recorded. Missing search history or undefined statistics yields insufficient evidence. The registry counts recorded hypotheses conservatively; it cannot account for experiments performed outside it. PBO remains unavailable without aligned multi-candidate return paths. Results do not automatically promote a strategy.

## Python research model

Use a Python 3 virtual environment, install `python/requirements.txt`, then activate it before running the npm sidecar commands. `npm run sidecar:train -- --pair PAIR_ID` fits normalization only on the raw chronological training split. Validation selects the epoch; the separate final split is evaluated once. Windows and label horizons stay inside each split. A unique research checkpoint records normalization, seed, source/data hashes and losses; repeated use of the same dataset holdout is refused.

Set `MODEL_CHECKPOINT` to that checkpoint before `npm run sidecar:serve`. Prediction input is `{ "pairId": "A-B", "observations": [[epoch, priceA, priceB], ...] }` with exactly 50 synchronized, ordered observations. Training and serving share frozen normalization and identical channels. Old checkpoints and `spreadHistory` requests are incompatible and fail visibly. The model is research-only and is not connected to order eligibility.

Run `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, and `npm run test:python`. Model integration tests require the Python dependencies; otherwise they report skips. Tests do not establish trading edge. Keep credentials in the untracked `.env`; diagnostics redact tokens.
