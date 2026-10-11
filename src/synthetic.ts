import type { MarketListing } from './types.js';

/*
  Synthetic markets with known parameters.

  Every listing is drawn from the model's own form,

    log p = log(price₀) + b·(age − age₀) + c·log(size / size₀) + d·[new] + e_brand + σ·ε,

  then made as messy as real marketplace data: years and sizes left out,
  new machines without a year, and a few impossible prices (placeholders, a
  missing zero). Because the parameters are known, a fit can be checked
  against the truth, and the library can be tried and benchmarked without
  anyone's real listings.

  Deterministic for a given seed.
*/

export interface SyntheticCategory {
  category: string;
  /** Price of the reference machine (used, age `referenceAge`, size `referenceSize`). */
  basePrice: number;
  referenceAge: number;
  /** Null for a category priced without a size measure. */
  referenceSize: number | null;
  sizes: number[];
  /** True change in log-price per year of age. */
  agePerYear: number;
  /** True elasticity of price to size. */
  sizeElasticity: number;
  /** True log-price premium of a new machine. */
  newPremium: number;
  /** True brand effects on log-price. */
  brands: Record<string, number>;
  /** Spread of log-price around the truth. */
  sigma: number;
}

export interface SyntheticOptions {
  /** Listings per category. */
  perCategory?: number;
  seed?: number;
  asOfYear?: number;
  /** Share of listings with no year (a new machine then has age 0). */
  missingYear?: number;
  /** Share of listings with no size. */
  missingSize?: number;
  /** Share of listings that are new. */
  newShare?: number;
  /** Share of listings with an impossible price (x1000 or /1000). */
  badPrice?: number;
  categories?: SyntheticCategory[];
}

/** Four categories with plausible, made-up parameters. Not fitted to any real market. */
export const SYNTHETIC_CATEGORIES: SyntheticCategory[] = [
  {
    category: 'excavators',
    basePrice: 300_000,
    referenceAge: 6,
    referenceSize: 20,
    sizes: [1.8, 3, 5.5, 8, 14, 20, 22, 30, 36, 45],
    agePerYear: -0.08,
    sizeElasticity: 0.7,
    newPremium: 0.25,
    brands: { Alpha: 0.15, Bravo: 0.05, Charlie: 0, Delta: -0.2 },
    sigma: 0.25,
  },
  {
    category: 'wheel-loaders',
    basePrice: 260_000,
    referenceAge: 7,
    referenceSize: 18,
    sizes: [8, 12, 15, 18, 22, 28],
    agePerYear: -0.07,
    sizeElasticity: 0.6,
    newPremium: 0.2,
    brands: { Alpha: 0.12, Bravo: 0.04, Echo: -0.15 },
    sigma: 0.28,
  },
  {
    category: 'generators',
    basePrice: 60_000,
    referenceAge: 5,
    referenceSize: 250,
    sizes: [20, 60, 100, 250, 500, 800, 1250],
    agePerYear: -0.1,
    sizeElasticity: 0.55,
    newPremium: 0.2,
    brands: { Foxtrot: 0.1, Golf: 0, Hotel: -0.25 },
    sigma: 0.3,
  },
  {
    category: 'compactors',
    basePrice: 45_000,
    referenceAge: 6,
    referenceSize: null,
    sizes: [],
    agePerYear: -0.06,
    sizeElasticity: 0,
    newPremium: 0.15,
    brands: { India: 0.08, Juliet: -0.1 },
    sigma: 0.3,
  },
];

/** Uniform (0, 1) from a linear congruential generator. */
function uniform(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
}

/** The unit of a synthetic category: kVA for generators, tons otherwise. */
export function syntheticUnit(category: string): 'ton' | 'kva' | null {
  const spec = SYNTHETIC_CATEGORIES.find(c => c.category === category);
  if (!spec || spec.referenceSize === null) return null;
  return category === 'generators' ? 'kva' : 'ton';
}

export function syntheticMarket(options: SyntheticOptions = {}): MarketListing[] {
  const {
    perCategory = 80,
    seed = 1,
    asOfYear = 2026,
    missingYear = 0.15,
    missingSize = 0.2,
    newShare = 0.15,
    badPrice = 0.02,
    categories = SYNTHETIC_CATEGORIES,
  } = options;
  const random = uniform(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];

  const listings: MarketListing[] = [];
  let id = 1;
  for (const spec of categories) {
    const brandNames = Object.keys(spec.brands);
    for (let i = 0; i < perCategory; i++) {
      const isNew = random() < newShare;
      const age = isNew ? 0 : 1 + Math.floor(random() * 15);
      const size = spec.referenceSize === null ? null : pick(spec.sizes);
      const brand = pick(brandNames);
      let log =
        Math.log(spec.basePrice) +
        spec.agePerYear * (age - spec.referenceAge) +
        spec.brands[brand] +
        (isNew ? spec.newPremium : 0) +
        spec.sigma * gaussian();
      if (size !== null && spec.referenceSize !== null) {
        log += spec.sizeElasticity * Math.log(size / spec.referenceSize);
      }
      let price = Math.round(Math.exp(log) / 100) * 100;
      const roll = random();
      if (roll < badPrice / 2) price = price * 1000;
      else if (roll < badPrice) price = Math.max(1, Math.round(price / 1000));

      listings.push({
        id: id++,
        category: spec.category,
        brand,
        year: random() < missingYear ? null : asOfYear - age,
        size: size === null || random() < missingSize ? null : size,
        hours: null,
        condition: isNew ? 'new' : 'used',
        region: null,
        price,
      });
    }
  }
  return listings;
}
