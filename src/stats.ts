/*
  Robust statistics. Marketplace listings are few and noisy - placeholder
  prices, mistyped years, a new machine priced as used - so everything here
  resists outliers: medians, MADs and Theil-Sen slopes rather than means and
  least squares.
*/

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The p-quantile (0..1) by linear interpolation. */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** Median absolute deviation, scaled to estimate a normal standard deviation. */
export function robustSigma(values: number[]): number {
  if (values.length < 2) return NaN;
  const centre = median(values);
  return 1.4826 * median(values.map(value => Math.abs(value - centre)));
}

/**
 * Theil-Sen slope: the median of the slopes between every pair of points with
 * different x. Tolerates up to ~29% outliers. Null with fewer than 3 points or
 * no spread in x.
 */
export function theilSenSlope(xs: number[], ys: number[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const dx = xs[j] - xs[i];
      if (Math.abs(dx) > 1e-9) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  return xs.length >= 3 && slopes.length > 0 ? median(slopes) : null;
}

/**
 * Partial pooling (empirical-Bayes shrinkage): a group estimate from n points
 * pulled toward its parent in proportion to how little data it has.
 * weight = n / (n + k); k is the number of points at which the two count equally.
 */
export function shrink(groupValue: number, n: number, parentValue: number, k: number): number {
  const weight = n / (n + k);
  return weight * groupValue + (1 - weight) * parentValue;
}

/** The inverse of the standard normal CDF at 0.75: half the width of a 50% interval. */
export const Z50 = 0.6744897501960817;
