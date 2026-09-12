import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import Table from 'cli-table3';
import chalk from 'chalk';
import type { PerformanceMetrics } from '../types/backtest.js';
import type { TradingMode } from '../types/trade.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return '?';
  }
}

/**
 * Renders a performance metrics table to the console.
 * Strictly separates BACKTEST, PAPER, DEMO, LIVE results.
 */
export function renderMetricsTable(metrics: PerformanceMetrics, title?: string): void {
  const modeColor = {
    BACKTEST: chalk.cyan,
    PAPER: chalk.yellow,
    DEMO: chalk.green,
    LIVE: chalk.red,
  } as Record<TradingMode, (s: string) => string>;

  const color = modeColor[metrics.mode] ?? chalk.white;
  const header = title ?? `${color(`[${metrics.mode}]`)} ${metrics.strategy} — ${metrics.symbol}`;

  console.log('\n' + chalk.bold('─'.repeat(70)));
  console.log(chalk.bold(header));
  console.log(
    chalk.dim(
      `  Period: ${metrics.fromDate.toISOString().slice(0, 10)} → ${metrics.toDate.toISOString().slice(0, 10)}`,
    ),
  );
  console.log(chalk.bold('─'.repeat(70)));

  const table = new Table({
    head: [chalk.bold('Metric'), chalk.bold('Value')],
    colWidths: [35, 35],
    style: { head: [], border: [] },
  });

  const pct = (v: number | null): string =>
    v === null ? chalk.dim('N/A') : `${(v * 100).toFixed(2)}%`;

  const num = (v: number | null, dp = 4): string => (v === null ? chalk.dim('N/A') : v.toFixed(dp));

  const edgeColor = {
    EDGE_DETECTED: chalk.green,
    EDGE_NOT_DETECTED: chalk.yellow,
    INSUFFICIENT_EVIDENCE: chalk.dim,
    OVERFIT_RISK_HIGH: chalk.red,
  };

  table.push(
    ['Total Trades', chalk.bold(metrics.totalTrades)],
    ['Wins / Losses', `${chalk.green(metrics.wins)} / ${chalk.red(metrics.losses)}`],
    ['Win Rate', pct(metrics.winRate)],
    ['Loss Rate', pct(metrics.lossRate)],
    ['─────────────────────────', '─────────────────────────'],
    ['Total Profit (normalized)', num(metrics.totalProfit)],
    ['Net Return', pct(metrics.netReturn)],
    ['Expectancy', num(metrics.expectancy)],
    ['Profit Factor', num(metrics.profitFactor)],
    ['Avg Win', num(metrics.averageWin)],
    ['Avg Loss', num(metrics.averageLoss)],
    ['─────────────────────────', '─────────────────────────'],
    ['Sharpe Ratio', num(metrics.sharpeRatio, 3)],
    ['Sortino Ratio', num(metrics.sortinoRatio, 3)],
    ['Calmar Ratio', num(metrics.calmarRatio, 3)],
    ['Deflated Sharpe (DSR)', num(metrics.deflatedSharpe, 4)],
    ['Sharpe p-value', num(metrics.pValueSharpe, 4)],
    ['─────────────────────────', '─────────────────────────'],
    ['Max Drawdown', pct(metrics.maxDrawdownPct)],
    ['Longest Loss Streak', metrics.longestLosingStreak],
    ['Longest Win Streak', metrics.longestWinningStreak],
    ['─────────────────────────', '─────────────────────────'],
    ['PBO', metrics.pbo !== null ? `${(metrics.pbo * 100).toFixed(1)}%` : chalk.dim('N/A')],
    [
      '95% CI on Returns',
      metrics.confidenceInterval95
        ? `[${num(metrics.confidenceInterval95[0])}, ${num(metrics.confidenceInterval95[1])}]`
        : chalk.dim('N/A'),
    ],
    ['─────────────────────────', '─────────────────────────'],
    [
      chalk.bold('EDGE STATUS'),
      (edgeColor[metrics.edgeStatus] ?? chalk.white)(chalk.bold(metrics.edgeStatus)),
    ],
  );

  console.log(table.toString());
}

/**
 * Renders the system header banner.
 */
export function renderBanner(): void {
  console.log(
    chalk.cyan(`
╔══════════════════════════════════════════════════════════╗
║   Quant Trading Research System v${readPackageVersion().padEnd(24)}║
║   Deriv Synthetic Indices — Demo-First Safety            ║
╠══════════════════════════════════════════════════════════╣
║   ${chalk.yellow('WARNING: This is a research tool. Not financial advice.')}  ║
║   ${chalk.yellow('Live trading is disabled until explicitly enabled.')}        ║
╚══════════════════════════════════════════════════════════╝
`),
  );
}

/**
 * Renders a safety status panel showing current trading mode.
 */
export function renderSafetyStatus(demoEnabled: boolean, liveEnabled: boolean): void {
  console.log(chalk.bold('\n📊 Trading Mode Status:'));
  console.log(
    `  Demo Trading:  ${demoEnabled ? chalk.green('✓ ENABLED') : chalk.red('✗ DISABLED')}`,
  );
  console.log(
    `  Live Trading:  ${liveEnabled ? chalk.red('⚠ ENABLED (real money!)') : chalk.green('✓ DISABLED (safe)')}`,
  );
  console.log();
}
