#!/usr/bin/env node
import { handleHelp } from './help.js';
handleHelp('trade:live', 'Eligible Options hypotheses only; explicit live flags required. --symbols SYMBOL,... --hypotheses HASH,...');
import { runEligibleTrading } from '../execution/runEligibleTrading.js';
runEligibleTrading('LIVE').catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Live runner failed');
  process.exitCode = 1;
});
