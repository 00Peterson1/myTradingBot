import { print } from '../monitoring/print.js';

/** Help must be available before configuration, database, or network access. */
export function handleHelp(command: string, description: string): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    print(`Usage: npm run ${command} -- [options]\n${description}`);
    process.exit(0);
  }
}
