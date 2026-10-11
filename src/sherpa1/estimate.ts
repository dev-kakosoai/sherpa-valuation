import type { Interval, Listing, Machine, SherpaEstimate, SherpaFactor, SherpaModel } from './types.js';
import { roundPrice } from '../estimate.js';
import { ageOf } from './features.js';
import { missingInputs, predictListing, termValue } from './fit.js';

/*
  SHERPA-1 - estimating one machine (docs/MODEL.md §6-7): its value, its
  asking rates for a day, a week and a month, each with a calibrated interval,
  the effect of every input, and the nearest listings as evidence.
*/

/** Normal quantiles, used when the conformal calibration is switched off. */
const NORMAL: Record<string, number> = { '0.5': 0.6745, '0.8': 1.2816, '0.9': 1.6449 };

export interface EstimateOptions {
  /** Interval level; must be one the model was calibrated for (default 0.5). */
  level?: number;
  /** Operator included, for the rates. */
  operator?: boolean;
  /** Comparables to return. */
  comparables?: number;
}

function scoreQuantile(m: SherpaModel, side: 'sale' | 'rent', missing: number, level: number): number {
  const key = String(level);
  const bin = missing === 0 ? '0' : missing === 1 ? '1' : '2+';
  const own = m.conformal[`${side}:${bin}`];
  if (own && own.n >= 20 && own[key] !== undefined) return own[key];
  const all = m.conformal[`${side}:all`];
  if (all && all[key] !== undefined) return all[key];
  // No calibration: a normal interval, widened by a third for each missing input.
  return (NORMAL[key] ?? 0.6745) * (1 + missing / 3);
}

function interval(logTypical: number, halfWidth: number, scale = 1): Interval {
  return {
    low: roundPrice(Math.exp(logTypical - halfWidth) * scale),
    typical: roundPrice(Math.exp(logTypical) * scale),
    high: roundPrice(Math.exp(logTypical + halfWidth) * scale),
  };
}

/** Distance between a machine and a listing: age, size, brand, grade and seller. */
export function distance1(machine: Machine, listing: Listing, asOfYear: number): number {
  let total = 0;
  const a = ageOf(machine, asOfYear);
  const b = ageOf(listing, asOfYear);
  total += a !== null && b !== null ? Math.abs(a - b) / 5 : 0.5;
  total += machine.size && listing.size ? Math.abs(Math.log(machine.size / listing.size)) / 0.5 : 0.5;
  if (machine.brand) total += listing.brand === machine.brand ? 0 : listing.brand ? 0.7 : 0.35;
  if (machine.grade) total += listing.grade ? Math.abs(machine.grade - listing.grade) * 0.3 : 0.15;
  if (machine.seller) total += listing.seller === machine.seller ? 0 : 0.3;
  return total;
}

const FACTOR_TERMS = [
  ['age', 'age'],
  ['size', 'size'],
  ['usage', 'usage'],
  ['new', 'condition'],
  ['grade', 'grade'],
  ['attachments', 'attachments'],
  ['emissions', 'emissions'],
  ['wear', 'wear'],
  ['spec', 'spec'],
  ['seller', 'seller'],
  ['verified', 'verified'],
  ['origin', 'brand'],
  ['brand', 'brand'],
  ['brandInCategory', 'brand'],
  ['region', 'region'],
] as const;

export function estimateSherpa(
  m: SherpaModel,
  machine: Machine,
  options: EstimateOptions = {}
): SherpaEstimate | null {
  const c = m.categories[machine.category];
  if (!c) return null;
  const level = options.level ?? 0.5;
  const asSale: Listing = { ...machine, id: 'input', side: 'sale', price: 1 };
  const logValue = predictListing(m, asSale, false);
  if (logValue === null) return null;
  const missing = missingInputs(m, asSale);

  const value = interval(logValue, scoreQuantile(m, 'sale', missing.length, level) * c.sigmaSale);

  let rates: SherpaEstimate['rates'] = null;
  if (!m.disabled.includes('rentSide')) {
    const rate = (period: number) => {
      const asRent: Listing = { ...machine, id: 'input', side: 'rent', price: 1, period, operator: options.operator ?? false };
      const logRate = predictListing(m, asRent, false) as number;
      return interval(logRate, scoreQuantile(m, 'rent', missing.length, level) * c.sigmaRent, period);
    };
    rates = { daily: rate(1), weekly: rate(7), monthly: rate(30) };
  }
  const monthlyYield = rates ? rates.monthly.typical / value.typical : null;

  // The effect of each input, merged by what the user would call it.
  const row = { listing: asSale, rent: false, category: machine.category, y: 0, age: ageOf(machine, m.asOfYear), logSize: machine.size ? Math.log(machine.size) : null, period: 30 };
  const merged = new Map<string, number>();
  for (const [term, key] of FACTOR_TERMS) {
    // An input the user left out keeps the "unknown" level in the price, but is
    // not shown as something about their machine.
    if ((term === 'emissions' || term === 'spec' || term === 'seller' || term === 'origin' || term === 'region') && !machine[term]) continue;
    const effect = termValue(term, row, m);
    if (Math.abs(effect) > 1e-6) merged.set(key, (merged.get(key) ?? 0) + effect);
  }
  const factors: SherpaFactor[] = [...merged]
    .filter(([, effect]) => Math.abs(effect) > 0.005)
    .map(([key, effect]) => ({ key, multiplier: Math.exp(effect) }));

  const n = c.nSale + c.nRent;
  const confidence: SherpaEstimate['confidence'] =
    n >= 30 && missing.length <= 1 ? 'high' : n >= 12 && missing.length <= 2 ? 'medium' : 'low';

  const comparables = m.listings
    .filter(l => l.category === machine.category)
    .map(l => ({ l, d: distance1(machine, l, m.asOfYear) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, options.comparables ?? 6)
    .map(entry => entry.l);

  return {
    category: machine.category,
    level,
    value,
    rates,
    monthlyYield,
    paybackMonths: monthlyYield ? 1 / monthlyYield : null,
    confidence,
    factors,
    missing,
    comparables,
  };
}

/** Typical value by age, other inputs fixed: a depreciation schedule. */
export function depreciationSchedule(m: SherpaModel, machine: Machine, ages: number[]): { age: number; value: number }[] {
  return ages.map(age => {
    const logValue = predictListing(
      m,
      { ...machine, year: m.asOfYear - age, condition: age === 0 ? 'new' : 'used', id: 'input', side: 'sale', price: 1 },
      false
    );
    return { age, value: logValue === null ? NaN : Math.exp(logValue) };
  });
}
