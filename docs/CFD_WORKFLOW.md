# CFD execution and research workflow

## Implemented components

- `CfdLedger` persists open/close requests before submission. Account identity and client request hashes prevent cross-account reuse and changed duplicate requests. Unknown submissions are never automatically resent.
- `CfdReconciliation` requires complete cumulative order/deal history from an adapter. It verifies account/request identity, unique deal IDs, requested volume, position identity, timestamps, and cumulative-history consistency. Working partial fills continue blocking submissions. A broker-confirmed cancellation of the remaining volume records a terminal partial fill; it never buys the remainder automatically. Order evidence is immutable in migration 6. Migration 7 stores full position-closure histories for broker-triggered stops/targets; a missing position without reconciling exit volume remains blocked.
- `CfdExecutionController` serializes reconciliation, opens and closes. It checks account mode, freshness, existing positions, stop protection, daily equity baseline, aggregate planned stop risk, margin, volume steps and an explicit hypothesis authorization callback. Disconnection clears readiness. The caller must supply a durable/broker-verified daily baseline, a genuine authorization gate and a broker adapter that returns complete evidence. This is a component API, not an autonomous production runner. Migration 8 provides account-scoped runner leases and immutable UTC daily equity baselines. Controllers renew ownership around asynchronous work; another controller cannot take over an unexpired lease. Call `dispose()` on shutdown. After a UTC day change, openings stop until a new controller is supplied a verified daily baseline; reducing existing positions remains possible. Unknown submissions still block a replacement after lease expiry.
- `CfdSubmissionService` remains paper-only by default. Demo dispatch requires an explicit account ID and preflight callback. Live accounts always fail. These explicit demo hooks support verification, not automatic strategy promotion.
- `verifyCfdDemo` performs a bounded demo round trip and records broker-reported open, protected position, application-readiness recovery, close and flat-account snapshots. Failed/uncertain execution produces a review/reconciliation result. It rejects paper/live accounts. A fixture test of this function is not a real broker verification. Its readiness reset does not test a physical network outage.

A cTrader order/position/deal adapter is still needed to connect these components to the provider. The existing `cfd:doctor` connection remains read-only. Application approval and broker verification are pending; no broker order was submitted for this implementation.

## Bid/ask dataset contract

`src/cfd/CfdDataset.ts` defines a strict versioned JSON input. The complete example is `examples/cfd/fixture.json`, explicitly labelled `FIXTURE` and unusable as validation evidence.

Required metadata: source, kind (`BROKER_BID_ASK`, `EXTERNAL_BID_ASK`, `SCENARIO_BID_ASK`, or `FIXTURE`), account currency, instrument specifications and cost source. Every quote supplies:

- UTC Unix milliseconds, bid and ask;
- historical profit-currency/account-currency conversion (one when identical);
- effective leverage;
- long/short financing cashflows per lot, in account currency, due **at that event** (zero means no charge due, not unknown).

Financing applies to positions carried into the event before stop/target processing. Corporate-action and dividend adjustments must already be handled by the supplied source/cashflows and disclosed in its metadata; automatic adjustment ingestion is not implemented. Do not pass annualized swap rates as per-event cashflows. Missing costs or conversion data must not be replaced with invented zero values. Inputs are validated and hashed; source labels themselves are declarations, not cryptographic proof of a broker export.

There is no 1,000-row limit on imported datasets. However, long bid/ask history and verified cost schedules have **not** been downloaded or independently verified. The 43,000 Deriv Options price ticks are incompatible with this input. Files load in memory; very large archives need partitioning/storage work. Third-party bid/ask data can support exploratory research but cannot demonstrate Deriv fill fidelity.

## Replay and validation

```bash
# Software fixture demonstration, not market performance evidence
npm run cfd:backtest -- --data examples/cfd/fixture.json --config examples/cfd/config.json

# Fixture must report insufficient evidence
npm run cfd:backtest -- --data examples/cfd/fixture.json --config examples/cfd/config.json --validate
```

Replay supports momentum, mean-reversion and breakout parameter declarations per symbol. Decisions execute only on the next quote. It models spread, both commissions, fixed adverse slippage, explicit financing, dated leverage, margin constraints, mark-to-market equity, stop-out, gap-aware stops and forced end-of-period close. Gaps clear pending decisions and warmup. Expected order rejections are counted with reasons. No order book, partial-liquidity simulation or market impact model is supplied; effective leverage is a simplified margin assumption, not the broker's complete tiered formula.

The validation command records the dataset/code/configuration before evaluation. It predeclares the supplied lookback and two bounded neighboring lookbacks, evaluates each in three chronological development periods, requires all neighbors to pass basic checks, applies DSR and BY multiple-testing correction, estimates PBO from aligned equity-return paths, applies a cost-stress run, and claims the final 20% before evaluating one selected candidate. Recorded prior CFD hypotheses for the same symbol (and legacy declarations without a symbol) that are not represented in the current search make the statistical correction unavailable. Other symbols are not candidate paths for this symbol. Batch reports additionally apply BY across every declared symbol, treating missing/failed studies as p=1; per-symbol support alone does not establish batch support. Block-bootstrap expectancy, minimum sample/span/trade counts and drawdown checks can reject a hypothesis. These fixed-rule periods do not train a model. Fixture/insufficient data cannot open the final holdout. Reused overlapping holdouts are refused by the existing registry.

A positive result is labelled holdout support **pending broker verification**. Multiple-testing correction uses the recorded per-symbol CFD trial universe, PBO uses a common aligned prefix divisible into four blocks, and undefined/tied PBO is unavailable rather than fabricated. Bootstrap expectancy must pass all predeclared block lengths (defaults 3, 5 and 10 trades); the reported interval envelopes their results. These sensitivity checks do not prove independence or that the chosen parameter neighborhood covers all strategies tried outside the registry. `demoEligible` and `liveEligible` remain false in every research report. This module must not be used to bypass the existing Options lifecycle or claim a validated CFD edge.

## Verification status

Offline tests cover account/mode guards, duplicate submissions, lost responses after acceptance, restart recovery, partial remainder cancellation, changed/duplicate deal evidence, gap/cost handling, deterministic replay and causal prefix invariance. A demo-shaped fixture tests the round-trip harness and is explicitly labelled `FIXTURE` in its report.

Still required before automated trading: the concrete cTrader adapter; broker-backed daily-risk baseline initialization; broker integration of position/stop reconciliation and dividend/corporate-action feeds; longer verified historical data and statistical assumption review; physical disconnect/reconnect tests against the approved demo account; prospective strategy evaluation. Live trading remains disabled.

## Historical acquisition, import and batch research

Selected external source: [Dukascopy historical bid/ask exports](https://www.dukascopy.com/api/data/get/historical-data-export). Its [binary decoding documentation](https://www.dukascopy.com/wiki/en/development/data-export/) describes the integer prices and volumes. The downloader uses the public hourly endpoint, a UTC hour offset, and an **explicit** instrument price divisor. It does not use the separate paid S3 service or require cTrader credentials.

```bash
# Bounded six-month acquisition. The default scheduling budget is 300 seconds.
# Rerun the identical command to resume; exit 2 means incomplete, not success.
npm run cfd:download -- --symbol EURUSD --start 2025-01-01T00:00:00Z --end 2025-07-01T00:00:00Z --scale 100000 --workers 4 --snapshot-ms 60000 --out ../data/history/dukascopy/EURUSD-2025H1

# Verify a canonical CSV whose rows already include real dated costs/conversions.
npm run cfd:import -- --csv examples/cfd/fixture.csv --metadata examples/cfd/import-metadata.json --out /tmp/cfd-import-example.json

# Inspect every declared symbol; missing history is reported and exits 2.
npm run cfd:research -- --plan examples/cfd/real-market-plan.json --out /tmp/cfd-readiness.json
# After supplying verified per-symbol datasets/configurations:
npm run cfd:research -- --plan examples/cfd/real-market-plan.json --out /tmp/cfd-validation.json --validate
```

`cfd:download` runs from `python/`, so its output path is relative to that directory. It retains compressed hourly archives, content hashes, missing/failed/pending-hour statuses and export provenance. Transport/decode failures or a runtime budget expiry prevent publishing a new CSV. A 404 is a reported gap, never assumed to be a closed session. Empty responses are explicitly counted. `--utc-hour 12` requests only the predeclared 12:00–13:00 UTC window each day and **cannot** be described as full daily coverage. No process runs indefinitely or silently treats partial downloads as complete.

`--snapshot-ms 0` exports full ticks, collapsing equal-millisecond observations to the last received quote and counting the collapses. Positive values export the last observed quote in each UTC bucket with its actual timestamp; no interpolation occurs. Original raw ticks remain necessary to resolve intrabucket stop/target paths. Price divisors are not guessed for metals/indices. The downloader is a provider-specific data tool, not an automatic mapping of Deriv CFDs.

The strict import header is:

```text
timeMs,bid,ask,profitCurrencyToAccount,leverage,longFinancingPerLot,shortFinancingPerLot
```

All fields are mandatory numeric values. `timeMs` is UTC Unix milliseconds; rates are account-currency conversions and financing is the cashflow **per lot due at that event**. Missing fields, nonfinite values, crossed quotes, duplicates, out-of-order rows and same-currency conversions other than one fail. Import never sorts, fills gaps or silently discards bad rows. Original CSV bytes are hashed into persisted source provenance. Outputs are published only when complete and refuse to overwrite existing files. Import reads CSV incrementally but the replay dataset remains in memory; partition very large archives.

Without verified broker costs, use explicit **scenario** preparation:

```bash
npm run cfd:prepare -- --quotes data/history/dukascopy/EURUSD-smoke/quotes.csv --metadata examples/cfd/eurusd-external-metadata.json --assumptions examples/cfd/cost-scenario.json --out /tmp/eurusd-scenario.json
npm run cfd:backtest -- --data /tmp/eurusd-scenario.json --config examples/cfd/eurusd-scenario-config.json
```

This generates `SCENARIO_BID_ASK`, which always fails validation eligibility even when prices are observed and history is long. The supplied example assumes effective leverage 30, 10% annual carrying charges in both directions, 3.5 account-currency commission per lot per side and two ticks of slippage. These are deliberately declared research assumptions, **not verified Deriv terms**. The scenario charges elapsed calendar days at the first observed quote of the new UTC day; it is not the broker swap/triple-roll calendar. Cross-currency scenarios require observed conversions and are rejected by this convenience preparer.

The CFD plan now uses **only the cTrader account catalogue**. The former 43-symbol Options-derived plan has been removed from the active workflow. `examples/cfd/real-market-plan.json` is an explicit pending-catalogue placeholder with no symbols until an account snapshot is obtained. It must not be populated by guessing broker IDs, stripping `frx` prefixes or substituting `OTC_SPC` for a CFD name.

```bash
# After Open API approval and authorization; reads metadata only, no trades:
npm run cfd:markets -- --refresh --out data/cfd-account-plan.json
# Alternatively, process a previously exported cTrader catalogue snapshot:
npm run cfd:markets -- --catalogue catalogue.json --out data/cfd-account-plan.json
npm run cfd:research -- --plan data/cfd-account-plan.json --out /tmp/cfd-readiness.json
```

`cfd:markets` queries the account's symbol list (including archived symbols), categories and asset classes. Every entry is retained with its original broker ID/name. Six real-market classifications route to starting research templates; unknown metadata remains REVIEW_REQUIRED, disabled/archived symbols remain visible, and synthetics stay paused. No instrument is invented to fill an absent market category. A catalogue is not a complete contract specification or execution authorization; full sizing/cost metadata remains part of broker integration.

Plan schema version 2 embeds the source snapshot and checks every broker ID, name, classification and status against it. Missing or substituted entries and version-1 Options plans are refused. Account ID/environment are part of catalogue identity. Imported JSON is a declared snapshot, not independent proof of broker origin; refresh obtains it through the authenticated read-only connection. Paths resolve relative to the plan. Audits consume no holdouts, and missing datasets remain explicit per-symbol blockers. An unavailable catalogue reports CTRADER_CATALOGUE_PENDING and exits 2 rather than reporting an empty universe as complete.

The protocol is based on the official [cTrader symbol/category/asset-class messages](https://raw.githubusercontent.com/spotware/openapi-proto-messages/main/OpenApiMessages.proto) and [symbol identity model](https://raw.githubusercontent.com/spotware/openapi-proto-messages/main/OpenApiModelMessages.proto). Provider IDs are server-specific; public marketing names are not executable account identifiers.

Research eligibility, broker execution verification and profitability are separate. The new commands complete acquisition/import/audit plumbing; they do not manufacture a passing result or make an incomplete archive sufficient.


### Resumption integrity

A failed checksum check never discards the original content hash. Unvisited hours retain their expected hash while marked PENDING; redownloaded files must also match it before they enter the cache. Changed historical bytes require explicit source review, not an automatic retry that silently changes research inputs. The downloader checkpoints progress every 25 processed hours and applies the scheduling budget to retry starts/backoff as well as new hours. A request already in progress is subject to its network timeout. Numeric provider Retry-After values longer than 60 seconds defer the request to a later run. Empty exports return exit code 2; selecting a UTC window outside the requested range is a configuration error.
