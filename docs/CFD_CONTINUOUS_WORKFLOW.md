# Continuous CFD demo workflow

As of 2026-10-11, the continuous workflow is implemented, but there are **zero supported strategy studies**. Broker connectivity and execution verification do not establish an edge. Live execution is disabled in this workflow.

## Commands available now

```sh
npm run cfd:run -- --status
npm run cfd:run -- --observe --symbol BTCUSD --cycles 5 --out data/observations.jsonl
```

Status is local. Observation authenticates the configured demo account and records quotes without placing orders. Observations are not automatically validated research datasets. The October 11 observer completed five cycles; the receipt is `data/cfd-observed-quotes-2026-10-11.jsonl`.

## Evidence required before entries

Each deployment requires the exact registered hypothesis, a completed supported study with successful development, sealed holdout and cost-stress results, and a matching immutable batch selection result. Fixture/scenario datasets cannot qualify. The current source hash, broker contract, account, symbol and currency must match. Missing data or insufficient evidence blocks deployment.

Historical acquisition remains incomplete. The EURUSD January–June 2025 archive checkpoint has 51 available, 65 empty, 7 failed and 4,221 pending hourly files. Resume with:

```sh
npm run cfd:download -- --symbol EURUSD --start 2025-01-01T00:00:00Z --end 2025-07-01T00:00:00Z --scale 100000 --out ../data/history/dukascopy/EURUSD-2025H1 --snapshot-ms 60000 --workers 2 --max-seconds 120
```

A partial archive cannot qualify. External historical quotes also need documented alignment to the broker's contract and historical spreads, commissions, financing, slippage and margin assumptions. Import/preparation and `cfd:research --validate` must succeed before deployment review. Do not repeatedly tune against the sealed holdout.

## Review and deployment

`npm run cfd:deploy -- --review review.json --out deployment.json` records an explicit operator review and checks all prerequisite evidence. It does not place orders. The review JSON contains:

- `deployment`: version 1, mode `DEMO`, configured API `accountId`, exact `symbol`, `hypothesisId`, `studyId`, `studyAttemptId`, `batchId`, `batchAttemptId`, ISO `expiresAt`, `pollIntervalMs` (1,000–60,000), `maxLots`, and `maxPlannedLoss` (positive, at most 5 account-currency units).
- `reviewer` and a substantive `assessment` explaining the evidence.
- `documents`: local `path`, descriptive `source`, and `role`, covering `HISTORICAL_COSTS`, `CONTRACT`, `QUOTE_CADENCE`, and `DEMO_EXECUTION`. Paths resolve relative to the review file.

Document hashes prove integrity, not independent accuracy. In particular, confirm that the observed polling cadence and execution assumptions are suitable for the researched strategy. Successful review writes the final deployment with immutable review identifiers. No eligible deployment has been produced yet.

After approval, the operating command is:

```sh
npm run cfd:run -- --execute-demo --deployment deployment.json --interval-ms 1000
```

The interval must equal the reviewed value. This is a continuous foreground process unless `--cycles` is supplied. Use only one approved symbol per account runner. Deployment expiry, suspension, code changes or inconsistent evidence block entries. Editing deployment limits requires a new review.

## Recovery and account coexistence

Signals share the backtest's causal calculation and execute on the next observed quote. Cash-risk sizing includes estimated commissions and adverse entry slippage; the planned-loss cap is not a guarantee against gaps. Duplicate quotes do not advance holding counters. Gaps reset signal warm-up; persisted holding counters survive restart. Missing post-fill counters trigger conservative closure of the bot-owned position.

Unknown or partial fills require reconciliation; the runner never sends a replacement order merely because an acknowledgement was lost. Reconnection recreates the controller and repeats warm-up. Daily baselines and recent account equity marks persist across process restarts. Deposits and withdrawals are not separately normalized out of the daily-loss calculation.

Manual phone trades coexist on hedged accounts. The bot manages only ledger-owned positions; shared equity, margin and daily losses still constrain it. Manual positions can therefore affect whether the bot is allowed to enter.

Create `data/CFD_STOP` to pause runner actions; remove it to permit resumption. Broker stops remain active while paused, expired, disconnected or shut down. A pause does not flatten positions. Ctrl+C stops the foreground process. Permanent hypothesis suspension is available through `npm run cfd:deploy -- --suspend HYPOTHESIS_ID --reason TEXT`.

The runner can renew a rejected access token when refresh credentials are configured. Rotated credentials are stored privately (0600) in gitignored `data/.ctrader-session.json`; the diagnostic, catalogue and execution CLIs also read this cache for the matching app/account. Renewal is tested with protocol fixtures, not forced against the actual token. After deliberately reauthorizing with replacement credentials, remove the old private cache so it cannot override the new `.env` values. Never commit or share either credential file.
