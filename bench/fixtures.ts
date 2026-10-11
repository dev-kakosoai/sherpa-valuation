/*
  Cross-language fixtures: a synthetic market and the TypeScript fits of it,
  which the Python test (python/tests) reproduces and compares.
  Run: npm run fixtures
*/
import { writeFileSync } from 'node:fs';
import { estimateSherpa, fitCore, fitSherpa, predictListing, syntheticMarket1 } from '../src/index.js';

const { listings } = syntheticMarket1({ sale: 60, rent: 60, seed: 5 });
const options = { market: 'XX', currency: 'USD', asOfYear: 2026, fittedAt: 'fixture', folds: 3 };

// Three rounds: the two implementations agree to the last digit here. Later
// rounds differ in the last digits of pow/log between V8 and CPython, and the
// medians amplify that, so the full fit is compared on its predictions.
const { listings: _a, ...early } = fitCore(listings, { ...options, rounds: 3 });
void _a;

const model = fitSherpa(listings, options);
const predictions = Object.fromEntries(model.listings.map(l => [String(l.id), predictListing(model, l)]));
const machine = {
  category: 'excavators',
  brand: 'Alpha',
  origin: 'japan',
  year: 2016,
  size: 20,
  hours: 9000,
  condition: 'used' as const,
  grade: 3 as const,
  attachments: ['breaker'],
  seller: 'dealer' as const,
};
const estimate = estimateSherpa(model, machine, { operator: true })!;

writeFileSync(
  new URL('../test/fixtures/crosscheck.json', import.meta.url),
  JSON.stringify({
    options,
    listings,
    early,
    predictions,
    machine,
    estimate: { value: estimate.value, rates: estimate.rates, missing: estimate.missing },
  })
);
console.log('wrote test/fixtures/crosscheck.json');
