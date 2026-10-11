/*
  SHERPA-1 - types.

  A listing is either a sale (an asking price) or a rental (an asking rate for
  a hire of `period` days). Both describe a machine with the same fields, and
  both are observations of one underlying machine value (docs/MODEL.md §3).
  Every machine field is optional: missing is normal in marketplace data.
*/

export type Side = 'sale' | 'rent';

export type SellerType = 'dealer' | 'rental' | 'private';

/** Ordinal condition grade: 1 needs repair, 2 fair, 3 good (the reference), 4 excellent. */
export type ConditionGrade = 1 | 2 | 3 | 4;

/** Ordered emissions standards; treated as levels, since resale value depends on the market. */
export type Emissions = 'tier2' | 'tier3' | 'tier4i' | 'tier4f';

export type SpecStatus = 'local' | 'imported';

export interface Machine {
  category: string;
  /** Category family (earthmoving, lifting, power, ...); the parent of the category. */
  family?: string | null;
  brand?: string | null;
  /** Brand origin group (japan, europe, usa, korea, china, ...); the parent of the brand. */
  origin?: string | null;
  year?: number | null;
  /** Size in the category's unit (tons, kVA, metres). */
  size?: number | null;
  hours?: number | null;
  condition?: 'new' | 'used' | null;
  grade?: ConditionGrade | null;
  /** Attachment types included (bucket, breaker, coupler, forks, ...). */
  attachments?: string[] | null;
  emissions?: Emissions | null;
  /** Remaining life of the wear parts (undercarriage, tyres), 0 ... 1. */
  wear?: number | null;
  spec?: SpecStatus | null;
  seller?: SellerType | null;
  /** Inspected or verified listing. */
  verified?: boolean | null;
  region?: string | null;
}

export interface Listing extends Machine {
  id: number | string;
  side: Side;
  /**
   * Sale: the asking price. Rent: the asking rate for the whole `period`
   * (a weekly rate for period 7, a monthly rate for period 30).
   */
  price: number;
  /** Rent only: hire duration in days that `price` covers (1, 7, 30, ...). */
  period?: number | null;
  /** Rent only: operator included (wet hire). */
  operator?: boolean | null;
  /** Listing month as a running index (e.g. year * 12 + month); enables the time index. */
  month?: number | null;
  /** Months the listing has been on the market. */
  monthsOnMarket?: number | null;
  /** Listing completeness, 0 ... 1 (photos, filled fields, description). */
  completeness?: number | null;
  /** For showing comparables only; never used by the fit. */
  title?: string;
  url?: string;
}

/** Effects of a categorical variable: level -> { effect on log value, listings behind it }. */
export type LevelEffects = Record<string, { effect: number; n: number }>;

export interface CategoryParams {
  category: string;
  family: string;
  nSale: number;
  nRent: number;
  /** Reference log value (log price of the reference machine). */
  alpha: number;
  /** Depreciation curve: value change at the reference age `ageRef`, and the curve shape. */
  depreciation: number;
  lambda: number;
  ageRef: number;
  /** Median log size of the stated sizes; null when the category has too few. */
  logSizeRef: number | null;
  logSizeRange: [number, number] | null;
  sizeElasticity: number;
  /** Typical annual hours, and the effect of usage relative to age. */
  annualHours: number;
  usage: number;
  newPremium: number;
  wear: number;
  /** Rent side: log daily rate per unit of value at a 30-day hire, duration exponent, operator premium. */
  rentToValue: number;
  duration: number;
  operator: number;
  sigmaSale: number;
  sigmaRent: number;
}

export interface SherpaModel {
  version: string;
  market: string;
  currency: string;
  fittedAt: string;
  asOfYear: number;
  /** Reference age at which `depreciation` is stated (years). */
  horizon: number;
  categories: Record<string, CategoryParams>;
  grade: Record<string, number>;
  attachments: LevelEffects;
  emissions: LevelEffects;
  spec: LevelEffects;
  seller: LevelEffects;
  verified: number;
  origin: LevelEffects;
  brand: LevelEffects;
  brandInCategory: LevelEffects;
  region: LevelEffects;
  /** Monthly market index by `month`; empty when the data span too few months. */
  time: Record<string, number>;
  listing: { monthsOnMarket: number; completeness: number };
  /** Conformal score quantiles by side and missing-input count (0, 1, 2+), per level. */
  conformal: Record<string, Record<string, number>>;
  /** The listings of fitted categories, for comparables. */
  listings: Listing[];
  /** Blocks switched off for this fit (ablations). */
  disabled: Block[];
}

/** Blocks of the model that can be switched off, for ablation studies. */
export type Block =
  | 'curve'
  | 'size'
  | 'usage'
  | 'grade'
  | 'attachments'
  | 'emissions'
  | 'wear'
  | 'spec'
  | 'seller'
  | 'verified'
  | 'brand'
  | 'region'
  | 'time'
  | 'listing'
  | 'rentSide'
  | 'pooling'
  | 'conformal';

export interface Interval {
  low: number;
  typical: number;
  high: number;
}

export interface SherpaFactor {
  key: string;
  /** Multiplicative effect on value, e.g. 0.82 for -18%. */
  multiplier: number;
}

export interface SherpaEstimate {
  category: string;
  /** Interval level, e.g. 0.5 for the middle 50%. */
  level: number;
  value: Interval;
  /** Asking rates for a whole day, week and month; null when the category cannot be rented out by the model. */
  rates: { daily: Interval; weekly: Interval; monthly: Interval } | null;
  /** Monthly rent as a share of value, and months of hire to pay the value back. */
  monthlyYield: number | null;
  paybackMonths: number | null;
  confidence: 'high' | 'medium' | 'low';
  factors: SherpaFactor[];
  /** Inputs the user left out that the model can use. */
  missing: string[];
  comparables: Listing[];
}
