import { createLogger } from '../monitoring/Logger.js';
import { getEnv, isLiveTradingEnabled } from '../config/env.js';
import type { DerivClient } from '../api/deriv/DerivClient.js';
import type { ApprovedSignal } from '../types/signal.js';
import type { Trade, TradeResult } from '../types/trade.js';

const log = createLogger('DerivExecution');

/**
 * DerivExecutionEngine — Places REAL orders via the Deriv API.
 *
 * SAFETY ARCHITECTURE:
 *   - Demo mode (real API, virtual money): always allowed when DEMO_TRADING=true
 *   - Live mode (real API, real money): requires LIVE_TRADING=true AND LIVE_CONFIRMATION=true
 *   - This engine NEVER bypasses the environment check
 *   - The trading mode (demo/live) is determined by the Deriv account type,
 *     not by this engine's internal state — the API token determines the account
 *
 * IMPORTANT:
 *   On Deriv, demo and live accounts use DIFFERENT API tokens.
 *   The DERIV_API_TOKEN in .env should be your DEMO token by default.
 *   Only after validating strategy performance should you consider a live token.
 */
export class DerivExecutionEngine {
  private readonly mode: 'DEMO' | 'LIVE';

  constructor(private readonly client: DerivClient) {
    const env = getEnv();

    // Determine mode based on env — NEVER allow live without explicit confirmation
    if (isLiveTradingEnabled()) {
      this.mode = 'LIVE';
      log.warn('DerivExecutionEngine initialized in LIVE mode — real money at risk');
    } else {
      this.mode = 'DEMO';
      log.info('DerivExecutionEngine initialized in DEMO mode (virtual money)');
    }

    if (!env.DEMO_TRADING && this.mode === 'DEMO') {
      throw new Error('DEMO_TRADING=false but attempted to initialize demo execution engine');
    }
  }

  /**
   * Places a binary options contract on Deriv.
   *
   * Contract type mapping:
   *   BUY signal → CALL contract (profit if price goes up)
   *   SELL signal → PUT contract (profit if price goes down)
   *
   * @param approved - Risk-validated signal with stake amount
   * @returns Pending trade awaiting settlement
   */
  async execute(approved: ApprovedSignal): Promise<Trade> {
    const { signal, stakeAmount, contractDuration, contractDurationUnit } = approved;

    if (signal.direction === 'NONE') {
      throw new Error('Cannot execute a NONE signal — logic error in caller');
    }

    const contractType = signal.direction === 'BUY' ? 'CALL' : 'PUT';

    log.info(
      {
        mode: this.mode,
        symbol: signal.symbol,
        direction: signal.direction,
        contractType,
        stake: stakeAmount,
        duration: `${contractDuration}${contractDurationUnit}`,
        strategy: signal.strategy,
      },
      `[${this.mode}] Placing ${contractType} contract`,
    );

    try {
      // 1. Request proposal quote
      const proposal = await this.client.requestProposal({
        stake: stakeAmount,
        basis: 'stake',
        contractType,
        currency: 'USD',
        duration: contractDuration,
        durationUnit: contractDurationUnit,
        symbol: signal.symbol,
      });

      // 2. Buy contract with proposal ID and price
      const response = await this.client.buyContract(proposal.id, proposal.ask_price);

      const trade: Trade = {
        id: crypto.randomUUID(),
        signalId: signal.id,
        symbol: signal.symbol,
        strategy: signal.strategy,
        direction: signal.direction,
        stakeAmount,
        contractType,
        contractDuration,
        contractDurationUnit,
        entryPrice: response.buy_price,
        exitPrice: null, // Not yet settled
        entryTime: new Date(),
        exitTime: null,
        mode: this.mode,
        status: 'OPEN',
        contractId: String(response.contract_id),
        riskNotes: approved.riskNotes,
      };

      log.info(
        {
          contractId: trade.contractId,
          entryPrice: trade.entryPrice,
          mode: this.mode,
        },
        `[${this.mode}] Contract placed successfully`,
      );

      return trade;
    } catch (err) {
      const error = err as Error;
      log.error(
        {
          symbol: signal.symbol,
          strategy: signal.strategy,
          error: error.message,
          mode: this.mode,
        },
        `[${this.mode}] Failed to place contract`,
      );
      throw error;
    }
  }

  /**
   * Polls for contract settlement result.
   * Call this after the contract duration has elapsed.
   */
  async settle(trade: Trade): Promise<TradeResult> {
    if (!trade.contractId) {
      throw new Error('Cannot settle trade without contractId');
    }

    log.info({ contractId: trade.contractId, mode: this.mode }, `[${this.mode}] Settling contract`);

    const response = await this.client.getContractResult(trade.contractId);

    const won = response.profit >= 0;
    const profit = response.profit;

    log.info(
      {
        contractId: trade.contractId,
        won,
        profit,
        mode: this.mode,
      },
      `[${this.mode}] Contract settled: ${won ? 'WON' : 'LOST'} $${Math.abs(profit).toFixed(2)}`,
    );

    return {
      profit,
      won,
      returnPct: profit / trade.stakeAmount,
      exitPrice: trade.entryPrice,
      exitTime: new Date(),
      status: 'SETTLED',
    };
  }

  getMode(): 'DEMO' | 'LIVE' {
    return this.mode;
  }
}
