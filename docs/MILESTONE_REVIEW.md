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

## Milestones 2–3 implementation checkpoint

Added an Options ledger with account/mode separation, integer cash, atomic reservations/purchases/settlements, immutable audit rows, persisted risk state, and restart recovery. Six dedicated ledger tests pass. Demo and live now share the serialized execution service: risk runs inside the reservation transaction; definitive buy rejections release capital; transport uncertainty keeps capital reserved and blocks new orders. Periodic provider status/portfolio/balance reconciliation replaces the guessed one-shot settlement timer. Unknown purchases are not automatically retried or guessed from similar contracts.

Seven targeted API/execution tests pass, covering decimal-string normalization, expiry without settlement, incomplete terminal data, duplicate settlement, ambiguous purchase, confirmed rejection, disconnect and portfolio/cash drift. Source/test typechecks and lint pass. The complete suite contains 134 tests; a spy-history assertion found during the full run was fixed and the affected four-test execution suite rerun successfully. No authenticated provider trades were performed. A full suite run will be repeated at the next integration checkpoint.

Provider behavior was checked against [Deriv's contract-status schema](https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/proposal_open_contract_response.schema.json), [portfolio schema](https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/portfolio_response.schema.json), and [buy schema](https://raw.githubusercontent.com/deriv-com/deriv-api-schemas/master/schemas/buy_response.schema.json). Expiry is not terminal settlement; financial values must be present and reconcile. Entry/exit spots and times remain null when the provider has not supplied them.

Remaining operational limits: account precision/minimum stake policy supports USD; unknown purchases require operator reconciliation; external deposits/withdrawals or foreign contracts deliberately block trading instead of rewriting the ledger. Broker-connected verification and strategy eligibility gates are not yet complete. Backtesting still needs the shared account simulation and replay work in M4/M5.
