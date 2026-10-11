/*
  Benchmark on synthetic data: SHERPA-1 against the category median and
  SHERPA-0, then each block of SHERPA-1 switched off in turn (ablations).
  Writes bench/results.json, which the README charts are drawn from.
  Run: npm run bench
*/
import { writeFileSync } from 'node:fs';
import { ablations, syntheticMarket1, type Block } from '../src/index.js';

const seed = Number(process.env.SEED ?? 7);
const { listings } = syntheticMarket1({ sale: 120, rent: 120, seed });
const options = { market: 'XX', currency: 'USD', asOfYear: 2026, fittedAt: 'bench', folds: 4 };
const blocks: Block[] = ['curve', 'usage', 'grade', 'attachments', 'seller', 'brand', 'rentSide', 'pooling', 'conformal'];

const started = Date.now();
const results = ablations(listings, options, blocks, 5);
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : 'n/a');

const full = results.full;
console.log(`${listings.length} synthetic listings, seed ${seed}, ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
console.log('Sale prices      MdAPE   cover50  cover80');
console.log(`category median  ${pct(full.baselines.categoryMedian.sale).padStart(6)}`);
console.log(`SHERPA-0         ${pct(full.baselines.sherpa0Sale).padStart(6)}`);
console.log(`SHERPA-1         ${pct(full.sale.mdape).padStart(6)}  ${pct(full.sale.coverage50).padStart(6)}  ${pct(full.sale.coverage80).padStart(6)}`);
console.log('\nRental rates     MdAPE   cover50  cover80');
console.log(`category median  ${pct(full.baselines.categoryMedian.rent).padStart(6)}`);
console.log(`SHERPA-1         ${pct(full.rent.mdape).padStart(6)}  ${pct(full.rent.coverage50).padStart(6)}  ${pct(full.rent.coverage80).padStart(6)}`);
console.log('\nAblation (block off)   sale MdAPE  rent MdAPE  sale cover50');
for (const block of blocks) {
  const r = results[block];
  console.log(
    `${block.padEnd(22)} ${pct(r.sale.mdape).padStart(10)}  ${pct(r.rent.mdape).padStart(10)}  ${pct(r.sale.coverage50).padStart(11)}`
  );
}
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({ seed, n: listings.length, results }, null, 1));
