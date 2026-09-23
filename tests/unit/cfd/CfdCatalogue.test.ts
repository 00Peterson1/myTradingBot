import { describe, expect, it } from 'vitest';
import { cTraderCatalogueSchema, catalogueResearchEntries, catalogueIdentity, type CTraderCatalogue } from '../../../src/cfd/ctrader/Catalogue.js';
import { cfdResearchPlanSchema } from '../../../src/cfd/CfdResearchBatch.js';

// Provider-shaped test data only: these IDs do not identify a real broker account or catalogue.
function fixture(): CTraderCatalogue {
  const names = ['Forex', 'Precious Metals', 'Commodities', 'Crypto', 'Stock Index', 'Stocks', 'Synthetic Indices', 'Unfamiliar'];
  return { version: 1, provider: 'CTRADER', environment: 'DEMO', accountId: '123', capturedAt: '2026-09-23T00:00:00Z',
    assetClasses: names.map((name, i) => ({ id: String(i + 1), name })), categories: names.map((name, i) => ({ id: String(i + 1), assetClassId: String(i + 1), name })),
    symbols: ['EURUSD', 'XAUUSD', 'US Oil', 'BTCUSD', 'US SP 500', 'NEW_STOCK', 'Volatility 10 Index', 'NEW_UNKNOWN'].map((symbolName, i) => ({ symbolName, symbolId: String(100 + i), symbolCategoryId: String(i + 1), enabled: true })),
    archivedSymbols: [{ symbolId: '999', name: 'OLD_STOCK' }] };
}
describe('cTrader CFD catalogue is independent from Options discovery', () => {
  it('retains all six real market categories, unknown, archived and paused synthetic symbols', () => {
    const entries = catalogueResearchEntries(fixture());
    expect(entries).toHaveLength(9);
    expect(entries.slice(0, 6).map(row => row.category)).toEqual(['forex', 'metals', 'commodities', 'crypto', 'stock_indices', 'stocks']);
    expect(entries[4]).toMatchObject({ symbol: 'US SP 500', brokerSymbolId: '104', catalogueStatus: 'ACTIVE' });
    expect(entries[6]?.category).toBe('synthetic');
    expect(entries[7]?.catalogueStatus).toBe('REVIEW_REQUIRED');
    expect(entries[8]?.catalogueStatus).toBe('ARCHIVED');
  });
  it('never treats a missing enabled flag or category reference as permission to research', () => {
    const input = fixture();
    input.symbols = [{ symbolId: '1', symbolName: 'EURUSD', symbolCategoryId: '1' }, { symbolId: '2', symbolName: 'NEW', enabled: true, symbolCategoryId: '999' }, { symbolId: '3', symbolName: 'DISABLED', enabled: false }];
    expect(catalogueResearchEntries(input).slice(0, 3).map(row => row.catalogueStatus)).toEqual(['REVIEW_REQUIRED', 'REVIEW_REQUIRED', 'DISABLED']);
  });
  it('rejects duplicate/unsafe IDs and binds identity to the account and catalogue', () => {
    const input = fixture();
    expect(() => cTraderCatalogueSchema.parse({ ...input, symbols: [input.symbols[0], input.symbols[0]] })).toThrow('Duplicate');
    expect(() => cTraderCatalogueSchema.parse({ ...input, accountId: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(catalogueIdentity(input)).not.toBe(catalogueIdentity({ ...input, accountId: '456' }));
  });
  it('rejects Options plans, incomplete universes and substituted broker names', () => {
    const catalogue = fixture(), symbols = catalogueResearchEntries(catalogue);
    const plan = { version: 2, universeSource: 'CTRADER_ACCOUNT_CATALOGUE', catalogue, symbols };
    expect(cfdResearchPlanSchema.parse(plan).symbols).toHaveLength(9);
    expect(() => cfdResearchPlanSchema.parse({ version: 1, universeSource: 'Options', symbols })).toThrow();
    expect(() => cfdResearchPlanSchema.parse({ ...plan, catalogue: null })).toThrow('require a cTrader');
    expect(() => cfdResearchPlanSchema.parse({ ...plan, symbols: symbols.slice(1) })).toThrow('every cTrader');
    expect(() => cfdResearchPlanSchema.parse({ ...plan, symbols: symbols.map(row => row.symbol === 'US SP 500' ? { ...row, symbol: 'OTC_SPC' } : row) })).toThrow('differs');
  });
});
