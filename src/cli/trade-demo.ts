#!/usr/bin/env node
import { print } from '../monitoring/print.js';
import { handleHelp } from './help.js';
handleHelp('trade:demo', 'Eligible Options hypotheses only. --symbols SYMBOL,... --hypotheses HASH,... --list-markets');
import { runEligibleTrading } from '../execution/runEligibleTrading.js';
if (process.argv.includes('--list-markets')) {
  print('Use npm run markets to inspect the public instrument catalogue. Availability is not strategy eligibility.');
} else {
  runEligibleTrading('DEMO').catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Demo runner failed');
    process.exitCode = 1;
  });
}
