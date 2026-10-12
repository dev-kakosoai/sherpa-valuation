/*
  The simulation study of the paper (paper/). Every experiment runs on
  synthetic markets with known parameters (src/sherpa1/synthetic.ts) and is
  deterministic for its seeds. Results go to bench/paper-results.json.
  Run: npx tsx bench/paper.ts [E1 E2 ...]
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  cleanListings1,
  estimatePrice,
  fitCore,
  fitPriceModel,
  fitSherpa,
  missingInputs,
  periodOf,
  predictListing,
  syntheticMarket1,
  SYNTHETIC_TRUTH,
  type Listing,
  type MarketListing,
  type SherpaFitOptions,
} from '../src/index.js';
import { median } from '../src/stats.js';
import { fitOls, predictOls, logTarget } from './ols.js';

const BASE: SherpaFitOptions = { market: 'XX', currency: 'USD', asOfYear: 2026, fittedAt: 'paper', folds: 0 };
const OUT = new URL('./paper-results.json', import.meta.url);
const results: Record<string, unknown> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 1));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function fold(id: number | string, folds: number, salt: number): number {
  let h = 2166136261 ^ salt;
  for (const ch of `cv:${id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % folds;
}

const toMarket = (l: Listing): MarketListing => ({
  id: l.id,
  category: l.category,
  brand: l.brand ?? null,
  year: l.year ?? null,
  size: l.size ?? null,
  hours: l.hours ?? null,
  condition: l.condition ?? null,
  region: l.region ?? null,
  price: l.price,
});

type Model = 'median' | 'sherpa0' | 'ols' | 'sherpa1' | 'sherpa1SaleOnly';
interface CvOptions {
  folds?: number;
  models?: Model[];
  sherpa?: Partial<SherpaFitOptions>;
  /** Interval levels to check for SHERPA-1 (needs sherpa.folds >= 2 for conformal). */
  coverage?: boolean;
}

/**
 * K-fold cross-validation of every model on the same folds. Models are fitted
 * on the raw training listings (junk prices included: SHERPA cleans its own
 * input, the median is robust, OLS takes them as they come) and scored on
 * the held-out listings that survive cleaning - an impossible price is not a
 * price any model should be judged on.
 */
function crossValidate(listings: Listing[], seed: number, options: CvOptions = {}) {
  const folds = options.folds ?? 4;
  const models = options.models ?? ['median', 'sherpa0', 'ols', 'sherpa1'];
  const scoreable = new Set(cleanListings1(listings).map(l => l.id));
  const errors: Record<string, number[]> = {};
  const push = (key: string, value: number) => (errors[key] ??= []).push(value);
  const cover = { sale50: 0, sale80: 0, saleN: 0, rent50: 0, rent80: 0, rentN: 0 };

  for (let f = 0; f < folds; f++) {
    const train = listings.filter(l => fold(l.id, folds, seed) !== f);
    const test = listings.filter(l => fold(l.id, folds, seed) === f && scoreable.has(l.id));
    const s1 = models.includes('sherpa1') ? fitSherpa(train, { ...BASE, ...options.sherpa }) : null;
    const s1s = models.includes('sherpa1SaleOnly') ? fitSherpa(train, { ...BASE, ...options.sherpa, disable: ['rentSide'] }) : null;
    const s0 = models.includes('sherpa0')
      ? fitPriceModel(train.filter(l => l.side === 'sale').map(toMarket), { market: 'XX', currency: 'USD', asOfYear: 2026, fittedAt: 'paper' })
      : null;
    const ols = models.includes('ols') ? fitOls(train, 2026) : null;
    const medians = new Map<string, number>();
    for (const l of train) {
      const key = `${l.category}|${l.side}|${l.side === 'rent' ? periodOf(l.period) : ''}`;
      if (!medians.has(key)) {
        medians.set(key, median(train.filter(p => `${p.category}|${p.side}|${p.side === 'rent' ? periodOf(p.period) : ''}` === key).map(logTarget)));
      }
    }
    for (const l of test) {
      const y = logTarget(l);
      const side = l.side;
      const ape = (logPred: number) => Math.abs(Math.exp(logPred - y) - 1);
      const key = `${l.category}|${side}|${side === 'rent' ? periodOf(l.period) : ''}`;
      if (models.includes('median') && medians.has(key)) push(`median:${side}`, ape(medians.get(key)!));
      if (ols) push(`ols:${side}`, ape(predictOls(ols, l)));
      if (s0 && side === 'sale') {
        const e = estimatePrice(s0, { category: l.category, brand: l.brand, year: l.year, size: l.size, condition: l.condition });
        if (e) push(`sherpa0:sale`, Math.abs(e.typical / l.price - 1));
      }
      if (s1s && side === 'sale') {
        const p = predictListing(s1s, l);
        if (p !== null) push(`sherpa1SaleOnly:sale`, ape(p));
      }
      if (s1) {
        const p = predictListing(s1, l);
        if (p === null) continue;
        push(`sherpa1:${side}`, ape(p));
        if (options.coverage) {
          const c = s1.categories[l.category];
          const sigma = side === 'rent' ? c.sigmaRent : c.sigmaSale;
          const missing = missingInputs(s1, l).length;
          const bin = missing === 0 ? '0' : missing === 1 ? '1' : '2+';
          const q = (level: string, normal: number) => {
            const own = s1.conformal[`${side}:${bin}`];
            const all = s1.conformal[`${side}:all`];
            if (own && own.n >= 20 && own[level] !== undefined) return own[level];
            if (all && all[level] !== undefined) return all[level];
            return normal * (1 + missing / 3);
          };
          const r = Math.abs(y - p);
          cover[`${side}N`]++;
          if (r <= q('0.5', 0.6745) * sigma) cover[`${side}50`]++;
          if (r <= q('0.8', 1.2816) * sigma) cover[`${side}80`]++;
        }
      }
    }
  }
  const out: Record<string, number> = {};
  for (const [key, list] of Object.entries(errors)) out[key] = median(list);
  if (options.coverage) {
    out['cover50:sale'] = cover.sale50 / cover.saleN;
    out['cover80:sale'] = cover.sale80 / cover.saleN;
    out['cover50:rent'] = cover.rent50 / cover.rentN;
    out['cover80:rent'] = cover.rent80 / cover.rentN;
  }
  return out;
}

/** Mean of each key across seeds, with the standard error. */
function summarise(runs: Record<string, number>[]) {
  const keys = [...new Set(runs.flatMap(r => Object.keys(r)))];
  return Object.fromEntries(
    keys.map(k => {
      const v = runs.map(r => r[k]).filter(Number.isFinite);
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
      return [k, { mean, se: sd / Math.sqrt(v.length), n: v.length }];
    })
  );
}

const seeds = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

const experiments: Record<string, () => void> = {
  /* E1: bias and RMSE of every parameter over 20 synthetic markets. */
  E1() {
    const truth = SYNTHETIC_TRUTH;
    const rows: Record<string, number[]> = {};
    const add = (k: string, err: number) => (rows[k] ??= []).push(err);
    for (const seed of seeds(20)) {
      const { listings } = syntheticMarket1({ sale: 120, rent: 120, seed });
      const m = fitCore(listings, BASE);
      for (const t of truth.categories) {
        const c = m.categories[t.category];
        add('depreciation (D)', c.depreciation - t.depreciation);
        add('curve shape (λ)', c.lambda - t.lambda);
        if (t.sizes) add('size elasticity (γ)', c.sizeElasticity - t.sizeElasticity);
        add('usage (δ)', c.usage - t.usage);
        add('new premium (θ)', c.newPremium - t.newPremium);
        add('wear (ζ)', c.wear - t.wear);
        add('rent-to-value (π)', c.rentToValue - t.rentToValue);
        add('duration discount (κ)', c.duration - t.duration);
        add('operator premium (ω)', c.operator - t.operator);
      }
      const contrast = (name: string, tr: Record<string, number>, fit: Record<string, { effect: number }>) => {
        const keys = Object.keys(tr).filter(k => fit[k]);
        const mt = keys.reduce((s, k) => s + tr[k], 0) / keys.length;
        const mf = keys.reduce((s, k) => s + fit[k].effect, 0) / keys.length;
        for (const k of keys) add(name, fit[k].effect - mf - (tr[k] - mt));
      };
      for (const g of ['1', '2', '4']) add('condition grade (η)', m.grade[g] - truth.grade[Number(g) as 1 | 2 | 4]);
      for (const k of Object.keys(truth.attachments)) add('attachments (ψ)', (m.attachments[k]?.effect ?? 0) - truth.attachments[k]);
      contrast('seller type (κ_k)', truth.seller, m.seller);
      contrast('brand origin', truth.origin, m.origin);
      contrast('emissions (ε)', truth.emissions, m.emissions);
      contrast('spec (φ)', truth.spec, m.spec);
      contrast('region (ρ)', truth.region, m.region);
      add('inspection (ν)', m.verified - truth.verified);
      add('time on market (λ_m)', m.listing.monthsOnMarket - truth.monthsOnMarket);
      add('completeness (λ_ℓ)', m.listing.completeness - truth.completeness);
      const months = Object.keys(m.time).map(Number).sort((a, b) => a - b);
      if (months.length > 1) {
        const trend = (m.time[String(months.at(-1))] - m.time[String(months[0])]) / (months.at(-1)! - months[0]);
        add('market trend / month (τ)', trend - truth.timeTrend);
      }
      log('E1 seed', seed);
    }
    results.E1 = Object.fromEntries(
      Object.entries(rows).map(([k, errs]) => {
        const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
        const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / errs.length);
        return [k, { bias, rmse, n: errs.length }];
      })
    );
    save();
  },

  /* E2: accuracy against the number of listings per category and side. */
  E2() {
    const out: Record<string, unknown> = {};
    for (const n of [20, 40, 80, 160]) {
      const runs = seeds(3).map(seed => crossValidate(syntheticMarket1({ sale: n, rent: n, seed: 100 + seed }).listings, seed));
      out[n] = summarise(runs);
      log('E2 n', n, JSON.stringify(out[n]).slice(0, 160));
      results.E2 = out;
      save();
    }
  },

  /* E3: robustness to impossible prices. */
  E3() {
    const out: Record<string, unknown> = {};
    for (const bad of [0, 0.05, 0.1, 0.2]) {
      const runs = seeds(3).map(seed => crossValidate(syntheticMarket1({ sale: 80, rent: 80, seed: 200 + seed, badPrice: bad }).listings, seed, { models: ['median', 'ols', 'sherpa1'] }));
      out[bad] = summarise(runs);
      log('E3 bad', bad);
      results.E3 = out;
      save();
    }
  },

  /* E4: accuracy against the share of empty fields. */
  E4() {
    const out: Record<string, unknown> = {};
    for (const missing of [0.1, 0.3, 0.5]) {
      const runs = seeds(3).map(seed => crossValidate(syntheticMarket1({ sale: 80, rent: 80, seed: 300 + seed, missing }).listings, seed, { models: ['median', 'ols', 'sherpa1'] }));
      out[missing] = summarise(runs);
      log('E4 missing', missing);
      results.E4 = out;
      save();
    }
  },

  /* E5: does fitting rental listings help sale estimates when sales are scarce? */
  E5() {
    const out: Record<string, unknown> = {};
    for (const sale of [10, 20, 40]) {
      const runs = seeds(5).map(seed => crossValidate(syntheticMarket1({ sale, rent: 160, seed: 400 + seed }).listings, seed, { models: ['median', 'sherpa1', 'sherpa1SaleOnly'] }));
      out[sale] = summarise(runs);
      log('E5 sale', sale);
      results.E5 = out;
      save();
    }
  },

  /* E6: interval coverage, conformal against normal, by market size. */
  E6() {
    const out: Record<string, unknown> = {};
    for (const n of [40, 160]) {
      for (const conformal of [true, false]) {
        const runs = seeds(3).map(seed =>
          crossValidate(syntheticMarket1({ sale: n, rent: n, seed: 500 + seed }).listings, seed, {
            models: ['sherpa1'],
            coverage: true,
            sherpa: conformal ? { folds: 4 } : { folds: 0, disable: ['conformal'] },
          })
        );
        out[`${n}:${conformal ? 'conformal' : 'normal'}`] = summarise(runs);
        log('E6', n, conformal);
        results.E6 = out;
        save();
      }
    }
  },
};

const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(experiments);
for (const name of chosen) {
  log('start', name);
  experiments[name]();
  log('done', name);
}
