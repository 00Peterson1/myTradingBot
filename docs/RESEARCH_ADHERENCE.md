# Research adherence audit — 2026-09-21

The bibliography supplied by the user is the research baseline. The current repository contains research-inspired candidates, not verified replications of all these papers. A paper's published performance cannot validate a different instrument, sampling interval, execution product or cost model. Synthetic markets remain paused under `MARKET_SCOPE=REAL`.

| Source | Current implementation and evidence gap |
|---|---|
| Moskowitz, Ooi & Pedersen, [Time Series Momentum (2012)](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) | Paper studies futures/forwards and long-horizon own-return predictability. Current tick-window momentum candidates are adaptations, not replication. Require predeclared calendar horizons, appropriate historical data, volatility targets and net-cost evaluation. |
| Dudler, Gmuer & Malamud, [Risk Adjusted Time Series Momentum](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2457647) | Current volatility-adjusted signal does not establish equivalence to averaging historically risk-normalized returns. Do not label it RAMOM replication. |
| Kim, Tse & Wald, [Time series momentum and volatility scaling](https://www.sciencedirect.com/science/article/pii/S1386418116301379) | Need scaled/unscaled momentum and corresponding passive controls to distinguish directional predictability from volatility scaling. Current candidate comparisons do not isolate this effect. |
| Zhang, Zohren & Roberts, [Deep Reinforcement Learning for Trading](https://arxiv.org/abs/1911.10107) | Tabular Q-learning and linear actor-critic prototypes are not the paper's deep models. Corrected the misleading Q-learning citation. Online learners remain excluded from ordinary backtests and eligible catalogue. |
| Ishikawa & Nakata, [Online Trading Models with Deep Reinforcement Learning in the Forex Market Considering Transaction Costs](https://arxiv.org/abs/2106.03035) | Requires an explicit online training/evaluation protocol including transaction costs. Existing prototypes do not demonstrate replication; they cannot supply eligibility evidence. |
| Zhou & Zhu, [A Theory of Technical Trading Using Moving Averages](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326650) | A theoretical motivation for research, not proof that the existing short-window indicators have positive net expectancy. |
| Hurst, Ooi & Pedersen, [A Century of Evidence on Trend-Following Investing](https://www.aqr.com/-/media/AQR/Documents/Insights/Journal-Article/AQR-JPM-Fall-2017.pdf) | Long historical, diversified trend evidence does not validate tick-frequency Deriv strategies. Current data does not reproduce its breadth or horizon. |
| Bailey et al., [Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) | CSCV rank calculation corrected; valid PBO requires aligned candidate paths. No fabricated PBO when those are unavailable. |
| Bailey & López de Prado, [Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) | Corrected reference formula and trial-variance handling; dependence and effective independent trials remain assumptions. DSR is not a posterior probability of profitability. |

## Cross-cutting evidence

Walk-forward isolation, untouched final holdout claims, recorded hypothesis counts, BY multiple-testing correction and dependence-aware block bootstrap are implemented and tested. These controls reduce specific evaluation errors; they do not establish an edge. Strategy lifecycle promotion still requires completed matching evidence and code/configuration identity.

The previous pair residual diagnostic assigned a few threshold buckets as p-values. It now returns unavailable (`null`) significance and never declares cointegration. Restored legacy significance is invalidated and pair signals fail closed. The descriptive OLS/spread calculations remain, with aligned finite input validation and centered covariance. A calibrated augmented Engle–Granger implementation with declared lag/trend selection and integration-order assumptions remains necessary; see [statsmodels reference](https://www.statsmodels.org/stable/generated/statsmodels.tsa.stattools.coint.html).

Regime detection, volatility forecasts, mean reversion and autocorrelation remain hypotheses/diagnostics until separately validated. Pair signals are not an atomic two-leg hedge. Position limits and stops do not constitute a calibrated risk-of-ruin estimate. No such estimate or statistical-arbitrage edge is certified.

## CFD status

Added separate CFD instrument/account/order/position schemas, risk sizing and a single-instrument paper broker. Simulation uses explicit bid/ask quotes, account-currency conversion, leverage assumptions, both commissions, adverse slippage, financing cashflows, partial closes and gap-aware stops. Multi-instrument portfolio studies are rejected until synchronized executable quotes are supported. Fixed leverage and supplied financing are declared assumptions, not exact broker dynamic-leverage/swap replication. Missing bid/ask history must not be replaced by Options ticks and called broker-fidelity testing.

`npm run cfd:doctor` checks separate cTrader credentials without printing their values. `--connect` performs read-only demo authentication and symbol/position inspection. The user has not created a CFD account. The implementation follows [cTrader JSON endpoints](https://help.ctrader.com/open-api/proxies-endpoints/) and [application/account authorization](https://help.ctrader.com/open-api/account-authentication/). Fixture tests are not broker verification.

Still outstanding: the cTrader execution adapter; durable CFD order/close intents and restart reconciliation; broker-specific sizing, conversion, costs and dynamic margin; causal CFD backtest/validation integration; CFD-specific lifecycle promotion; prospective demo evidence. Therefore milestone 10 and complete paper adherence are **not complete**. Existing Options eligibility is not CFD eligibility.
