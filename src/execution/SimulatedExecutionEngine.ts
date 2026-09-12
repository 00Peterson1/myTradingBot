import { createLogger } from '../monitoring/Logger.js';
import type { ApprovedSignal } from '../types/signal.js';
import type { Trade, TradeResult } from '../types/trade.js';

const log = createLogger('SimulatedExecution');

/**
 * SimulatedExecutionEngine — Paper Trading (No Real Orders)
 *
 * Simulates trade outcomes using the NEXT tick price.
 * Used for:
 *   1. Paper trading (dry run before demo)
 *   2. Unit testing the execution pipeline
 *   3. Verifying risk engine behavior
 *
 * This engine NEVER communicates with Deriv API.
 * All outcomes are deterministic given the next price.
 *
 * Payout model: binary options
 *   - WIN: +stake * payoutMultiplier
 *   - LOSE: -stake (entire stake lost)
 */
export interface SimulatedExecutionConfig {
  payoutMultiplier: number; // e.g., 0.85 for 85% payout
  feePerTrade: number; // Fixed fee per trade
}

export class SimulatedExecutionEngine {
  private tradeCount = 0;

  constructor(private readonly config: SimulatedExecutionConfig) {
    log.info({ config }, 'SimulatedExecutionEngine initialized (paper trading)');
  }

  /**
   * Simulates a trade execution given an approved signal and the next price.
   *
   * @param approved - Risk-approved signal with stake amount
   * @param entryPrice - Price at signal time (current tick price)
   * @param exitPrice - Price at trade expiry (next tick price)
   * @returns Complete trade with profit/loss
   */
  execute(approved: ApprovedSignal, entryPrice: number, exitPrice: number): Trade & TradeResult {
    this.tradeCount++;
    const id = crypto.randomUUID();
    const now = new Date();

    const direction = approved.signal.direction;
    if (direction === 'NONE') {
      throw new Error('Cannot execute signal with direction NONE');
    }
    const stake = approved.stakeAmount;

    // Determine outcome
    const priceWentUp = exitPrice > entryPrice;
    const won = (direction === 'BUY' && priceWentUp) || (direction === 'SELL' && !priceWentUp);

    const grossProfit = won ? stake * this.config.payoutMultiplier : -stake;
    const netProfit = grossProfit - this.config.feePerTrade;

    const result: Trade & TradeResult = {
      id,
      signalId: approved.signal.id,
      symbol: approved.signal.symbol,
      strategy: approved.signal.strategy,
      direction: direction as 'BUY' | 'SELL',
      stakeAmount: stake,
      contractType: direction === 'BUY' ? 'CALL' : 'PUT',
      contractDuration: approved.contractDuration,
      contractDurationUnit: approved.contractDurationUnit,
      entryPrice,
      exitPrice,
      entryTime: approved.approvedAt,
      exitTime: now,
      mode: 'PAPER',
      status: 'SETTLED',
      contractId: `SIM-${id}`,

      // Result
      profit: netProfit,
      won,
      returnPct: netProfit / stake,
      riskNotes: approved.riskNotes,
    };

    log.info(
      {
        id,
        direction,
        entryPrice,
        exitPrice,
        stake,
        won,
        profit: netProfit,
      },
      `[PAPER] Trade ${won ? 'WON' : 'LOST'}`,
    );

    return result;
  }

  getTradeCount(): number {
    return this.tradeCount;
  }
}
