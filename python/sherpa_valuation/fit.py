"""SHERPA-1 - the fit (a port of src/sherpa1/fit.ts; docs/MODEL.md §5).

Robust backfitting: every block of parameters is re-estimated on the partial
residuals of all the others, a few rounds until the predictions settle. Each
estimate is a median or a Theil-Sen slope, shrunk toward its parent by partial
pooling and clamped to what equipment does. Listings and the fitted model are
plain dicts with the same keys as the TypeScript version, so a model fitted in
one language can be read in the other.
"""

from __future__ import annotations

import math
from typing import Callable, Optional

from .features import LAMBDA_GRID, age_of, box_cox, period_of, usage_ratio
from .stats import NAN, median, robust_sigma, theil_sen_slope

SHERPA1_VERSION = "1.0.0-draft"

DEFAULT_K = {
    "alpha": 6, "slope": 12, "lambda": 24, "newPremium": 10, "grade": 8, "attachment": 6, "level": 8,
    "origin": 6, "brand": 4, "brandInCategory": 6, "region": 8, "time": 8, "listing": 30, "rent": 8,
    "sigma": 8, "annualHours": 12,
}

TERMS = [
    "alpha", "rent", "age", "size", "usage", "new", "wear", "grade", "attachments", "emissions", "spec",
    "seller", "verified", "origin", "brand", "brandInCategory", "region", "time", "monthsOnMarket",
    "completeness", "duration", "operator",
]

TERM_BLOCK = {
    "age": "curve", "size": "size", "usage": "usage", "grade": "grade", "attachments": "attachments",
    "emissions": "emissions", "wear": "wear", "spec": "spec", "seller": "seller", "verified": "verified",
    "origin": "brand", "brand": "brand", "brandInCategory": "brand", "region": "region", "time": "time",
    "monthsOnMarket": "listing", "completeness": "listing",
}

UNKNOWN = "unknown"
CENTRED = ["emissions", "spec", "seller", "origin", "region"]


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def shrink_to(value: float, n: float, parent: float, k: float) -> float:
    """Partial pooling; a group with no data is its parent."""
    if not (n > 0) or not _finite(value):
        return parent
    return (n / (n + k)) * value + (k / (n + k)) * parent


def slope(xs: list, ys: list, cap: int = 160) -> Optional[float]:
    """Theil-Sen on at most `cap` points, taken evenly."""
    if len(xs) <= cap:
        return theil_sen_slope(xs, ys)
    step = len(xs) / cap
    idx = [math.floor(i * step) for i in range(cap)]
    return theil_sen_slope([xs[j] for j in idx], [ys[j] for j in idx])



#: Rounds in which the curve shape λ is profiled; it is then held fixed, so it
#: cannot ratchet along the ridge it shares with the other age terms.
LAMBDA_ROUNDS = 5

#: Sale listings a category needs before α is estimated from sales alone.
MIN_SALE_FOR_ALPHA = 3


#: Rounds before the parameters start to be averaged (Polyak averaging).
BURN_IN = 15

#: Category fields that are data constants, not fitted parameters.
_CONSTANT_FIELDS = {"category", "family", "nSale", "nRent", "ageRef", "logSizeRef", "logSizeRange",
                    "annualHours", "sigmaSale", "sigmaRent", "lambda"}
_LEVEL_SETS = ["attachments", "emissions", "spec", "seller", "origin", "brand", "brandInCategory", "region"]


def _leaves(m: dict):
    """(container, key) of every fitted parameter, in a fixed order."""
    for name in sorted(m["categories"]):
        c = m["categories"][name]
        for key in sorted(c):
            if key not in _CONSTANT_FIELDS:
                yield c, key, f"c:{name}:{key}"
    for key in sorted(m["grade"]):
        yield m["grade"], key, f"g:{key}"
    for set_name in _LEVEL_SETS:
        for key in sorted(m[set_name]):
            yield m[set_name][key], "effect", f"{set_name}:{key}"
    yield m, "verified", "verified"
    for key in sorted(m["time"]):
        yield m["time"], key, f"t:{key}"
    for key in sorted(m["listing"]):
        yield m["listing"], key, f"l:{key}"


def _accumulate(total: dict, m: dict) -> None:
    for container, key, path in _leaves(m):
        total[path] = total.get(path, 0.0) + container[key]


def _apply_average(total: dict, count: int, m: dict) -> None:
    for container, key, path in _leaves(m):
        if path in total:
            container[key] = total[path] / count


def _refine(scores: list) -> float:
    """The λ minimising a profile scored on LAMBDA_GRID, refined by a parabola through the
    best grid point and its neighbours, so λ moves continuously rather than in steps."""
    best = min(range(len(scores)), key=lambda i: scores[i])
    lam = LAMBDA_GRID[best]
    if 0 < best < len(scores) - 1:
        s0, s1, s2 = scores[best - 1], scores[best], scores[best + 1]
        denom = s0 - 2 * s1 + s2
        h = LAMBDA_GRID[best + 1] - LAMBDA_GRID[best]
        if denom > 0:
            lam += clamp(h * (s0 - s2) / (2 * denom), -h, h)
    return lam


def _min_js(values: list) -> float:
    """JavaScript's Math.min: NaN if any value is NaN, +Infinity when empty."""
    if any(isinstance(v, float) and math.isnan(v) for v in values):
        return NAN
    return min(values) if values else math.inf


def _level_of(effects: dict, key) -> float:
    if not key:
        return 0.0
    entry = effects.get(key)
    return entry["effect"] if entry else 0.0


def _or_unknown(key):
    return key or UNKNOWN


class _Row:
    __slots__ = ("listing", "rent", "category", "y", "age", "log_size", "period")

    def __init__(self, listing: dict, as_of_year: int):
        self.listing = listing
        self.rent = listing["side"] == "rent"
        self.period = period_of(listing.get("period"))
        self.category = listing["category"]
        price = listing["price"]
        self.y = math.log(price / self.period) if self.rent else math.log(price)
        self.age = age_of(listing, as_of_year)
        size = listing.get("size")
        self.log_size = math.log(size) if size and size > 0 else None


def term_value(term: str, row: _Row, m: dict) -> float:
    """One term's contribution to a listing's log price, under the current parameters."""
    l = row.listing
    c = m["categories"][row.category]
    if term == "alpha":
        return c["alpha"]
    if term == "rent":
        return c["rentToValue"] if row.rent else 0.0
    if term == "age":
        if row.age is None:
            return 0.0
        return (c["depreciation"] / box_cox(m["horizon"], c["lambda"])) * (
            box_cox(row.age, c["lambda"]) - box_cox(c["ageRef"], c["lambda"]))
    if term == "size":
        if row.log_size is None or c["logSizeRef"] is None:
            return 0.0
        lo, hi = c["logSizeRange"] if c["logSizeRange"] else (-math.inf, math.inf)
        return c["sizeElasticity"] * (clamp(row.log_size, lo, hi) - c["logSizeRef"])
    if term == "usage":
        hours = l.get("hours")
        if hours is None or row.age is None:
            return 0.0
        return c["usage"] * usage_ratio(hours, row.age, c["annualHours"])
    if term == "new":
        return c["newPremium"] if l.get("condition") == "new" else 0.0
    if term == "wear":
        wear = l.get("wear")
        return 0.0 if wear is None else c["wear"] * (wear - 0.5)
    if term == "grade":
        g = l.get("grade")
        return m["grade"].get(str(g), 0.0) if g else 0.0
    if term == "attachments":
        total = 0.0
        for a in l.get("attachments") or []:
            total += _level_of(m["attachments"], a)
        return total
    if term in ("emissions", "spec", "seller", "origin", "region"):
        return _level_of(m[term], _or_unknown(l.get(term)))
    if term == "verified":
        return m["verified"] if l.get("verified") else 0.0
    if term == "brand":
        return _level_of(m["brand"], l.get("brand"))
    if term == "brandInCategory":
        brand = l.get("brand")
        return _level_of(m["brandInCategory"], f"{brand}|{row.category}") if brand else 0.0
    if term == "time":
        month = l.get("month")
        return 0.0 if month is None else m["time"].get(str(month), 0.0)
    if term == "monthsOnMarket":
        mom = l.get("monthsOnMarket")
        return m["listing"]["monthsOnMarket"] * math.log1p(mom) if mom else 0.0
    if term == "completeness":
        cp = l.get("completeness")
        return 0.0 if cp is None else m["listing"]["completeness"] * (cp - 0.5)
    if term == "duration":
        return c["duration"] * math.log(row.period / 30) if row.rent else 0.0
    if term == "operator":
        return c["operator"] if row.rent and l.get("operator") else 0.0
    raise ValueError(term)


def clean_listings(listings: list[dict]) -> list[dict]:
    """Drops non-positive prices and log prices more than 3.5 robust SDs from their group median."""
    groups: dict[str, list] = {}
    for listing in listings:
        if not (listing["price"] > 0):
            continue
        rent = listing["side"] == "rent"
        period = period_of(listing.get("period"))
        y = (math.log(listing["price"] / period) + 0.25 * math.log(period / 30)) if rent else math.log(listing["price"])
        groups.setdefault(f"{listing['category']}|{listing['side']}", []).append((listing, y))
    kept = []
    for group in groups.values():
        ys = [y for _, y in group]
        centre = median(ys)
        spread = robust_sigma(ys)
        for listing, y in group:
            if not _finite(spread) or spread == 0 or abs(y - centre) <= 3.5 * spread:
                kept.append(listing)
    return kept


def _empty_model(options: dict, disabled: list) -> dict:
    return {
        "version": SHERPA1_VERSION, "market": options["market"], "currency": options["currency"],
        "fittedAt": options.get("fittedAt", ""), "asOfYear": options["asOfYear"],
        "horizon": options.get("horizon", 10), "categories": {}, "grade": {"1": 0.0, "2": 0.0, "3": 0.0, "4": 0.0},
        "attachments": {}, "emissions": {}, "spec": {}, "seller": {}, "verified": 0.0, "origin": {}, "brand": {},
        "brandInCategory": {}, "region": {}, "time": {}, "listing": {"monthsOnMarket": 0.0, "completeness": 0.0},
        "conformal": {}, "listings": [], "disabled": disabled,
    }


def fit_core(listings_in: list[dict], options: dict) -> dict:
    """The point fit, without conformal calibration."""
    disabled = list(options.get("disable", []))
    off = lambda block: block in disabled  # noqa: E731
    K = {k: 0 for k in DEFAULT_K} if off("pooling") else {**DEFAULT_K, **options.get("k", {})}
    min_listings = options.get("minListings", 8)
    m = _empty_model(options, disabled)

    listings = clean_listings(listings_in)
    if off("rentSide"):
        listings = [l for l in listings if l["side"] == "sale"]
    counts: dict[str, int] = {}
    for l in listings:
        counts[l["category"]] = counts.get(l["category"], 0) + 1
    listings = [l for l in listings if counts.get(l["category"], 0) >= min_listings]
    rows = [_Row(l, options["asOfYear"]) for l in listings]
    m["listings"] = listings

    by_category: dict[str, list[_Row]] = {}
    for row in rows:
        by_category.setdefault(row.category, []).append(row)
    for category, group in by_category.items():
        sale = [r for r in group if not r.rent]
        rent = [r for r in group if r.rent]
        ages = [r.age for r in group if r.age is not None]
        sizes = [r.log_size for r in group if r.log_size is not None]
        per_year = [r.listing["hours"] / max(r.age, 0.5) for r in group
                    if r.listing.get("hours") and r.age is not None and r.age > 0]
        family = next((r.listing.get("family") for r in group if r.listing.get("family")), None) or category
        m["categories"][category] = {
            "category": category, "family": family, "nSale": len(sale), "nRent": len(rent),
            "alpha": median([r.y for r in (sale if sale else rent)]),
            "depreciation": -0.8, "lambda": 0.5, "ageRef": median(ages) if ages else 5,
            "logSizeRef": median(sizes) if len(sizes) >= 3 and not off("size") else None,
            "logSizeRange": [min(sizes), max(sizes)] if len(sizes) >= 3 else None,
            "sizeElasticity": 0.0,
            "annualHours": shrink_to(median(per_year), len(per_year), 1000, K["annualHours"]),
            "usage": 0.0, "newPremium": 0.0, "wear": 0.0,
            "rentToValue": (median([r.y for r in rent]) - median([r.y for r in sale])) if sale and rent else math.log(0.0015),
            "duration": -0.25, "operator": 0.0, "sigmaSale": 0.3, "sigmaRent": 0.3,
        }

    def is_active(term: str) -> bool:
        block = TERM_BLOCK.get(term)
        if block and off(block):
            return False
        if term == "time":
            return len({r.listing.get("month") for r in rows}) >= 6
        return True

    active = [t for t in TERMS if is_active(t)]
    contrib = [{t: term_value(t, row, m) for t in active} for row in rows]
    totals = []
    for values in contrib:
        s = 0.0
        for t in active:
            s += values.get(t, 0.0)
        totals.append(s)

    def refresh(term: str) -> None:
        for i, row in enumerate(rows):
            nxt = term_value(term, row, m)
            totals[i] += nxt - contrib[i].get(term, 0.0)
            contrib[i][term] = nxt

    def partial(i: int, term: str) -> float:
        return rows[i].y - totals[i] + contrib[i].get(term, 0.0)

    cat_index = {category: [i for i, r in enumerate(rows) if r.category == category] for category in by_category}
    #: The listings α is estimated from: sales where a category has at least MIN_SALE_FOR_ALPHA.
    alpha_index = {
        category: ([i for i in idx if not rows[i].rent]
                   if m["categories"][category]["nSale"] >= MIN_SALE_FOR_ALPHA else idx)
        for category, idx in cat_index.items()
    }

    def update_levels(term: str, key_of: Callable, k: float) -> dict:
        groups: dict[str, list] = {}
        for i, row in enumerate(rows):
            key = key_of(row)
            if not key:
                continue
            groups.setdefault(key, []).append(partial(i, term))
        return {key: {"effect": shrink_to(median(v), len(v), 0.0, k), "n": len(v)} for key, v in groups.items()}

    def update_slopes(term: str, x: Callable, keep: Callable, setter: Callable) -> None:
        raw = {}
        pooled_x, pooled_y = [], []
        for category, idx in cat_index.items():
            c = m["categories"][category]
            xs, ys = [], []
            for i in idx:
                if not keep(rows[i]):
                    continue
                value = x(rows[i], c)
                if value is None or not _finite(value):
                    continue
                xs.append(value)
                ys.append(partial(i, term))
            raw[category] = (slope(xs, ys), len(xs))
            centre = median(ys)
            for j, value in enumerate(xs):
                pooled_x.append(value)
                pooled_y.append(ys[j] - centre)
        pooled = slope(pooled_x, pooled_y, 300)
        pooled = 0.0 if pooled is None else pooled
        for category, (b, n) in raw.items():
            setter(m["categories"][category], pooled if b is None else b, pooled, 0 if b is None else n)

    rounds = options.get("rounds", 40)
    burn_in = options.get("burnIn", BURN_IN)
    average: dict = {}
    averaged_rounds = 0
    previous = list(totals)
    for round_ in range(rounds):
        for term in active:
            if term == "alpha":
                # Sale listings set α where a category has them; rental listings then
                # set π given α. Fitting α on both let α and π slide along a ridge.
                family_values: dict[str, list] = {}
                for category, idx in cat_index.items():
                    lst = family_values.setdefault(m["categories"][category]["family"], [])
                    lst.extend(partial(i, "alpha") for i in alpha_index[category])
                for category, idx in cat_index.items():
                    c = m["categories"][category]
                    own = [partial(i, "alpha") for i in alpha_index[category]]
                    c["alpha"] = shrink_to(median(own), len(own), median(family_values[c["family"]]), K["alpha"])
            elif term == "rent":
                raws = []
                for category, idx in cat_index.items():
                    c = m["categories"][category]
                    own = [partial(i, "rent") for i in idx if rows[i].rent]
                    raws.append((category, median(own), min(c["nSale"], len(own)) if c["nSale"] > 0 else 0))
                identified = [r for r in raws if r[2] > 0 and _finite(r[1])]
                pooled = median([r[1] for r in identified]) if identified else math.log(0.0015)
                for category, value, n in raws:
                    m["categories"][category]["rentToValue"] = shrink_to(value, n, pooled, K["rent"])
            elif term == "age":
                if round_ < LAMBDA_ROUNDS:
                  scores = {}
                  for category, idx in cat_index.items():
                      c = m["categories"][category]
                      used = [i for i in idx if rows[i].age is not None and rows[i].listing.get("condition") != "new"]
                      ys = [partial(i, "age") for i in used]
                      sc = []
                      for lam in LAMBDA_GRID:
                          xs = [box_cox(rows[i].age, lam) - box_cox(c["ageRef"], lam) for i in used]
                          b = slope(xs, ys)
                          b = min(0.0, 0.0 if b is None else b)
                          a = median([y - b * xs[j] for j, y in enumerate(ys)])
                          s = 0.0
                          for j, y in enumerate(ys):
                              s += abs(y - a - b * xs[j])
                          sc.append(s)
                      scores[category] = sc
                  pooled_score = []
                  for g in range(len(LAMBDA_GRID)):
                      s = 0.0
                      for sc in scores.values():
                          v = sc[g]
                          s += v if (_finite(v) and v != 0) else 0.0
                      pooled_score.append(s)
                  lambda0 = _refine(pooled_score)
                  for category, idx in cat_index.items():
                      sc = scores[category]
                      best = _min_js(sc)
                      n = len([i for i in idx if rows[i].age is not None]) if _finite(best) else 0
                      raw_l = _refine(sc) if _finite(best) else lambda0
                      m["categories"][category]["lambda"] = clamp(shrink_to(raw_l, n, lambda0, K["lambda"]), -1, 1)

                def set_age(c, b, pooled, n):
                    g = box_cox(m["horizon"], c["lambda"])
                    pooled_d = clamp(pooled * g, -2, -0.3)
                    c["depreciation"] = clamp(shrink_to(b * g, n, pooled_d, K["slope"]), -3, -0.05)

                update_slopes(
                    "age",
                    lambda row, c: None if row.age is None else box_cox(row.age, c["lambda"]) - box_cox(c["ageRef"], c["lambda"]),
                    lambda row: row.age is not None and row.listing.get("condition") != "new",
                    set_age,
                )
            elif term == "size":
                def set_size(c, b, pooled, n):
                    c["sizeElasticity"] = 0.0 if c["logSizeRef"] is None else clamp(
                        shrink_to(b, n, clamp(pooled, 0, 1.5), K["slope"]), 0, 1.5)

                update_slopes(
                    "size",
                    lambda row, c: None if row.log_size is None or c["logSizeRef"] is None else row.log_size - c["logSizeRef"],
                    lambda row: True,
                    set_size,
                )
            elif term == "usage":
                def set_usage(c, b, pooled, n):
                    c["usage"] = clamp(shrink_to(b, n, clamp(pooled, -0.6, 0), K["slope"]), -1, 0)

                update_slopes(
                    "usage",
                    lambda row, c: None if row.listing.get("hours") is None or row.age is None
                    else usage_ratio(row.listing["hours"], row.age, c["annualHours"]),
                    lambda row: True,
                    set_usage,
                )
            elif term == "wear":
                def set_wear(c, b, pooled, n):
                    c["wear"] = clamp(shrink_to(b, n, clamp(pooled, 0, 1.5), K["slope"]), 0, 1.5)

                update_slopes(
                    "wear",
                    lambda row, c: None if row.listing.get("wear") is None else row.listing["wear"] - 0.5,
                    lambda row: True,
                    set_wear,
                )
            elif term == "new":
                raws = []
                for category, idx in cat_index.items():
                    own = [partial(i, "new") for i in idx if rows[i].listing.get("condition") == "new"]
                    raws.append((category, median(own), len(own)))
                known = [r for r in raws if r[2] > 0]
                pooled = clamp(median([r[1] for r in known]), 0, 0.6) if known else 0.15
                for category, value, n in raws:
                    m["categories"][category]["newPremium"] = clamp(shrink_to(value, n, pooled, K["newPremium"]), 0, 0.8)
            elif term == "grade":
                effects = update_levels("grade", lambda row: str(row.listing["grade"]) if row.listing.get("grade") else None, K["grade"])

                def g(key):
                    return effects[key]["effect"] if key in effects else 0.0

                g4 = max(0.0, g("4") - g("3"))
                g2 = min(0.0, g("2") - g("3"))
                g1 = min(g2, g("1") - g("3"))
                m["grade"] = {"1": g1, "2": g2, "3": 0.0, "4": g4}
            elif term == "attachments":
                types = []
                for r in rows:
                    for a in r.listing.get("attachments") or []:
                        if a not in types:
                            types.append(a)
                effects = {}
                for t in types:
                    values = []
                    for i, row in enumerate(rows):
                        if t in (row.listing.get("attachments") or []):
                            values.append(partial(i, "attachments") - contrib[i].get("attachments", 0.0)
                                          + _level_of(m["attachments"], t))
                    effects[t] = {"effect": clamp(shrink_to(median(values), len(values), 0.0, K["attachment"]), 0, 1),
                                  "n": len(values)}
                m["attachments"] = effects
            elif term in ("emissions", "spec", "seller"):
                m[term] = update_levels(term, lambda row, t=term: _or_unknown(row.listing.get(t)), K["level"])
            elif term == "verified":
                values = [partial(i, "verified") for i, row in enumerate(rows) if row.listing.get("verified")]
                m["verified"] = clamp(shrink_to(median(values), len(values), 0.0, K["level"]), 0, 0.5)
            elif term == "origin":
                m["origin"] = update_levels("origin", lambda row: _or_unknown(row.listing.get("origin")), K["origin"])
            elif term == "brand":
                m["brand"] = update_levels("brand", lambda row: row.listing.get("brand"), K["brand"])
            elif term == "brandInCategory":
                m["brandInCategory"] = update_levels(
                    "brandInCategory",
                    lambda row: f"{row.listing['brand']}|{row.category}" if row.listing.get("brand") else None,
                    K["brandInCategory"],
                )
            elif term == "region":
                m["region"] = update_levels("region", lambda row: _or_unknown(row.listing.get("region")), K["region"])
            elif term == "time":
                effects = update_levels(
                    "time", lambda row: None if row.listing.get("month") is None else str(row.listing["month"]), K["time"])
                months = sorted(int(k) for k in effects)
                values = [effects[str(mo)]["effect"] for mo in months]
                for _pass in range(2):
                    values = [
                        0.25 * (values[j - 1] if j > 0 else v) + 0.5 * v + 0.25 * (values[j + 1] if j < len(values) - 1 else v)
                        for j, v in enumerate(values)
                    ]
                latest = values[-1] if values else 0.0
                m["time"] = {str(mo): values[j] - latest for j, mo in enumerate(months)}
                for c in m["categories"].values():
                    c["alpha"] += latest
                refresh("alpha")
            elif term == "monthsOnMarket":
                xs, ys = [], []
                for i, row in enumerate(rows):
                    mom = row.listing.get("monthsOnMarket")
                    if mom is None:
                        continue
                    xs.append(math.log1p(mom))
                    ys.append(partial(i, "monthsOnMarket"))
                b = slope(xs, ys, 300)
                m["listing"]["monthsOnMarket"] = clamp(shrink_to(0.0 if b is None else b, len(xs), 0.0, K["listing"]), -0.2, 0.3)
            elif term == "completeness":
                xs, ys = [], []
                for i, row in enumerate(rows):
                    cp = row.listing.get("completeness")
                    if cp is None:
                        continue
                    xs.append(cp - 0.5)
                    ys.append(partial(i, "completeness"))
                b = slope(xs, ys, 300)
                m["listing"]["completeness"] = clamp(shrink_to(0.0 if b is None else b, len(xs), 0.0, K["listing"]), -0.2, 0.5)
            elif term == "duration":
                def set_duration(c, b, pooled, n):
                    c["duration"] = clamp(shrink_to(b, n, clamp(pooled, -0.8, 0), K["rent"]), -1, 0)

                update_slopes("duration", lambda row, c: math.log(row.period / 30), lambda row: row.rent, set_duration)
            elif term == "operator":
                raws = []
                for category, idx in cat_index.items():
                    own = [partial(i, "operator") for i in idx if rows[i].rent and rows[i].listing.get("operator")]
                    raws.append((category, median(own), len(own)))
                known = [r for r in raws if r[2] > 0]
                pooled = clamp(median([r[1] for r in known]), 0, 1) if known else 0.0
                for category, value, n in raws:
                    m["categories"][category]["operator"] = clamp(shrink_to(value, n, pooled, K["rent"]), 0, 1)
            refresh(term)

        # Centre the reference-free sets on the average listing; α takes the shift.
        any_centred = False
        for name in CENTRED:
            if name not in active:
                continue
            any_centred = True
            effects = m[name]
            n = sum(e["n"] for e in effects.values())
            if not n:
                continue
            mean = sum(e["n"] * e["effect"] for e in effects.values()) / n
            for e in effects.values():
                e["effect"] -= mean
            for c in m["categories"].values():
                c["alpha"] += mean
            refresh(name)
        if any_centred:
            refresh("alpha")
        current = list(totals)
        change = max([0.0] + [abs(v - previous[i]) for i, v in enumerate(current)])
        previous = current
        if change < 1e-4:
            break
        if round_ >= burn_in:
            _accumulate(average, m)
            averaged_rounds += 1

    # Polyak averaging: the median updates wander around the fixed point rather
    # than settle on it, so the model is the average of the rounds after the
    # burn-in. With the parameters set to that average, every term is refreshed.
    if averaged_rounds:
        _apply_average(average, averaged_rounds, m)
        for term in active:
            refresh(term)

    for side in ("sale", "rent"):
        all_res = [row.y - totals[i] for i, row in enumerate(rows) if ("rent" if row.rent else "sale") == side]
        rs = robust_sigma(all_res)
        pooled = max(0.1, rs if (_finite(rs) and rs != 0) else 0.4)
        for category, idx in cat_index.items():
            own = [rows[i].y - totals[i] for i in idx if ("rent" if rows[i].rent else "sale") == side]
            sigma = max(0.1, shrink_to(robust_sigma(own), len(own), pooled, K["sigma"]))
            m["categories"][category]["sigmaSale" if side == "sale" else "sigmaRent"] = sigma
    return m


def predict_listing(m: dict, listing: dict, with_listing_terms: bool = True) -> Optional[float]:
    """Log price (sale) or log rate per day (rent) a fitted model predicts for a listing."""
    if listing["category"] not in m["categories"]:
        return None
    row = _Row({**listing, "price": 1}, m["asOfYear"])
    total = 0.0
    for term in TERMS:
        block = TERM_BLOCK.get(term)
        if block and block in m["disabled"]:
            continue
        if not with_listing_terms and term in ("monthsOnMarket", "completeness", "time"):
            continue
        total += term_value(term, row, m)
    return total


def missing_inputs(m: dict, listing: dict) -> list[str]:
    """Inputs that move the price and are missing."""
    c = m["categories"].get(listing["category"])
    missing = []
    if age_of(listing, m["asOfYear"]) is None:
        missing.append("year")
    if c is not None and c["logSizeRef"] is not None and not listing.get("size"):
        missing.append("size")
    if listing.get("hours") is None:
        missing.append("hours")
    if not listing.get("grade"):
        missing.append("grade")
    return missing


def _missing_bin(count: int) -> str:
    return "0" if count == 0 else "1" if count == 1 else "2+"


def _conformal_quantile(scores: list, level: float) -> float:
    s = sorted(scores)
    rank = min(len(s), math.ceil((len(s) + 1) * level))
    return s[rank - 1]


def _fold_of(listing_id, folds: int) -> int:
    """FNV-1a over the id's characters, as in the TypeScript version."""
    h = 2166136261
    for ch in str(listing_id):
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h % folds


def fit_sherpa(listings: list[dict], options: dict) -> dict:
    """Fits SHERPA-1: the point model on all listings, intervals by cross-conformal calibration."""
    model = fit_core(listings, options)
    folds = options.get("folds", 5)
    levels = options.get("levels", [0.5, 0.8])
    if "conformal" in model["disabled"] or folds < 2:
        return model
    scores: dict[str, list] = {}
    cleaned = model["listings"]
    for f in range(folds):
        train = [l for l in cleaned if _fold_of(l["id"], folds) != f]
        test = [l for l in cleaned if _fold_of(l["id"], folds) == f]
        fitted = fit_core(train, {**options, "folds": 0})
        for l in test:
            predicted = predict_listing(fitted, l)
            if predicted is None:
                continue
            c = fitted["categories"][l["category"]]
            rent = l["side"] == "rent"
            y = math.log(l["price"] / period_of(l.get("period"))) if rent else math.log(l["price"])
            score = abs(y - predicted) / (c["sigmaRent"] if rent else c["sigmaSale"])
            scores.setdefault(f"{l['side']}:{_missing_bin(len(missing_inputs(fitted, l)))}", []).append(score)
            scores.setdefault(f"{l['side']}:all", []).append(score)
    for key, lst in scores.items():
        q = {str(level): _conformal_quantile(lst, level) for level in levels}
        q["n"] = len(lst)
        model["conformal"][key] = q
    return model
