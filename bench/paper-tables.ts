/*
  Writes the paper's tables (paper/tables/*.tex) and inline numbers
  (paper/numbers/*.tex) from bench/paper-results.json, and the ablation figure
  from docs/img. Run after bench/paper.ts: npx tsx bench/paper-tables.ts
*/
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SYNTHETIC_TRUTH } from '../src/index.js';

type Stat = { mean: number; se: number; n: number };
const R = JSON.parse(readFileSync(new URL('./paper-results.json', import.meta.url), 'utf8'));
const tables = new URL('../paper/tables/', import.meta.url);
const numbers = new URL('../paper/numbers/', import.meta.url);
mkdirSync(tables, { recursive: true });
mkdirSync(numbers, { recursive: true });
const write = (dir: URL, name: string, body: string) => writeFileSync(new URL(name, dir), body.trim() + '\n');

const pct = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? '--' : `${(100 * x).toFixed(1)}`);
const cell = (s: Stat | undefined, best = false) => {
  if (!s || !Number.isFinite(s.mean)) return '--';
  const v = `${(100 * s.mean).toFixed(1)}`;
  return best ? `\\textbf{${v}}` : v;
};
/** A parameter label with its Greek symbol typeset; the two-character symbols come first. */
const tex = (s: string) => {
  const greek: [string, string][] = [
    ['κ_k', String.raw`\kappa_k`],
    ['λ_m', String.raw`\lambda_m`],
    ['λ_ℓ', String.raw`\lambda_\ell`],
    ['λ', String.raw`\lambda`],
    ['θ', String.raw`\theta`],
    ['γ', String.raw`\gamma`],
    ['δ', String.raw`\delta`],
    ['ζ', String.raw`\zeta`],
    ['π', String.raw`\pi`],
    ['κ', String.raw`\kappa`],
    ['ω', String.raw`\omega`],
    ['η', String.raw`\eta`],
    ['ψ', String.raw`\psi`],
    ['ε', String.raw`\varepsilon`],
    ['φ', String.raw`\varphi`],
    ['ρ', String.raw`\rho`],
    ['ν', String.raw`\nu`],
    ['τ', String.raw`\tau`],
  ];
  let out = s.split('(D)').join('($D$)');
  for (const [g, t] of greek) out = out.split(g).join(`$${t}$`);
  return out;
};

/* Table: parameter recovery (E1). */
if (R.E1) {
  const rows = Object.entries(R.E1 as Record<string, { bias: number; rmse: number; n: number }>)
    .map(([k, v]) => `${tex(k)} & ${v.bias >= 0 ? '' : '$-$'}${Math.abs(v.bias).toFixed(3)} & ${v.rmse.toFixed(3)} & ${v.n} \\\\`)
    .join('\n');
  write(tables, 'recovery.tex', `
\\begin{table}[t]
\\centering\\small
\\caption{Parameter recovery over 20 synthetic markets (120 sale and 120 rental listings per category). Errors are on the log-price scale; level effects without a reference level are compared after centring. $n$ counts estimates (parameters $\\times$ markets).}
\\label{tab:recovery}
\\begin{tabular}{lrrr}
\\toprule
Parameter & Bias & RMSE & $n$ \\\\
\\midrule
${rows}
\\bottomrule
\\end{tabular}
\\end{table}`);
}

/* Table: accuracy by market size (E2). */
if (R.E2) {
  const sizes = Object.keys(R.E2);
  const line = (n: string) => {
    const s = R.E2[n] as Record<string, Stat>;
    const saleBest = Math.min(...['median:sale', 'sherpa0:sale', 'ols:sale', 'sherpa1:sale'].map(k => s[k]?.mean ?? Infinity));
    const rentBest = Math.min(...['median:rent', 'ols:rent', 'sherpa1:rent'].map(k => s[k]?.mean ?? Infinity));
    const c = (k: string, best: number) => cell(s[k], s[k]?.mean === best);
    return `${n} & ${c('median:sale', saleBest)} & ${c('sherpa0:sale', saleBest)} & ${c('ols:sale', saleBest)} & ${c('sherpa1:sale', saleBest)} & ${c('median:rent', rentBest)} & ${c('ols:rent', rentBest)} & ${c('sherpa1:rent', rentBest)} \\\\`;
  };
  write(tables, 'size.tex', `
\\begin{table}[t]
\\centering\\small
\\caption{Median absolute percentage error (\\%) by listings per category and side; four-fold cross-validation, mean over three markets. Best per side in bold.}
\\label{tab:size}
\\begin{tabular}{rccccccc}
\\toprule
 & \\multicolumn{4}{c}{Sale prices} & \\multicolumn{3}{c}{Rental rates} \\\\
\\cmidrule(lr){2-5}\\cmidrule(lr){6-8}
$n$ & Median & \\textsc{sherpa-0} & OLS & \\textsc{sherpa-1} & Median & OLS & \\textsc{sherpa-1} \\\\
\\midrule
${sizes.map(line).join('\n')}
\\bottomrule
\\end{tabular}
\\end{table}`);
  const at80 = R.E2['80'] as Record<string, Stat> | undefined;
  if (at80) {
    write(numbers, 'e2_ols_sale.tex', `${pct(at80['ols:sale']?.mean)}\\%`);
    write(numbers, 'e2_s1_sale.tex', `${pct(at80['sherpa1:sale']?.mean)}\\%`);
  }
}

/* Table: robustness (E3, E4). */
if (R.E3 || R.E4) {
  const row = (label: string, s: Record<string, Stat>) => {
    const best = (side: string) => Math.min(...['median', 'ols', 'sherpa1'].map(m => s[`${m}:${side}`]?.mean ?? Infinity));
    const c = (k: string, side: string) => cell(s[k], s[k]?.mean === best(side));
    return `${label} & ${c('median:sale', 'sale')} & ${c('ols:sale', 'sale')} & ${c('sherpa1:sale', 'sale')} & ${c('median:rent', 'rent')} & ${c('ols:rent', 'rent')} & ${c('sherpa1:rent', 'rent')} \\\\`;
  };
  const e3 = R.E3 ? Object.entries(R.E3).map(([k, s]) => row(`${Math.round(100 * Number(k))}\\% impossible prices`, s as Record<string, Stat>)) : [];
  const e4 = R.E4 ? Object.entries(R.E4).map(([k, s]) => row(`${Math.round(100 * Number(k))}\\% empty fields`, s as Record<string, Stat>)) : [];
  write(tables, 'robust.tex', `
\\begin{table}[t]
\\centering\\small
\\caption{Robustness: MdAPE (\\%) with 80 listings per category and side, mean over three markets. Models are trained on the raw listings; scored on held-out listings with plausible prices.}
\\label{tab:robust}
\\begin{tabular}{lcccccc}
\\toprule
 & \\multicolumn{3}{c}{Sale prices} & \\multicolumn{3}{c}{Rental rates} \\\\
\\cmidrule(lr){2-4}\\cmidrule(lr){5-7}
Condition & Median & OLS & \\textsc{sherpa-1} & Median & OLS & \\textsc{sherpa-1} \\\\
\\midrule
${e3.join('\n')}
\\midrule
${e4.join('\n')}
\\bottomrule
\\end{tabular}
\\end{table}`);
}

/* Table: joint fitting (E5). */
if (R.E5) {
  const lines = Object.entries(R.E5).map(([n, raw]) => {
    const s = raw as Record<string, Stat>;
    const joint = s['sherpa1:sale'];
    const alone = s['sherpa1SaleOnly:sale'];
    const gain = joint && alone ? `${(100 * (alone.mean - joint.mean)).toFixed(1)}` : '--';
    return `${n} & ${cell(s['median:sale'])} & ${cell(alone)} & ${cell(joint, true)} & ${gain} \\\\`;
  });
  write(tables, 'joint.tex', `
\\begin{table}[t]
\\centering\\small
\\caption{Sale-price MdAPE (\\%) with 160 rental listings per category and few sale listings; mean over five markets. \\textit{Sale only} fits \\textsc{sherpa-1} without the rental listings.}
\\label{tab:joint}
\\begin{tabular}{rcccc}
\\toprule
Sale listings per category & Median & \\textsc{sherpa-1}, sale only & \\textsc{sherpa-1}, joint & Gain (points) \\\\
\\midrule
${lines.join('\n')}
\\bottomrule
\\end{tabular}
\\end{table}`);
}

/* Table: coverage (E6). */
if (R.E6) {
  const lines = Object.entries(R.E6).map(([key, raw]) => {
    const s = raw as Record<string, Stat>;
    const [n, kind] = key.split(':');
    return `${n} & ${kind} & ${pct(s['cover50:sale']?.mean)} & ${pct(s['cover80:sale']?.mean)} & ${pct(s['cover50:rent']?.mean)} & ${pct(s['cover80:rent']?.mean)} \\\\`;
  });
  write(tables, 'coverage.tex', `
\\begin{table}[t]
\\centering\\small
\\caption{Share (\\%) of held-out prices inside the 50\\% and 80\\% intervals; four-fold cross-validation, mean over three markets. Nominal levels: 50 and 80.}
\\label{tab:coverage}
\\begin{tabular}{rlcccc}
\\toprule
 & & \\multicolumn{2}{c}{Sale} & \\multicolumn{2}{c}{Rent} \\\\
\\cmidrule(lr){3-4}\\cmidrule(lr){5-6}
$n$ & Intervals & 50\\% & 80\\% & 50\\% & 80\\% \\\\
\\midrule
${lines.join('\n')}
\\bottomrule
\\end{tabular}
\\end{table}`);
}

/* Appendix: the true parameters. */
const T = SYNTHETIC_TRUTH;
const f = (x: number, d = 2) => (x < 0 ? `$-$${Math.abs(x).toFixed(d)}` : x.toFixed(d));
write(tables, 'truth.tex', `
\\begin{table}[h]
\\centering\\small
\\caption{Category parameters of the synthetic markets. $D$ is the log-value change from new to age 10; $\\pi$ is given as the daily rate per unit of value, $e^{\\pi}$.}
\\begin{tabular}{lrrrrrrrrrr}
\\toprule
Category & Base price & $D$ & $\\lambda$ & $\\gamma$ & $\\delta$ & $\\theta$ & $\\zeta$ & $e^{\\pi}$ & $\\kappa$ & $\\omega$ \\\\
\\midrule
${T.categories
  .map(c => `${c.category} & ${c.basePrice.toLocaleString('en-US')} & ${f(c.depreciation)} & ${f(c.lambda)} & ${f(c.sizeElasticity)} & ${f(c.usage)} & ${f(c.newPremium)} & ${f(c.wear)} & ${Math.exp(c.rentToValue).toFixed(4)} & ${f(c.duration)} & ${f(c.operator)} \\\\`)
  .join('\n')}
\\bottomrule
\\end{tabular}

\\vspace{0.6em}
Grade: ${Object.entries(T.grade).map(([k, v]) => `${k}: ${f(v)}`).join(', ')}.
Attachments: ${Object.entries(T.attachments).map(([k, v]) => `${k} ${f(v)}`).join(', ')}.
Seller: ${Object.entries(T.seller).map(([k, v]) => `${k} ${f(v)}`).join(', ')}.
Origin: ${Object.entries(T.origin).map(([k, v]) => `${k} ${f(v)}`).join(', ')}.
Emissions: ${Object.entries(T.emissions).map(([k, v]) => `${k} ${f(v)}`).join(', ')}.
Inspection ${f(T.verified)}; market trend ${f(T.timeTrend, 3)} per month; time on market ${f(T.monthsOnMarket)}; completeness ${f(T.completeness)}.
Noise standard deviation 0.22--0.30 on log price, by category.
\\end{table}`);

console.log('tables and numbers written to paper/');
