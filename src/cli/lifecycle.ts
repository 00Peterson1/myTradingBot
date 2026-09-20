#!/usr/bin/env node
import { print } from '../monitoring/print.js';
import { handleHelp } from './help.js';
handleHelp('lifecycle', 'List hypothesis states. --id HASH shows history. --id HASH --to STATE --reason TEXT [--evidence EXPERIMENT_HASH] requests an evidence-checked transition.');
import { getDb, closeDb } from '../data/database/sqlite.js';
import { StrategyLifecycle, lifecycleStateSchema } from '../research/experiments/StrategyLifecycle.js';
try {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };
  const lifecycle = new StrategyLifecycle(getDb());
  const id = argument('--id');
  const to = argument('--to');
  if (to) {
    const reason = argument('--reason');
    if (!id || !reason) throw new Error('--to requires --id and --reason');
    lifecycle.transition(id, lifecycleStateSchema.parse(to), reason, argument('--evidence'));
  }
  print(JSON.stringify(id ? { id, state: lifecycle.state(id), history: lifecycle.history(id) } : lifecycle.list(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Lifecycle command failed');
  process.exitCode = 1;
} finally { closeDb(); }
