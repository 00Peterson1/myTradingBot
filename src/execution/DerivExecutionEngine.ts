import { assertDefined } from '../utils/assertDefined.js';
import { majorUnits, optionSpecificationSchema } from '../types/product.js';
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
  async execute(approved: ApprovedSignal, beforePurchase?: () => void): Promise<Trade> {
    const { signal, stakeAmount, contractDuration, contractDurationUnit } = approved;

    if (signal.direction === 'NONE') {
      throw new Error('Cannot execute a NONE signal — logic error in caller');
    }

    const spec = optionSpecificationSchema.parse(approved.optionSpecification);
    if (signal.product !== 'OPTIONS' || spec.symbol !== signal.symbol ||
        majorUnits(spec.stake) !== stakeAmount || spec.duration !== contractDuration ||
        spec.durationUnit !== contractDurationUnit) {
      throw new Error('Approved Options specification does not match the execution request');
    }
    const contractType = spec.contractType;
    const barrier = spec.barrier;

    log.info(
      {
        mode: this.mode,
        symbol: signal.symbol,
        direction: signal.direction,
        contractType,
        barrier,
        stake: stakeAmount,
        duration: `${String(contractDuration)}${contractDurationUnit}`,
        strategy: signal.strategy,
      },
      `[${this.mode}] Placing ${contractType}${barrier !== undefined ? ` (${String(barrier)})` : ''} contract`,
    );

    try {
      // The approved hypothesis is immutable. Unsupported specifications must fail.
      const proposal = await this.client.requestProposal({
        stake: majorUnits(spec.stake), basis: spec.basis, contractType,
        ...(barrier !== undefined ? { barrier } : {}),
        currency: spec.stake.currency, duration: spec.duration,
        durationUnit: spec.durationUnit, symbol: spec.symbol,
      });
      if (!Number.isFinite(proposal.ask_price) || proposal.ask_price <= 0 || proposal.ask_price > stakeAmount) {
        throw new Error('Proposal cost exceeds approved stake or is invalid');
      }

      beforePurchase?.();
      // 2. Buy contract with proposal ID and price
      const response = await this.client.buyContract(proposal.id, proposal.ask_price);

      const trade: Trade = {
        product: 'OPTIONS', optionSpecification: spec,
        id: crypto.randomUUID(),
        signalId: signal.id,
        symbol: signal.symbol,
        strategy: signal.strategy,
        direction: signal.direction,
        stakeAmount: response.buy_price,
        contractType,
        contractDuration,
        contractDurationUnit,
        entryPrice: null, // Entry spot is only known from subsequent contract status.
        exitPrice: null, // Not yet settled
        entryTime: new Date(response.purchase_time * 1000),
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
      const cleanMsg = error.message;

      log.warn(
        {
          symbol: signal.symbol,
          error: cleanMsg,
          mode: this.mode,
        },
        `[${this.mode}] Order skipped for ${signal.symbol}`,
      );
      throw err;
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

    if (!response.isSettled) throw new Error('Contract is not settled');
    if (response.currency !== trade.optionSpecification.stake.currency || response.contractType !== trade.contractType) {
      throw new Error('Settlement product/currency does not match the purchased contract');
    }
    const profit = assertDefined(response.profit);
    const won = profit > 0;

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
      exitPrice: response.exitPrice,
      exitTime: response.exitTime,
      status: 'SETTLED',
    };
  }

  getMode(): 'DEMO' | 'LIVE' {
    return this.mode;
  }
}
