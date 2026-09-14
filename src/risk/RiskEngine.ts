import { z } from 'zod';
import type { OptionsLedger } from '../portfolio/OptionsLedger.js';
import { createLogger } from '../monitoring/Logger.js';
import type { Env } from '../config/env.js';
import { getEnv } from '../config/index.js';
import { MIN_STAKE_USD, HARD_MAX_RISK_PER_TRADE, HARD_MAX_DRAWDOWN } from '../config/constants.js';
import { signalSchema } from '../types/signal.js';
import { money, optionSpecificationSchema } from '../types/product.js';
import type { Signal, ApprovedSignal, RiskDecision, RiskOutcome } from '../types/signal.js';

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

const riskStateSchema = z.object({
  sessionStartBalance: z.number().finite(), currentBalance: z.number().finite(), peakBalance: z.number().finite(),
  dailyStartBalance: z.number().finite(), dailyDate: z.string(), consecutiveLosses: z.number().int().nonnegative(),
  consecutiveWins: z.number().int().nonnegative(), totalTrades: z.number().int().nonnegative(), dailyTrades: z.number().int().nonnegative(),
  cooldownUntil: z.coerce.date().nullable(), killSwitchActive: z.boolean(),
});

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
  private reserved = new Map<string, number>();

  constructor(initialBalance: number, private readonly currency = 'USD', private readonly ledger?: OptionsLedger,
    private readonly runtime: { now?: () => Date; env?: Env; executionFee?: number } = {}) {
    if (currency !== 'USD') throw new Error('Currency precision and minimum-stake policy currently support USD accounts only');
    if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
      throw new Error('A positive account balance is required');
    }
    const today = this.now().toISOString().slice(0, 10);
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
    const restored = ledger?.loadRiskState();
    if (restored !== null && restored !== undefined) this.state = riskStateSchema.parse(restored);
    this.persist();
    log.info({ initialBalance }, 'Risk engine initialized');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Evaluates a signal and returns a risk decision.
   * This is the main entry point — called for every signal.
   */
  evaluate(signal: Signal, tradingMode: 'DEMO' | 'LIVE' | 'PAPER' | 'BACKTEST'): RiskDecision {
    const snapshot = this.ledger?.snapshot();
    if (snapshot) {
      const restored = this.ledger?.loadRiskState();
      if (restored !== null && restored !== undefined) this.state = riskStateSchema.parse(restored);
      this.state.currentBalance = snapshot.equityMinor / 100;
      this.reserved = new Map(snapshot.intents.filter(intent => ['RESERVED', 'SUBMITTING', 'UNKNOWN', 'OPEN'].includes(intent.status))
        .map(intent => [intent.intent_id, (intent.cost_minor ?? intent.reserved_minor) / 100]));
      if (snapshot.blockedReason) return { approved: false, reason: 'KILL_SWITCH_ACTIVE', signal,
        portfolioSnapshotId: snapshot.id, portfolioAuthority: 'DURABLE_UNRECONCILED' };
    }
    const outcome = this.evaluateSignal(signal, tradingMode);
    this.persist();
    return { ...outcome, portfolioSnapshotId: snapshot?.id ?? crypto.randomUUID(),
      portfolioAuthority: snapshot ? 'DURABLE_UNRECONCILED' : 'SESSION_ONLY' };
  }

  private evaluateSignal(signal: Signal, tradingMode: 'DEMO' | 'LIVE' | 'PAPER' | 'BACKTEST'): RiskOutcome {
    if (!signalSchema.safeParse(signal).success) return { approved: false, reason: 'INVALID_SIGNAL', signal };
    if (signal.product !== 'OPTIONS') return { approved: false, reason: 'UNSUPPORTED_PRODUCT', signal };
    const env = this.runtime.env ?? getEnv();

    // Hard safety: validate trading mode is enabled
    if (tradingMode === 'LIVE') {
      const isLive = env.LIVE_TRADING && env.LIVE_CONFIRMATION && !env.DEMO_TRADING;
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

    if (signal.confidence < env.MIN_CONSENSUS_CONFIDENCE) return { approved: false, reason: 'INSUFFICIENT_CONFIDENCE', signal };

    // Kill switch
    if (this.state.killSwitchActive) {
      log.warn({ signalId: signal.id }, 'Rejected: kill switch active');
      return { approved: false, reason: 'KILL_SWITCH_ACTIVE', signal };
    }

    // Cooldown
    if (this.state.cooldownUntil !== null && this.now() < this.state.cooldownUntil) {
      log.warn(
        { signalId: signal.id, cooldownUntil: this.state.cooldownUntil },
        'Rejected: cooldown active',
      );
      return { approved: false, reason: 'COOLDOWN_ACTIVE', signal };
    }

    // Reset cooldown if expired
    if (this.state.cooldownUntil !== null && this.now() >= this.state.cooldownUntil) {
      this.state.cooldownUntil = null;
      this.state.consecutiveLosses = 0;
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

    if (dailyLoss >= Math.min(env.RISK_MAX_DAILY_LOSS_FRACTION, env.MAX_DAILY_LOSS_PERCENT)) {
      log.warn(
        { dailyLoss, limit: env.RISK_MAX_DAILY_LOSS_FRACTION },
        'Rejected: max daily loss hit',
      );
      return { approved: false, reason: 'MAX_DAILY_LOSS_HIT', signal };
    }

    // Consecutive losses check
    if (this.state.consecutiveLosses >= env.RISK_MAX_CONSECUTIVE_LOSSES) {
      const cooldownUntil = new Date(this.now().getTime() + env.RISK_COOLDOWN_SECONDS * 1000);
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

    if (this.ledger && this.ledger.countPurchasesSince(signal.symbol, new Date(this.now().getTime() - 3600_000)) >= env.MAX_TRADES_PER_HOUR) {
      return { approved: false, reason: 'MAX_TRADES_PER_HOUR', signal };
    }

    // Compute stake — uses STAKE_AMOUNT from .env, capped by MAX_STAKE_PERCENT
    const rawStake = this.computeStake(Math.min(env.RISK_MAX_PER_TRADE_FRACTION, env.MAX_STAKE_PERCENT));

    if (rawStake < MIN_STAKE_USD) {
      log.warn({ rawStake, minStake: MIN_STAKE_USD }, 'Rejected: stake too small');
      return { approved: false, reason: 'POSITION_SIZE_TOO_SMALL', signal };
    }

    // Use STAKE_AMOUNT from env if explicitly set, otherwise use risk-calculated stake
    const fee = this.runtime.executionFee ?? 0;
    if (!Number.isFinite(fee) || fee < 0) throw new Error('Invalid execution fee');
    const configuredStake = env.STAKE_AMOUNT;
    const stake = configuredStake !== undefined
      ? Math.floor(Math.min(rawStake - fee, configuredStake) * 100) / 100
      : Math.floor((rawStake - fee) * 100) / 100;
    if (stake < MIN_STAKE_USD) return { approved: false, reason: 'POSITION_SIZE_TOO_SMALL', signal };
    const reserved = this.getReservedExposure();
    const dailyBudget = this.state.dailyStartBalance * Math.min(env.RISK_MAX_DAILY_LOSS_FRACTION, env.MAX_DAILY_LOSS_PERCENT);
    const drawdownBudget = this.state.peakBalance * maxDDFraction;
    if (this.reserved.size >= env.MAX_OPEN_TRADES ||
        reserved + stake + fee > this.state.currentBalance ||
        Math.max(0, this.state.dailyStartBalance - this.state.currentBalance) + reserved + stake + fee > dailyBudget ||
        this.state.peakBalance - this.state.currentBalance + reserved + stake + fee > drawdownBudget) {
      return { approved: false, reason: 'OPEN_EXPOSURE_LIMIT', signal };
    }

    const parsedSpec = optionSpecificationSchema.safeParse({
      product: 'OPTIONS', symbol: signal.symbol,
      contractType: signal.metadata.contractType ?? (signal.direction === 'BUY' ? 'CALL' : 'PUT'),
      duration: env.CONTRACT_DURATION, durationUnit: env.CONTRACT_DURATION_UNIT,
      basis: 'stake', stake: money(stake, this.currency, 2),
      ...(signal.metadata.barrier !== undefined ? { barrier: Number(signal.metadata.barrier) } : {}),
    });
    if (parsedSpec.success && ((parsedSpec.data.contractType === 'CALL' && signal.direction !== 'BUY') ||
        (parsedSpec.data.contractType === 'PUT' && signal.direction !== 'SELL'))) {
      return { approved: false, reason: 'INVALID_CONTRACT_SPECIFICATION', signal };
    }
    if (!parsedSpec.success) return { approved: false, reason: 'INVALID_CONTRACT_SPECIFICATION', signal };

    const approvedSignal: ApprovedSignal = {
      signal,
      optionSpecification: parsedSpec.data,
      stakeAmount: stake,
      contractDuration: env.CONTRACT_DURATION,
      contractDurationUnit: env.CONTRACT_DURATION_UNIT,
      approvedAt: this.now(),
      riskNotes: `Stake=$${stake.toFixed(2)}, DrawdownPct=${(currentDrawdown * 100).toFixed(2)}%, DailyLoss=${(dailyLoss * 100).toFixed(2)}%`,
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
    if (!Number.isFinite(profit)) throw new Error('Invalid settled profit');
    this.checkDailyReset();
    this.state.currentBalance = this.ledger ? this.ledger.snapshot().equityMinor / 100 : this.state.currentBalance + profit;
    this.state.totalTrades++;
    this.state.dailyTrades++;

    if (this.state.currentBalance > this.state.peakBalance) {
      this.state.peakBalance = this.state.currentBalance;
    }

    if (profit > 0) {
      this.state.consecutiveLosses = 0;
      this.state.consecutiveWins++;
    } else if (profit < 0) {
      this.state.consecutiveWins = 0;
      this.state.consecutiveLosses++;
    }

    this.persist();
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
    if (!Number.isFinite(balance) || balance < 0) throw new Error('Invalid account balance');
    this.state.currentBalance = balance;
    if (balance > this.state.peakBalance) {
      this.state.peakBalance = balance;
    }
  }

  reserve(signal: ApprovedSignal): void {
    this.reserved.set(signal.signal.id, signal.stakeAmount);
  }

  release(signalId: string): void {
    this.reserved.delete(signalId);
  }

  getReservedExposure(): number {
    return [...this.reserved.values()].reduce((sum, amount) => sum + amount, 0);
  }

  /**
   * Manually activates the kill switch.
   * Only a manual call to resetKillSwitch() can re-enable trading.
   */
  activateKillSwitch(reason: string): void {
    this.state.killSwitchActive = true;
    this.persist();
    log.warn({ reason }, 'KILL SWITCH ACTIVATED');
  }

  /**
   * Resets the kill switch — requires explicit human action.
   */
  resetKillSwitch(): void {
    this.state.killSwitchActive = false;
    this.persist();
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

  private now(): Date { return this.runtime.now?.() ?? new Date(); }

  private persist(): void {
    this.ledger?.saveRiskState(this.state);
  }

  private computeStake(fractionOfBalance: number): number {
    const maxFraction = Math.min(fractionOfBalance, HARD_MAX_RISK_PER_TRADE);
    const stake = this.state.currentBalance * maxFraction;
    // Round to 2 decimal places
    return Math.floor(stake * 100) / 100;
  }

  private checkDailyReset(): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.state.dailyDate) {
      log.info({ date: today }, 'Daily risk reset');
      this.state.dailyDate = today;
      this.state.dailyStartBalance = this.state.currentBalance;
      this.state.dailyTrades = 0;
    }
  }
}
