/*
  Parameter recovery: fit SHERPA-1 on a synthetic market and print each
  recovered parameter beside the truth it was generated with.
  Run: npx tsx bench/recovery.ts [sale] [rent] [seed]
*/
import { fitSherpa, syntheticMarket1 } from '../src/index.js';

const sale = Number(process.argv[2] ?? 200);
const rent = Number(process.argv[3] ?? 200);
const seed = Number(process.argv[4] ?? 1);
const { listings, truth } = syntheticMarket1({ sale, rent, seed });
const started = Date.now();
const model = fitSherpa(listings, { market: 'XX', currency: 'USD', asOfYear: 2026, fittedAt: 'bench', folds: 0 });
console.log(`${listings.length} listings, fitted in ${Date.now() - started} ms\n`);

const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3).padStart(7) : '    n/a');
console.log('category        param          truth   fitted');
for (const t of truth.categories) {
  const c = model.categories[t.category];
  const rows: [string, number, number][] = [
    ['depreciation', t.depreciation, c.depreciation],
    ['lambda', t.lambda, c.lambda],
    ['size', t.sizeElasticity, c.sizeElasticity],
    ['usage', t.usage, c.usage],
    ['newPremium', t.newPremium, c.newPremium],
    ['wear', t.wear, c.wear],
    ['rentToValue', t.rentToValue, c.rentToValue],
    ['duration', t.duration, c.duration],
    ['operator', t.operator, c.operator],
    ['sigma(sale)', t.sigma, c.sigmaSale],
    ['sigma(rent)', t.sigma, c.sigmaRent],
  ];
  for (const [name, a, b] of rows) console.log(t.category.padEnd(15), name.padEnd(13), f(a), f(b));
}
const show = (name: string, truthMap: Record<string, number>, fitted: Record<string, { effect: number } | number>) => {
  for (const key of Object.keys(truthMap)) {
    const value = fitted[key];
    const effect = typeof value === 'number' ? value : (value?.effect ?? NaN);
    console.log(name.padEnd(15), key.padEnd(13), f(truthMap[key]), f(effect));
  }
};
console.log('');
show('grade', truth.grade as unknown as Record<string, number>, model.grade);
show('attachments', truth.attachments, model.attachments);
show('seller', truth.seller, model.seller);
show('origin', truth.origin, model.origin);
show('emissions', truth.emissions, model.emissions);
show('spec', truth.spec, model.spec);
show('region', truth.region, model.region);
console.log('verified'.padEnd(15), ''.padEnd(13), f(truth.verified), f(model.verified));
console.log('monthsOnMarket'.padEnd(29), f(truth.monthsOnMarket), f(model.listing.monthsOnMarket));
console.log('completeness'.padEnd(29), f(truth.completeness), f(model.listing.completeness));
const months = Object.keys(model.time).map(Number).sort((a, b) => a - b);
if (months.length) {
  const span = months[months.length - 1] - months[0];
  const fittedTrend = (model.time[String(months[months.length - 1])] - model.time[String(months[0])]) / span;
  console.log('time trend/mo'.padEnd(29), f(truth.timeTrend), f(fittedTrend));
}
