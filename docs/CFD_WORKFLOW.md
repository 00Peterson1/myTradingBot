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

Required metadata: source, kind (`BROKER_BID_ASK`, `EXTERNAL_BID_ASK`, or `FIXTURE`), account currency, instrument specifications and cost source. Every quote supplies:

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

The validation command records the dataset/code/configuration before evaluation. It predeclares the supplied lookback and two bounded neighboring lookbacks, evaluates each in three chronological development periods, requires all neighbors to pass basic checks, applies DSR and BY multiple-testing correction, estimates PBO from aligned equity-return paths, applies a cost-stress run, and claims the final 20% before evaluating one selected candidate. Recorded prior CFD hypotheses that are not represented in the current search make the statistical correction unavailable. Block-bootstrap expectancy, minimum sample/span/trade counts and drawdown checks can reject a hypothesis. These fixed-rule periods do not train a model. Fixture/insufficient data cannot open the final holdout. Reused overlapping holdouts are refused by the existing registry.

A positive result is labelled holdout support **pending broker verification**. Multiple-testing correction uses the recorded CFD trial universe, PBO uses a common aligned prefix divisible into four blocks, and undefined/tied PBO is unavailable rather than fabricated. Dependence calibration and representativeness of the chosen lookback neighborhood still need review. `demoEligible` and `liveEligible` remain false in every research report. This module must not be used to bypass the existing Options lifecycle or claim a validated CFD edge.

## Verification status

Offline tests cover account/mode guards, duplicate submissions, lost responses after acceptance, restart recovery, partial remainder cancellation, changed/duplicate deal evidence, gap/cost handling, deterministic replay and causal prefix invariance. A demo-shaped fixture tests the round-trip harness and is explicitly labelled `FIXTURE` in its report.

Still required before automated trading: the concrete cTrader adapter; broker-backed daily-risk baseline initialization; broker integration of position/stop reconciliation and dividend/corporate-action feeds; longer verified historical data and statistical assumption review; physical disconnect/reconnect tests against the approved demo account; prospective strategy evaluation. Live trading remains disabled.
