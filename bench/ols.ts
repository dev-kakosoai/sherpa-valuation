/*
  The ordinary least squares hedonic baseline for the paper's comparisons
  [Rosen 1974]: one regression on log price (log rate per day for rentals)
  with the same inputs SHERPA-1 sees, the way a hedonic model is usually
  fitted - category intercepts, category-specific age and size slopes, dummy
  variables for every level, an indicator for each missing input, and a small
  ridge penalty so sparse dummies stay solvable. No pooling, no robustness.
*/
import type { Listing } from '../src/index.js';
import { ageOf1 as ageOf, periodOf } from '../src/index.js';

export interface OlsModel {
  columns: string[];
  beta: number[];
  asOfYear: number;
}

/** Named features of a listing; a missing input contributes its indicator only. */
function features(l: Listing, asOfYear: number): Record<string, number> {
  const f: Record<string, number> = { intercept: 1 };
  const c = l.category;
  f[`cat:${c}`] = 1;
  const rent = l.side === 'rent';
  if (rent) {
    f[`rent:${c}`] = 1;
    f['logPeriod'] = Math.log(periodOf(l.period) / 30);
    if (l.operator) f['operator'] = 1;
  }
  const age = ageOf(l, asOfYear);
  if (age === null) f[`ageMissing:${c}`] = 1;
  else f[`age:${c}`] = age;
  if (l.size && l.size > 0) f[`logSize:${c}`] = Math.log(l.size);
  else f[`sizeMissing:${c}`] = 1;
  if (l.hours !== null && l.hours !== undefined) f['logHours'] = Math.log1p(l.hours);
  else f['hoursMissing'] = 1;
  if (l.condition === 'new') f['new'] = 1;
  if (l.grade) f[`grade:${l.grade}`] = 1;
  for (const a of l.attachments ?? []) f[`att:${a}`] = 1;
  if (l.emissions) f[`em:${l.emissions}`] = 1;
  if (l.wear !== null && l.wear !== undefined) f['wear'] = l.wear;
  if (l.spec) f[`spec:${l.spec}`] = 1;
  if (l.seller) f[`seller:${l.seller}`] = 1;
  if (l.verified) f['verified'] = 1;
  if (l.origin) f[`origin:${l.origin}`] = 1;
  if (l.brand) f[`brand:${l.brand}`] = 1;
  if (l.region) f[`region:${l.region}`] = 1;
  if (l.month !== null && l.month !== undefined) f['month'] = l.month;
  if (l.monthsOnMarket) f['logMonthsOnMarket'] = Math.log1p(l.monthsOnMarket);
  if (l.completeness !== null && l.completeness !== undefined) f['completeness'] = l.completeness;
  return f;
}

const target = (l: Listing) =>
  l.side === 'rent' ? Math.log(l.price / periodOf(l.period)) : Math.log(l.price);

/** Solves (XᵀX + ridge·I) β = Xᵀy by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / p;
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) m[r][k] -= factor * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function fitOls(listings: Listing[], asOfYear: number, ridge = 1e-3): OlsModel {
  const rows = listings.filter(l => l.price > 0).map(l => ({ f: features(l, asOfYear), y: target(l) }));
  const columns = [...new Set(rows.flatMap(r => Object.keys(r.f)))].sort();
  const index = new Map(columns.map((c, i) => [c, i]));
  const k = columns.length;
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (const { f, y } of rows) {
    const entries = Object.entries(f).map(([name, v]) => [index.get(name)!, v] as const);
    for (const [i, vi] of entries) {
      xty[i] += vi * y;
      for (const [j, vj] of entries) xtx[i][j] += vi * vj;
    }
  }
  for (let i = 0; i < k; i++) if (columns[i] !== 'intercept') xtx[i][i] += ridge * rows.length;
  return { columns, beta: solve(xtx, xty), asOfYear };
}

/** Log price (sale) or log rate per day (rent). Unseen columns contribute nothing. */
export function predictOls(model: OlsModel, l: Listing): number {
  const f = features(l, model.asOfYear);
  let sum = 0;
  model.columns.forEach((c, i) => {
    if (f[c] !== undefined) sum += f[c] * model.beta[i];
  });
  return sum;
}

export { target as logTarget };
