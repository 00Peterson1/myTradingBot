import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CFD_CSV_HEADER, importCfdCsv, writeNewJson } from '../../../src/cfd/history/CfdCsvImport.js';
import { prepareCfdScenario } from '../../../src/cfd/history/CfdScenario.js';
import { cfdDatasetIdentity } from '../../../src/cfd/CfdDataset.js';
import { cfdBacktestConfigSchema } from '../../../src/cfd/CfdBacktest.js';
import { validateCfd } from '../../../src/cfd/CfdValidation.js';
import { inspectCfdData } from '../../../src/cfd/CfdDataQuality.js';
import { cfdResearchPlanSchema, researchCfdBatch } from '../../../src/cfd/CfdResearchBatch.js';
import { catalogueResearchEntries, type CTraderCatalogue } from '../../../src/cfd/ctrader/Catalogue.js';
import { ExperimentRegistry } from '../../../src/research/experiments/ExperimentRegistry.js';
const metadata: unknown = JSON.parse(readFileSync('examples/cfd/import-metadata.json', 'utf8'));
const dataset = cfdDatasetIdentity(JSON.parse(readFileSync('examples/cfd/fixture.json', 'utf8')) as unknown).dataset;
const config = cfdBacktestConfigSchema.parse(JSON.parse(readFileSync('examples/cfd/config.json', 'utf8')) as unknown);

describe('CFD history ingestion and exhaustive coverage', () => {
  it('imports explicit quote/cost rows without modifying prices or financing', async () => {
    const imported = await importCfdCsv('examples/cfd/fixture.csv', metadata);
    expect(imported.dataset).toEqual(dataset);
    expect(imported.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(imported.quality.financingEvents).toBe(1);
  });
  it('rejects missing input, malformed rows and duplicate timestamps without publishing output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cfd-import-'));
    try {
      await expect(importCfdCsv(join(directory, 'missing.csv'), metadata)).rejects.toThrow();
      const path = join(directory, 'bad.csv');
      for (const rows of ['1000,1,1.1,1,30,0,\n', '1000,1,1.1,1,30,0,0\n1000,1,1.1,1,30,0,0\n', '1000,1.2,1.1,1,30,0,0\n']) {
        writeFileSync(path, CFD_CSV_HEADER + '\n' + rows);
        await expect(importCfdCsv(path, metadata)).rejects.toThrow('row');
      }
      const output = join(directory, 'result.json');
      await writeNewJson(output, { original: true });
      await expect(writeNewJson(output, { original: false })).rejects.toThrow();
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ original: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('reports sparse observations without inventing continuity', () => {
    const sparse = { ...dataset, quotes: dataset.quotes.map((row, index) => ({ ...row, timeMs: index * 86400000 })) };
    const quality = inspectCfdData(sparse, 60000);
    expect(quality.activeUtcDays).toBe(250);
    expect(quality.longestContinuousQuotes).toBe(1);
    expect(quality.discontinuities).toBe(249);
  });
  it('charges explicit scenario carrying costs and prevents their use as validated evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cfd-scenario-')), db = new Database(':memory:');
    try {
      const path = join(directory, 'quotes.csv');
      writeFileSync(path, 'timeMs,bid,ask\n0,1,1.01\n259200000,1,1.01\n');
      expect(() => prepareCfdScenario(path, { ...dataset, quotes: undefined }, {})).toThrow();
      const meta = JSON.parse(readFileSync('examples/cfd/import-metadata.json', 'utf8')) as Record<string, unknown>;
      const data = prepareCfdScenario(path, { ...meta, kind: 'EXTERNAL_BID_ASK' }, { description: 'Test assumption', leverage: 30, annualLongFinancingFraction: 0.1, annualShortFinancingFraction: 0.1 });
      expect(data.kind).toBe('SCENARIO_BID_ASK');
      expect(data.quotes[1]?.longFinancingPerLot).toBeCloseTo(-100500 * 0.1 * 3 / 365);
      const result = await validateCfd(data, config, new ExperimentRegistry(db, { test: 'scenario' }));
      expect(result.verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.demoEligible).toBe(false);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('retains every missing symbol and refuses duplicate or mismatched identities', async () => {
    const db = new Database(':memory:');
    try {
      const registry = new ExperimentRegistry(db, { test: 'coverage' });
      const catalogue: CTraderCatalogue = { version: 1, provider: 'CTRADER', environment: 'DEMO', accountId: '123', capturedAt: '2026-09-23T00:00:00Z',
        symbols: [{ symbolId: '1', symbolName: 'US SP 500', symbolCategoryId: '1', enabled: true }, { symbolId: '2', symbolName: 'WRONG', symbolCategoryId: '2', enabled: true }],
        categories: [{ id: '1', assetClassId: '1', name: 'Indices' }, { id: '2', assetClassId: '2', name: 'Forex' }], assetClasses: [{ id: '1', name: 'Indices' }, { id: '2', name: 'Forex' }], archivedSymbols: [] };
      const entries = catalogueResearchEntries(catalogue), entry = entries[0];
      const plan = { version: 2, universeSource: 'CTRADER_ACCOUNT_CATALOGUE', catalogue };
      expect(() => cfdResearchPlanSchema.parse({ ...plan, symbols: [entry, entry] })).toThrow('Duplicate');
      const report = await researchCfdBatch({ ...plan, symbols: [entry, { ...entries[1], dataset: 'fixture.json', config: 'config.json' }] }, resolve('examples/cfd'), registry, true);
      expect(report.symbols).toHaveLength(2);
      expect(report.symbols[0]?.reasons).toContain('MISSING_BID_ASK_HISTORY');
      expect(report.symbols[1]?.status).toBe('INVALID_INPUT');
      expect(report.complete).toBe(false);
      expect(report.liveEligible).toBe(false);
      expect(db.prepare('SELECT * FROM research_holdout_claims').all()).toHaveLength(0);
    } finally { db.close(); }
  });
  it('counts prior trials separately per symbol while retaining unknown-scope declarations', () => {
    const db = new Database(':memory:');
    try {
      const registry = new ExperimentRegistry(db, { test: 'search scopes' });
      registry.registerHypothesis({ product: 'CFD', symbol: 'EURUSD', parameter: 1 });
      registry.registerHypothesis({ product: 'CFD', symbol: 'EURUSD', parameter: 2 });
      registry.registerHypothesis({ product: 'CFD', symbol: 'US500', parameter: 1 });
      expect(registry.countProductHypotheses('CFD', 'EURUSD')).toBe(2);
      expect(registry.countProductHypotheses('CFD', 'US500')).toBe(1);
      registry.registerHypothesis({ product: 'CFD', legacyUnknownSymbol: true });
      expect(registry.countProductHypotheses('CFD', 'EURUSD')).toBe(3);
      expect(registry.countProductHypotheses('CFD')).toBe(4);
    } finally { db.close(); }
  });
  it('reports the account catalogue as pending instead of falling back to Options symbols', async () => {
    const db = new Database(':memory:');
    try {
      const report = await researchCfdBatch(JSON.parse(readFileSync('examples/cfd/real-market-plan.json', 'utf8')) as unknown, resolve('examples/cfd'), new ExperimentRegistry(db, { test: 'universe' }), false);
      expect(report.symbols).toHaveLength(0);
      expect(report.blockers).toContain('CTRADER_CATALOGUE_PENDING');
      expect(report.complete).toBe(false);
    } finally { db.close(); }
  });
});
