import { format } from 'node:util';

/** Human-readable CLI output; operational events belong in the structured logger. */
export function print(...values: unknown[]): void {
  process.stdout.write(format(...values) + '\n');
}
