/*
  SHERPA - types.

  The model sees a listing as a handful of fields: category, brand, year, size,
  hours, condition, region and an asking price. Everything else a marketplace
  stores stays with the marketplace.
*/

/** The size measure a category is priced by, when it has one. */
export type SizeUnit = 'ton' | 'kva';

/** One priced listing, as the model sees it. All prices in one model share one currency. */
export interface MarketListing {
  id: number | string;
  category: string;
  brand: string | null;
  /** Manufacture year, from a structured field or extracted from the text. */
  year: number | null;
  /** Size in the category's unit (operating weight or capacity in tons, kVA). */
  size: number | null;
  hours: number | null;
  condition: 'new' | 'used' | null;
  region: string | null;
  price: number;
  /** For showing comparables only; never used by the fit. */
  title?: string;
  url?: string;
}

/** What a user tells the estimator about their machine. */
export interface MachineInput {
  category: string;
  brand?: string | null;
  year?: number | null;
  size?: number | null;
  hours?: number | null;
  condition?: 'new' | 'used' | null;
  region?: string | null;
}

/** The fitted parameters for one category. All effects are on log(price). */
export interface CategoryModel {
  category: string;
  /** Listings the category was fitted on (after cleaning). */
  n: number;
  /** Log-price of a reference machine: reference age, reference size, average brand, used. */
  intercept: number;
  referenceAge: number;
  /** Log-size of the reference machine, when the category has a size unit. */
  referenceLogSize: number | null;
  /** Change in log-price per year of age (negative: depreciation). */
  agePerYear: number;
  /** Elasticity of price to size: change in log-price per unit of log-size. */
  sizeElasticity: number;
  /** Log-price premium of a new machine over a used one of the same age. */
  newPremium: number;
  /** Shrunk brand effects on log-price, with the listings behind each. */
  brands: Record<string, { effect: number; n: number }>;
  /** Robust spread of log-price around the fit. */
  sigma: number;
  /** How many listings carried a year and a size. */
  withYear: number;
  withSize: number;
  /** The log-sizes the fit saw; estimates outside are capped, not extrapolated. */
  logSizeRange: [number, number] | null;
}

export interface PriceModel {
  /** Market the model was fitted for, e.g. 'AE'. One model per market. */
  market: string;
  currency: string;
  fittedAt: string;
  /** The year ages are counted from. */
  asOfYear: number;
  categories: Record<string, CategoryModel>;
  /** The comparables index: the cleaned listings of the fitted categories. */
  listings: MarketListing[];
}

export type Confidence = 'high' | 'medium' | 'low';

export interface PriceFactor {
  /** Machine-readable key: 'age', 'size', 'brand' or 'condition'. */
  key: string;
  /** Multiplicative effect on the price, e.g. 0.82 for -18%. */
  multiplier: number;
}

export interface PriceEstimate {
  category: string;
  /** A 50% interval of asking prices, and the central estimate. */
  low: number;
  typical: number;
  high: number;
  confidence: Confidence;
  /** Number of listings the category model was fitted on. */
  basis: number;
  factors: PriceFactor[];
  comparables: MarketListing[];
}
