# Changelog

## 0.1.0 - unreleased

**SHERPA-1** (`fitSherpa`, `estimateSherpa`; Python `fit_sherpa`, `estimate_sherpa`):

- One machine-value core fitted jointly from sale and rental listings: a per-category
  rent-to-value level, a duration discount (rate per day ∝ T^κ) and an operator premium.
- Box-Cox depreciation curve, size elasticity, usage relative to age, new-machine premium,
  condition grade (monotone), attachments, emissions standard, wear parts, spec/import status,
  seller type, inspection, brand → origin hierarchy, region, monthly market index, and listing
  terms (time on market, completeness).
- Robust backfitting with partial pooling and domain constraints; α from sale listings; λ
  profiled then held; Polyak averaging after a burn-in.
- Cross-conformal intervals, calibrated by side and by how many inputs are missing.
- Rate card (daily, weekly, monthly), rental yield and payback, factor breakdown, comparables,
  depreciation schedule.
- Cross-validation, baselines and ablations (`crossValidate`, `ablations`).
- Synthetic sale and rental markets with known parameters (`syntheticMarket1`).
- Python port with a cross-language test.

**SHERPA-0** (`fitPriceModel`, `estimatePrice`): the baseline sale-price model - per-category
log-price with Theil-Sen age and size slopes, new-machine premium and brand effects, partial
pooling, normal 50% intervals, comparables, leave-one-out evaluation. Text extraction of year,
size and engine hours from listing titles and descriptions.
