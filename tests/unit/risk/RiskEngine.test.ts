import { describe, it, expect, beforeEach } from 'vitest';
import { RiskEngine } from '../../../src/risk/RiskEngine.js';
import { resetEnvForTesting } from '../../../src/config/env.js';
import type { Signal } from '../../../src/types/signal.js';

// Helper to create a mock signal
function mockSignal(direction: Signal['direction'] = 'BUY'): Signal {
  return {
    product: 'OPTIONS', hypothesisId: null, strategyVersion: '1',
    id: crypto.randomUUID(),
    timestamp: new Date(),
    symbol: 'R_100',
    price: 1000,
    direction,
    strategy: 'TestStrategy',
    confidence: 0.8,
    metadata: {},
  };
}

// Set required env vars before importing config-dependent modules
function setTestEnv(): void {
  delete process.env.STAKE_AMOUNT;
  process.env.DERIV_API_TOKEN = 'test_token';
  process.env.DATABASE_PASSWORD = 'test_pass';
  process.env.DEMO_TRADING = 'true';
  process.env.LIVE_TRADING = 'false';
  process.env.LIVE_CONFIRMATION = 'false';
  process.env.RISK_MAX_PER_TRADE_FRACTION = '0.01';
  process.env.RISK_MAX_DAILY_LOSS_FRACTION = '0.05';
  process.env.RISK_MAX_DRAWDOWN_FRACTION = '0.15';
  process.env.RISK_MAX_CONSECUTIVE_LOSSES = '3';
  process.env.RISK_COOLDOWN_SECONDS = '1';
  process.env.LOG_LEVEL = 'error'; // Suppress logs in tests
  process.env.LOG_PRETTY = 'false';
}

describe('RiskEngine', () => {
  let engine: RiskEngine;

  beforeEach(() => {
    setTestEnv();
    resetEnvForTesting(); // Clear cached env so process.env changes take effect
    engine = new RiskEngine(10_000);
  });

  // ---------------------------------------------------------------------------
  // Basic approval
  // ---------------------------------------------------------------------------

  it('approves a valid DEMO BUY signal', () => {
    const result = engine.evaluate(mockSignal('BUY'), 'DEMO');
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.approvedSignal.stakeAmount).toBeGreaterThan(0);
      expect(result.approvedSignal.stakeAmount).toBeLessThanOrEqual(10_000 * 0.05);
    }
  });

  it('approves a valid DEMO SELL signal', () => {
    const result = engine.evaluate(mockSignal('SELL'), 'DEMO');
    expect(result.approved).toBe(true);
  });

  it('rejects NONE direction signal', () => {
    const result = engine.evaluate(mockSignal('NONE'), 'DEMO');
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('NO_SIGNAL');
    }
  });

  // ---------------------------------------------------------------------------
  // Live trading safety gates
  // ---------------------------------------------------------------------------

  it('SAFETY: rejects LIVE signals when env says LIVE_TRADING=false', () => {
    // LIVE_TRADING=false is set in setTestEnv()
    const result = engine.evaluate(mockSignal('BUY'), 'LIVE');
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('LIVE_TRADING_DISABLED');
    }
  });

  // ---------------------------------------------------------------------------
  // Kill switch
  // ---------------------------------------------------------------------------

  it('rejects all signals when kill switch is active', () => {
    engine.activateKillSwitch('Test kill');
    const result = engine.evaluate(mockSignal('BUY'), 'DEMO');
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('KILL_SWITCH_ACTIVE');
    }
  });

  it('approves signals after kill switch is manually reset', () => {
    engine.activateKillSwitch('Test kill');
    engine.resetKillSwitch();
    const result = engine.evaluate(mockSignal('BUY'), 'DEMO');
    expect(result.approved).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Consecutive losses / cooldown
  // ---------------------------------------------------------------------------

  it('triggers cooldown after reaching max consecutive losses', () => {
    engine.recordTradeResult(-100);
    engine.recordTradeResult(-100);
    engine.recordTradeResult(-100); // Third loss — limit is 3

    const result = engine.evaluate(mockSignal('BUY'), 'DEMO');
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('MAX_CONSECUTIVE_LOSSES');
    }
  });

  it('resets consecutive loss counter after a win', () => {
    engine.recordTradeResult(-100);
    engine.recordTradeResult(-100);
    engine.recordTradeResult(200); // Win breaks the streak
    const state = engine.getState();
    expect(state.consecutiveLosses).toBe(0);
    expect(state.consecutiveWins).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Drawdown protection
  // ---------------------------------------------------------------------------

  it('triggers kill switch when max drawdown is reached', () => {
    // Engine starts at 10,000. 15% drawdown = below 8,500
    engine.updateBalance(8_499); // 15.01% drawdown from 10,000
    const result = engine.evaluate(mockSignal('BUY'), 'DEMO');
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('MAX_DRAWDOWN_HIT');
    }
  });

  // ---------------------------------------------------------------------------
  // Position sizing
  // ---------------------------------------------------------------------------

  it('stake equals 1% of balance (RISK_MAX_PER_TRADE_FRACTION=0.01)', () => {
    const result = engine.evaluate(mockSignal('BUY'), 'DEMO');
    if (result.approved) {
      // 1% of 10,000 = 100
      expect(result.approvedSignal.stakeAmount).toBeCloseTo(100, 0);
    }
  });

  it('ANTI-MARTINGALE: stake does NOT increase after a loss', () => {
    const resultBefore = engine.evaluate(mockSignal('BUY'), 'DEMO');
    const stakeBefore = resultBefore.approved ? resultBefore.approvedSignal.stakeAmount : 0;

    // Record a loss equal to the full stake
    engine.recordTradeResult(-stakeBefore);

    const resultAfter = engine.evaluate(mockSignal('BUY'), 'DEMO');
    const stakeAfter = resultAfter.approved ? resultAfter.approvedSignal.stakeAmount : 0;

    // Stake should be smaller after a loss (balance decreased), never larger
    expect(stakeAfter).toBeLessThanOrEqual(stakeBefore);
  });

  // ---------------------------------------------------------------------------
  // State tracking
  // ---------------------------------------------------------------------------

  it('tracks balance and trade counts correctly', () => {
    engine.recordTradeResult(500); // win
    engine.recordTradeResult(-200); // loss
    engine.recordTradeResult(100); // win

    const state = engine.getState();
    expect(state.currentBalance).toBeCloseTo(10_400, 0);
    expect(state.totalTrades).toBe(3);
    // After: win → loss → win: consecutiveLosses=0, consecutiveWins=1
    expect(state.consecutiveLosses).toBe(0);
    expect(state.consecutiveWins).toBe(1);
  });

  it('tracks peak balance correctly', () => {
    engine.recordTradeResult(1000); // Balance → 11,000 (new peak)
    engine.recordTradeResult(-500); // Balance → 10,500

    const state = engine.getState();
    expect(state.peakBalance).toBeCloseTo(11_000, 0);
    expect(state.currentBalance).toBeCloseTo(10_500, 0);
  });
});
