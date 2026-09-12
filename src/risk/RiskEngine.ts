import { createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/index.js';
import { MIN_STAKE_USD, HARD_MAX_RISK_PER_TRADE, HARD_MAX_DRAWDOWN } from '../config/constants.js';
import type { Signal, ApprovedSignal, RiskDecision } from '../types/signal.js';

const log = createLogger('RiskEngine');

// ---------------------------------------------------------------------------
// Risk State (per-session, in-memory)
// ---------------------------------------------------------------------------

interface RiskState {
  sessionStartBalance: number;
  currentBalance: number;
  peakBalance: number;
  dailyStartBalance: number;
  dailyDate: string; // YYYY-MM-DD
  consecutiveLosses: number;
  consecutiveWins: number;
  totalTrades: number;
  dailyTrades: number;
  cooldownUntil: Date | null;
  killSwitchActive: boolean;
}

/**
 * The Risk Engine is the gatekeeper between signal generation and execution.
 *
 * It enforces:
 *   - Maximum risk per trade (fraction of balance)
 *   - Maximum daily loss
 *   - Maximum drawdown from peak
 *   - Maximum consecutive losses (triggers cooldown)
 *   - Kill switch (manual or automatic)
 *   - Trading mode safety (demo/live enforcement)
 *
 * CRITICAL DESIGN PRINCIPLES:
 *   - RiskEngine never modifies market state
 *   - RiskEngine never calls the Deriv API
 *   - RiskEngine is stateful (tracks balance, losses, etc.)
 *   - RiskEngine state must be updated on every trade result
 *   - No martingale, no loss doubling, no revenge trading
 */
export class RiskEngine {
  private state: RiskState;

  constructor(initialBalance: number) {
    const today = new Date().toISOString().slice(0, 10);
    this.state = {
      sessionStartBalance: initialBalance,
      currentBalance: initialBalance,
      peakBalance: initialBalance,
      dailyStartBalance: initialBalance,
      dailyDate: today,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      totalTrades: 0,
      dailyTrades: 0,
      cooldownUntil: null,
      killSwitchActive: false,
    };
    log.info({ initialBalance }, 'Risk engine initialized');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Evaluates a signal and returns a risk decision.
   * This is the main entry point — called for every signal.
   */
  evaluate(signal: Signal, tradingMode: 'DEMO' | 'LIVE'): RiskDecision {
    const env = getEnv();

    // Hard safety: validate trading mode is enabled
    if (tradingMode === 'LIVE') {
      const isLive = env.LIVE_TRADING && env.LIVE_CONFIRMATION;
      if (!isLive) {
        log.warn({ signalId: signal.id }, 'Rejected: live trading not enabled');
        return { approved: false, reason: 'LIVE_TRADING_DISABLED', signal };
      }
    }

    if (tradingMode === 'DEMO' && !env.DEMO_TRADING) {
      return { approved: false, reason: 'DEMO_TRADING_DISABLED', signal };
    }

    // No signal
    if (signal.direction === 'NONE') {
      return { approved: false, reason: 'NO_SIGNAL', signal };
    }

    // Kill switch
    if (this.state.killSwitchActive) {
      log.warn({ signalId: signal.id }, 'Rejected: kill switch active');
      return { approved: false, reason: 'KILL_SWITCH_ACTIVE', signal };
    }

    // Cooldown
    if (this.state.cooldownUntil !== null && new Date() < this.state.cooldownUntil) {
      log.warn(
        { signalId: signal.id, cooldownUntil: this.state.cooldownUntil },
        'Rejected: cooldown active',
      );
      return { approved: false, reason: 'COOLDOWN_ACTIVE', signal };
    }

    // Reset cooldown if expired
    if (this.state.cooldownUntil !== null && new Date() >= this.state.cooldownUntil) {
      this.state.cooldownUntil = null;
      log.info('Cooldown expired, trading resumed');
    }

    // Daily reset check
    this.checkDailyReset();

    // Max drawdown check
    const currentDrawdown =
      this.state.peakBalance > 0
        ? (this.state.peakBalance - this.state.currentBalance) / this.state.peakBalance
        : 0;

    const maxDDFraction = Math.min(env.RISK_MAX_DRAWDOWN_FRACTION, HARD_MAX_DRAWDOWN);

    if (currentDrawdown >= maxDDFraction) {
      log.warn(
        { drawdown: currentDrawdown, limit: maxDDFraction },
        'Rejected: max drawdown hit — kill switch triggered',
      );
      this.state.killSwitchActive = true;
      return { approved: false, reason: 'MAX_DRAWDOWN_HIT', signal };
    }

    // Max daily loss check
    const dailyLoss =
      this.state.dailyStartBalance > 0
        ? (this.state.dailyStartBalance - this.state.currentBalance) / this.state.dailyStartBalance
        : 0;

    if (dailyLoss >= env.RISK_MAX_DAILY_LOSS_FRACTION) {
      log.warn(
        { dailyLoss, limit: env.RISK_MAX_DAILY_LOSS_FRACTION },
        'Rejected: max daily loss hit',
      );
      return { approved: false, reason: 'MAX_DAILY_LOSS_HIT', signal };
    }

    // Consecutive losses check
    if (this.state.consecutiveLosses >= env.RISK_MAX_CONSECUTIVE_LOSSES) {
      const cooldownUntil = new Date(Date.now() + env.RISK_COOLDOWN_SECONDS * 1000);
      this.state.cooldownUntil = cooldownUntil;
      log.warn(
        {
          consecutiveLosses: this.state.consecutiveLosses,
          cooldownUntil,
        },
        'Rejected: max consecutive losses — cooldown triggered',
      );
      return { approved: false, reason: 'MAX_CONSECUTIVE_LOSSES', signal };
    }

    // Compute stake
    const stake = this.computeStake(env.RISK_MAX_PER_TRADE_FRACTION);

    if (stake < MIN_STAKE_USD) {
      log.warn({ stake, minStake: MIN_STAKE_USD }, 'Rejected: stake too small');
      return { approved: false, reason: 'POSITION_SIZE_TOO_SMALL', signal };
    }

    const approvedSignal: ApprovedSignal = {
      signal,
      stakeAmount: stake,
      contractDuration: 5, // Default 5 ticks — configurable per strategy
      contractDurationUnit: 't',
      approvedAt: new Date(),
      riskNotes: `Stake=${stake}, DrawdownPct=${(currentDrawdown * 100).toFixed(2)}%, DailyLoss=${(dailyLoss * 100).toFixed(2)}%`,
    };

    log.info(
      {
        signalId: signal.id,
        direction: signal.direction,
        stake,
        currentBalance: this.state.currentBalance,
      },
      'Signal approved',
    );

    return { approved: true, approvedSignal };
  }

  /**
   * Called after each trade result to update risk state.
   * This is mandatory — without this, risk limits cannot function.
   */
  recordTradeResult(profit: number): void {
    this.state.currentBalance += profit;
    this.state.totalTrades++;
    this.state.dailyTrades++;

    if (this.state.currentBalance > this.state.peakBalance) {
      this.state.peakBalance = this.state.currentBalance;
    }

    if (profit > 0) {
      this.state.consecutiveLosses = 0;
      this.state.consecutiveWins++;
    } else {
      this.state.consecutiveWins = 0;
      this.state.consecutiveLosses++;
    }

    log.info(
      {
        profit,
        currentBalance: this.state.currentBalance,
        consecutiveLosses: this.state.consecutiveLosses,
        consecutiveWins: this.state.consecutiveWins,
      },
      'Trade result recorded',
    );
  }

  /**
   * Updates the balance from an external source (e.g., Deriv balance update).
   */
  updateBalance(balance: number): void {
    this.state.currentBalance = balance;
    if (balance > this.state.peakBalance) {
      this.state.peakBalance = balance;
    }
  }

  /**
   * Manually activates the kill switch.
   * Only a manual call to resetKillSwitch() can re-enable trading.
   */
  activateKillSwitch(reason: string): void {
    this.state.killSwitchActive = true;
    log.warn({ reason }, 'KILL SWITCH ACTIVATED');
  }

  /**
   * Resets the kill switch — requires explicit human action.
   */
  resetKillSwitch(): void {
    this.state.killSwitchActive = false;
    log.info('Kill switch reset by operator');
  }

  /**
   * Returns a snapshot of the current risk state (read-only).
   */
  getState(): Readonly<RiskState> {
    return { ...this.state };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private computeStake(fractionOfBalance: number): number {
    const maxFraction = Math.min(fractionOfBalance, HARD_MAX_RISK_PER_TRADE);
    const stake = this.state.currentBalance * maxFraction;
    // Round to 2 decimal places
    return Math.floor(stake * 100) / 100;
  }

  private checkDailyReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.state.dailyDate) {
      log.info({ date: today }, 'Daily risk reset');
      this.state.dailyDate = today;
      this.state.dailyStartBalance = this.state.currentBalance;
      this.state.dailyTrades = 0;
    }
  }
}
