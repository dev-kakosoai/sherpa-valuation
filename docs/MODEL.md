# The SHERPA model

**SHERPA** - *Shrinkage-based Heavy Equipment Residual Price Analysis* - estimates what a used
heavy machine is worth **and what it rents for**, from marketplace listings. It is built for the
data such markets actually have: few listings per category, fields left empty, facts buried in
free text, and outliers.

This document specifies **SHERPA-1**. **SHERPA-0**, the sale-only model it extends, is kept in the
library as the baseline (section 10).

> Status: draft specification for review. References are listed in [REFERENCES.md](REFERENCES.md); all are verified.

---

## 1. Design principles

1. **One machine value, two markets.** A sale listing and a rental listing of the same machine
   are two observations of one underlying value. Both inform the same parameters.
2. **Explainable.** Every term is a named, signed effect on log price that can be shown to a user
   ("+12% for a breaker", "−18% for age").
3. **Partial pooling everywhere.** Every effect is estimated in its own group and shrunk toward
   its parent in proportion to how little data the group has.
4. **Robust.** Medians, Theil-Sen slopes and heavy-tailed errors: one placeholder price must not
   move the fit.
5. **Missing is normal.** A missing input contributes nothing to the point estimate and widens the
   interval by a fitted amount.
6. **Honest intervals.** Prediction intervals are calibrated by conformal prediction, so their
   stated coverage holds in finite samples under exchangeability.
7. **Domain constraints.** Machines lose value with age; more use, more wear and worse condition
   never raise the price; attachments never lower it; longer hire never costs more per day.

---

## 2. Notation

| Symbol | Meaning |
| --- | --- |
| *i* | a listing |
| *c* = c(*i*) | its category (excavators, wheel loaders, generators, ...) |
| *f* = f(*c*) | the category's family (earthmoving, lifting, power, ...) |
| *b*, *o*(*b*) | brand, and the brand's origin group |
| *a* | age in years at the listing date |
| *s* | size in the category's unit (tons, kVA, metres of reach) |
| *h* | engine hours |
| *q* | condition grade, ordinal 1 (needs repair) ... 4 (excellent) |
| *A* | the set of attachments included |
| *e* | emissions standard, ordinal (≤ Tier 2, Tier 3, Tier 4i, Tier 4f / Stage V) |
| *w* | remaining life of the wear parts (undercarriage, tyres), 0 ... 1 |
| *g* | spec / import status (local spec, imported, re-export) |
| *k* | seller type (dealer, rental company, owner-operator, unknown) |
| *v* | inspected or verified (0/1) |
| *r* | region |
| *t* | listing month |
| *m* | months the listing has been on the market |
| *ℓ* | listing completeness, 0 ... 1 (photos, filled fields, description) |
| *T* | hire duration in days (1 = daily, 7 = weekly, 30 = monthly rate) |
| *op* | operator included (wet hire) |
| *P* | sale price; *R*(*T*) the rental rate per day at duration *T* |

All prices are in one currency per fitted model. **One model per market**: listings from different
countries describe different markets and are not pooled.

---

## 3. The model

### 3.1 Machine value

The log value of machine *x* is a sum of named effects around a **reference machine** (the
category's median age and size, average brand, private seller, good condition, no attachments,
local spec, unknown everything else):

```
V(x) = α_c                                   reference log value of category c
     + β_c · g_λc(a)                         depreciation
     + γ_c · log(s / s̄_c)                    size
     + δ_c · u(h, a)                         usage relative to age
     + θ_c · 1[new]                          new-machine premium
     + η_q                                   condition grade
     + Σ_{j∈A} ψ_j                           attachments
     + ε_e                                   emissions standard
     + ζ_c · (w − ½)                         wear parts
     + φ_g                                   spec / import status
     + κ_k                                   seller type
     + ν · v                                 inspection / verification
     + b_o + b_b + b_{b,c}                   origin group, brand, brand within category
     + ρ_r                                   region
     + τ_t                                   market level over time
```

**Depreciation curve.** Age enters through the Box-Cox transform [Box & Cox 1964]

```
g_λ(a) = ((1 + a)^λ − 1) / λ ,     g_0(a) = log(1 + a),     λ ∈ [−1, 1]
```

With λ = 1 the curve is geometric depreciation (a constant percentage per year); as λ falls the
loss is concentrated in the first years and flattens later. Hulten & Wykoff [1981] showed with
Box-Cox forms on used-asset prices that a flexible shape fits better than imposing one; Cross &
Perry [1995] and Wu & Perry [2004] compared functional forms for farm machinery; Lucko,
Anderson-Cook & Vorster [2006] and Fan et al. [2008] modelled the residual value of heavy
construction equipment. SHERPA
estimates λ per category, shrunk toward the family's λ.

**Usage relative to age.** Hours matter in proportion to what is normal for the machine's age:

```
u(h, a) = log( (h + h₀) / (h̄_c · max(a, ½) + h₀) )
```

*h̄_c* is the category's typical annual hours (estimated; pooled prior 1,000 h/yr) and *h₀* = 250
a smoothing constant. *u* = 0 is a normally used machine; *u* = log 2 one used twice as hard.
The remaining-value formula of ASABE D497 and Cross & Perry [1996] uses age and *annual* hours
as separate square-root terms; SHERPA uses hours relative to what is normal for the age, so
hours do not double-count age. Constraint: δ_c ≤ 0.

**Condition grade.** An ordinal effect with η_good = 0 and the monotone constraint
η₁ ≤ η₂ ≤ η₃ ≤ η₄, enforced by pooled-adjacent-violators after each update.

**Attachments.** Each attachment type *j* (bucket, breaker, quick coupler, forks, auger,
grapple, ...) adds a premium ψ_j ≥ 0 on log value. ψ_j is pooled across categories and may be
refined per family. Because attachments are *additive* in money but the model is multiplicative,
ψ_j is interpreted as the attachment's value relative to the machine; this is accurate for
attachments worth a modest share of the machine and is noted as a limitation.

**Wear parts.** *w* is the remaining life of the undercarriage (tracked machines) or tyres
(wheeled ones), as stated in listings ("undercarriage 80%"). ζ_c ≥ 0.

**Brand hierarchy.** A brand's effect is shrunk toward its origin group, the group toward zero,
and the brand-within-category deviation toward zero. A brand seen twice borrows almost
everything from its group; a brand seen fifty times speaks for itself.

**Time.** τ_t is a monthly market index with a random-walk smoothness penalty, in the spirit of
regression-based price indices [Bailey, Muth & Nourse 1963]. It is identified only when the data
span enough months; otherwise τ ≡ 0.

### 3.2 Sale prices

```
log P_i = V(x_i) + λ_m · log(1 + m_i) + λ_ℓ · (ℓ_i − ½) + ε_i^sale
```

The last two terms describe the **listing**, not the machine: asking prices that have sat on the
market for months tend to sit above the market, and complete listings tend to come from serious
sellers. They are fitted, then set to their reference values when *estimating* a machine's value.

### 3.3 Rental rates

A rental listing quotes a rate per day, week or month. SHERPA models the **rate per day** at hire
duration *T*:

```
log R_i(T) = V(x_i) + π_c + κ_c · log(T / 30) + ω_c · 1[op] + λ_m · log(1 + m_i) + ε_i^rent
```

- **π_c - the rent-to-value ratio** of category *c*. Capital theory prices the use of an asset by
  its *user cost*: rent ≈ value × (interest + depreciation + upkeep) [Jorgenson 1963; Hall &
  Jorgenson 1967]. π_c is the log of the daily rate per unit of value at a one-month hire,
  estimated per category and shrunk toward its family. Categories that wear fast or sit idle
  between hires rent dearer relative to their value.
- **κ_c - the duration discount.** The rate per day for a *T*-day hire is
  `R(T) = R(30) · (T / 30)^κ_c`, with κ_c ≤ 0: weekly and monthly hires cost less per day than
  daily ones. One parameter turns a daily rate into a weekly and monthly one, and its steepness
  is learned per category.
- **ω_c - the operator premium** of a wet hire over a dry hire, ω_c ≥ 0.

Because *V* is shared, a rental listing informs the age, size, brand and condition effects as
much as a sale listing does - and a market with many rental listings but few sales still gets a
value model.

### 3.4 Errors

```
ε^side ~ σ_{c,side} · t_ν          side ∈ {sale, rent}
```

Errors are assumed heavy-tailed, with a scale per category and side shrunk toward the pooled
scale. No distribution is fitted: the estimators are robust (section 5) and the intervals are
calibrated empirically (section 6), so the model never relies on normal errors.

---

## 4. Hierarchy and shrinkage

Every group estimate is pulled toward its parent by partial pooling
[Efron & Morris 1975; Gelman & Hill 2007]:

```
θ̂_group = n/(n + k) · θ̃_group + k/(n + k) · θ̂_parent
```

*θ̃* is the group's own robust estimate, *n* its listings, and *k* the number of listings at which
group and parent count equally.

| Parameter | Group | Parent | Default *k* | Constraint |
| --- | --- | --- | --- | --- |
| α | category | family | 6 | - |
| β, λ | category | family → market | 12 | β < 0, λ ∈ [−1, 1] |
| γ | category | family | 12 | γ ≥ 0 |
| δ, h̄ | category | market | 12 | δ ≤ 0 |
| θ | category | market | 10 | θ ≥ 0 |
| η_q | grade | market | 8 | monotone in *q* |
| ψ_j | attachment | 0 | 6 | ψ ≥ 0 |
| ε_e, φ_g, κ_k | level | 0 | 8 | - |
| ζ | category | market | 10 | ζ ≥ 0 |
| ν | - | 0 | 8 | ν ≥ 0 |
| b_o, b_b, b_{b,c} | origin / brand / brand×category | 0 / origin / 0 | 6 / 4 / 6 | - |
| ρ_r | region | 0 | 8 | - |
| π, κ, ω | category | family → market | 8 | κ ≤ 0, ω ≥ 0 |
| σ | category × side | pooled | 8 | σ ≥ 0.1 |

Defaults are documented choices, overridable through `FitOptions`, and reported in the
sensitivity analysis.

---

## 5. Estimation

SHERPA-1 is fitted by **robust backfitting** [Hastie & Tibshirani 1986, 1990]: each block of
parameters is re-estimated on the partial residuals of all the others, until the changes are
small.

```
1  Clean        drop non-positive prices and log-prices > 3.5 robust SDs from the median of their
                category and side (rates first put on a 30-day footing)
2  Initialise   α_c = median log price; π_c = median rent − median sale; every other effect 0
3  Repeat until no prediction moves by more than 0.01% (at most 40 rounds), each block in turn:
   a. levels    α_c                   median partial residual of the category's sale listings
                                      (all listings if it has fewer than 3 sales), shrunk to the
                                      family
   b. rent      π_c                   median partial residual of rental listings; identified only
                                      in categories with both sides, elsewhere the pooled value
   c. curve     λ_c                   in the first 5 rounds only: profiled over a grid in [−1, 1]
                                      by the L1 fit of a Theil-Sen line, refined by a parabola
                                      through the best grid point and its neighbours, shrunk to
                                      the λ pooled across categories; then held fixed
   d. slopes    β_c, γ_c, δ_c, ζ_c, κ_c
                                      Theil-Sen [Theil 1950; Sen 1968] on partial residuals,
                                      shrunk to the pooled slope, clamped to their constraints
   e. levels    θ_c, ω_c, η, ψ, ε, φ, κ_k, ν, origin, brand, brand×category, region
                                      median partial residual per level, shrunk; η made monotone
   f. time      τ_t                   medians per month, shrunk, smoothed by two passes of a
                                      (¼, ½, ¼) filter, and set to 0 at the latest month
   g. listing   λ_m, λ_ℓ              pooled Theil-Sen slopes, strongly shrunk to 0
   h. centre    the level sets without a reference level (emissions, spec, seller, origin,
                region - each with an explicit "unknown" level) are centred on the average
                listing, and the time index on the latest month; α_c takes each shift, so no
                prediction moves
   i. average   from round 15, every fitted parameter is added to a running average
3' Average      the model is the average of the rounds after the burn-in (Polyak averaging)
4  Scale        σ_{c,side} = 1.4826 · MAD of residuals [Hampel 1974; Rousseeuw & Croux 1993],
                shrunk to the pooled scale of that side
5  Calibrate    cross-conformal score quantiles (section 6)
```

**Depreciation parameterisation.** The age slope β and the curve shape λ are not shrunk
directly, because β's units change with λ. SHERPA shrinks the *depreciation at a fixed horizon*
`D_c = β_c · g_λc(H)` (the log-value change from new to age H = 10 years) and recovers
`β_c = D_c / g_λc(H)`.

**Why averaging.** Backfitting with median updates is not guaranteed to converge: in testing
it settled near the fixed point and then wandered around it by about ±0.8% in prediction,
indefinitely. Averaging the iterates after a burn-in, as in stochastic approximation [Polyak &
Juditsky 1992], fixes the answer and reduces the wander about tenfold.

**Speed.** Theil-Sen slopes are computed on at most 160 evenly spaced points per category (300
pooled). Every step is a median or a Theil-Sen slope: no matrix inversion, no dependency, and
the fit is deterministic.

---

## 6. Prediction

**Point estimate.** For a machine *x*:

- value: `P̂ = exp(V(x))`, with the listing terms at their reference values;
- rate per day at duration *T*: `R̂(T) = exp(V(x) + π_c + κ_c·log(T/30) + ω_c·1[op])`;
- a **rate card**: daily, weekly (7·R̂(7)) and monthly (30·R̂(30)) prices.

Inputs the user leaves out contribute their reference value (0) and are recorded as missing.

**Intervals.** SHERPA uses **normalised cross-conformal prediction**
[Vovk, Gammerman & Shafer 2005; Lei et al. 2018; Barber et al. 2021]:

1. Split the listings into K folds (default 5, by a hash of the listing id). For each fold, fit
   on the others and score every held-out listing:
   `S_i = |log y_i − log ŷ_i| / σ̂_{c,side}`.
2. Scores are pooled by side and by how many price-moving inputs are missing (year, size, hours,
   grade: 0, 1, 2 or more) - a *Mondrian* split, so a listing with gaps is calibrated against
   listings with gaps. A group with fewer than 20 scores falls back to its side.
3. The interval at level 1 − α is `ŷ · exp(± q̂ · σ̂)`, with q̂ the ⌈(n+1)(1−α)⌉-th smallest score
   of the group. The point model is then fitted on all listings.

Split conformal prediction guarantees coverage of at least 1 − α under exchangeability;
cross-conformal and jackknife+ intervals carry a slightly weaker worst-case guarantee and in
practice cover close to the nominal level, which SHERPA's evaluation reports. The default is the
50% interval, shown as "low - typical - high"; the 80% interval is also calibrated. Missing
inputs widen the interval through the Mondrian groups, not through a fixed factor.

**Evidence.** The six nearest listings by a weighted distance on age, log size, brand, condition
and seller type are returned with every estimate, from either side of the market.

---

## 7. Derived quantities

From one fitted model:

| Quantity | Formula |
| --- | --- |
| Depreciation schedule | `P̂(a)` for a = 0 ... 20 at fixed other inputs |
| Rate card | daily, weekly, monthly rates from `R̂(T)` |
| Gross rental yield | `y = 30 · R̂(30) / P̂` per month |
| Simple payback | `1 / y` months of full utilisation |
| Effect breakdown | each term as a multiplier `exp(term)`, in order |

---

## 8. Identifiability and assumptions

- **Age, condition and wear** are correlated: old machines tend to be in worse condition. Each is
  identified by listings where they diverge; shrinkage keeps the weakly identified ones small.
- **π_c and α_c** are separately identified only in categories with both sale and rental
  listings. α_c is estimated from sale listings wherever a category has at least three, and π_c
  from rental listings given α_c; elsewhere π_c is the pooled value. (Estimating α_c from both
  sides let α_c and π_c slide along a ridge, round after round.)
- **The new-machine premium θ and the curve shape λ** are weakly identified together. New
  machines are listed at age 0 and used ones from age 1, so the data cannot separate "the jump
  from new" from "how sharply the curve bends in the first year". On synthetic markets with 60
  sale listings per category, λ is biased toward geometric depreciation and θ comes out
  roughly twice its true value, while the predicted *price* of a new machine stays close. The
  depreciation over ten years, D_c, is well identified. θ and λ should be read with this in
  mind, and the paper should report them as such.
- **Numerical stability.** Medians are step functions, so the fit responds to tiny changes in the
  data by small jumps rather than smoothly. With the averaging of §5, a 10⁻⁹ change to every
  price moves predictions by a median of 0.3% (maximum about 2%) on a 600-listing market, and the
  TypeScript and Python implementations - identical to the last digit for the first three rounds,
  then differing in the last digits of `pow` and `log` - agree within the same margin.
- **Asking prices are not transaction prices.** SHERPA estimates asking prices and asking rates.
  The gap to transaction prices needs transaction data; the model has a hook (a per-category
  discount term) for when such data exist.
- **Exchangeability** is required for the conformal guarantee. Strong time trends weaken it; the
  calibration fold is then taken from the most recent listings.
- **Selection.** Listings with "price on request" are missing, not random. SHERPA does not correct
  for this; it is reported as a limitation.

---

## 9. Evaluation protocol

- **Splits:** leave-one-out and 5-fold cross-validation; for time-indexed data, a forward split
  (fit on the past, predict the future).
- **Metrics:** median absolute percentage error (MdAPE), mean absolute log error, interval
  coverage at 50% and 80%, mean interval width.
- **Baselines:** category median; SHERPA-0; ordinary least squares on the same features (a plain
  hedonic regression [Rosen 1974]); optionally gradient-boosted trees.
- **Ablations:** remove one block at a time (curve shape, usage, condition, attachments, seller,
  rent side, conformal calibration) and report the change in each metric.
- **Recovery:** on synthetic markets with known parameters, report the error of every recovered
  parameter.

---

## 10. SHERPA-0 (baseline)

Sale listings only:

```
log P = a + b·(age − age₀) + c·(log s − log s₀) + d·1[new] + e_brand + ε
```

Theil-Sen slopes shrunk toward slopes pooled across categories, brand effects shrunk toward zero,
a normal 50% interval `±0.6745·σ·√(1 + 1/n)` widened for a missing age or size. It is the model
SHERPA-1 must beat.

---

## References

See [REFERENCES.md](REFERENCES.md) for full citations and DOIs, and [references.bib](references.bib)
for BibTeX.
