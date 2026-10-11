/*
  Fit SHERPA-1 on a synthetic market and price one machine.
  Run: npm run example
*/
import { estimateSherpa, fitSherpa, syntheticMarket1 } from '../src/index.js';

const { listings } = syntheticMarket1({ sale: 120, rent: 120, seed: 1 });
const model = fitSherpa(listings, { market: 'XX', currency: 'USD', asOfYear: 2026 });

const estimate = estimateSherpa(
  model,
  {
    category: 'excavators',
    brand: 'Alpha',
    origin: 'japan',
    year: 2016,
    size: 20,
    hours: 9000,
    grade: 3,
    attachments: ['breaker'],
    seller: 'dealer',
  },
  { operator: false }
)!;

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
console.log(`Value      ${usd(estimate.value.typical)}  (50%: ${usd(estimate.value.low)} – ${usd(estimate.value.high)})`);
console.log(`Daily      ${usd(estimate.rates!.daily.typical)}`);
console.log(`Weekly     ${usd(estimate.rates!.weekly.typical)}`);
console.log(`Monthly    ${usd(estimate.rates!.monthly.typical)}`);
console.log(`Payback    ${estimate.paybackMonths!.toFixed(1)} months of hire`);
console.log(`Confidence ${estimate.confidence}; missing: ${estimate.missing.join(', ') || 'nothing'}`);
for (const f of estimate.factors) {
  const pct = (f.multiplier - 1) * 100;
  console.log(`  ${f.key.padEnd(12)} ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`);
}
