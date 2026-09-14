# Quantitative research workstation

The intended workflow is research → backtesting → validated demo evaluation → explicitly eligible live execution. The current implementation does **not** enforce all of these gates. See [the milestone review](docs/MILESTONE_REVIEW.md) for verified capabilities and remaining defects.

| Command | Current behavior |
|---|---|
| `npm run doctor` | Local configuration and read-only database diagnostics; does not certify trading readiness |
| `npm run doctor -- --connectivity` | Also checks the public market-data connection; no account authorization or orders |
| `npm run migrate` | Initializes the existing SQLite schema; versioned migrations are not implemented |
| `npm run markets` | Lists cached markets; discovers them through the public API when the cache is empty |
| `npm run research:daemon` | Collects and persists tick batches and derived features |
| `npm run research` | Samples ticks in memory and saves exploratory summary profiles |
| `npm run backtest` | Runs preliminary chronological simulations using configured duration/payout assumptions |
| `npm run trade:demo` | Existing Options execution runner; lifecycle, durable accounting and reconciliation remain incomplete |
| `npm run trade:live` | Existing real-account Options runner; not ready for validated deployment |

`SYMBOLS` selects instruments. Instrument discovery does not guarantee availability of a particular contract, duration, account or product. The code includes directional and digit Options strategies with incomplete capability integration. CFD trading is not implemented.

`CONTRACT_DURATION`, `CONTRACT_DURATION_UNIT` and `BACKTEST_PAYOUT_MULTIPLIER` configure simulation assumptions. The executor still contains a duration fallback, so configured equality is not proof of execution parity. Fixed payouts are assumptions, not observed historical quotes.

Run `npm run typecheck`, `npm test`, and `npm run lint` to check engineering health. Passing tests or a preliminary backtest check does not establish an edge, demo eligibility, or live eligibility. Keep credentials in the untracked `.env`; diagnostics redact the token completely.
