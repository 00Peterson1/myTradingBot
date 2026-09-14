import type { Signal } from '../types/signal.js';

/** Only supported strict Rise/Fall and digit contracts can be simulated. */
export function contractWon(signal: Signal, entryPrice: number, exitPrice: number, pipSize?: number): boolean {
  if (signal.product !== 'OPTIONS') throw new Error('Options simulator cannot evaluate CFD signals');
  const contractType = signal.metadata.contractType ?? (signal.direction === 'BUY' ? 'CALL' : 'PUT');
  if (contractType === 'CALL') return exitPrice > entryPrice;
  if (contractType === 'PUT') return exitPrice < entryPrice;
  if (pipSize === undefined || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 10) {
    throw new Error('Digit contract backtesting requires verified symbol precision');
  }
  const digit = Number(exitPrice.toFixed(pipSize).slice(-1));
  if (contractType === 'DIGITEVEN') return digit % 2 === 0;
  if (contractType === 'DIGITODD') return digit % 2 === 1;
  const barrier = Number(signal.metadata.barrier);
  if (!Number.isInteger(barrier) || barrier < 0 || barrier > 9) throw new Error('Digit barrier must be an integer from 0 to 9');
  switch (contractType) {
    case 'DIGITOVER': return digit > barrier;
    case 'DIGITUNDER': return digit < barrier;
    case 'DIGITMATCH': return digit === barrier;
    case 'DIGITDIFF': return digit !== barrier;
    default: throw new Error('Unsupported backtest contract');
  }
}
