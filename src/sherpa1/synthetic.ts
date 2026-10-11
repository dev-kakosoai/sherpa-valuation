import type { ConditionGrade, Emissions, Listing, SellerType, SpecStatus } from './types.js';
import { boxCox, usageRatio } from './features.js';

/*
  SHERPA-1 synthetic markets: sale and rental listings drawn from the model of
  docs/MODEL.md §3 with known parameters, then made as messy as marketplace
  data - fields left out, wrong prices. The truth comes back with the listings,
  so a fit can be checked against it. Deterministic for a seed; every brand,
  region and number is made up.
*/

export interface SyntheticCategory1 {
  category: string;
  family: string;
  basePrice: number;
  ageRef: number;
  /** Value change in log price at age `horizon` relative to new: negative. */
  depreciation: number;
  lambda: number;
  sizes: number[] | null;
  sizeRef: number | null;
  sizeElasticity: number;
  annualHours: number;
  usage: number;
  newPremium: number;
  wear: number;
  /** Log daily rate per unit of value at a 30-day hire. */
  rentToValue: number;
  duration: number;
  operator: number;
  sigma: number;
}

export interface SyntheticTruth {
  horizon: number;
  categories: SyntheticCategory1[];
  grade: Record<ConditionGrade, number>;
  attachments: Record<string, number>;
  emissions: Record<Emissions, number>;
  spec: Record<SpecStatus, number>;
  seller: Record<SellerType, number>;
  verified: number;
  origin: Record<string, number>;
  brands: Record<string, { origin: string; effect: number }>;
  region: Record<string, number>;
  /** Market drift per month on log value. */
  timeTrend: number;
  monthsOnMarket: number;
  completeness: number;
}

export const SYNTHETIC_TRUTH: SyntheticTruth = {
  horizon: 10,
  categories: [
    {
      category: 'excavators',
      family: 'earthmoving',
      basePrice: 300_000,
      ageRef: 6,
      depreciation: -0.9,
      lambda: 0.4,
      sizes: [1.8, 3, 5.5, 8, 14, 20, 22, 30, 36, 45],
      sizeRef: 20,
      sizeElasticity: 0.7,
      annualHours: 1200,
      usage: -0.15,
      newPremium: 0.2,
      wear: 0.3,
      rentToValue: Math.log(0.0013),
      duration: -0.25,
      operator: 0.35,
      sigma: 0.22,
    },
    {
      category: 'wheel-loaders',
      family: 'earthmoving',
      basePrice: 260_000,
      ageRef: 7,
      depreciation: -0.8,
      lambda: 0.6,
      sizes: [8, 12, 15, 18, 22, 28],
      sizeRef: 18,
      sizeElasticity: 0.6,
      annualHours: 1300,
      usage: -0.12,
      newPremium: 0.18,
      wear: 0.25,
      rentToValue: Math.log(0.0012),
      duration: -0.22,
      operator: 0.3,
      sigma: 0.24,
    },
    {
      category: 'cranes',
      family: 'lifting',
      basePrice: 900_000,
      ageRef: 9,
      depreciation: -0.7,
      lambda: 0.8,
      sizes: [25, 40, 50, 80, 100, 160, 250],
      sizeRef: 80,
      sizeElasticity: 0.8,
      annualHours: 900,
      usage: -0.1,
      newPremium: 0.15,
      wear: 0.15,
      rentToValue: Math.log(0.0011),
      duration: -0.3,
      operator: 0.25,
      sigma: 0.26,
    },
    {
      category: 'generators',
      family: 'power',
      basePrice: 60_000,
      ageRef: 5,
      depreciation: -1.1,
      lambda: 0.1,
      sizes: [20, 60, 100, 250, 500, 800, 1250],
      sizeRef: 250,
      sizeElasticity: 0.55,
      annualHours: 2500,
      usage: -0.2,
      newPremium: 0.22,
      wear: 0,
      rentToValue: Math.log(0.0025),
      duration: -0.35,
      operator: 0,
      sigma: 0.28,
    },
    {
      category: 'compactors',
      family: 'earthmoving',
      basePrice: 45_000,
      ageRef: 6,
      depreciation: -0.85,
      lambda: 0.5,
      sizes: null,
      sizeRef: null,
      sizeElasticity: 0,
      annualHours: 800,
      usage: -0.1,
      newPremium: 0.15,
      wear: 0.2,
      rentToValue: Math.log(0.0018),
      duration: -0.28,
      operator: 0.2,
      sigma: 0.3,
    },
  ],
  grade: { 1: -0.45, 2: -0.18, 3: 0, 4: 0.12 },
  attachments: { bucket: 0.03, breaker: 0.1, coupler: 0.04, forks: 0.05 },
  emissions: { tier2: -0.1, tier3: 0, tier4i: 0.05, tier4f: 0.1 },
  spec: { local: 0.05, imported: -0.05 },
  seller: { dealer: 0.1, rental: -0.04, private: -0.06 },
  verified: 0.06,
  origin: { japan: 0.08, europe: 0.06, usa: 0.05, korea: -0.03, china: -0.2 },
  brands: {
    Alpha: { origin: 'japan', effect: 0.05 },
    Bravo: { origin: 'japan', effect: -0.02 },
    Charlie: { origin: 'europe', effect: 0.04 },
    Delta: { origin: 'usa', effect: 0.06 },
    Echo: { origin: 'korea', effect: 0 },
    Foxtrot: { origin: 'china', effect: 0.05 },
    Golf: { origin: 'china', effect: -0.08 },
    Hotel: { origin: 'europe', effect: -0.03 },
  },
  region: { north: 0.04, central: 0, south: -0.05 },
  timeTrend: 0.004,
  monthsOnMarket: 0.04,
  completeness: 0.08,
};

export interface SyntheticOptions1 {
  /** Sale and rental listings per category. */
  sale?: number;
  rent?: number;
  seed?: number;
  asOfYear?: number;
  /** Months the listing dates span, ending at month index 0. */
  months?: number;
  /** Share of each optional field left empty. */
  missing?: number;
  /** Share of impossible prices. */
  badPrice?: number;
  truth?: SyntheticTruth;
}

function uniform(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
}

/** The log value the truth assigns to a machine, before listing terms and noise. */
export function trueLogValue(
  truth: SyntheticTruth,
  listing: Listing,
  age: number,
  hours: number
): number {
  const c = truth.categories.find(x => x.category === listing.category)!;
  const ref = boxCox(c.ageRef, c.lambda);
  const beta = c.depreciation / boxCox(truth.horizon, c.lambda);
  let v = Math.log(c.basePrice) + beta * (boxCox(age, c.lambda) - ref);
  if (c.sizeRef && listing.size) v += c.sizeElasticity * Math.log(listing.size / c.sizeRef);
  v += c.usage * usageRatio(hours, age, c.annualHours);
  if (listing.condition === 'new') v += c.newPremium;
  if (listing.wear !== null && listing.wear !== undefined) v += c.wear * (listing.wear - 0.5);
  return v;
}

export function syntheticMarket1(options: SyntheticOptions1 = {}): {
  listings: Listing[];
  truth: SyntheticTruth;
} {
  const {
    sale = 120,
    rent = 120,
    seed = 1,
    asOfYear = 2026,
    months = 24,
    missing = 0.2,
    badPrice = 0.02,
    truth = SYNTHETIC_TRUTH,
  } = options;
  const random = uniform(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const maybe = <T>(value: T): T | null => (random() < missing ? null : value);

  const brandNames = Object.keys(truth.brands);
  const attachmentNames = Object.keys(truth.attachments);
  const regions = Object.keys(truth.region);
  const sellers = Object.keys(truth.seller) as SellerType[];
  const emissions = Object.keys(truth.emissions) as Emissions[];
  const specs = Object.keys(truth.spec) as SpecStatus[];
  const periods = [1, 7, 30];

  const listings: Listing[] = [];
  let id = 1;
  for (const c of truth.categories) {
    for (const side of ['sale', 'rent'] as const) {
      const count = side === 'sale' ? sale : rent;
      for (let i = 0; i < count; i++) {
        const isNew = side === 'sale' && random() < 0.12;
        const age = isNew ? 0 : 1 + Math.floor(random() * 15);
        const hours = Math.round(c.annualHours * age * Math.exp(0.5 * gaussian()));
        const brand = pick(brandNames);
        const grade = (isNew ? 4 : pick([1, 2, 3, 3, 3, 4] as const)) as ConditionGrade;
        const attachments = attachmentNames.filter(() => random() < 0.25);
        const month = -Math.floor(random() * months);
        const monthsOnMarket = Math.floor(random() * 8);
        const completeness = Math.round(random() * 100) / 100;
        const listing: Listing = {
          id: id++,
          side,
          category: c.category,
          family: c.family,
          brand,
          origin: truth.brands[brand].origin,
          year: asOfYear - age,
          size: c.sizes ? pick(c.sizes) : null,
          hours,
          condition: isNew ? 'new' : 'used',
          grade,
          attachments,
          emissions: pick(emissions),
          wear: Math.round((0.2 + 0.8 * random()) * 100) / 100,
          spec: pick(specs),
          seller: side === 'rent' ? (random() < 0.8 ? 'rental' : 'dealer') : pick(sellers),
          verified: random() < 0.3,
          region: pick(regions),
          price: 0,
          month,
          monthsOnMarket,
          completeness,
        };
        let log = trueLogValue(truth, listing, age, hours);
        log += truth.grade[grade];
        for (const a of attachments) log += truth.attachments[a];
        log += truth.emissions[listing.emissions!];
        log += truth.spec[listing.spec!];
        log += truth.seller[listing.seller!];
        if (listing.verified) log += truth.verified;
        log += truth.origin[listing.origin!] + truth.brands[brand].effect;
        log += truth.region[listing.region!];
        log += truth.timeTrend * month;
        log += truth.monthsOnMarket * Math.log1p(monthsOnMarket);
        log += truth.completeness * (completeness - 0.5);
        if (side === 'rent') {
          const period = pick(periods);
          const operator = random() < 0.3;
          log += c.rentToValue + c.duration * Math.log(period / 30);
          if (operator) log += c.operator;
          listing.period = period;
          listing.operator = operator;
          // The listed price is the rate for the whole period.
          listing.price = Math.round(Math.exp(log + c.sigma * gaussian()) * period);
        } else {
          listing.price = Math.round(Math.exp(log + c.sigma * gaussian()) / 100) * 100;
        }
        const roll = random();
        if (roll < badPrice / 2) listing.price *= 1000;
        else if (roll < badPrice) listing.price = Math.max(1, Math.round(listing.price / 1000));

        // Marketplace data: most optional fields are often empty.
        listing.year = isNew && random() < 0.5 ? null : maybe(listing.year!);
        listing.size = listing.size === null ? null : maybe(listing.size!);
        listing.hours = random() < 0.5 ? null : listing.hours;
        listing.grade = maybe(listing.grade!);
        listing.emissions = random() < 0.6 ? null : listing.emissions;
        listing.wear = random() < 0.6 ? null : listing.wear;
        listing.spec = maybe(listing.spec!);
        listing.seller = maybe(listing.seller!);
        listing.region = maybe(listing.region!);
        listings.push(listing);
      }
    }
  }
  return { listings, truth };
}
