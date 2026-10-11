import { describe, expect, it } from 'vitest';
import {
  boxCox,
  cleanListings1,
  crossValidate,
  depreciationSchedule,
  estimateSherpa,
  fitSherpa,
  syntheticMarket1,
  usageRatio,
} from '../src/index.js';

/*
  SHERPA-1 on synthetic markets with known parameters (src/sherpa1/synthetic.ts):
  the fit must recover what the market was built with, respect the domain
  constraints, and give calibrated intervals.
*/

const options = { market: 'XX', currency: 'USD', asOfYear: 2026, fittedAt: 'test', folds: 0 };
const { listings, truth } = syntheticMarket1({ sale: 100, rent: 100, seed: 3 });
const model = fitSherpa(listings, options);
const truthOf = (category: string) => truth.categories.find(c => c.category === category)!;

describe('transforms', () => {
  it('Box-Cox nests the log and the linear curve', () => {
    expect(boxCox(9, 0)).toBeCloseTo(Math.log(10), 10);
    expect(boxCox(9, 1)).toBeCloseTo(9, 10);
    expect(boxCox(9, 1e-9)).toBeCloseTo(Math.log(10), 6);
  });

  it('usage is zero for a normally used machine and grows with hours', () => {
    expect(usageRatio(5000, 5, 1000)).toBeCloseTo(0, 10);
    expect(usageRatio(10000, 5, 1000)).toBeGreaterThan(0.6);
  });
});

describe('fitSherpa', () => {
  it('recovers the duration discount and the rent-to-value ratio of every category', () => {
    for (const t of truth.categories) {
      const c = model.categories[t.category];
      expect(Math.abs(c.duration - t.duration)).toBeLessThan(0.08);
      expect(Math.abs(c.rentToValue - t.rentToValue)).toBeLessThan(0.25);
    }
  });

  it('recovers size elasticity and depreciation within tolerance', () => {
    for (const name of ['excavators', 'wheel-loaders', 'cranes', 'generators']) {
      expect(Math.abs(model.categories[name].sizeElasticity - truthOf(name).sizeElasticity)).toBeLessThan(0.15);
    }
    for (const t of truth.categories) {
      expect(Math.abs(model.categories[t.category].depreciation - t.depreciation)).toBeLessThan(0.35);
    }
  });

  it('keeps every constrained effect on its side of zero', () => {
    for (const c of Object.values(model.categories)) {
      expect(c.depreciation).toBeLessThan(0);
      expect(c.sizeElasticity).toBeGreaterThanOrEqual(0);
      expect(c.usage).toBeLessThanOrEqual(0);
      expect(c.newPremium).toBeGreaterThanOrEqual(0);
      expect(c.duration).toBeLessThanOrEqual(0);
      expect(c.operator).toBeGreaterThanOrEqual(0);
    }
    for (const a of Object.values(model.attachments)) expect(a.effect).toBeGreaterThanOrEqual(0);
    const g = model.grade;
    expect(g['1']).toBeLessThanOrEqual(g['2']);
    expect(g['2']).toBeLessThanOrEqual(g['3']);
    expect(g['3']).toBeLessThanOrEqual(g['4']);
  });

  it('orders levels the way the market prices them', () => {
    expect(model.origin.japan.effect).toBeGreaterThan(model.origin.china.effect);
    expect(model.seller.dealer.effect).toBeGreaterThan(model.seller.private.effect);
    expect(model.attachments.breaker.effect).toBeGreaterThan(model.attachments.bucket.effect);
  });

  it('drops impossible prices before fitting', () => {
    const typo = { ...listings[0], id: 'typo', price: listings[0].price * 1000 };
    expect(cleanListings1([...listings, typo]).some(l => l.id === 'typo')).toBe(false);
  });

  it('can fit sale listings alone', () => {
    const saleOnly = fitSherpa(listings, { ...options, disable: ['rentSide'] });
    expect(saleOnly.listings.every(l => l.side === 'sale')).toBe(true);
    expect(estimateSherpa(saleOnly, { category: 'excavators', year: 2018 })!.rates).toBeNull();
  });
});

describe('estimateSherpa', () => {
  const base = {
    category: 'excavators',
    brand: 'Alpha',
    origin: 'japan',
    year: 2018,
    size: 20,
    hours: 9000,
    condition: 'used' as const,
    grade: 3 as const,
  };

  it('gives a value and a rate card that falls per day with longer hire', () => {
    const e = estimateSherpa(model, base)!;
    expect(e.value.low).toBeLessThan(e.value.typical);
    expect(e.value.high).toBeGreaterThan(e.value.typical);
    const { daily, weekly, monthly } = e.rates!;
    expect(weekly.typical).toBeGreaterThan(daily.typical);
    expect(monthly.typical).toBeGreaterThan(weekly.typical);
    expect(weekly.typical / 7).toBeLessThan(daily.typical);
    expect(monthly.typical / 30).toBeLessThan(weekly.typical / 7);
    expect(e.paybackMonths).toBeCloseTo(e.value.typical / monthly.typical, 6);
  });

  it('prices an operator, attachments and a better grade higher', () => {
    const plain = estimateSherpa(model, base)!;
    expect(estimateSherpa(model, base, { operator: true })!.rates!.daily.typical).toBeGreaterThan(plain.rates!.daily.typical);
    expect(estimateSherpa(model, { ...base, attachments: ['breaker'] })!.value.typical).toBeGreaterThan(plain.value.typical);
    expect(estimateSherpa(model, { ...base, grade: 1 })!.value.typical).toBeLessThan(plain.value.typical);
  });

  it('explains itself with factors and lists what is missing', () => {
    const e = estimateSherpa(model, { category: 'excavators', size: 20 })!;
    expect(e.missing).toEqual(['year', 'hours', 'grade']);
    expect(e.factors.some(f => f.key === 'size')).toBe(true);
    expect(e.comparables).toHaveLength(6);
  });

  it('depreciates with age', () => {
    const schedule = depreciationSchedule(model, base, [1, 5, 10, 15]);
    for (let i = 1; i < schedule.length; i++) expect(schedule[i].value).toBeLessThan(schedule[i - 1].value);
  });

  it('returns null for a category it has not fitted', () => {
    expect(estimateSherpa(model, { category: 'submarines' })).toBeNull();
  });
});

describe('calibration', () => {
  it('covers about half of held-out prices with the 50% interval and beats the category median', () => {
    const small = syntheticMarket1({ sale: 50, rent: 50, seed: 9 }).listings;
    const cv = crossValidate(small, { ...options, folds: 4 }, 4);
    expect(cv.sale.coverage50).toBeGreaterThan(0.38);
    expect(cv.sale.coverage50).toBeLessThan(0.65);
    expect(cv.sale.coverage80).toBeGreaterThan(0.7);
    expect(cv.sale.mdape).toBeLessThan(cv.baselines.categoryMedian.sale);
    expect(cv.rent.mdape).toBeLessThan(cv.baselines.categoryMedian.rent);
  }, 120_000);
});
