import { assertDefined } from '../../utils/assertDefined.js';
export interface CointegrationResult {
  isCointegrated: boolean;
  pValue: number;          // ADF p-value on residuals (approximate)
  betaHedgeRatio: number;  // OLS slope: log(A) = alpha + beta*log(B) + eps
  alpha: number;           // OLS intercept
  spreadMean: number;      // mean of residuals
  spreadStd: number;       // std of residuals
  adfStatistic: number;    // ADF test statistic on residuals
}

function mean(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const value of arr) sum += value;
  return sum / arr.length;
}

export function cointegrationTest(
  logPricesA: readonly number[],
  logPricesB: readonly number[],
): CointegrationResult {
  const n = logPricesA.length;
  if (n < 50) {
    return {
      isCointegrated: false,
      pValue: 1.0,
      betaHedgeRatio: 1.0,
      alpha: 0.0,
      spreadMean: 0.0,
      spreadStd: 0.0,
      adfStatistic: 0.0,
    };
  }

  const meanA = mean(logPricesA);
  const meanB = mean(logPricesB);

  let sumAB = 0;
  let sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumAB += assertDefined(logPricesA[i]) * assertDefined(logPricesB[i]);
    sumB2 += assertDefined(logPricesB[i]) * assertDefined(logPricesB[i]);
  }

  const beta = (sumAB - n * meanA * meanB) / (sumB2 - n * meanB * meanB);
  const alpha = meanA - beta * meanB;

  const residuals = new Float64Array(n);
  let resSum = 0;
  for (let i = 0; i < n; i++) {
    residuals[i] = assertDefined(logPricesA[i]) - alpha - beta * assertDefined(logPricesB[i]);
    resSum += assertDefined(residuals[i]);
  }
  const spreadMean = resSum / n;

  let sqDiffSum = 0;
  for (let i = 0; i < n; i++) {
    const diff = assertDefined(residuals[i]) - spreadMean;
    sqDiffSum += diff * diff;
  }
  const spreadStd = Math.sqrt(sqDiffSum / n);

  // ADF test on residuals (approximate Dickey-Fuller)
  const delta = new Float64Array(n - 1);
  const lagged = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) {
    delta[i - 1] = assertDefined(residuals[i]) - assertDefined(residuals[i - 1]);
    lagged[i - 1] = assertDefined(residuals[i - 1]);
  }

  let sumLaggedDelta = 0;
  let sumLagged2 = 0;
  for (let i = 0; i < n - 1; i++) {
    sumLaggedDelta += assertDefined(lagged[i]) * assertDefined(delta[i]);
    sumLagged2 += assertDefined(lagged[i]) * assertDefined(lagged[i]);
  }

  const gamma = sumLagged2 === 0 ? 0 : sumLaggedDelta / sumLagged2;

  let errSqSum = 0;
  for (let i = 0; i < n - 1; i++) {
    const err = assertDefined(delta[i]) - gamma * assertDefined(lagged[i]);
    errSqSum += err * err;
  }
  
  const se = Math.sqrt(errSqSum / (n - 1 - 2)) / Math.sqrt(sumLagged2 === 0 ? 1 : sumLagged2);
  const tStat = se === 0 ? 0 : gamma / se;

  let pValue = 0.99;
  if (tStat < -3.96) {
    pValue = 0.01;
  } else if (tStat < -3.41) {
    pValue = 0.05;
  } else if (tStat < -3.12) {
    pValue = 0.10;
  }

  return {
    isCointegrated: pValue < 0.05,
    pValue,
    betaHedgeRatio: beta,
    alpha,
    spreadMean,
    spreadStd,
    adfStatistic: tStat,
  };
}
