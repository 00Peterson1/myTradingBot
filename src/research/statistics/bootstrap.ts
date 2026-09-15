import { assertDefined } from '../../utils/assertDefined.js';

export interface BootstrapPolicy { seed: number; replications: number; blockLength: number; minObservations: number }
export const DEFAULT_BOOTSTRAP_POLICY: BootstrapPolicy = { seed: 1729, replications: 2000, blockLength: 5, minObservations: 30 };

/** Circular block percentile CI for mean return; blocks never cross fold boundaries. */
export function blockBootstrapMean(segments: readonly (readonly number[])[], policy: BootstrapPolicy = DEFAULT_BOOTSTRAP_POLICY): [number, number] | null {
  if (!Number.isInteger(policy.seed) || policy.seed < 0 || policy.seed > 0xffffffff ||
      !Number.isInteger(policy.replications) || policy.replications < 500 || policy.replications > 100000 ||
      !Number.isInteger(policy.blockLength) || policy.blockLength < 1 ||
      !Number.isInteger(policy.minObservations) || policy.minObservations < 2) throw new Error('Invalid bootstrap policy');
  const count = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (segments.some(segment => Array.from(segment).some(value => !Number.isFinite(value)))) throw new Error('Bootstrap requires finite returns');
  if (count < policy.minObservations || !segments.length || segments.some(segment => segment.length < 2 * policy.blockLength)) return null;
  let state = policy.seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let replicate = 0; replicate < policy.replications; replicate++) {
    let total = 0;
    for (const segment of segments) {
      let taken = 0;
      while (taken < segment.length) {
        const start = Math.floor(random() * segment.length);
        for (let offset = 0; offset < policy.blockLength && taken < segment.length; offset++, taken++) {
          total += assertDefined(segment[(start + offset) % segment.length]);
        }
      }
    }
    means.push(total / count);
  }
  means.sort((a, b) => a - b);
  const quantile = (p: number): number => {
    const position = (means.length - 1) * p;
    const left = Math.floor(position);
    return assertDefined(means[left]) + (position - left) * (assertDefined(means[Math.ceil(position)]) - assertDefined(means[left]));
  };
  return [quantile(0.025), quantile(0.975)];
}
