import type {
  Confidence,
  MachineInput,
  MarketListing,
  PriceEstimate,
  PriceFactor,
  PriceModel,
} from './types.js';
import { Z50 } from './stats.js';
import { ageOf } from './fit.js';

/*
  Estimating one machine: the fitted category model applied to the user's
  inputs, an interval from the model's spread widened for what the user left
  out, and the most similar listings as evidence.
*/

/** How much wider the interval gets when a price-moving input is unknown. */
const MISSING_WIDEN = { age: 0.3, size: 0.45 };

/** A price a person would write: 1,240 -> 1,250; 18,730 -> 18,750; 263,000 -> 265,000. */
export function roundPrice(value: number): number {
  const step = value < 2_000 ? 50 : value < 20_000 ? 250 : value < 200_000 ? 1_000 : 5_000;
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * Similarity distance between a machine and a listing: age in 5-year units,
 * size in half log-units (about 1.6x), a different brand or condition each
 * counting as a step. Unknown values count as half a step.
 */
export function distance(input: MachineInput, listing: MarketListing, asOfYear: number): number {
  let total = 0;
  const inputAge = ageOf(
    { year: input.year ?? null, condition: input.condition ?? null },
    asOfYear
  );
  const listingAge = ageOf(listing, asOfYear);
  total += inputAge !== null && listingAge !== null ? Math.abs(inputAge - listingAge) / 5 : 0.5;
  total +=
    input.size && listing.size
      ? Math.abs(Math.log(input.size) - Math.log(listing.size)) / 0.5
      : 0.5;
  if (input.brand) total += listing.brand === input.brand ? 0 : listing.brand ? 0.7 : 0.35;
  if (input.condition) total += listing.condition === input.condition ? 0 : 0.5;
  return total;
}

export function estimatePrice(model: PriceModel, input: MachineInput): PriceEstimate | null {
  const category = model.categories[input.category];
  if (!category) return null;

  const factors: PriceFactor[] = [];
  let logPrice = category.intercept;
  let sigma = category.sigma;

  const age = ageOf(
    { year: input.year ?? null, condition: input.condition ?? null },
    model.asOfYear
  );
  if (age !== null) {
    const effect = category.agePerYear * (age - category.referenceAge);
    logPrice += effect;
    factors.push({ key: 'age', multiplier: Math.exp(effect) });
  } else {
    sigma *= 1 + MISSING_WIDEN.age;
  }

  if (category.referenceLogSize !== null) {
    if (input.size && input.size > 0) {
      // Within the sizes the fit saw; beyond them, the edge and a wider range.
      const [minLog, maxLog] = category.logSizeRange ?? [-Infinity, Infinity];
      const logSize = Math.min(maxLog, Math.max(minLog, Math.log(input.size)));
      if (logSize !== Math.log(input.size)) sigma *= 1 + MISSING_WIDEN.size;
      const effect = category.sizeElasticity * (logSize - category.referenceLogSize);
      logPrice += effect;
      factors.push({ key: 'size', multiplier: Math.exp(effect) });
    } else {
      sigma *= 1 + MISSING_WIDEN.size;
    }
  }

  if (input.condition === 'new' && category.newPremium !== 0) {
    logPrice += category.newPremium;
    factors.push({ key: 'condition', multiplier: Math.exp(category.newPremium) });
  }

  const brand = input.brand ? category.brands[input.brand] : undefined;
  if (brand && Math.abs(brand.effect) > 0.01) {
    logPrice += brand.effect;
    factors.push({ key: 'brand', multiplier: Math.exp(brand.effect) });
  }

  // The intercept's own uncertainty shrinks with the listings behind it.
  const spread = sigma * Math.sqrt(1 + 1 / category.n);
  const comparables = model.listings
    .filter(listing => listing.category === input.category)
    .map(listing => ({ listing, d: distance(input, listing, model.asOfYear) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
    .map(entry => entry.listing);

  const confidence: Confidence =
    category.n >= 20 &&
    age !== null &&
    (category.referenceLogSize === null || input.size) &&
    spread < 0.5
      ? 'high'
      : category.n >= 10 && spread < 0.8
        ? 'medium'
        : 'low';

  return {
    category: input.category,
    low: roundPrice(Math.exp(logPrice - Z50 * spread)),
    typical: roundPrice(Math.exp(logPrice)),
    high: roundPrice(Math.exp(logPrice + Z50 * spread)),
    confidence,
    basis: category.n,
    factors,
    comparables,
  };
}
