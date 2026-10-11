import type { CategoryModel, MarketListing, PriceModel } from './types.js';
import { median, robustSigma, shrink, theilSenSlope } from './stats.js';

/*
  Fitting the price model.

  For each category, log-price is modelled as

    log p = a + b·(age − age₀) + c·(log s − log s₀) + d·[new] + e_brand + ε

  where age is years since manufacture, s the machine's size (tons, kVA), and
  the reference machine is the category's median age and size. Every term is
  estimated robustly (medians, Theil-Sen) and shrunk toward a wider estimate
  in proportion to how little data backs it (partial pooling):

    - the age and size slopes toward the slopes pooled across all categories;
    - the new-machine premium and each brand effect toward zero;
    - the spread toward the pooled spread.

  So a category with 38 listings mostly speaks for itself, and a brand with two
  listings barely moves the estimate. ε is assumed symmetric on the log scale;
  its robust spread gives the interval.
*/

export interface FitOptions {
  market: string;
  currency: string;
  asOfYear: number;
  /** Categories with fewer cleaned listings are left out; estimatePrice returns null for them. */
  minListings?: number;
  /** Shrinkage strengths: listings at which a group and its parent count equally. */
  k?: { slope?: number; brand?: number; newPremium?: number; sigma?: number };
  fittedAt?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Drops what cannot be a real asking price: non-positive values and, per
 * category, log-prices more than 3.5 robust deviations from the median
 * (placeholders, a monthly rate typed into the sale price, a missing zero).
 */
export function cleanListings(listings: MarketListing[]): MarketListing[] {
  const byCategory = new Map<string, MarketListing[]>();
  for (const listing of listings) {
    if (!(listing.price > 0)) continue;
    const group = byCategory.get(listing.category) ?? [];
    group.push(listing);
    byCategory.set(listing.category, group);
  }
  const kept: MarketListing[] = [];
  for (const group of byCategory.values()) {
    const logs = group.map(listing => Math.log(listing.price));
    const centre = median(logs);
    const spread = robustSigma(logs);
    for (const listing of group) {
      const distance = Math.abs(Math.log(listing.price) - centre);
      if (!Number.isFinite(spread) || spread === 0 || distance <= 3.5 * spread) kept.push(listing);
    }
  }
  return kept;
}

/** Age in years; a new machine without a year is taken as age 0. */
export function ageOf(
  listing: { year: number | null; condition: 'new' | 'used' | null },
  asOfYear: number
): number | null {
  if (listing.year !== null) return Math.max(0, asOfYear - listing.year);
  return listing.condition === 'new' ? 0 : null;
}

export function fitPriceModel(input: MarketListing[], options: FitOptions): PriceModel {
  const minListings = options.minListings ?? 8;
  const k = { slope: 12, brand: 4, newPremium: 10, sigma: 8, ...options.k };
  const listings = cleanListings(input);

  const byCategory = new Map<string, MarketListing[]>();
  for (const listing of listings) {
    const group = byCategory.get(listing.category) ?? [];
    group.push(listing);
    byCategory.set(listing.category, group);
  }

  // Pooled slopes: within-category deviations, all categories together.
  const pooledAge: { x: number[]; y: number[] } = { x: [], y: [] };
  const pooledSize: { x: number[]; y: number[] } = { x: [], y: [] };
  const pooledResiduals: number[] = [];
  for (const group of byCategory.values()) {
    const logs = group.map(listing => Math.log(listing.price));
    const centre = median(logs);
    const ages = group.map(listing => ageOf(listing, options.asOfYear));
    const ageCentre = median(ages.filter((a): a is number => a !== null));
    const sizes = group.map(listing => (listing.size ? Math.log(listing.size) : null));
    const sizeCentre = median(sizes.filter((s): s is number => s !== null));
    group.forEach((_listing, i) => {
      if (ages[i] !== null) {
        pooledAge.x.push((ages[i] as number) - ageCentre);
        pooledAge.y.push(logs[i] - centre);
      }
      if (sizes[i] !== null) {
        pooledSize.x.push((sizes[i] as number) - sizeCentre);
        pooledSize.y.push(logs[i] - centre);
      }
      pooledResiduals.push(logs[i] - centre);
    });
  }
  /*
    Prior bounds from what equipment does: it loses value with age, between
    about 4% and 15% a year once past the first, and bigger machines cost more.
    A pooled slope can come out near zero in a mixed market - cheap new
    imports listed beside ten-year-old premium machines - so the bound, not
    the data, sets the floor of depreciation a thin category is pulled toward.
  */
  const ageSlope0 = clamp(theilSenSlope(pooledAge.x, pooledAge.y) ?? -0.08, -0.15, -0.04);
  const sizeSlope0 = clamp(theilSenSlope(pooledSize.x, pooledSize.y) ?? 0.6, 0, 1.5);
  const sigma0 = Math.max(0.2, robustSigma(pooledResiduals) || 0.6);

  const categories: Record<string, CategoryModel> = {};
  for (const [category, group] of byCategory) {
    if (group.length < minListings) continue;
    const logs = group.map(listing => Math.log(listing.price));
    const ages = group.map(listing => ageOf(listing, options.asOfYear));
    const sizes = group.map(listing => (listing.size ? Math.log(listing.size) : null));
    const withAge = ages.filter((a): a is number => a !== null);
    const withSize = sizes.filter((s): s is number => s !== null);
    const referenceAge = withAge.length ? median(withAge) : 5;
    /*
      Size enters the price only where most listings state it: with sizes for
      a handful of listings the reference machine can be a 3 t mini, and every
      other size is then extrapolated from there. Below half coverage the
      category is priced without size, and an unknown size widens the range
      instead.
    */
    const sizeModelled = withSize.length >= 8 && withSize.length >= group.length / 2;
    const referenceLogSize = sizeModelled ? median(withSize) : null;
    const sizeRange: [number, number] | null = sizeModelled
      ? [Math.min(...withSize), Math.max(...withSize)]
      : null;

    /*
      Age and size slopes by backfitting: each is fitted on prices already
      adjusted for the other, a few rounds until they settle. Fitted on raw
      prices, age soaks up size wherever the older machines listed are mostly
      full-size ones and the young ones mostly minis, and depreciation comes
      out near zero. New machines stay out of the age slope: at age 0 they
      carry the new premium, and often a cheap import besides.
    */
    const pairs = (
      values: (number | null)[],
      adjust: (i: number) => number,
      keep: (i: number) => boolean = () => true
    ) => {
      const x: number[] = [];
      const y: number[] = [];
      values.forEach((value, i) => {
        if (value !== null && keep(i)) {
          x.push(value);
          y.push(logs[i] - adjust(i));
        }
      });
      return { x, y };
    };
    const used = (i: number) => group[i].condition !== 'new';
    let agePerYear = ageSlope0;
    let sizeElasticity = sizeModelled ? sizeSlope0 : 0;
    for (let round = 0; round < 3; round++) {
      const ageData = pairs(
        ages,
        i =>
          sizes[i] !== null && referenceLogSize !== null
            ? sizeElasticity * ((sizes[i] as number) - referenceLogSize)
            : 0,
        used
      );
      const rawAge = theilSenSlope(ageData.x, ageData.y);
      agePerYear = clamp(
        rawAge === null ? ageSlope0 : shrink(rawAge, ageData.x.length, ageSlope0, k.slope),
        -0.3,
        -0.02
      );
      if (!sizeModelled) break;
      const sizeData = pairs(sizes, i =>
        ages[i] !== null ? agePerYear * ((ages[i] as number) - referenceAge) : 0
      );
      const rawSize = theilSenSlope(sizeData.x, sizeData.y);
      sizeElasticity = clamp(
        rawSize === null ? sizeSlope0 : shrink(rawSize, sizeData.x.length, sizeSlope0, k.slope),
        0,
        1.5
      );
    }

    // Price adjusted to the reference age and size.
    const adjusted = group.map((_listing, i) => {
      let value = logs[i];
      if (ages[i] !== null) value -= agePerYear * ((ages[i] as number) - referenceAge);
      if (sizes[i] !== null && referenceLogSize !== null) {
        value -= sizeElasticity * ((sizes[i] as number) - referenceLogSize);
      }
      return value;
    });

    const newOnes = adjusted.filter((_, i) => group[i].condition === 'new');
    const usedOnes = adjusted.filter((_, i) => group[i].condition !== 'new');
    const newPremium =
      newOnes.length && usedOnes.length
        ? clamp(
            shrink(
              median(newOnes) - median(usedOnes),
              Math.min(newOnes.length, usedOnes.length),
              0,
              k.newPremium
            ),
            // A new machine is never cheaper than the same one used; a negative
            // gap in the data is a mix of machines (new Chinese minis), not a price.
            0,
            0.6
          )
        : 0;
    const base = adjusted.map(
      (value, i) => value - (group[i].condition === 'new' ? newPremium : 0)
    );
    const intercept = median(base);

    const byBrand = new Map<string, number[]>();
    base.forEach((value, i) => {
      const brand = group[i].brand;
      if (!brand) return;
      const list = byBrand.get(brand) ?? [];
      list.push(value - intercept);
      byBrand.set(brand, list);
    });
    const brands: CategoryModel['brands'] = {};
    for (const [brand, residuals] of byBrand) {
      brands[brand] = {
        effect: shrink(median(residuals), residuals.length, 0, k.brand),
        n: residuals.length,
      };
    }

    const residuals = base.map(
      (value, i) =>
        value - intercept - (group[i].brand ? (brands[group[i].brand as string]?.effect ?? 0) : 0)
    );
    const sigma = Math.max(
      0.15,
      shrink(robustSigma(residuals) || sigma0, group.length, sigma0, k.sigma)
    );

    categories[category] = {
      category,
      n: group.length,
      intercept,
      referenceAge,
      referenceLogSize,
      agePerYear,
      sizeElasticity,
      newPremium,
      brands,
      sigma,
      withYear: withAge.length,
      withSize: withSize.length,
      logSizeRange: sizeRange,
    };
  }

  return {
    market: options.market,
    currency: options.currency,
    fittedAt: options.fittedAt ?? new Date().toISOString(),
    asOfYear: options.asOfYear,
    categories,
    listings: listings.filter(listing => categories[listing.category]),
  };
}
