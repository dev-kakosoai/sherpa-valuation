"""SHERPA-1 - estimating one machine (a port of src/sherpa1/estimate.ts; docs/MODEL.md §6-7)."""

from __future__ import annotations

import math
from typing import Optional

from .features import age_of
from .fit import _Row, missing_inputs, predict_listing, term_value
from .stats import round_price

NORMAL = {"0.5": 0.6745, "0.8": 1.2816, "0.9": 1.6449}

FACTOR_TERMS = [
    ("age", "age"), ("size", "size"), ("usage", "usage"), ("new", "condition"), ("grade", "grade"),
    ("attachments", "attachments"), ("emissions", "emissions"), ("wear", "wear"), ("spec", "spec"),
    ("seller", "seller"), ("verified", "verified"), ("origin", "brand"), ("brand", "brand"),
    ("brandInCategory", "brand"), ("region", "region"),
]


def _score_quantile(m: dict, side: str, missing: int, level: float) -> float:
    key = str(level)
    bin_ = "0" if missing == 0 else "1" if missing == 1 else "2+"
    own = m["conformal"].get(f"{side}:{bin_}")
    if own and own.get("n", 0) >= 20 and key in own:
        return own[key]
    all_ = m["conformal"].get(f"{side}:all")
    if all_ and key in all_:
        return all_[key]
    return NORMAL.get(key, 0.6745) * (1 + missing / 3)


def _interval(log_typical: float, half_width: float, scale: float = 1) -> dict:
    return {
        "low": round_price(math.exp(log_typical - half_width) * scale),
        "typical": round_price(math.exp(log_typical) * scale),
        "high": round_price(math.exp(log_typical + half_width) * scale),
    }


def distance(machine: dict, listing: dict, as_of_year: int) -> float:
    """Distance between a machine and a listing: age, size, brand, grade and seller."""
    total = 0.0
    a, b = age_of(machine, as_of_year), age_of(listing, as_of_year)
    total += abs(a - b) / 5 if a is not None and b is not None else 0.5
    ms, ls = machine.get("size"), listing.get("size")
    total += abs(math.log(ms / ls)) / 0.5 if ms and ls else 0.5
    if machine.get("brand"):
        total += 0 if listing.get("brand") == machine["brand"] else 0.7 if listing.get("brand") else 0.35
    if machine.get("grade"):
        total += abs(machine["grade"] - listing["grade"]) * 0.3 if listing.get("grade") else 0.15
    if machine.get("seller"):
        total += 0 if listing.get("seller") == machine["seller"] else 0.3
    return total


def estimate_sherpa(m: dict, machine: dict, level: float = 0.5, operator: bool = False,
                    comparables: int = 6) -> Optional[dict]:
    """Value, a daily/weekly/monthly rate card, yield, payback, factors and comparables."""
    c = m["categories"].get(machine["category"])
    if c is None:
        return None
    as_sale = {**machine, "id": "input", "side": "sale", "price": 1}
    log_value = predict_listing(m, as_sale, False)
    missing = missing_inputs(m, as_sale)
    value = _interval(log_value, _score_quantile(m, "sale", len(missing), level) * c["sigmaSale"])

    rates = None
    if "rentSide" not in m["disabled"]:
        def rate(period: int) -> dict:
            as_rent = {**machine, "id": "input", "side": "rent", "price": 1, "period": period, "operator": operator}
            log_rate = predict_listing(m, as_rent, False)
            return _interval(log_rate, _score_quantile(m, "rent", len(missing), level) * c["sigmaRent"], period)

        rates = {"daily": rate(1), "weekly": rate(7), "monthly": rate(30)}
    monthly_yield = rates["monthly"]["typical"] / value["typical"] if rates else None

    row = _Row(as_sale, m["asOfYear"])
    merged: dict[str, float] = {}
    for term, key in FACTOR_TERMS:
        # An input left out keeps the "unknown" level in the price, but is not shown as a factor.
        if term in ("emissions", "spec", "seller", "origin", "region") and not machine.get(term):
            continue
        effect = term_value(term, row, m)
        if abs(effect) > 1e-6:
            merged[key] = merged.get(key, 0.0) + effect
    factors = [{"key": k, "multiplier": math.exp(e)} for k, e in merged.items() if abs(e) > 0.005]

    n = c["nSale"] + c["nRent"]
    confidence = "high" if n >= 30 and len(missing) <= 1 else "medium" if n >= 12 and len(missing) <= 2 else "low"
    nearest = sorted(
        (l for l in m["listings"] if l["category"] == machine["category"]),
        key=lambda l: distance(machine, l, m["asOfYear"]),
    )[:comparables]
    return {
        "category": machine["category"], "level": level, "value": value, "rates": rates,
        "monthlyYield": monthly_yield, "paybackMonths": 1 / monthly_yield if monthly_yield else None,
        "confidence": confidence, "factors": factors, "missing": missing, "comparables": nearest,
    }
