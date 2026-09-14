import { DerivApiError, type DerivClient } from '../api/deriv/DerivClient.js';
import { DerivExecutionEngine } from './DerivExecutionEngine.js';
import type { OptionsLedger, LedgerIntent } from '../portfolio/OptionsLedger.js';
import type { RiskEngine } from '../risk/RiskEngine.js';
import { assertDefined } from '../utils/assertDefined.js';
import { optionSpecificationSchema } from '../types/product.js';
import type { ApprovedSignal, Signal } from '../types/signal.js';
import type { Trade } from '../types/trade.js';
import type { ContractState } from '../api/deriv/DerivTypes.js';

export interface RecordedSettlement { intent: LedgerIntent; state: ContractState }

/** One serialized account pipeline shared by demo and live runners. */
export class OptionsExecutionService {
  private ready = false;
  private busy = false;
  private executor: DerivExecutionEngine;

  constructor(
    private readonly client: DerivClient,
    readonly ledger: OptionsLedger,
    readonly risk: RiskEngine,
    private readonly mode: 'DEMO' | 'LIVE',
  ) {
    this.executor = new DerivExecutionEngine(client);
    if (this.executor.getMode() !== mode) throw new Error('Executor and account mode disagree');
    this.client.on('tradingDisconnected', () => { this.ready = false; });
    this.client.on('tradingConnected', () => { this.ready = false; });
  }

  isReady(): boolean { return this.ready && !this.busy && this.client.isTradingConnected(); }

  async start(): Promise<RecordedSettlement[]> {
    this.ledger.recoverAfterRestart();
    return this.poll();
  }

  async execute(signal: Signal): Promise<Trade> {
    if (!this.isReady()) throw new Error('Account is not reconciled and ready');
    this.busy = true;
    this.ready = false;
    try {
      let approved: ApprovedSignal | undefined;
      const intent = this.ledger.reserve(() => {
        const decision = this.risk.evaluate(signal, this.mode);
        if (!decision.approved) throw new Error(`Risk rejected: ${decision.reason}`);
        approved = decision.approvedSignal;
        return approved;
      });
      try {
        const trade = await this.executor.execute(assertDefined(approved), () => { this.ledger.markSubmitting(intent.intent_id); });
        this.ledger.recordPurchase(intent.intent_id, assertDefined(trade.contractId), trade.stakeAmount, trade);
        return { ...trade, id: intent.intent_id };
      } catch (error) {
        const current = this.ledger.get(intent.intent_id);
        if (current.status === 'RESERVED') this.ledger.cancel(intent.intent_id);
        else if (current.status === 'SUBMITTING') {
          if (error instanceof DerivApiError) this.ledger.rejectPurchase(intent.intent_id);
          else this.ledger.markUnknown(intent.intent_id);
        }
        throw error;
      }
    } finally {
      this.busy = false;
      // A subsequent successful poll must reconcile cash and contracts before another buy.
    }
  }

  async poll(): Promise<RecordedSettlement[]> {
    if (this.busy || !this.client.isTradingConnected()) return [];
    this.busy = true;
    this.ready = false;
    const settled: RecordedSettlement[] = [];
    try {
      const account = this.client.getTradingAccount();
      if (account?.currency !== 'USD' || account.accountType !== (this.mode === 'DEMO' ? 'demo' : 'real') ||
          this.ledger.accountKey !== `${this.mode}:OPTIONS:${account.accountId}`) throw new Error('Authenticated account does not match ledger');
      for (const intent of this.ledger.snapshot().intents.filter(item => item.status === 'OPEN')) {
        const state = await this.client.getContractResult(assertDefined(intent.contract_id));
        const spec = optionSpecificationSchema.parse(JSON.parse(intent.specification));
        if (state.contractType !== spec.contractType || state.currency !== spec.stake.currency ||
            (state.symbol !== null && state.symbol !== intent.symbol)) throw new Error('Contract identity mismatch during reconciliation');
        if (!state.isSettled) continue;
        if (state.buyPrice !== (intent.cost_minor ?? 0) / 100) throw new Error('Contract purchase price does not match ledger');
        const applied = this.ledger.recordSettlement(intent.intent_id, assertDefined(state.payout), assertDefined(state.profit),
          () => { this.risk.recordTradeResult(assertDefined(state.profit)); }, state);
        if (applied) settled.push({ intent, state });
      }
      const portfolio = await this.client.getPortfolio();
      if (portfolio.some(contract => contract.currency !== 'USD')) throw new Error('Unexpected currency in account portfolio');
      const balance = await this.client.getBalance();
      if (balance.currency !== 'USD') throw new Error('Unexpected balance currency');
      this.ledger.confirmReconciled(balance.balance, portfolio.map(contract => String(contract.contract_id)));
      this.ready = true;
      return settled;
    } catch (error) {
      this.ledger.block(error instanceof Error ? error.message : 'Reconciliation failed');
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
