import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DerivClient, DerivApiError, UncertainTradeError } from '../../src/api/deriv/DerivClient.js';
import { OptionsLedger } from '../../src/portfolio/OptionsLedger.js';
import { RiskEngine } from '../../src/risk/RiskEngine.js';
import { OptionsExecutionService } from '../../src/execution/OptionsExecutionService.js';
import { resetEnvForTesting } from '../../src/config/env.js';
import type { Signal } from '../../src/types/signal.js';
import type { ContractState } from '../../src/api/deriv/DerivTypes.js';

let db: Database.Database;
let client: DerivClient;
let ledger: OptionsLedger;
let service: OptionsExecutionService;
const candidate = (): Signal => ({ id: crypto.randomUUID(), product: 'OPTIONS', hypothesisId: null,
  strategyVersion: '1', timestamp: new Date(), symbol: 'TEST', price: 100,
  direction: 'BUY', strategy: 'test', confidence: 0.9, metadata: {} });
const opened: ContractState = { contractId: '123', contractType: 'CALL', currency: 'USD', symbol: 'TEST',
  isSettled: false, buyPrice: 1, profit: null, payout: null, entryPrice: 100, exitPrice: null, exitTime: null };

beforeEach(() => {
  vi.stubEnv('DEMO_TRADING', 'true'); vi.stubEnv('LIVE_TRADING', 'false');
  vi.stubEnv('LIVE_CONFIRMATION', 'false'); vi.stubEnv('STAKE_AMOUNT', '1'); resetEnvForTesting();
  db = new Database(':memory:');
  ledger = new OptionsLedger(db, 'account', 'DEMO', 1000);
  client = new DerivClient();
  vi.spyOn(client, 'isTradingConnected').mockReturnValue(true);
  vi.spyOn(client, 'getTradingAccount').mockReturnValue({ accountId: 'account', accountType: 'demo', currency: 'USD', balance: 1000 });
  vi.spyOn(client, 'getPortfolio').mockResolvedValue([]);
  vi.spyOn(client, 'getBalance').mockResolvedValue({ balance: 1000, currency: 'USD' });
  vi.spyOn(client, 'requestProposal').mockResolvedValue({ id: 'proposal', ask_price: 1, payout: 1.85 });
  vi.spyOn(client, 'buyContract').mockResolvedValue({ balance_after: 999, buy_price: 1, contract_id: 123, payout: 1.85, purchase_time: 1000, transaction_id: 456 });
  service = new OptionsExecutionService(client, ledger, new RiskEngine(1000, 'USD', ledger), 'DEMO');
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); resetEnvForTesting(); });

describe('signal → risk → durable reservation → purchase → settlement', () => {
  it('accounts for confirmed settlement and reconciles before accepting another order', async () => {
    await service.start();
    const trade = await service.execute(candidate());
    expect(service.isReady()).toBe(false);
    vi.spyOn(client, 'getPortfolio').mockResolvedValue([{ contract_id: 123, contract_type: 'CALL', currency: 'USD', buy_price: 1 }]);
    vi.spyOn(client, 'getBalance').mockResolvedValue({ balance: 999, currency: 'USD' });
    vi.spyOn(client, 'getContractResult').mockResolvedValue(opened);
    expect(await service.poll()).toEqual([]);
    expect(ledger.get(trade.id).status).toBe('OPEN');
    expect(service.isReady()).toBe(true);
    vi.spyOn(client, 'getContractResult').mockResolvedValue({ ...opened, isSettled: true, payout: 1.85, profit: 0.85 });
    vi.spyOn(client, 'getPortfolio').mockResolvedValue([]);
    vi.spyOn(client, 'getBalance').mockResolvedValue({ balance: 1000.85, currency: 'USD' });
    expect(await service.poll()).toHaveLength(1);
    expect(await service.poll()).toHaveLength(0);
    expect(ledger.snapshot().cashMinor).toBe(100085);
  });
  it('holds uncertain purchases and never retries a buy automatically', async () => {
    await service.start();
    const buy = vi.spyOn(client, 'buyContract').mockRejectedValue(new UncertainTradeError('lost response'));
    await expect(service.execute(candidate())).rejects.toThrow('unknown');
    expect(ledger.snapshot().reservedMinor).toBe(100);
    await expect(service.poll()).rejects.toThrow('Unresolved purchase');
    await expect(service.execute(candidate())).rejects.toThrow('not reconciled');
    expect(buy).toHaveBeenCalledTimes(1);
  });
  it('releases exposure only for a confirmed provider rejection', async () => {
    await service.start();
    vi.spyOn(client, 'buyContract').mockRejectedValue(new DerivApiError('PriceMoved', 'proposal changed'));
    await expect(service.execute(candidate())).rejects.toThrow('PriceMoved');
    expect(ledger.snapshot().reservedMinor).toBe(0);
    await service.poll();
    expect(service.isReady()).toBe(true);
  });
  it('blocks on foreign open contracts, balance drift, and disconnect', async () => {
    await service.start();
    client.emit('tradingDisconnected', 'test');
    expect(service.isReady()).toBe(false);
    vi.spyOn(client, 'getBalance').mockResolvedValue({ balance: 999, currency: 'USD' });
    await expect(service.poll()).rejects.toThrow('cash balance differs');
    expect(service.isReady()).toBe(false);
    vi.spyOn(client, 'getBalance').mockResolvedValue({ balance: 1000, currency: 'USD' });
    vi.spyOn(client, 'getPortfolio').mockResolvedValue([{ contract_id: 999, contract_type: 'PUT', currency: 'USD', buy_price: 1 }]);
    await expect(service.poll()).rejects.toThrow('portfolio differs');
  });
});
