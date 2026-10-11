import type { Block, Listing } from './types.js';
import type { MarketListing } from '../types.js';
import { median } from '../stats.js';
import { fitPriceModel } from '../fit.js';
import { estimatePrice } from '../estimate.js';
import { cleanListings1, fitSherpa, missingInputs, predictListing, type SherpaFitOptions } from './fit.js';
import { periodOf } from './features.js';

/*
  SHERPA-1 - evaluation (docs/MODEL.md §9). K-fold cross-validation: every
  listing is predicted by a model fitted without its fold. Errors are on the
  listing's own scale (price, or the rate for its period); intervals are
  checked for the share of held-out prices they contain.
*/

export interface SideMetrics {
  n: number;
  /** Median absolute percentage error of the typical estimate. */
  mdape: number;
  /** Mean absolute log error. */
  male: number;
  /** Share of held-out prices inside the 50% and 80% intervals. */
  coverage50: number;
  coverage80: number;
  /** Median width of the 50% interval, as high / low. */
  width50: number;
}

export interface CrossValidation {
  sale: SideMetrics;
  rent: SideMetrics;
  baselines: { categoryMedian: { sale: number; rent: number }; sherpa0Sale: number };
}

function fold(id: number | string, folds: number): number {
  let h = 2166136261;
  for (const ch of `cv:${id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % folds;
}

const NORMAL50 = 0.6745;
const NORMAL80 = 1.2816;

/** log of the listed price on the model's scale: price, or rate per day. */
const logTarget = (l: Listing) =>
  l.side === 'rent' ? Math.log(l.price / periodOf(l.period)) : Math.log(l.price);

function toMarketListing(l: Listing, asOfYear: number): MarketListing {
  void asOfYear;
  return {
    id: l.id,
    category: l.category,
    brand: l.brand ?? null,
    year: l.year ?? null,
    size: l.size ?? null,
    hours: l.hours ?? null,
    condition: l.condition ?? null,
    region: l.region ?? null,
    price: l.price,
  };
}

export function crossValidate(
  listings: Listing[],
  options: SherpaFitOptions,
  folds = 5
): CrossValidation {
  const cleaned = cleanListings1(listings);
  const errors = { sale: [] as number[], rent: [] as number[] };
  const logErrors = { sale: [] as number[], rent: [] as number[] };
  const inside50 = { sale: 0, rent: 0 };
  const inside80 = { sale: 0, rent: 0 };
  const widths = { sale: [] as number[], rent: [] as number[] };
  const baseline = { sale: [] as number[], rent: [] as number[] };
  const sherpa0: number[] = [];

  for (let f = 0; f < folds; f++) {
    const train = cleaned.filter(l => fold(l.id, folds) !== f);
    const test = cleaned.filter(l => fold(l.id, folds) === f);
    const model = fitSherpa(train, options);
    const model0 = fitPriceModel(
      train.filter(l => l.side === 'sale').map(l => toMarketListing(l, options.asOfYear)),
      { market: options.market, currency: options.currency, asOfYear: options.asOfYear, fittedAt: 'cv' }
    );
    for (const l of test) {
      const side = l.side;
      if (side === 'rent' && model.disabled.includes('rentSide')) continue;
      const predicted = predictListing(model, l);
      if (predicted === null) continue;
      const c = model.categories[l.category];
      const sigma = side === 'rent' ? c.sigmaRent : c.sigmaSale;
      const missing = missingInputs(model, l).length;
      const q = (level: number, normal: number) => {
        const bin = missing === 0 ? '0' : missing === 1 ? '1' : '2+';
        const own = model.conformal[`${side}:${bin}`];
        const all = model.conformal[`${side}:all`];
        const key = String(level);
        if (own && own.n >= 20 && own[key] !== undefined) return own[key];
        if (all && all[key] !== undefined) return all[key];
        return normal * (1 + missing / 3);
      };
      const y = logTarget(l);
      const residual = Math.abs(y - predicted);
      errors[side].push(Math.abs(Math.exp(predicted - y) - 1));
      logErrors[side].push(residual);
      const h50 = q(0.5, NORMAL50) * sigma;
      const h80 = q(0.8, NORMAL80) * sigma;
      if (residual <= h50) inside50[side]++;
      if (residual <= h80) inside80[side]++;
      widths[side].push(Math.exp(2 * h50));

      // Baseline: the median of the same category and side in the training folds
      // (for rent, of the same period).
      const peers = train
        .filter(p => p.category === l.category && p.side === side && (side === 'sale' || periodOf(p.period) === periodOf(l.period)))
        .map(logTarget);
      if (peers.length) baseline[side].push(Math.abs(Math.exp(median(peers) - y) - 1));

      if (side === 'sale') {
        const estimate = estimatePrice(model0, {
          category: l.category,
          brand: l.brand,
          year: l.year,
          size: l.size,
          condition: l.condition,
        });
        if (estimate) sherpa0.push(Math.abs(estimate.typical / l.price - 1));
      }
    }
  }

  const metrics = (side: 'sale' | 'rent'): SideMetrics => {
    const n = errors[side].length;
    return {
      n,
      mdape: median(errors[side]),
      male: n ? logErrors[side].reduce((a, b) => a + b, 0) / n : NaN,
      coverage50: n ? inside50[side] / n : NaN,
      coverage80: n ? inside80[side] / n : NaN,
      width50: median(widths[side]),
    };
  };
  return {
    sale: metrics('sale'),
    rent: metrics('rent'),
    baselines: {
      categoryMedian: { sale: median(baseline.sale), rent: median(baseline.rent) },
      sherpa0Sale: median(sherpa0),
    },
  };
}

/** Cross-validation with each block switched off in turn. */
export function ablations(
  listings: Listing[],
  options: SherpaFitOptions,
  blocks: Block[],
  folds = 5
): Record<string, CrossValidation> {
  const out: Record<string, CrossValidation> = { full: crossValidate(listings, options, folds) };
  for (const block of blocks) {
    out[block] = crossValidate(listings, { ...options, disable: [...(options.disable ?? []), block] }, folds);
  }
  return out;
}
