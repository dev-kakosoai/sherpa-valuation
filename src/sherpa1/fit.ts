import type {
  Block,
  CategoryParams,
  LevelEffects,
  Listing,
  SherpaModel,
} from './types.js';
import { median, robustSigma, theilSenSlope } from '../stats.js';
import { LAMBDA_GRID, ageOf, boxCox, periodOf, usageRatio } from './features.js';

/*
  SHERPA-1 - the fit (docs/MODEL.md §5).

  Robust backfitting: every block of parameters is re-estimated on the partial
  residuals of all the others (the observed log price minus every other term),
  a few rounds until the predictions settle. Each estimate is a median or a
  Theil-Sen slope, shrunk toward its parent by partial pooling and clamped to
  what equipment does. Sale listings are fitted on log price, rental listings
  on log rate per day; both share the machine-value terms.
*/

export const SHERPA1_VERSION = '1.0.0-draft';

export interface SherpaFitOptions {
  market: string;
  currency: string;
  asOfYear: number;
  fittedAt?: string;
  /** Categories with fewer cleaned listings (both sides) are left out. */
  minListings?: number;
  /** Age at which the depreciation is stated, in years. */
  horizon?: number;
  /** Shrinkage strengths: listings at which a group and its parent count equally. */
  k?: Partial<Record<ShrinkKey, number>>;
  /** Blocks to switch off (ablations). */
  disable?: Block[];
  /** Folds for the conformal calibration; 0 or 1 skips it. */
  folds?: number;
  /** Interval levels to calibrate. */
  levels?: number[];
  /** Backfitting rounds at most (default 40; it stops earlier once no prediction moves by more than 0.01%). */
  rounds?: number;
  /** Rounds before parameters are averaged (default 15). */
  burnIn?: number;
}

type ShrinkKey =
  | 'alpha'
  | 'slope'
  | 'lambda'
  | 'newPremium'
  | 'grade'
  | 'attachment'
  | 'level'
  | 'origin'
  | 'brand'
  | 'brandInCategory'
  | 'region'
  | 'time'
  | 'listing'
  | 'rent'
  | 'sigma'
  | 'annualHours';

const DEFAULT_K: Record<ShrinkKey, number> = {
  alpha: 6,
  slope: 12,
  lambda: 24,
  newPremium: 10,
  grade: 8,
  attachment: 6,
  level: 8,
  origin: 6,
  brand: 4,
  brandInCategory: 6,
  region: 8,
  time: 8,
  listing: 30,
  rent: 8,
  sigma: 8,
  annualHours: 12,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Partial pooling; a group with no data is its parent. */
function shrinkTo(value: number, n: number, parent: number, k: number): number {
  if (!(n > 0) || !Number.isFinite(value)) return parent;
  return (n / (n + k)) * value + (k / (n + k)) * parent;
}

/** Theil-Sen on at most `cap` points, taken evenly, so a large category stays fast. */
function slope(xs: number[], ys: number[], cap = 160): number | null {
  if (xs.length <= cap) return theilSenSlope(xs, ys);
  const step = xs.length / cap;
  const sx: number[] = [];
  const sy: number[] = [];
  for (let i = 0; i < cap; i++) {
    const j = Math.floor(i * step);
    sx.push(xs[j]);
    sy.push(ys[j]);
  }
  return theilSenSlope(sx, sy);
}

/** Rounds in which the curve shape λ is profiled; it is then held fixed. */
export const LAMBDA_ROUNDS = 5;
/** Sale listings a category needs before α is estimated from sales alone. */
export const MIN_SALE_FOR_ALPHA = 3;
/** Rounds before the parameters start to be averaged (Polyak averaging). */
export const BURN_IN = 15;

/**
 * The λ minimising a profile scored on LAMBDA_GRID, refined by a parabola
 * through the best grid point and its neighbours, so λ moves continuously
 * rather than in steps.
 */
function refineLambda(scores: number[]): number {
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] < scores[best]) best = i;
  let lambda = LAMBDA_GRID[best];
  if (best > 0 && best < scores.length - 1) {
    const [s0, s1, s2] = [scores[best - 1], scores[best], scores[best + 1]];
    const denom = s0 - 2 * s1 + s2;
    const h = LAMBDA_GRID[best + 1] - LAMBDA_GRID[best];
    if (denom > 0) lambda += clamp((h * (s0 - s2)) / (2 * denom), -h, h);
  }
  return lambda;
}

/** Category fields that are data constants (or fitted afterwards), not averaged. */
const CONSTANT_FIELDS = new Set([
  'category',
  'family',
  'nSale',
  'nRent',
  'ageRef',
  'logSizeRef',
  'logSizeRange',
  'annualHours',
  'sigmaSale',
  'sigmaRent',
  'lambda',
]);
const LEVEL_SETS = ['attachments', 'emissions', 'spec', 'seller', 'origin', 'brand', 'brandInCategory', 'region'] as const;
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every fitted parameter as [container, key, path], in a fixed order. */
function leaves(m: SherpaModel): [Record<string, unknown>, string, string][] {
  const out: [Record<string, unknown>, string, string][] = [];
  for (const name of Object.keys(m.categories).sort(byKey)) {
    const c = m.categories[name] as unknown as Record<string, unknown>;
    for (const key of Object.keys(c).sort(byKey)) {
      if (!CONSTANT_FIELDS.has(key)) out.push([c, key, `c:${name}:${key}`]);
    }
  }
  for (const key of Object.keys(m.grade).sort(byKey)) out.push([m.grade, key, `g:${key}`]);
  for (const set of LEVEL_SETS) {
    for (const key of Object.keys(m[set]).sort(byKey)) {
      out.push([m[set][key] as unknown as Record<string, unknown>, 'effect', `${set}:${key}`]);
    }
  }
  out.push([m as unknown as Record<string, unknown>, 'verified', 'verified']);
  for (const key of Object.keys(m.time).sort(byKey)) out.push([m.time, key, `t:${key}`]);
  for (const key of Object.keys(m.listing).sort(byKey)) {
    out.push([m.listing as unknown as Record<string, unknown>, key, `l:${key}`]);
  }
  return out;
}

/** A listing prepared for the fit. */
interface Row {
  listing: Listing;
  rent: boolean;
  category: string;
  /** Log price (sale) or log rate per day (rent). */
  y: number;
  age: number | null;
  logSize: number | null;
  period: number;
}

/** The terms of the model, in the order they are fitted. */
const TERMS = [
  'alpha',
  'rent',
  'age',
  'size',
  'usage',
  'new',
  'wear',
  'grade',
  'attachments',
  'emissions',
  'spec',
  'seller',
  'verified',
  'origin',
  'brand',
  'brandInCategory',
  'region',
  'time',
  'monthsOnMarket',
  'completeness',
  'duration',
  'operator',
] as const;
type Term = (typeof TERMS)[number];

/** Which block switches a term off. */
const TERM_BLOCK: Partial<Record<Term, Block>> = {
  age: 'curve',
  size: 'size',
  usage: 'usage',
  grade: 'grade',
  attachments: 'attachments',
  emissions: 'emissions',
  wear: 'wear',
  spec: 'spec',
  seller: 'seller',
  verified: 'verified',
  origin: 'brand',
  brand: 'brand',
  brandInCategory: 'brand',
  region: 'region',
  time: 'time',
  monthsOnMarket: 'listing',
  completeness: 'listing',
};

const levelOf = (effects: LevelEffects, key: string | null | undefined) =>
  key ? (effects[key]?.effect ?? 0) : 0;

/**
 * The level a missing value takes in a centred set. Emissions, spec, seller,
 * origin and region have no natural reference level, so each set covers every
 * listing - "unknown" included - and is centred on the average listing, with
 * the shift moved into the category's α. Their effects then read "relative to
 * a typical listing", and a missing input gets what listings missing it
 * fetch, not an arbitrary zero.
 */
export const UNKNOWN = 'unknown';
const orUnknown = (key: string | null | undefined) => key || UNKNOWN;
const CENTRED = ['emissions', 'spec', 'seller', 'origin', 'region'] as const;

/** One term's contribution to a listing's log price, under the current parameters. */
export function termValue(term: Term, row: Row, m: SherpaModel): number {
  const l = row.listing;
  const c = m.categories[row.category];
  switch (term) {
    case 'alpha':
      return c.alpha;
    case 'rent':
      return row.rent ? c.rentToValue : 0;
    case 'age':
      return row.age === null
        ? 0
        : (c.depreciation / boxCox(m.horizon, c.lambda)) *
            (boxCox(row.age, c.lambda) - boxCox(c.ageRef, c.lambda));
    case 'size': {
      if (row.logSize === null || c.logSizeRef === null) return 0;
      const [lo, hi] = c.logSizeRange ?? [-Infinity, Infinity];
      return c.sizeElasticity * (clamp(row.logSize, lo, hi) - c.logSizeRef);
    }
    case 'usage':
      return l.hours === null || l.hours === undefined || row.age === null
        ? 0
        : c.usage * usageRatio(l.hours, row.age, c.annualHours);
    case 'new':
      return l.condition === 'new' ? c.newPremium : 0;
    case 'wear':
      return l.wear === null || l.wear === undefined ? 0 : c.wear * (l.wear - 0.5);
    case 'grade':
      return l.grade ? (m.grade[String(l.grade)] ?? 0) : 0;
    case 'attachments':
      return (l.attachments ?? []).reduce((sum, a) => sum + levelOf(m.attachments, a), 0);
    case 'emissions':
      return levelOf(m.emissions, orUnknown(l.emissions));
    case 'spec':
      return levelOf(m.spec, orUnknown(l.spec));
    case 'seller':
      return levelOf(m.seller, orUnknown(l.seller));
    case 'verified':
      return l.verified ? m.verified : 0;
    case 'origin':
      return levelOf(m.origin, orUnknown(l.origin));
    case 'brand':
      return levelOf(m.brand, l.brand);
    case 'brandInCategory':
      return l.brand ? levelOf(m.brandInCategory, `${l.brand}|${row.category}`) : 0;
    case 'region':
      return levelOf(m.region, orUnknown(l.region));
    case 'time':
      return l.month === null || l.month === undefined ? 0 : (m.time[String(l.month)] ?? 0);
    case 'monthsOnMarket':
      return l.monthsOnMarket ? m.listing.monthsOnMarket * Math.log1p(l.monthsOnMarket) : 0;
    case 'completeness':
      return l.completeness === null || l.completeness === undefined
        ? 0
        : m.listing.completeness * (l.completeness - 0.5);
    case 'duration':
      return row.rent ? c.duration * Math.log(row.period / 30) : 0;
    case 'operator':
      return row.rent && l.operator ? c.operator : 0;
  }
}

/**
 * Drops impossible prices: non-positive values and, per category and side,
 * log prices more than 3.5 robust deviations from the median. Rates are put on
 * a common 30-day footing first, with a typical duration discount.
 */
export function cleanListings1(listings: Listing[]): Listing[] {
  const groups = new Map<string, { listing: Listing; y: number }[]>();
  for (const listing of listings) {
    if (!(listing.price > 0)) continue;
    const rent = listing.side === 'rent';
    const period = periodOf(listing.period);
    const y = rent
      ? Math.log(listing.price / period) + 0.25 * Math.log(period / 30)
      : Math.log(listing.price);
    const key = `${listing.category}|${listing.side}`;
    const group = groups.get(key) ?? [];
    group.push({ listing, y });
    groups.set(key, group);
  }
  const kept: Listing[] = [];
  for (const group of groups.values()) {
    const ys = group.map(g => g.y);
    const centre = median(ys);
    const spread = robustSigma(ys);
    for (const g of group) {
      if (!Number.isFinite(spread) || spread === 0 || Math.abs(g.y - centre) <= 3.5 * spread) {
        kept.push(g.listing);
      }
    }
  }
  return kept;
}

function toRow(listing: Listing, asOfYear: number): Row {
  const rent = listing.side === 'rent';
  const period = periodOf(listing.period);
  return {
    listing,
    rent,
    category: listing.category,
    y: rent ? Math.log(listing.price / period) : Math.log(listing.price),
    age: ageOf(listing, asOfYear),
    logSize: listing.size && listing.size > 0 ? Math.log(listing.size) : null,
    period,
  };
}

function emptyModel(options: SherpaFitOptions, disabled: Block[]): SherpaModel {
  return {
    version: SHERPA1_VERSION,
    market: options.market,
    currency: options.currency,
    fittedAt: options.fittedAt ?? new Date().toISOString(),
    asOfYear: options.asOfYear,
    horizon: options.horizon ?? 10,
    categories: {},
    grade: { '1': 0, '2': 0, '3': 0, '4': 0 },
    attachments: {},
    emissions: {},
    spec: {},
    seller: {},
    verified: 0,
    origin: {},
    brand: {},
    brandInCategory: {},
    region: {},
    time: {},
    listing: { monthsOnMarket: 0, completeness: 0 },
    conformal: {},
    listings: [],
    disabled,
  };
}

/** The point fit, without conformal calibration. */
export function fitCore(input: Listing[], options: SherpaFitOptions): SherpaModel {
  const disabled = options.disable ?? [];
  const off = (block: Block) => disabled.includes(block);
  const K = off('pooling')
    ? (Object.fromEntries(Object.keys(DEFAULT_K).map(key => [key, 0])) as Record<ShrinkKey, number>)
    : { ...DEFAULT_K, ...options.k };
  const minListings = options.minListings ?? 8;
  const m = emptyModel(options, disabled);

  let listings = cleanListings1(input);
  if (off('rentSide')) listings = listings.filter(l => l.side === 'sale');
  const counts = new Map<string, number>();
  for (const l of listings) counts.set(l.category, (counts.get(l.category) ?? 0) + 1);
  listings = listings.filter(l => (counts.get(l.category) ?? 0) >= minListings);
  const rows = listings.map(l => toRow(l, options.asOfYear));
  m.listings = listings;

  // Per-category constants and starting values.
  const byCategory = new Map<string, Row[]>();
  for (const row of rows) {
    const group = byCategory.get(row.category) ?? [];
    group.push(row);
    byCategory.set(row.category, group);
  }
  for (const [category, group] of byCategory) {
    const sale = group.filter(r => !r.rent);
    const rent = group.filter(r => r.rent);
    const ages = group.map(r => r.age).filter((a): a is number => a !== null);
    const sizes = group.map(r => r.logSize).filter((s): s is number => s !== null);
    const perYear = group
      .filter(r => r.listing.hours && r.age !== null && r.age > 0)
      .map(r => (r.listing.hours as number) / Math.max(r.age as number, 0.5));
    m.categories[category] = {
      category,
      family: group.find(r => r.listing.family)?.listing.family ?? category,
      nSale: sale.length,
      nRent: rent.length,
      alpha: median((sale.length ? sale : rent).map(r => r.y)),
      depreciation: -0.8,
      lambda: 0.5,
      ageRef: ages.length ? median(ages) : 5,
      logSizeRef: sizes.length >= 3 && !off('size') ? median(sizes) : null,
      logSizeRange: sizes.length >= 3 ? [Math.min(...sizes), Math.max(...sizes)] : null,
      sizeElasticity: 0,
      annualHours: shrinkTo(median(perYear), perYear.length, 1000, K.annualHours),
      usage: 0,
      newPremium: 0,
      wear: 0,
      rentToValue: sale.length && rent.length ? median(rent.map(r => r.y)) - median(sale.map(r => r.y)) : Math.log(0.0015),
      duration: -0.25,
      operator: 0,
      sigmaSale: 0.3,
      sigmaRent: 0.3,
    };
  }

  const active = TERMS.filter(term => {
    const block = TERM_BLOCK[term];
    if (block && off(block)) return false;
    if (term === 'time') return new Set(rows.map(r => r.listing.month)).size >= 6;
    return true;
  });

  // Current contributions, kept in step with the parameters.
  const contrib = rows.map(row => {
    const values: Partial<Record<Term, number>> = {};
    for (const term of active) values[term] = termValue(term, row, m);
    return values;
  });
  // Running totals, updated by difference when a term changes.
  const totals = contrib.map(values => active.reduce((sum, term) => sum + (values[term] ?? 0), 0));
  const total = (i: number) => totals[i];
  const refresh = (term: Term) => {
    rows.forEach((row, i) => {
      const next = termValue(term, row, m);
      totals[i] += next - (contrib[i][term] ?? 0);
      contrib[i][term] = next;
    });
  };
  /** Partial residual of row i for `term`: the price with every other term removed. */
  const partial = (i: number, term: Term) => rows[i].y - totals[i] + (contrib[i][term] ?? 0);

  const indexBy = (keep: (row: Row) => boolean) =>
    rows.map((row, i) => (keep(row) ? i : -1)).filter(i => i >= 0);
  const catIndex = new Map<string, number[]>();
  for (const category of byCategory.keys()) catIndex.set(category, indexBy(r => r.category === category));
  /** The listings α is estimated from: sales where a category has at least MIN_SALE_FOR_ALPHA. */
  const alphaIndex = new Map<string, number[]>();
  for (const [category, idx] of catIndex) {
    alphaIndex.set(
      category,
      m.categories[category].nSale >= MIN_SALE_FOR_ALPHA ? idx.filter(i => !rows[i].rent) : idx
    );
  }

  /** A categorical level effect: median partial residual per level, shrunk toward `parent`. */
  const updateLevels = (
    term: Term,
    keyOf: (row: Row) => string | null | undefined,
    k: number,
    parentOf: (key: string) => number = () => 0
  ): LevelEffects => {
    const groups = new Map<string, number[]>();
    rows.forEach((row, i) => {
      const key = keyOf(row);
      if (!key) return;
      const list = groups.get(key) ?? [];
      list.push(partial(i, term));
      groups.set(key, list);
    });
    const effects: LevelEffects = {};
    for (const [key, values] of groups) {
      effects[key] = { effect: shrinkTo(median(values), values.length, parentOf(key), k), n: values.length };
    }
    return effects;
  };

  /** A per-category slope on x(row), shrunk toward the slope pooled across categories. */
  const updateSlopes = (
    term: Term,
    x: (row: Row, c: CategoryParams) => number | null,
    keep: (row: Row) => boolean,
    set: (c: CategoryParams, value: number, pooled: number, n: number) => void
  ) => {
    const raw = new Map<string, { b: number | null; n: number }>();
    const pooledX: number[] = [];
    const pooledY: number[] = [];
    for (const [category, idx] of catIndex) {
      const c = m.categories[category];
      const xs: number[] = [];
      const ys: number[] = [];
      for (const i of idx) {
        if (!keep(rows[i])) continue;
        const value = x(rows[i], c);
        if (value === null || !Number.isFinite(value)) continue;
        xs.push(value);
        ys.push(partial(i, term));
      }
      raw.set(category, { b: slope(xs, ys), n: xs.length });
      const centre = median(ys);
      xs.forEach((value, j) => {
        pooledX.push(value);
        pooledY.push(ys[j] - centre);
      });
    }
    const pooled = slope(pooledX, pooledY, 300) ?? 0;
    for (const [category, { b, n }] of raw) {
      set(m.categories[category], b ?? pooled, pooled, b === null ? 0 : n);
    }
  };

  const rounds = options.rounds ?? 40;
  const burnIn = options.burnIn ?? BURN_IN;
  const average = new Map<string, number>();
  let averagedRounds = 0;
  let previous = rows.map((_, i) => total(i));
  for (let round = 0; round < rounds; round++) {
    for (const term of active) {
      switch (term) {
        case 'alpha': {
          // Sale listings set α where a category has them; rental listings then
          // set π given α. Fitting α on both let α and π slide along a ridge.
          const familyValues = new Map<string, number[]>();
          for (const category of catIndex.keys()) {
            const family = m.categories[category].family;
            const list = familyValues.get(family) ?? [];
            for (const i of alphaIndex.get(category)!) list.push(partial(i, 'alpha'));
            familyValues.set(family, list);
          }
          for (const category of catIndex.keys()) {
            const c = m.categories[category];
            const own = alphaIndex.get(category)!.map(i => partial(i, 'alpha'));
            c.alpha = shrinkTo(median(own), own.length, median(familyValues.get(c.family)!), K.alpha);
          }
          break;
        }
        case 'rent': {
          const raws: { category: string; value: number; n: number }[] = [];
          for (const [category, idx] of catIndex) {
            const c = m.categories[category];
            const own = idx.filter(i => rows[i].rent).map(i => partial(i, 'rent'));
            raws.push({ category, value: median(own), n: c.nSale > 0 ? Math.min(c.nSale, own.length) : 0 });
          }
          const identified = raws.filter(r => r.n > 0 && Number.isFinite(r.value));
          const pooled = identified.length ? median(identified.map(r => r.value)) : Math.log(0.0015);
          for (const r of raws) {
            m.categories[r.category].rentToValue = shrinkTo(r.value, r.n, pooled, K.rent);
          }
          break;
        }
        case 'age': {
          // Profile the curve shape, per category and pooled, in the first rounds
          // only; it is then held, so it cannot ratchet along its ridge with the
          // other age terms.
          if (round < LAMBDA_ROUNDS) {
          const scores = new Map<string, number[]>();
          for (const [category, idx] of catIndex) {
            const c = m.categories[category];
            const used = idx.filter(i => rows[i].age !== null && rows[i].listing.condition !== 'new');
            const ys = used.map(i => partial(i, 'age'));
            scores.set(
              category,
              LAMBDA_GRID.map(lambda => {
                const xs = used.map(i => boxCox(rows[i].age as number, lambda) - boxCox(c.ageRef, lambda));
                const b = Math.min(0, slope(xs, ys) ?? 0);
                const a = median(ys.map((y, j) => y - b * xs[j]));
                return ys.reduce((sum, y, j) => sum + Math.abs(y - a - b * xs[j]), 0);
              })
            );
          }
          const pooledScore = LAMBDA_GRID.map((_, g) =>
            [...scores.values()].reduce((sum, s) => sum + (s[g] || 0), 0)
          );
          const lambda0 = refineLambda(pooledScore);
          for (const [category, idx] of catIndex) {
            const s = scores.get(category)!;
            const best = Math.min(...s);
            const n = Number.isFinite(best) ? idx.filter(i => rows[i].age !== null).length : 0;
            const raw = Number.isFinite(best) ? refineLambda(s) : lambda0;
            m.categories[category].lambda = clamp(shrinkTo(raw, n, lambda0, K.lambda), -1, 1);
          }
          }
          updateSlopes(
            'age',
            (row, c) =>
              row.age === null ? null : boxCox(row.age, c.lambda) - boxCox(c.ageRef, c.lambda),
            row => row.age !== null && row.listing.condition !== 'new',
            (c, b, pooled, n) => {
              const g = boxCox(m.horizon, c.lambda);
              const pooledD = clamp(pooled * g, -2, -0.3);
              c.depreciation = clamp(shrinkTo(b * g, n, pooledD, K.slope), -3, -0.05);
            }
          );
          break;
        }
        case 'size':
          updateSlopes(
            'size',
            (row, c) =>
              row.logSize === null || c.logSizeRef === null ? null : row.logSize - c.logSizeRef,
            () => true,
            (c, b, pooled, n) => {
              c.sizeElasticity =
                c.logSizeRef === null ? 0 : clamp(shrinkTo(b, n, clamp(pooled, 0, 1.5), K.slope), 0, 1.5);
            }
          );
          break;
        case 'usage':
          updateSlopes(
            'usage',
            (row, c) =>
              row.listing.hours === null || row.listing.hours === undefined || row.age === null
                ? null
                : usageRatio(row.listing.hours, row.age, c.annualHours),
            () => true,
            (c, b, pooled, n) => {
              c.usage = clamp(shrinkTo(b, n, clamp(pooled, -0.6, 0), K.slope), -1, 0);
            }
          );
          break;
        case 'wear':
          updateSlopes(
            'wear',
            row => (row.listing.wear === null || row.listing.wear === undefined ? null : row.listing.wear - 0.5),
            () => true,
            (c, b, pooled, n) => {
              c.wear = clamp(shrinkTo(b, n, clamp(pooled, 0, 1.5), K.slope), 0, 1.5);
            }
          );
          break;
        case 'new': {
          const raws = [...catIndex].map(([category, idx]) => {
            const own = idx.filter(i => rows[i].listing.condition === 'new').map(i => partial(i, 'new'));
            return { category, value: median(own), n: own.length };
          });
          const known = raws.filter(r => r.n > 0);
          const pooled = known.length ? clamp(median(known.map(r => r.value)), 0, 0.6) : 0.15;
          for (const r of raws) {
            m.categories[r.category].newPremium = clamp(shrinkTo(r.value, r.n, pooled, K.newPremium), 0, 0.8);
          }
          break;
        }
        case 'grade': {
          const effects = updateLevels('grade', row => (row.listing.grade ? String(row.listing.grade) : null), K.grade);
          // Grade 3 (good) is the reference; the scale is monotone.
          const g = (key: string) => effects[key]?.effect ?? 0;
          const g4 = Math.max(0, g('4') - g('3'));
          const g2 = Math.min(0, g('2') - g('3'));
          const g1 = Math.min(g2, g('1') - g('3'));
          m.grade = { '1': g1, '2': g2, '3': 0, '4': g4 };
          break;
        }
        case 'attachments': {
          const types = new Set(rows.flatMap(r => r.listing.attachments ?? []));
          const effects: LevelEffects = {};
          for (const type of types) {
            const values: number[] = [];
            rows.forEach((row, i) => {
              if ((row.listing.attachments ?? []).includes(type)) {
                values.push(partial(i, 'attachments') - (contrib[i].attachments ?? 0) + levelOf(m.attachments, type));
              }
            });
            effects[type] = {
              effect: clamp(shrinkTo(median(values), values.length, 0, K.attachment), 0, 1),
              n: values.length,
            };
          }
          m.attachments = effects;
          break;
        }
        case 'emissions':
          m.emissions = updateLevels('emissions', row => orUnknown(row.listing.emissions), K.level);
          break;
        case 'spec':
          m.spec = updateLevels('spec', row => orUnknown(row.listing.spec), K.level);
          break;
        case 'seller':
          m.seller = updateLevels('seller', row => orUnknown(row.listing.seller), K.level);
          break;
        case 'verified': {
          const values = rows.map((row, i) => (row.listing.verified ? partial(i, 'verified') : NaN)).filter(Number.isFinite);
          m.verified = clamp(shrinkTo(median(values), values.length, 0, K.level), 0, 0.5);
          break;
        }
        case 'origin':
          m.origin = updateLevels('origin', row => orUnknown(row.listing.origin), K.origin);
          break;
        case 'brand':
          m.brand = updateLevels('brand', row => row.listing.brand, K.brand);
          break;
        case 'brandInCategory':
          m.brandInCategory = updateLevels(
            'brandInCategory',
            row => (row.listing.brand ? `${row.listing.brand}|${row.category}` : null),
            K.brandInCategory
          );
          break;
        case 'region':
          m.region = updateLevels('region', row => orUnknown(row.listing.region), K.region);
          break;
        case 'time': {
          const effects = updateLevels('time', row => (row.listing.month ?? null) === null ? null : String(row.listing.month), K.time);
          const months = Object.keys(effects).map(Number).sort((a, b) => a - b);
          // Random-walk smoothing: two passes of a three-month weighted average.
          let values = months.map(month => effects[String(month)].effect);
          for (let pass = 0; pass < 2; pass++) {
            values = values.map((v, j) => {
              const before = j > 0 ? values[j - 1] : v;
              const after = j < values.length - 1 ? values[j + 1] : v;
              return 0.25 * before + 0.5 * v + 0.25 * after;
            });
          }
          // The latest month is the reference: estimates describe the market now.
          // α takes the shift, so the reset does not move predictions (it did,
          // and α drifted round after round chasing it).
          const latest = values[values.length - 1] ?? 0;
          m.time = Object.fromEntries(months.map((month, j) => [String(month), values[j] - latest]));
          for (const c of Object.values(m.categories)) c.alpha += latest;
          refresh('alpha');
          break;
        }
        case 'monthsOnMarket': {
          const xs: number[] = [];
          const ys: number[] = [];
          rows.forEach((row, i) => {
            if (row.listing.monthsOnMarket === null || row.listing.monthsOnMarket === undefined) return;
            xs.push(Math.log1p(row.listing.monthsOnMarket));
            ys.push(partial(i, 'monthsOnMarket'));
          });
          m.listing.monthsOnMarket = clamp(shrinkTo(slope(xs, ys, 300) ?? 0, xs.length, 0, K.listing), -0.2, 0.3);
          break;
        }
        case 'completeness': {
          const xs: number[] = [];
          const ys: number[] = [];
          rows.forEach((row, i) => {
            if (row.listing.completeness === null || row.listing.completeness === undefined) return;
            xs.push(row.listing.completeness - 0.5);
            ys.push(partial(i, 'completeness'));
          });
          m.listing.completeness = clamp(shrinkTo(slope(xs, ys, 300) ?? 0, xs.length, 0, K.listing), -0.2, 0.5);
          break;
        }
        case 'duration':
          updateSlopes(
            'duration',
            row => Math.log(row.period / 30),
            row => row.rent,
            (c, b, pooled, n) => {
              c.duration = clamp(shrinkTo(b, n, clamp(pooled, -0.8, 0), K.rent), -1, 0);
            }
          );
          break;
        case 'operator': {
          const raws = [...catIndex].map(([category, idx]) => {
            const own = idx.filter(i => rows[i].rent && rows[i].listing.operator).map(i => partial(i, 'operator'));
            return { category, value: median(own), n: own.length };
          });
          const known = raws.filter(r => r.n > 0);
          const pooled = known.length ? clamp(median(known.map(r => r.value)), 0, 1) : 0;
          for (const r of raws) {
            m.categories[r.category].operator = clamp(shrinkTo(r.value, r.n, pooled, K.rent), 0, 1);
          }
          break;
        }
      }
      refresh(term);
    }
    // Centre the reference-free sets on the average listing; α takes the shift,
    // so no prediction changes.
    for (const name of CENTRED) {
      if (!active.includes(name)) continue;
      const effects = m[name];
      const n = Object.values(effects).reduce((sum, e) => sum + e.n, 0);
      if (!n) continue;
      const mean = Object.values(effects).reduce((sum, e) => sum + e.n * e.effect, 0) / n;
      for (const e of Object.values(effects)) e.effect -= mean;
      for (const c of Object.values(m.categories)) c.alpha += mean;
      refresh(name);
    }
    if (CENTRED.some(name => active.includes(name))) refresh('alpha');
    const current = rows.map((_, i) => total(i));
    const change = Math.max(0, ...current.map((v, i) => Math.abs(v - previous[i])));
    previous = current;
    if (change < 1e-4) break;
    if (round >= burnIn) {
      for (const [container, key, path] of leaves(m)) {
        average.set(path, (average.get(path) ?? 0) + (container[key] as number));
      }
      averagedRounds++;
    }
  }

  // Polyak averaging: the median updates wander around the fixed point rather
  // than settle on it, so the model is the average of the rounds after the
  // burn-in. With the parameters set to that average, every term is refreshed.
  if (averagedRounds) {
    for (const [container, key, path] of leaves(m)) {
      const sum = average.get(path);
      if (sum !== undefined) container[key] = sum / averagedRounds;
    }
    for (const term of active) refresh(term);
  }

  // Robust spread per category and side, shrunk toward the pooled spread of that side.
  for (const side of ['sale', 'rent'] as const) {
    const all = rows.map((row, i) => ((row.rent ? 'rent' : 'sale') === side ? row.y - total(i) : NaN)).filter(Number.isFinite);
    const pooled = Math.max(0.1, robustSigma(all) || 0.4);
    for (const [category, idx] of catIndex) {
      const own = idx.filter(i => (rows[i].rent ? 'rent' : 'sale') === side).map(i => rows[i].y - total(i));
      const sigma = Math.max(0.1, shrinkTo(robustSigma(own), own.length, pooled, K.sigma));
      if (side === 'sale') m.categories[category].sigmaSale = sigma;
      else m.categories[category].sigmaRent = sigma;
    }
  }
  return m;
}

/** Log price (sale) or log rate per day (rent) a fitted model predicts for a listing. */
export function predictListing(m: SherpaModel, listing: Listing, withListingTerms = true): number | null {
  if (!m.categories[listing.category]) return null;
  const row = toRow({ ...listing, price: 1 }, m.asOfYear);
  let sum = 0;
  for (const term of TERMS) {
    const block = TERM_BLOCK[term];
    if (block && m.disabled.includes(block)) continue;
    if (!withListingTerms && (term === 'monthsOnMarket' || term === 'completeness' || term === 'time')) continue;
    sum += termValue(term, row, m);
  }
  return sum;
}

/** Inputs that move the price and are missing, for the interval's calibration group. */
export function missingInputs(m: SherpaModel, listing: Listing | (Omit<Listing, 'id' | 'side' | 'price'> & { side?: string })): string[] {
  const c = m.categories[listing.category];
  const missing: string[] = [];
  if (ageOf(listing, m.asOfYear) === null) missing.push('year');
  if (c?.logSizeRef !== null && c?.logSizeRef !== undefined && !listing.size) missing.push('size');
  if (listing.hours === null || listing.hours === undefined) missing.push('hours');
  if (!listing.grade) missing.push('grade');
  return missing;
}

const missingBin = (count: number) => (count === 0 ? '0' : count === 1 ? '1' : '2+');

/** The conformal quantile: the ⌈(n + 1)·level⌉-th smallest score. */
function conformalQuantile(scores: number[], level: number): number {
  const sorted = [...scores].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.ceil((sorted.length + 1) * level));
  return sorted[rank - 1];
}

/** A deterministic fold for a listing id. */
function foldOf(id: number | string, folds: number): number {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % folds;
}

/**
 * Fits SHERPA-1. The point model is fitted on all listings; the intervals are
 * calibrated on out-of-fold predictions (cross-conformal, docs/MODEL.md §6).
 */
export function fitSherpa(listings: Listing[], options: SherpaFitOptions): SherpaModel {
  const model = fitCore(listings, options);
  const folds = options.folds ?? 5;
  const levels = options.levels ?? [0.5, 0.8];
  if (model.disabled.includes('conformal') || folds < 2) return model;

  const scores = new Map<string, number[]>();
  const add = (key: string, score: number) => {
    const list = scores.get(key) ?? [];
    list.push(score);
    scores.set(key, list);
  };
  const cleaned = model.listings;
  for (let f = 0; f < folds; f++) {
    const train = cleaned.filter(l => foldOf(l.id, folds) !== f);
    const test = cleaned.filter(l => foldOf(l.id, folds) === f);
    const fitted = fitCore(train, { ...options, folds: 0 });
    for (const l of test) {
      const predicted = predictListing(fitted, l);
      if (predicted === null) continue;
      const c = fitted.categories[l.category];
      const rent = l.side === 'rent';
      const y = rent ? Math.log(l.price / periodOf(l.period)) : Math.log(l.price);
      const score = Math.abs(y - predicted) / (rent ? c.sigmaRent : c.sigmaSale);
      add(`${l.side}:${missingBin(missingInputs(fitted, l).length)}`, score);
      add(`${l.side}:all`, score);
    }
  }
  for (const [key, list] of scores) {
    model.conformal[key] = Object.fromEntries(levels.map(level => [String(level), conformalQuantile(list, level)]));
    model.conformal[key].n = list.length;
  }
  return model;
}
