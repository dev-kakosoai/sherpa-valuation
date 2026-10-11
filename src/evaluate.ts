import type { MarketListing } from './types.js';
import { fitPriceModel, type FitOptions } from './fit.js';
import { estimatePrice } from './estimate.js';
import { median } from './stats.js';

/*
  Leave-one-out evaluation: every listing is predicted by a
  model fitted without it. Reports the median absolute percentage error and
  how often the stated 50% interval actually contains the price - a calibrated
  model covers about half. These are the numbers a paper would report, against
  the baseline of the plain category median.
*/

export interface Evaluation {
  n: number;
  medianAbsPctError: number;
  baselineMedianAbsPctError: number;
  coverage50: number;
  byCategory: Record<string, { n: number; medianAbsPctError: number; coverage50: number }>;
}

export function leaveOneOut(listings: MarketListing[], options: FitOptions): Evaluation {
  const errors: number[] = [];
  const baselineErrors: number[] = [];
  let covered = 0;
  const perCategory = new Map<string, { errors: number[]; covered: number }>();

  for (const held of listings) {
    const rest = listings.filter(listing => listing.id !== held.id);
    const model = fitPriceModel(rest, options);
    const estimate = estimatePrice(model, {
      category: held.category,
      brand: held.brand,
      year: held.year,
      size: held.size,
      condition: held.condition,
    });
    if (!estimate) continue;
    const error = Math.abs(estimate.typical - held.price) / held.price;
    const peers = rest.filter(listing => listing.category === held.category).map(l => l.price);
    errors.push(error);
    baselineErrors.push(Math.abs(median(peers) - held.price) / held.price);
    const inside = held.price >= estimate.low && held.price <= estimate.high;
    if (inside) covered++;
    const bucket = perCategory.get(held.category) ?? { errors: [], covered: 0 };
    bucket.errors.push(error);
    if (inside) bucket.covered++;
    perCategory.set(held.category, bucket);
  }

  const byCategory: Evaluation['byCategory'] = {};
  for (const [category, bucket] of perCategory) {
    byCategory[category] = {
      n: bucket.errors.length,
      medianAbsPctError: median(bucket.errors),
      coverage50: bucket.covered / bucket.errors.length,
    };
  }
  return {
    n: errors.length,
    medianAbsPctError: median(errors),
    baselineMedianAbsPctError: median(baselineErrors),
    coverage50: errors.length ? covered / errors.length : NaN,
    byCategory,
  };
}
