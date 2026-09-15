# Current verification — 2026-09-15

This section supersedes all historical checkpoints below. The Options engineering and research pipeline has been substantially strengthened, but **Milestones 0–7 are not certified complete**, and neither a profitable strategy nor live readiness has been established.

| Milestone | Implemented and checked | Remaining completion evidence |
|---|---|---|
| 0 Tooling | Source/test typechecks, zero-warning lint, build, CLI startup/failure checks, read-only doctor | Broader provider failure traces |
| 1 Domain | Explicit Options/CFD products, validated immutable Options specs, USD minor-unit money, canonical market classification | Canonical portfolio-event integration audit; CFD runtime belongs to M10 |
| 2 Accounting | Durable reservations/intents/events, atomic settlement and risk persistence, exposure caps, transactional versioned migrations | Operational resolution workflow for unknown purchases |
| 3 Execution | Authenticated demo balance/portfolio and real quote verified; strict capabilities; uncertainty blocks orders; settlement/restart tests | Recorded broker purchase/settlement/recovery evidence; no order was placed during verification |
| 4 Backtesting | Ledger-backed cash, fees, delay, expiry, risk constraints and isolated periods | Historical contract quotes/availability and calibrated execution assumptions |
| 5 Replay | Shared causal features, context, warm-up, deterministic consensus and interruption handling; mocked account parity | Complete multi-symbol shared-account scheduling and recorded recovery parity |
| 6 Experiments | Immutable data/code/config/hypothesis/attempt/outcome records; validation selection records; verified bundle export; failed and interrupted attempts visible | Automated reconstruction and replay of arbitrary declared factory closures; full external search history cannot be recovered |
| 7 Validation | Corrected DSR/BY/PBO reference fixtures; seeded segmented block-bootstrap; fold-account aggregation; sensitivity families; sealed holdout and selection; Python split/normalization leakage fixes | Aligned full-search PBO inputs, justified effective trial/dependence policy, richer sensitivity studies and valid continuous market data |
| 8–10 | Deferred | Enforced strategy lifecycle, governance and a separately verified CFD adapter |

## Verified behavior

- Final verification: **181 TypeScript tests across 26 files pass**, including actual fold/registry integration without duplicate hypothesis counting. Source/test typechecks, zero-warning lint, build and `git diff --check` pass.
- Python preprocessing and actual CPU training/checkpoint/FastAPI inference passed **5 tests**, using an isolated dependency environment. Training used a synthetic fixture; its losses are not trading evidence.
- Public connectivity and demo authentication/balance/portfolio passed. After correcting the barrier-count interpretation, `npm run doctor -- --demo-connectivity --proposal 1HZ10V` returned a configured five-tick CALL quote with a **USD 1 ask and USD 1.90 payout**, with zero diagnostic errors. A preceding attempt hit a transient network failure. This is a quote snapshot, not a historical payout assumption or purchase test.
- The provider's `barriers` field counts contract barriers; it does not require a caller-supplied offset. The fix follows the official [contracts schema](https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/contracts_for_response.schema.json) and [proposal schema](https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/proposal_request.schema.json). Unsupported durations still fail; no duration fallback exists.
- The research CLI regression exposed by subprocess tests was repaired. Market discovery preserves research scores/timestamps and uses the central category mapping, including distinct metals and stock indices.
- Migrations 1–3 were applied to the actual local database after a consistent backup at `/tmp/trading-before-migrations-20260915.db`; the integrity check passed. Migration tests cover adoption, idempotency, incompatible history and transactional rollback.
- A real-data backtest of `1HZ10V` rejected interrupted input and exited nonzero. Its 1,881 observations contain **23 gaps over 60 seconds**, with a maximum gap of **76,329 seconds**. The study and failed fold were retained in SQLite. A verified study bundle was exported to `/tmp/trading-validation-study-20260915.json`. These files are local audit artifacts, not deployment artifacts.

## Validation policy and limits

Development selection sees the first 80% only. Predeclared parameter families must have at least two passing neighbors, sufficient trades per fold and at least 100 total, positive expectancy and block-bootstrap lower bound, acceptable worst-fold drawdown, and BY-adjusted DSR evidence. The chosen candidate alone can consume the final 20%, once. Exact repeats and overlapping same-symbol holdouts are refused, including changed-price datasets. A failed final attempt still consumes its holdout. Policies, candidate declarations, decisions and fold/final experiment references are persisted.

The circular block-bootstrap is seeded (1729 by default), uses 2,000 replications and block length 5, and never samples across fold boundaries. These are explicit research settings, not calibrated independence guarantees. Fold accounts reset; aggregate drawdown/streaks use the worst fold instead of inventing a combined account path. Calmar remains unavailable without an appropriate annualized account series. Circular block construction follows the [arch documentation](https://bashtage.github.io/arch/bootstrap/timeseries-bootstraps.html).

Trial variance must be positive and all recorded hypotheses represented before selection can pass. Prior unrepresented searches produce insufficient evidence. This conservative recorded count is not a validated estimate of effective independent trials. PBO uses aligned candidate matrices only; temporal folds are not candidate strategies. Low PBO or passing a simulated holdout does not authorize trading.

Python fits log-price OLS with its intercept and residual normalization on training rows only, then freezes it for validation, test and serving. Raw 70/15/15 splits isolate 50-observation feature windows and 20-observation label horizons. Training is seeded on the CPU reference path. Legacy normalization/checkpoints fail visibly. Python's holdout marker currently prevents exact-dataset reuse within its checkpoint directory; unlike the TypeScript registry it does not detect overlapping revised datasets, and neither mechanism can prove data was never inspected elsewhere.

The remaining items above are explicit completion work. Passing engineering checks must not be relabeled as completion of research validation, CFD support or live deployment.

---

# Historical checkpoints (superseded)

# Current integration checkpoint — 2026-09-15

This checkpoint supersedes the historical milestone status below. The full research-to-trading workflow remains incomplete.

| Milestone | Current evidence | Remaining work |
|---|---|---|
| 0–1 Tooling/domain | Typechecks and zero-warning lint; CLI boundary and Options invariant tests | Provider-connected verification; immutable hypothesis identity |
| 2–3 Accounting/execution | Durable Options ledger, reservations, risk recovery, confirmed settlement and reconciliation tests | Operator resolution of uncertain purchases, schema migration lifecycle and broker verification |
| 4 Backtesting | Ledger-backed cash/fees, delayed entry, explicit expiry, historical risk limits and isolated periods | Historical proposal pricing, availability and calibrated execution assumptions |
| 5 Replay parity | Shared feature/history/warm-up and consensus conversion; mocked purchase/settlement/risk parity | Full multi-symbol account scheduling, recorded provider recovery traces and identical configured suite selection |
| 6 Experiments | Immutable registry integrated with backtest CLI | Replay reconstruction, seed/model identities, trial-count integration and artifact export |
| 7–8 Validation/lifecycle | Not complete | Reference statistics/leakage review and enforced eligibility |
| 9–10 Governance/CFDs | Deferred | V1 prerequisites and a separate verified CFD execution adapter |

## Milestone 7 PBO checkpoint

PBO now uses chronological equal-sized blocks, all complementary train/test assignments, and the selected strategy's out-of-sample relative rank divided by N+1. It retains the logits and counts nonpositive logits. This replaces the previous array-median shortcut and follows the [authors' CSCV description](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf). The block count and evaluated combination count are reported separately.

Malformed/nonfinite/unequal-length matrices are rejected instead of zero-padded. Block counts must be even from 2 through 16 (an explicit exhaustive-computation limit), and observations must divide equally into blocks. Insufficient samples, undefined Sharpe or ambiguous selected rankings return unavailable for the whole estimate; no problematic combination is silently dropped. Ties use relative tolerance 1e-12 and an explicit unavailable policy, rather than choosing the first strategy in array order.

Five deterministic fixtures cover reversed and persistent winners, six assignments from four blocks, a selected median rank, invalid partitions/matrices, and ties/constant returns. The numeric API cannot prove timestamp alignment or complete search history. Walk-forward PBO remains unavailable until genuinely aligned multi-candidate returns exist; temporal folds are not substituted for candidate strategies. A low estimated PBO is not proof of strategy correctness or profitability.

## Milestone 7 statistical correction checkpoint

Deflated Sharpe now uses a zero reference for a single trial, the correct one-quarter kurtosis coefficient in estimator variance, and the same nonnormal variance estimate for its approximate one-sided zero-Sharpe p-value. Multiple-trial DSR requires an explicit reference or variance across trial Sharpe estimates; absent evidence returns unavailable rather than assuming unit variance. Invalid trial counts/variance are rejected and nonfinite return samples are unavailable. The implementation follows [Bailey and López de Prado's DSR paper](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf). A single-trial result is probabilistic Sharpe without a selection correction, not proof that only one trial was searched.

BY multiple-testing adjustment now applies reverse cumulative minima to adjusted p-values, preserves original ordering, validates inputs, and derives rejection from the adjusted values. This matches the procedure in [statsmodels' reference implementation](https://www.statsmodels.org/stable/_modules/statsmodels/stats/multitest.html). Bonferroni documentation no longer incorrectly requires independence.

Four deterministic regression fixtures cover losing single-trial returns, missing/invalid trial information, an independent Python NormalDist numerical calculation, and a hand-calculated BY vector with nonmonotonic raw adjustments. Walk-forward cannot pass when selection-adjusted Sharpe evidence is unavailable or below 0.95. The current CLI does not yet provide across-trial variance and therefore reports missing evidence instead of a statistical pass.

M7 remains incomplete: PBO integration with aligned full-search returns, dependent-return confidence intervals, fold-account aggregation, untouched holdout policy, Python leakage, full search-history/effective-trial estimation and reference test coverage remain outstanding. Formula corrections alone do not validate the underlying samples or establish trading eligibility.

## Experiment registry checkpoint

Backtest CLI folds now register before strategy evaluation. Content hashes identify ordered symbol/time/price inputs, captured TypeScript source/dependency declarations, declared strategy factory source, resolved execution/risk settings, period boundaries and runtime version/platform. Repeated identical registrations reuse the experiment identity and create distinct attempt IDs. Changed input order, prices, configuration or captured code changes identity. Saved code artifacts exclude `.env`, credentials, account databases and model binaries.

Manifest/artifact/attempt/outcome tables reject SQL updates and deletes. Completed attempts retain raw trade observations; failed evaluations retain error messages. Missing outcomes denote interrupted/unfinished attempts. Invalid input rejected before registration is not counted as a registered attempt. `--verbose` displays fold experiment and attempt IDs. The registry is optional for direct library users and enabled by the backtest CLI.

Four fixtures cover identity sensitivity and stable key ordering, unsupported manifest values/transaction rollback, immutable failure records, and registration of actual engine success/failure paths. This records provenance, not a proof that arbitrary factory closures are reproducible. Seed/model artifact identity, reconstruction/export, registry-backed multiple-testing counts, result comparison and lifecycle promotion are pending. Recorded statistical metrics are not certified; completed outcome records deliberately retain raw observations for later re-evaluation. Python/model binaries are not captured by this TypeScript-only path.

## Stream continuity checkpoint

`MAX_TICK_GAP_SECONDS` now declares the maximum accepted interval between events (default 60 seconds). Demo, live and backtest use this same limit, and backtests record the value and rejection policy in run parameters. This is an operational setting, not a calibrated market assumption. A larger gap blocks that symbol's stream; a public-feed disconnect blocks all active streams. Reconnection alone does not clear the block. A restart must create fresh strategies and repeat warm-up, while the running account service continues settlement reconciliation.

Four additional fixtures verify disconnect blocking/fresh warm-up, the exact gap boundary, isolated interleaved symbol state, and rejection of incomplete backtest periods. These verify stream continuity and per-symbol state, not complete multi-symbol account scheduling or recovery of missing provider events. Historical sessions separated by a gap need explicit dataset segmentation; increasing the threshold merely to make an experiment pass is not validation.

## Changes verified in this checkpoint

- Demo, live and replay use `StrategyStream`: 200 prior-event context and first decision on event 50 by default. Backtests recompute features with a cold start in each period. Invalid ticks are rejected before feature state changes.
- Both runners use `VotingEngine.toSignal` instead of independently rebuilding random consensus signals. Consensus IDs are deterministic for the same event, member IDs and voting configuration; these are not immutable experiment IDs.
- Voting rejects malformed signals, different event times/prices and incompatible contract types/barriers. Invalid configuration updates fail before mutation; ties abstain.
- `ConsensusStrategy` can be supplied through the existing backtest strategy factory to evaluate a complete suite. It propagates the online-learner flag so an ensemble cannot conceal a learner from the standard-backtest guard. The CLI still runs its individual candidate list; this wrapper does not establish that its suite matches a runner's selected suite.
- Removed demo's separate in-memory rate limiter. Demo, live and replay now use the ledger-backed risk limit; demo's remaining-trade display reads durable purchase history.
- Mocked provider/replay fixtures match cash, reserved capital, open cost, available capital, equity, risk balance and loss counters for a win and a losing Rise tie. Both reject competing exposure while a position is open; repeated settlement polling does not credit twice.

Verification uses disposable SQLite and mocked provider responses, with no account orders. Source/test typechecks and lint pass. The full suite passes: **167 tests across 22 files**, including CLI subprocess checks run with sandbox escalation. These fixtures do not prove broker latency, historical quote fidelity, stochastic learner reproducibility or trading eligibility. Unknown purchases still block new orders for operator reconciliation. Unvalidated strategies are not yet excluded by lifecycle gates.

Next work: experiment reconstruction/seed and trial-count integration, plus recorded multi-symbol account/recovery traces, then validation and eligibility enforcement. Statistical helper defects, Python leakage concerns and CFD execution remain outstanding.

---

# Milestone review — 2026-09-14

Reviewed commit `82ae0a3` and the current working tree against the supplied integrity brief. The tree was clean before this review. This is a bounded integration correction, not completion of domain integrity or authorization for trading.

## What the latest update actually completed

- Typechecking succeeds; the previous removed-market import and strategy-factory mismatch are repaired.
- Backtest CLI now constructs fresh strategy factories, excludes the two online learners, and supplies configured duration and payout assumptions.
- Demo risk starts from the authenticated demo balance; timer conversion now distinguishes time units.
- Modern account selection/reconnect improvements remain in place. No authenticated connection or purchase was tested in this review.
- A doctor command exists and the missing ESLint package is installed.

These are primarily **Milestone 0** improvements. The current `Signal` still lacks product/hypothesis/version identity; `Trade` is Options-specific despite its generic name; canonical portfolio events and portfolio-aware risk decisions are absent. **Milestone 1 is not almost complete in this checkout.** No alternate uncommitted domain implementation was present.

## Corrections made during review

- Doctor inspects SQLite read-only, without calling the schema-initializing singleton. It checks `market_profiles`, not nonexistent `research_results`, tests database integrity, closes its connection, and uses the application's project-relative database location. Tokens are entirely redacted. Low sample counts are warnings against configured policy, not database corruption. Static observations no longer claim execution parity or feature validation.
- The migration script points to an actual CLI, creates the data directory if needed, initializes the existing SQLite schema and checks integrity. This does not introduce versioned migrations.
- ESLint explicitly includes the test TypeScript project. Existing rule violations remain visible; no rules were weakened.
- Standard backtesting rejects declared online learners before calling their signal/update function. Previously only the CLI omitted them, while doctor claimed an engine-level safeguard existed.
- Both trading runners preserve consensus contract/barrier metadata. Previously it was discarded before risk and execution.
- Backtest batches fail when no experiments complete or any evaluation fails. An empty data run no longer says `NO EDGE FOUND`. Unsuccessful preliminary checks are described as insufficient evidence.
- Research failures in subscription or persistence now produce nonzero exit status. Output reports actual saved profiles and no longer claims that survey ticks are persisted or that a profile establishes demo eligibility.

## Verified checks

Initial baseline: typecheck passed; 95 tests passed; ESLint reported 488 errors and 212 warnings, including five test-project parsing failures.

After changes: 98 tests pass, including read-only diagnostics/missing-storage checks and rejection of online learning before scoring. Source and test-project typechecks pass after correcting stale extensionless imports in three existing test files. Doctor exits 0 with limitation warnings. On a disposable SQLite backup, backtest completed 10 evaluations without internal errors (zero candidates passed), an unmatched-symbol backtest exited 1, and the repaired migration command exited 0. Full lint now reports 534 errors and 213 warnings with zero parsing failures: checking the formerly excluded tests exposed additional pre-existing violations. No lint rules were relaxed. Research network/error branches were inspected but not exercised against the provider; authenticated execution and settlement were not tested. The database currently contains ticks for 43 symbols, so previous small-dataset counts must not be reused as current evidence. Tests do not establish a profitable or statistically valid strategy.

## Remaining priority defects

1. **M0:** substantial repository-wide lint debt; incomplete CLI integration coverage; public research unnecessarily requires account credentials; diagnostic claims must remain distinct from authenticated readiness.
2. **M1:** define product-discriminated Options/CFD types, signal hypothesis identity, explicit contract specifications and portfolio-aware risk decisions. Integrate these through factories, consensus, risk and execution; do not merely add unused interfaces.
3. **M1/M3:** executor silently retries disallowed tick durations as 15 seconds and records the original duration. This breaks the configured hypothesis alignment. Capability resolution exists but is not integrated. Market classification is duplicated and inconsistent; discovery is not proof of product availability.
4. **M2:** no durable execution ledger, portfolio, reservations or risk restart recovery. Live risk still starts from a hardcoded balance. Existing reservation helpers are not wired into submissions.
5. **M3:** settlement ignores `isSettled` and can fabricate a settled zero-profit result from an open contract. Live execution lacks settlement tracking. Timeout can leave an unknown purchase outcome; reconnect is not reconciliation.
6. **M4/M5:** fixed-payout, zero-latency simulation has no shared account constraints or replay/live parity proof. Passing the same configured duration is insufficient when execution silently changes it.
7. **M6/M7:** immutable experiment/dataset identities are absent. Statistical helpers retain known DSR/PBO/BHY defects; existing tests are insufficient reference validation. OOS ranking can influence selection. A preliminary PASS is not validated edge.
8. **M7:** Python pair normalization can use later-fitted state; labels overlap split boundaries; training/serving channels differ. RL remains unsuitable for standard evaluation. The new guard trusts the declared flag and does not sandbox arbitrary strategies.
9. **M8:** lifecycle eligibility is not enforced. Both runners can instantiate unvalidated strategies. Environment switches alone do not establish readiness.
10. **M10:** CFD account/position/margin/execution support is absent. Options symbol discovery must not be presented as CFD trading support.

## Milestone status and next bounded scope

| Milestone | Status | Completion evidence required |
|---|---|---|
| 0 Baseline/tooling | Partial | Clean lint, bounded CLI success/failure tests, trustworthy diagnostics |
| 1 Domain integrity | Incomplete | Product-discriminated models used end-to-end; invalid cross-product/specification inputs rejected |
| 2 Ledger/portfolio | Not complete | Durable, atomic lifecycle/accounting and restart recovery tests |
| 3 Execution/reconciliation | Partial transport only | Purchase uncertainty, settlement and restart reconciliation scenarios |
| 4 Backtest fidelity | Partial | Exact product outcomes, costs, duration and account constraint tests |
| 5 Replay parity | Not complete | Identical event streams yield identical decisions |
| 6 Experiment registry | Not implemented | Immutable config/data/code identities and repeatable results |
| 7 Validation integrity | Partial and untrusted | Reference statistics, isolated evaluation, leakage and sample policies |
| 8 Lifecycle | Not implemented | Enforced promotion gates and eligible-only loading |
| 9 Governance | Deferred | Complete V1 prerequisites first |
| 10 CFDs | Deferred | Separate verified account/position execution model |

Next work should complete M0 lint and CLI failure coverage, then integrate M1 domain invariants. Preserve the existing transport/fold fixes. Do not expand ML, automate promotion, or enable live execution as part of this cleanup.


## Milestone 0 completion checkpoint

Baseline/tooling cleanup completed on 2026-09-14. Source and test TypeScript projects pass; ESLint passes with **zero errors and zero warnings**, without disabling rules. **116 tests pass**, including 11 subprocess CLI help/configuration/safety checks. The sandbox rejects subprocess startup with EPERM; the full suite passed after the required escalation. No network/account orders are part of those tests.

Changes include explicit indexed-value checks, typed external/calendar and database values, typed EventEmitter events, observed async rejections, complete token redaction, strict boolean parsing, credential-free public configuration, credential checks at the authenticated boundary, stdout reporting separate from operational logs, `--help` on all CLIs, and concise backtest/research defaults (`--verbose` for detail). Calendar tests cover malformed input, missing numeric values, upcoming-event SQL, and provider failure.

This supersedes the lint count and M0 status above. It does not certify statistical methodology, account correctness, contract settlement, or trading eligibility; those remain subsequent milestones. The remaining milestone table is historical until each new completion checkpoint below.

## Milestone 1 domain checkpoint

121 tests, both typechecks and zero-warning lint pass. Signals carry product, hypothesis reference (explicitly null for unregistered candidates) and strategy version. Options specifications validate contract family/barrier, stake currency/precision and duration. Risk creates the specification; execution uses it unchanged and refuses an overpriced proposal. Removed the automatic 15-second execution retry. Mixed-product/symbol votes and CFD signals at Options risk/simulation boundaries are rejected. Money uses explicit integer minor units; Options and CFD exposure/event types are distinct.

The current operational risk policy explicitly supports USD accounts only, rather than applying USD precision/minimum stake to arbitrary wallets. Both trading runners now pass the actual account balance/currency into risk. Portfolio snapshot authority is explicitly session-only until Milestone 2; immutable experiment identity and eligibility remain M6/M8 work. No provider purchases were used for verification.
