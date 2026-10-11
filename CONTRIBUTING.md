# Contributing to SHERPA

Thanks for your interest. Issues and pull requests are welcome.

## Ground rules

- **No real listing data in the repository.** Tests, examples and benchmarks use the synthetic
  generator (`src/synthetic.ts`). If you report a result on real data, report aggregates only.
- **Every modelling change is explained.** A change to the fit or the estimate updates
  `docs/MODEL.md`, adds or updates a test that checks the fit recovers known parameters on
  synthetic data, and bumps `MODEL_VERSION`.
- **Cite what you build on.** New terms or estimators come with a reference in
  `docs/REFERENCES.md`.
- **No runtime dependencies.** The TypeScript package has none; keep it that way.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run bench
```

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0.
