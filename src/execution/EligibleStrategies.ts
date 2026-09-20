import { requestedSymbol, storedMarketAllowed } from '../markets/MarketScope.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { BacktestEngine } from '../backtest/BacktestEngine.js';
import { getEnv } from '../config/env.js';
import { captureResearchCode, contentHash } from '../research/experiments/ExperimentRegistry.js';
import { StrategyLifecycle } from '../research/experiments/StrategyLifecycle.js';
import { strategyFactories } from '../strategies/catalogue.js';
import type { Strategy } from '../strategies/base/Strategy.js';

const declarationSchema = z.object({ symbol: z.string(), strategy: z.string(),
  declaration: z.object({ catalogKey: z.string(), version: z.literal(1) }) });

export interface EligibleStrategy { id: string; symbol: string; strategy: Strategy; assertEligible: () => void }

/** Reconstruct only known, versioned factories. Never execute code from an artifact. */
export function loadEligibleStrategies(db: Database.Database, mode: 'DEMO' | 'LIVE', symbols: readonly string[], ids?: readonly string[]): EligibleStrategy[] {
  const env = getEnv();
  const lifecycle = new StrategyLifecycle(db);
  const codeId = contentHash(captureResearchCode(fileURLToPath(new URL('../../', import.meta.url))));
  const candidates = ids ? ids.map(id => ({ id, state: lifecycle.state(id) })) : lifecycle.list()
    .filter(row => (mode === 'DEMO' ? ['DEMO_ELIGIBLE', 'DEMO_RUNNING'] : ['LIVE_ELIGIBLE', 'LIVE']).includes(row.state));
  const loaded: EligibleStrategy[] = [];
  for (const { id } of candidates) {
    const registered = lifecycle.declaration(id);
    const declaration = declarationSchema.parse(registered);
    if (!requestedSymbol(declaration.symbol, symbols) || !storedMarketAllowed(db, declaration.symbol, env.MARKET_SCOPE)) {
      if (ids) throw new Error('Requested hypothesis symbol is outside SYMBOLS or MARKET_SCOPE');
      continue;
    }
    lifecycle.assertEligible(id, mode, codeId);
    const entry = strategyFactories.find(candidate => candidate.name === declaration.declaration.catalogKey);
    if (!entry) throw new Error('Hypothesis factory is not in the executable catalogue');
    const expected = new BacktestEngine({ strategyFactory: entry.factory, strategyName: entry.name,
      strategyDeclaration: { catalogKey: entry.name, version: 1 }, symbol: declaration.symbol,
      payoutMultiplier: env.BACKTEST_PAYOUT_MULTIPLIER, feePerTrade: 0, minConfidence: env.MIN_CONSENSUS_CONFIDENCE,
      contextWindow: 200, contractDuration: env.CONTRACT_DURATION, contractDurationUnit: env.CONTRACT_DURATION_UNIT }).declaration();
    if (contentHash(expected) !== id) throw new Error('Runtime strategy, contract, risk or feature configuration differs from the validated hypothesis');
    if (loaded.some(row => row.symbol === declaration.symbol)) throw new Error('Multiple eligible hypotheses for one symbol: select one explicitly with --hypotheses');
    const strategy = entry.factory();
    const assertEligible = (): void => { lifecycle.assertEligible(id, mode, codeId); };
    loaded.push({ id, symbol: declaration.symbol, assertEligible, strategy: {
      name: `hypothesis:${id}`, description: strategy.description,
      generateSignal: (current, history) => {
        assertEligible();
        return { ...strategy.generateSignal(current, history), hypothesisId: id, strategyVersion: '1', strategy: `hypothesis:${id}` };
      },
    } });
  }
  if (!loaded.length) throw new Error(`No ${mode}-eligible hypotheses. Research rankings do not authorize trading. Inspect npm run lifecycle.`);
  return loaded;
}
