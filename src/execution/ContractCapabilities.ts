import type { AvailableContract } from '../api/deriv/DerivTypes.js';

export type ContractFamily = 'RISE_FALL' | 'EVEN_ODD' | 'OVER_UNDER' | 'MATCHES_DIFFERS';
export type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';
export interface ContractSpec {
  family: ContractFamily;
  duration: number;
  durationUnit: DurationUnit;
}

export const FAMILY_CONTRACTS: Record<ContractFamily, readonly string[]> = {
  RISE_FALL: ['CALL', 'PUT'],
  EVEN_ODD: ['DIGITEVEN', 'DIGITODD'],
  OVER_UNDER: ['DIGITOVER', 'DIGITUNDER'],
  // The shared strategy factory currently uses DIFFERS mode.
  MATCHES_DIFFERS: ['DIGITDIFF'],
};
const SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

function parseDuration(value: string | undefined): { value: number; ticks: boolean } | null {
  const match = /^(\d+)([tsmhd])$/.exec(value ?? '');
  if (!match) return null;
  const unit = match[2] as DurationUnit;
  return { value: Number(match[1]) * (unit === 't' ? 1 : SECONDS[unit]), ticks: unit === 't' };
}

function supports(contract: AvailableContract, duration: number, unit: DurationUnit): boolean {
  const min = parseDuration(contract.min_contract_duration);
  const max = parseDuration(contract.max_contract_duration);
  if (!min || !max || min.ticks !== max.ticks || min.ticks !== (unit === 't')) return false;
  const value = duration * (unit === 't' ? 1 : SECONDS[unit]);
  // CALL/PUT with a required barrier represents Higher/Lower, not Rise/Fall.
  if (['CALL', 'PUT'].includes(contract.contract_type) && Number(contract.barriers ?? 0) !== 0) return false;
  return value >= min.value && value <= max.value;
}

/** Use advertised durations. Never retry an order using an unvalidated expiry. */
export function resolveContractSpec(
  available: readonly AvailableContract[],
  requestedFamily: ContractFamily | 'AUTO',
  duration: number,
  unit: DurationUnit,
): ContractSpec | null {
  const family = requestedFamily === 'AUTO' ? 'RISE_FALL' : requestedFamily;
  const types = FAMILY_CONTRACTS[family];
  const accepts = (d: number, u: DurationUnit): boolean =>
    types.every(type => available.some(c => c.contract_type === type && supports(c, d, u)));
  if (accepts(duration, unit)) return { family, duration, durationUnit: unit };
  // Financial markets commonly offer time-based contracts only. Resolve this
  // before research validation, and use the same resolved expiry in execution.
  if (unit === 't' && family === 'RISE_FALL') {
    const candidates = available.filter(c => types.includes(c.contract_type))
      .map(c => parseDuration(c.min_contract_duration))
      .filter((d): d is { value: number; ticks: boolean } => d !== null && !d.ticks)
      .sort((a, b) => a.value - b.value);
    for (const candidate of candidates) {
      if (accepts(candidate.value, 's')) return { family, duration: candidate.value, durationUnit: 's' };
    }
  }
  return null;
}
