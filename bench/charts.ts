/*
  README charts. Draws SVGs from a fit on synthetic data and from
  bench/results.json (npm run bench), each in a light and a dark version for
  GitHub's <picture> switch. No dependencies: plain SVG strings.
  Run: npm run charts
*/
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  boxCox,
  estimateSherpa,
  fitSherpa,
  syntheticMarket1,
  type CrossValidation,
  type SherpaModel,
  type SyntheticTruth,
} from '../src/index.js';

type Theme = 'light' | 'dark';
const THEME = {
  light: {
    surface: '#fcfcfb',
    text: '#0b0b0b',
    muted: '#52514e',
    grid: '#e4e3df',
    axis: '#bdbcb6',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'],
    positive: '#2a78d6',
    negative: '#e34948',
  },
  dark: {
    surface: '#1a1a19',
    text: '#ffffff',
    muted: '#c3c2b7',
    grid: '#2e2e2c',
    axis: '#55544f',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500'],
    positive: '#3987e5',
    negative: '#e66767',
  },
} as const;

const W = 720;
const FONT = "font-family='-apple-system, Segoe UI, Helvetica, Arial, sans-serif'";
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Frame {
  t: (typeof THEME)[Theme];
  parts: string[];
  x: (v: number) => number;
  y: (v: number) => number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function svg(theme: Theme, height: number, title: string, subtitle: string, body: string[]): string {
  const t = THEME[theme];
  return [
    `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${height}' viewBox='0 0 ${W} ${height}' role='img' aria-label='${esc(title)}'>`,
    `<rect width='${W}' height='${height}' rx='8' fill='${t.surface}'/>`,
    `<text x='24' y='32' ${FONT} font-size='16' font-weight='600' fill='${t.text}'>${esc(title)}</text>`,
    `<text x='24' y='52' ${FONT} font-size='12' fill='${t.muted}'>${esc(subtitle)}</text>`,
    ...body,
    '</svg>',
  ].join('\n');
}

/** A plot area with linear scales, recessive grid and axis labels. */
function frame(
  theme: Theme,
  box: { left: number; right: number; top: number; bottom: number },
  xDomain: [number, number],
  yDomain: [number, number],
  xTicks: number[],
  yTicks: number[],
  xFormat: (v: number) => string,
  yFormat: (v: number) => string,
  xLabel: string,
  yLabel: string
): Frame {
  const t = THEME[theme];
  const x = (v: number) => box.left + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * (box.right - box.left);
  const y = (v: number) => box.bottom - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * (box.bottom - box.top);
  const parts: string[] = [];
  for (const v of yTicks) {
    parts.push(`<line x1='${box.left}' x2='${box.right}' y1='${y(v)}' y2='${y(v)}' stroke='${t.grid}' stroke-width='1'/>`);
    parts.push(`<text x='${box.left - 8}' y='${y(v) + 4}' text-anchor='end' ${FONT} font-size='11' fill='${t.muted}'>${esc(yFormat(v))}</text>`);
  }
  parts.push(`<line x1='${box.left}' x2='${box.right}' y1='${box.bottom}' y2='${box.bottom}' stroke='${t.axis}' stroke-width='1'/>`);
  for (const v of xTicks) {
    parts.push(`<text x='${x(v)}' y='${box.bottom + 18}' text-anchor='middle' ${FONT} font-size='11' fill='${t.muted}'>${esc(xFormat(v))}</text>`);
  }
  parts.push(`<text x='${(box.left + box.right) / 2}' y='${box.bottom + 38}' text-anchor='middle' ${FONT} font-size='12' fill='${t.muted}'>${esc(xLabel)}</text>`);
  parts.push(`<text transform='translate(18 ${(box.top + box.bottom) / 2}) rotate(-90)' text-anchor='middle' ${FONT} font-size='12' fill='${t.muted}'>${esc(yLabel)}</text>`);
  return { t, parts, x, y, ...box };
}

const path = (points: [number, number][]) =>
  points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');

function legend(t: Frame['t'], items: { label: string; color: string; dashed?: boolean }[], x0: number, y0: number): string[] {
  const out: string[] = [];
  let x = x0;
  for (const item of items) {
    out.push(`<line x1='${x}' x2='${x + 18}' y1='${y0}' y2='${y0}' stroke='${item.color}' stroke-width='2' stroke-linecap='round' ${item.dashed ? "stroke-dasharray='4 3'" : ''}/>`);
    out.push(`<text x='${x + 24}' y='${y0 + 4}' ${FONT} font-size='12' fill='${t.text}'>${esc(item.label)}</text>`);
    x += 34 + item.label.length * 6.6;
  }
  return out;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** End-of-line labels, pushed apart so none overlap (at least `gap` px). */
function spaced(ys: number[], gap = 15): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) order[k].y = Math.max(order[k].y, order[k - 1].y + gap);
  const out: number[] = [];
  for (const o of order) out[o.i] = o.y;
  return out;
}

/* 1. Depreciation curves: fitted (solid) against the truth (dashed). */
function depreciationChart(theme: Theme, model: SherpaModel, truth: SyntheticTruth): string {
  const cats = ['excavators', 'wheel-loaders', 'cranes', 'generators'];
  const f = frame(theme, { left: 64, right: 540, top: 96, bottom: 330 }, [1, 15], [0, 1], [1, 3, 5, 7, 9, 11, 13, 15], [0, 0.25, 0.5, 0.75, 1], v => String(v), pct, 'Age (years)', 'Value relative to a 1-year-old machine');
  const labels: { text: string; y: number }[] = [];
  cats.forEach((cat, i) => {
    const c = model.categories[cat];
    const tc = truth.categories.find(x => x.category === cat)!;
    const fitted = (a: number) => Math.exp((c.depreciation / boxCox(model.horizon, c.lambda)) * (boxCox(a, c.lambda) - boxCox(1, c.lambda)));
    const real = (a: number) => Math.exp((tc.depreciation / boxCox(truth.horizon, tc.lambda)) * (boxCox(a, tc.lambda) - boxCox(1, tc.lambda)));
    const ages = Array.from({ length: 29 }, (_, k) => 1 + k * 0.5);
    const color = f.t.series[i];
    f.parts.push(`<path d='${path(ages.map(a => [f.x(a), f.y(real(a))]))}' fill='none' stroke='${color}' stroke-width='1.5' stroke-dasharray='4 3' opacity='0.8'/>`);
    f.parts.push(`<path d='${path(ages.map(a => [f.x(a), f.y(fitted(a))]))}' fill='none' stroke='${color}' stroke-width='2' stroke-linecap='round'/>`);
    labels.push({ text: cat, y: f.y(fitted(15)) + 4 });
  });
  spaced(labels.map(l => l.y)).forEach((y, i) => {
    f.parts.push(`<circle cx='${f.x(15) + 10}' cy='${y - 4}' r='4' fill='${f.t.series[i]}'/>`);
    f.parts.push(`<text x='${f.x(15) + 20}' y='${y}' ${FONT} font-size='12' fill='${f.t.text}'>${esc(labels[i].text)}</text>`);
  });
  f.parts.push(...legend(f.t, [{ label: 'fitted', color: f.t.muted }, { label: 'true curve', color: f.t.muted, dashed: true }], 64, 76));
  return svg(theme, 380, 'Depreciation curves', 'The curve shape is learned per category (Box-Cox). Synthetic market, 2,000 listings.', f.parts);
}

/* 2. Duration discount: rate per day relative to the daily rate. */
function durationChart(theme: Theme, model: SherpaModel, truth: SyntheticTruth): string {
  const cats = ['excavators', 'wheel-loaders', 'cranes', 'generators'];
  const f = frame(theme, { left: 64, right: 540, top: 96, bottom: 330 }, [1, 30], [0, 1], [1, 7, 14, 21, 30], [0, 0.25, 0.5, 0.75, 1], v => `${v} d`, pct, 'Hire length (days)', 'Rate per day relative to a 1-day hire');
  const labels: { text: string; y: number }[] = [];
  cats.forEach((cat, i) => {
    const kappa = model.categories[cat].duration;
    const tk = truth.categories.find(x => x.category === cat)!.duration;
    const days = Array.from({ length: 59 }, (_, k) => 1 + k * 0.5);
    const color = f.t.series[i];
    f.parts.push(`<path d='${path(days.map(d => [f.x(d), f.y(Math.pow(d, tk))]))}' fill='none' stroke='${color}' stroke-width='1.5' stroke-dasharray='4 3' opacity='0.8'/>`);
    f.parts.push(`<path d='${path(days.map(d => [f.x(d), f.y(Math.pow(d, kappa))]))}' fill='none' stroke='${color}' stroke-width='2' stroke-linecap='round'/>`);
    labels.push({ text: `${cat} (κ ${kappa.toFixed(2)})`, y: f.y(Math.pow(30, kappa)) + 4 });
  });
  spaced(labels.map(l => l.y)).forEach((y, i) => {
    f.parts.push(`<circle cx='${f.x(30) + 10}' cy='${y - 4}' r='4' fill='${f.t.series[i]}'/>`);
    f.parts.push(`<text x='${f.x(30) + 20}' y='${y}' ${FONT} font-size='12' fill='${f.t.text}'>${esc(labels[i].text)}</text>`);
  });
  f.parts.push(...legend(f.t, [{ label: 'fitted', color: f.t.muted }, { label: 'true curve', color: f.t.muted, dashed: true }], 64, 76));
  return svg(theme, 380, 'Rental duration discount', 'Per-day rate falls with hire length as T^κ; κ is learned per category from rental listings.', f.parts);
}

/* 3. What moves the price: one machine's factors as signed bars. */
function factorsChart(theme: Theme, model: SherpaModel): string {
  const t = THEME[theme];
  const machine = {
    category: 'excavators',
    brand: 'Alpha',
    origin: 'japan',
    year: 2016,
    size: 30,
    hours: 16000,
    condition: 'used' as const,
    grade: 2 as const,
    attachments: ['breaker', 'bucket'],
    seller: 'dealer' as const,
    verified: true,
  };
  const e = estimateSherpa(model, machine)!;
  const rows = e.factors.map(fct => ({ key: fct.key, v: fct.multiplier - 1 })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const max = Math.max(0.3, ...rows.map(r => Math.abs(r.v)));
  const left = 150, right = 600, top = 84, rowH = 30;
  const zero = (left + right) / 2;
  const scale = (v: number) => zero + (v / max) * ((right - left) / 2);
  const parts: string[] = [];
  parts.push(`<line x1='${zero}' x2='${zero}' y1='${top - 6}' y2='${top + rows.length * rowH}' stroke='${t.axis}' stroke-width='1'/>`);
  rows.forEach((r, i) => {
    const yy = top + i * rowH;
    const x0 = Math.min(zero, scale(r.v));
    const w = Math.max(2, Math.abs(scale(r.v) - zero));
    parts.push(`<text x='${left - 10}' y='${yy + 17}' text-anchor='end' ${FONT} font-size='12' fill='${t.text}'>${esc(r.key)}</text>`);
    parts.push(`<rect x='${x0}' y='${yy + 6}' width='${w}' height='16' rx='3' fill='${r.v >= 0 ? t.positive : t.negative}'/>`);
    const label = `${r.v >= 0 ? '+' : '−'}${Math.abs(r.v * 100).toFixed(0)}%`;
    parts.push(`<text x='${r.v >= 0 ? scale(r.v) + 6 : scale(r.v) - 6}' y='${yy + 18}' text-anchor='${r.v >= 0 ? 'start' : 'end'}' ${FONT} font-size='12' fill='${t.text}'>${label}</text>`);
  });
  const h = top + rows.length * rowH + 50;
  parts.push(`<text x='24' y='${h - 18}' ${FONT} font-size='12' fill='${t.muted}'>${esc(`Estimate: ${e.value.typical.toLocaleString('en-US')} (50% range ${e.value.low.toLocaleString('en-US')} – ${e.value.high.toLocaleString('en-US')}); monthly rent ${e.rates!.monthly.typical.toLocaleString('en-US')}; payback ${e.paybackMonths!.toFixed(0)} months`)}</text>`);
  return svg(theme, h, 'What moves the price', 'One excavator: 10 years old, 30 t, hard-worked, fair condition, breaker, dealer, inspected. Synthetic.', parts);
}

/* 4. Parameter recovery: every fitted parameter against its true value. */
function recoveryChart(theme: Theme, model: SherpaModel, truth: SyntheticTruth): string {
  const points: [number, number][] = [];
  for (const tc of truth.categories) {
    const c = model.categories[tc.category];
    points.push([tc.depreciation, c.depreciation], [tc.sizeElasticity, c.sizeElasticity], [tc.usage, c.usage], [tc.wear, c.wear], [tc.duration, c.duration], [tc.operator, c.operator], [tc.newPremium, c.newPremium]);
  }
  const centred = (truthMap: Record<string, number>, fitted: Record<string, { effect: number }>) => {
    const keys = Object.keys(truthMap).filter(k => fitted[k]);
    const mt = keys.reduce((s, k) => s + truthMap[k], 0) / keys.length;
    const mf = keys.reduce((s, k) => s + fitted[k].effect, 0) / keys.length;
    for (const k of keys) points.push([truthMap[k] - mt, fitted[k].effect - mf]);
  };
  centred(truth.attachments, model.attachments);
  centred(truth.seller, model.seller);
  centred(truth.origin, model.origin);
  centred(truth.emissions, model.emissions);
  centred(truth.spec, model.spec);
  centred(truth.region, model.region);
  for (const g of ['1', '2', '4'] as const) points.push([truth.grade[Number(g) as 1 | 2 | 4], model.grade[g]]);
  const f = frame(theme, { left: 64, right: 420, top: 70, bottom: 400 }, [-1.2, 0.9], [-1.2, 0.9], [-1, -0.5, 0, 0.5], [-1, -0.5, 0, 0.5], v => v.toFixed(1), v => v.toFixed(1), 'True effect (log price)', 'Fitted effect');
  f.parts.push(`<line x1='${f.x(-1.2)}' y1='${f.y(-1.2)}' x2='${f.x(0.9)}' y2='${f.y(0.9)}' stroke='${f.t.axis}' stroke-width='1' stroke-dasharray='4 3'/>`);
  f.parts.push(`<text x='${f.x(-1.15)}' y='${f.y(-1.02)}' ${FONT} font-size='11' fill='${f.t.muted}'>fitted = true</text>`);
  for (const [a, b] of points) {
    f.parts.push(`<circle cx='${f.x(a).toFixed(1)}' cy='${f.y(b).toFixed(1)}' r='4' fill='${f.t.series[0]}' stroke='${f.t.surface}' stroke-width='2'/>`);
  }
  const r = (() => {
    const n = points.length;
    const mx = points.reduce((s, p) => s + p[0], 0) / n;
    const my = points.reduce((s, p) => s + p[1], 0) / n;
    const sxy = points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
    const sxx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    const syy = points.reduce((s, p) => s + (p[1] - my) ** 2, 0);
    return sxy / Math.sqrt(sxx * syy);
  })();
  f.parts.push(`<text x='450' y='120' ${FONT} font-size='13' fill='${f.t.text}'>${points.length} parameters</text>`);
  f.parts.push(`<text x='450' y='142' ${FONT} font-size='13' fill='${f.t.text}'>correlation ${r.toFixed(3)}</text>`);
  f.parts.push(`<text x='450' y='170' ${FONT} font-size='11' fill='${f.t.muted}'>Slopes, premiums and level effects</text>`);
  f.parts.push(`<text x='450' y='186' ${FONT} font-size='11' fill='${f.t.muted}'>of all five categories. Level effects</text>`);
  f.parts.push(`<text x='450' y='202' ${FONT} font-size='11' fill='${f.t.muted}'>are compared after centring.</text>`);
  return svg(theme, 450, 'Parameter recovery', 'Fitted on a synthetic market built from known parameters: points on the dashed line are recovered exactly.', f.parts);
}

/* 5. Accuracy: median absolute % error, by model and side. */
function accuracyChart(theme: Theme, cv: CrossValidation): string {
  const t = THEME[theme];
  const rows: { group: string; label: string; v: number; slot: number }[] = [
    { group: 'Sale prices', label: 'Category median', v: cv.baselines.categoryMedian.sale, slot: 1 },
    { group: 'Sale prices', label: 'SHERPA-0', v: cv.baselines.sherpa0Sale, slot: 2 },
    { group: 'Sale prices', label: 'SHERPA-1', v: cv.sale.mdape, slot: 0 },
    { group: 'Rental rates', label: 'Category median', v: cv.baselines.categoryMedian.rent, slot: 1 },
    { group: 'Rental rates', label: 'SHERPA-1', v: cv.rent.mdape, slot: 0 },
  ];
  const max = Math.max(...rows.map(r => r.v)) * 1.15;
  const left = 170, right = 620;
  const parts: string[] = [];
  let yy = 84;
  let lastGroup = '';
  for (const r of rows) {
    if (r.group !== lastGroup) {
      if (lastGroup) yy += 12;
      parts.push(`<text x='24' y='${yy + 14}' ${FONT} font-size='12' font-weight='600' fill='${t.text}'>${esc(r.group)}</text>`);
      yy += 24;
      lastGroup = r.group;
    }
    const w = ((right - left) * r.v) / max;
    parts.push(`<text x='${left - 10}' y='${yy + 15}' text-anchor='end' ${FONT} font-size='12' fill='${t.text}'>${esc(r.label)}</text>`);
    parts.push(`<rect x='${left}' y='${yy + 4}' width='${w.toFixed(1)}' height='16' rx='3' fill='${t.series[r.slot]}'/>`);
    parts.push(`<text x='${left + w + 6}' y='${yy + 16}' ${FONT} font-size='12' fill='${t.text}'>${(r.v * 100).toFixed(1)}%</text>`);
    yy += 28;
  }
  return svg(theme, yy + 30, 'Accuracy', 'Median absolute percentage error, 5-fold cross-validation on synthetic listings (lower is better).', parts);
}

/* 6. Ablations: how much worse the error gets with each block switched off. */
function ablationChart(theme: Theme, results: Record<string, CrossValidation>): string {
  const t = THEME[theme];
  const full = results.full;
  const names: Record<string, string> = {
    curve: 'depreciation curve',
    usage: 'hours vs age',
    grade: 'condition grade',
    attachments: 'attachments',
    seller: 'seller type',
    brand: 'brand hierarchy',
    rentSide: 'rental listings',
    pooling: 'partial pooling',
  };
  const rows = Object.keys(names)
    .filter(k => results[k])
    .map(k => ({ label: names[k], v: results[k].sale.mdape - full.sale.mdape }))
    .sort((a, b) => b.v - a.v);
  const max = Math.max(0.01, ...rows.map(r => Math.abs(r.v))) * 1.2;
  const left = 170, right = 620, zero = rows.some(r => r.v < 0) ? 170 + 70 : 170 + 10;
  const scale = (v: number) => zero + (v / max) * (right - zero);
  const parts: string[] = [];
  parts.push(`<line x1='${zero}' x2='${zero}' y1='78' y2='${84 + rows.length * 28}' stroke='${t.axis}' stroke-width='1'/>`);
  rows.forEach((r, i) => {
    const yy = 84 + i * 28;
    const x0 = Math.min(zero, scale(r.v));
    const w = Math.max(2, Math.abs(scale(r.v) - zero));
    parts.push(`<text x='${left - 10}' y='${yy + 15}' text-anchor='end' ${FONT} font-size='12' fill='${t.text}'>${esc(r.label)}</text>`);
    parts.push(`<rect x='${x0}' y='${yy + 4}' width='${w.toFixed(1)}' height='16' rx='3' fill='${r.v >= 0 ? t.series[0] : t.axis}'/>`);
    parts.push(`<text x='${Math.max(scale(r.v), zero) + 6}' y='${yy + 16}' ${FONT} font-size='12' fill='${t.text}'>${r.v >= 0 ? '+' : '−'}${Math.abs(r.v * 100).toFixed(1)} pts</text>`);
  });
  void left;
  return svg(theme, 84 + rows.length * 28 + 30, 'What each part contributes', `Rise in sale-price error (MdAPE, ${(full.sale.mdape * 100).toFixed(1)}% with everything on) when one block is switched off.`, parts);
}

/* 7. Calibration: promised against achieved interval coverage. */
function calibrationChart(theme: Theme, results: Record<string, CrossValidation>): string {
  const f = frame(theme, { left: 64, right: 380, top: 80, bottom: 360 }, [0.3, 1], [0.3, 1], [0.4, 0.5, 0.6, 0.7, 0.8, 0.9], [0.4, 0.5, 0.6, 0.7, 0.8, 0.9], pct, pct, 'Promised coverage', 'Share of held-out prices inside');
  f.parts.push(`<line x1='${f.x(0.3)}' y1='${f.y(0.3)}' x2='${f.x(1)}' y2='${f.y(1)}' stroke='${f.t.axis}' stroke-width='1' stroke-dasharray='4 3'/>`);
  const series = [
    { label: 'conformal, sale', r: results.full.sale, slot: 0 },
    { label: 'conformal, rent', r: results.full.rent, slot: 2 },
    { label: 'normal intervals, sale', r: results.conformal?.sale, slot: 1 },
  ].filter(s => s.r);
  series.forEach((s, i) => {
    const pts: [number, number][] = [[0.5, s.r!.coverage50], [0.8, s.r!.coverage80]];
    f.parts.push(`<path d='${path(pts.map(([a, b]) => [f.x(a), f.y(b)]))}' stroke='${f.t.series[s.slot]}' stroke-width='2' fill='none'/>`);
    for (const [a, b] of pts) f.parts.push(`<circle cx='${f.x(a)}' cy='${f.y(b)}' r='5' fill='${f.t.series[s.slot]}' stroke='${f.t.surface}' stroke-width='2'/>`);
    f.parts.push(`<line x1='420' x2='438' y1='${120 + i * 24}' y2='${120 + i * 24}' stroke='${f.t.series[s.slot]}' stroke-width='2'/>`);
    f.parts.push(`<circle cx='429' cy='${120 + i * 24}' r='4' fill='${f.t.series[s.slot]}'/>`);
    f.parts.push(`<text x='446' y='${124 + i * 24}' ${FONT} font-size='12' fill='${f.t.text}'>${esc(`${s.label}: ${pct(s.r!.coverage50)} / ${pct(s.r!.coverage80)}`)}</text>`);
  });
  f.parts.push(`<text x='420' y='212' ${FONT} font-size='11' fill='${f.t.muted}'>On the dashed line, a 50% range holds</text>`);
  f.parts.push(`<text x='420' y='228' ${FONT} font-size='11' fill='${f.t.muted}'>half the prices and an 80% range 80%.</text>`);
  return svg(theme, 410, 'Interval calibration', 'Do the stated ranges hold? Out-of-fold coverage at the 50% and 80% levels.', f.parts);
}

const out = new URL('../docs/img/', import.meta.url);
mkdirSync(out, { recursive: true });
const { listings, truth } = syntheticMarket1({ sale: 200, rent: 200, seed: 1 });
const model = fitSherpa(listings, { market: 'XX', currency: 'USD', asOfYear: 2026, fittedAt: 'charts' });
const resultsFile = new URL('./results.json', import.meta.url);
const bench = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : null;

for (const theme of ['light', 'dark'] as const) {
  const write = (name: string, content: string) => writeFileSync(new URL(`${name}-${theme}.svg`, out), content);
  write('depreciation', depreciationChart(theme, model, truth));
  write('duration', durationChart(theme, model, truth));
  write('factors', factorsChart(theme, model));
  write('recovery', recoveryChart(theme, model, truth));
  if (bench) {
    write('accuracy', accuracyChart(theme, bench.results.full));
    write('ablation', ablationChart(theme, bench.results));
    write('calibration', calibrationChart(theme, bench.results));
  }
}
console.log(`charts written to docs/img${bench ? '' : ' (run npm run bench first for accuracy, ablation and calibration)'}`);
