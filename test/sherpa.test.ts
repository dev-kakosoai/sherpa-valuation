import { describe, expect, it } from 'vitest';
import {
  cleanListings,
  estimatePrice,
  excavatorClassFromModel,
  extractHours,
  extractMachineSize,
  extractSize,
  extractYear,
  fitPriceModel,
  leaveOneOut,
  roundPrice,
  shrink,
  syntheticMarket,
  SYNTHETIC_CATEGORIES,
  theilSenSlope,
  type MarketListing,
} from '../src/index.js';

/*
  Synthetic markets with known depreciation and size elasticity, so the tests
  check that the fit recovers what was put in - not that it reproduces a
  snapshot of anyone's listings.
*/

const AS_OF = 2026;
const options = { market: 'XX', currency: 'USD', asOfYear: AS_OF, fittedAt: 'test' };

/** Deterministic noise: a linear congruential generator, then Box-Muller. */
function noise(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
}

/** log p = log(300k) - 0.08·(age-6) + 0.7·log(size/20) + brand + 0.2·ε */
function market(n: number, seed = 1): MarketListing[] {
  const gaussian = noise(seed);
  const brands = ['Alpha', 'Bravo', 'Delta', 'Charlie'];
  const brandEffect: Record<string, number> = { Alpha: 0.15, Bravo: 0.05, Delta: -0.2, Charlie: 0 };
  const sizes = [3, 8, 14, 20, 22, 30, 36, 45];
  return Array.from({ length: n }, (_, i) => {
    const age = 1 + (i % 14);
    const size = sizes[i % sizes.length];
    const brand = brands[i % brands.length];
    const log =
      Math.log(300_000) -
      0.08 * (age - 6) +
      0.7 * Math.log(size / 20) +
      brandEffect[brand] +
      0.2 * gaussian();
    return {
      id: i + 1,
      category: 'excavators',
      brand,
      year: AS_OF - age,
      size,
      hours: null,
      condition: 'used' as const,
      region: null,
      price: Math.round(Math.exp(log)),
    };
  });
}

describe('extract', () => {
  it('reads a plausible year from the title, then the description', () => {
    expect(extractYear('Komatsu PC200 2016 for sale', null, AS_OF)).toBe(2016);
    expect(extractYear('Komatsu PC200', 'Year 2012, good condition', AS_OF)).toBe(2012);
    // A model number or a year in the future is not a manufacture year.
    expect(extractYear('Generator 2050 kVA', null, AS_OF)).toBeNull();
    expect(extractYear('Volvo EC210', null, AS_OF)).toBeNull();
  });

  it('reads sizes in the category unit within plausible bounds', () => {
    expect(extractSize('Kubota 3 Ton Mini Excavator', null, 'ton')).toBe(3);
    expect(extractSize('Cummins 500 kVA generator', null, 'kva')).toBe(500);
    expect(extractSize('Cummins 500 kVA generator', null, 'ton')).toBeNull();
    expect(extractSize('Anything 20 ton', null, null)).toBeNull();
  });

  it('reads an excavator class from its model number', () => {
    expect(excavatorClassFromModel('Komatsu PC200-8', 'Komatsu')).toBe(20);
    expect(excavatorClassFromModel('Volvo EC210B', 'Volvo')).toBe(21);
    expect(excavatorClassFromModel('CAT 320D excavator', 'Caterpillar')).toBe(20);
    expect(excavatorClassFromModel('Caterpillar 336 for sale', null)).toBe(36);
    expect(excavatorClassFromModel('Mini excavator, very clean', null)).toBe(3.5);
    // A Caterpillar year is not a model number.
    expect(excavatorClassFromModel('CAT excavator 2016', 'Caterpillar')).toBeNull();
  });

  it('prefers a stated size and only reads models for excavators', () => {
    expect(extractMachineSize('excavators', 'ton', 'Komatsu PC200 22 ton', null, null)).toBe(22);
    expect(extractMachineSize('excavators', 'ton', 'Komatsu PC200', null, null)).toBe(20);
    expect(extractMachineSize('trucks', 'ton', 'Hino PC200', null, null)).toBeNull();
  });

  it('reads engine hours from a field or the text, within credible bounds', () => {
    expect(extractHours('4,500', '', null)).toBe(4500);
    expect(extractHours(null, 'Loader 6200 hrs', null)).toBe(6200);
    expect(extractHours(null, 'Loader', 'only 12,000 working hours')).toBe(12000);
    expect(extractHours(250000, 'Loader', null)).toBeNull();
  });
});

describe('stats', () => {
  it('Theil-Sen ignores an outlier a least-squares line would chase', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7];
    const ys = [2, 4, 6, 8, 10, 12, 100];
    expect(theilSenSlope(xs, ys)).toBeCloseTo(2, 5);
    expect(theilSenSlope([1, 2], [1, 2])).toBeNull();
  });

  it('shrinks a group toward its parent by how little data it has', () => {
    expect(shrink(1, 0, 0, 4)).toBe(0);
    expect(shrink(1, 4, 0, 4)).toBe(0.5);
    expect(shrink(1, 1000, 0, 4)).toBeGreaterThan(0.99);
  });

  it('rounds to a price a person would write', () => {
    expect(roundPrice(1_240)).toBe(1_250);
    expect(roundPrice(18_730)).toBe(18_750);
    expect(roundPrice(263_000)).toBe(265_000);
  });
});

describe('fitPriceModel', () => {
  const listings = market(160);
  const model = fitPriceModel(listings, options);
  const excavators = model.categories.excavators;

  it('recovers depreciation and size elasticity', () => {
    expect(excavators.agePerYear).toBeGreaterThan(-0.11);
    expect(excavators.agePerYear).toBeLessThan(-0.05);
    expect(excavators.sizeElasticity).toBeGreaterThan(0.55);
    expect(excavators.sizeElasticity).toBeLessThan(0.85);
  });

  it('orders brands the way the market prices them', () => {
    expect(excavators.brands.Alpha.effect).toBeGreaterThan(excavators.brands.Delta.effect);
  });

  it('drops categories with too few listings and impossible prices', () => {
    const thin = listings.slice(0, 5).map(listing => ({ ...listing, category: 'cranes' }));
    expect(fitPriceModel([...listings, ...thin], options).categories.cranes).toBeUndefined();
    const typo = { ...listings[0], id: 9999, price: listings[0].price * 1000 };
    expect(cleanListings([...listings, typo]).some(listing => listing.id === 9999)).toBe(false);
  });

  it('never prices a new machine below the same one used', () => {
    const mixed = market(120, 7).map((listing, i) =>
      i % 3 === 0 ? { ...listing, condition: 'new' as const, price: listing.price * 0.6 } : listing
    );
    expect(fitPriceModel(mixed, options).categories.excavators.newPremium).toBeGreaterThanOrEqual(
      0
    );
  });

  it('leaves size out where few listings state it', () => {
    const sparse = listings.map((listing, i) =>
      i % 5 === 0 ? listing : { ...listing, size: null }
    );
    const fitted = fitPriceModel(sparse, options).categories.excavators;
    expect(fitted.referenceLogSize).toBeNull();
    expect(fitted.sizeElasticity).toBe(0);
  });

  it('beats the category median in leave-one-out and covers about half', () => {
    const evaluation = leaveOneOut(market(80, 3), options);
    expect(evaluation.medianAbsPctError).toBeLessThan(evaluation.baselineMedianAbsPctError);
    expect(evaluation.coverage50).toBeGreaterThan(0.35);
    expect(evaluation.coverage50).toBeLessThan(0.75);
  });
});

describe('estimatePrice', () => {
  const model = fitPriceModel(market(160), options);
  const base = { category: 'excavators', year: 2018, size: 20, condition: 'used' as const };

  it('is dearer for younger and bigger machines', () => {
    const older = estimatePrice(model, { ...base, year: 2012 })!;
    const younger = estimatePrice(model, { ...base, year: 2022 })!;
    const bigger = estimatePrice(model, { ...base, size: 36 })!;
    const middle = estimatePrice(model, base)!;
    expect(younger.typical).toBeGreaterThan(middle.typical);
    expect(older.typical).toBeLessThan(middle.typical);
    expect(bigger.typical).toBeGreaterThan(middle.typical);
    expect(middle.low).toBeLessThan(middle.typical);
    expect(middle.high).toBeGreaterThan(middle.typical);
  });

  it('caps sizes outside what it has seen and widens the range instead', () => {
    const edge = estimatePrice(model, { ...base, size: 45 })!;
    const beyond = estimatePrice(model, { ...base, size: 450 })!;
    expect(beyond.typical).toBe(edge.typical);
    expect(beyond.high - beyond.low).toBeGreaterThan(edge.high - edge.low);
  });

  it('widens the range when the year is unknown', () => {
    const known = estimatePrice(model, base)!;
    const unknown = estimatePrice(model, { ...base, year: null })!;
    expect(unknown.high / unknown.low).toBeGreaterThan(known.high / known.low);
  });

  it('returns six comparables, nearest first, and null for an unknown category', () => {
    const estimate = estimatePrice(model, base)!;
    expect(estimate.comparables).toHaveLength(6);
    expect(estimate.comparables[0].size).toBe(20);
    expect(estimatePrice(model, { category: 'submarines' })).toBeNull();
  });
});

describe('syntheticMarket', () => {
  it('is deterministic for a seed and different across seeds', () => {
    expect(syntheticMarket({ seed: 5 })).toEqual(syntheticMarket({ seed: 5 }));
    expect(syntheticMarket({ seed: 5 })).not.toEqual(syntheticMarket({ seed: 6 }));
  });

  it('is as messy as asked: missing years and sizes, bad prices', () => {
    const listings = syntheticMarket({ perCategory: 400, seed: 2 });
    const share = (test: (l: MarketListing) => boolean) =>
      listings.filter(test).length / listings.length;
    expect(share(l => l.year === null)).toBeGreaterThan(0.08);
    expect(share(l => l.condition === 'new')).toBeGreaterThan(0.08);
    expect(cleanListings(listings).length).toBeLessThan(listings.length);
  });

  it('lets a fit recover the depreciation it was built with', () => {
    const model = fitPriceModel(syntheticMarket({ perCategory: 300, seed: 11 }), options);
    for (const truth of SYNTHETIC_CATEGORIES) {
      const fitted = model.categories[truth.category];
      expect(fitted).toBeDefined();
      expect(Math.abs(fitted.agePerYear - truth.agePerYear)).toBeLessThan(0.03);
    }
  });
});
