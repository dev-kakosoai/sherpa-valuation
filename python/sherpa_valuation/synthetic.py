"""Synthetic markets with known parameters (a port of src/sherpa1/synthetic.ts).

The random stream is the same linear congruential generator as the TypeScript
version, consumed in the same order, so a seed gives the same listings in both
languages - which is what the cross-language test relies on.
"""

from __future__ import annotations

import copy
import math
from typing import Callable

from .features import box_cox, usage_ratio
from .stats import js_round

SYNTHETIC_TRUTH: dict = {
    "horizon": 10,
    "categories": [
        dict(category="excavators", family="earthmoving", basePrice=300_000, ageRef=6, depreciation=-0.9, lambda_=0.4,
             sizes=[1.8, 3, 5.5, 8, 14, 20, 22, 30, 36, 45], sizeRef=20, sizeElasticity=0.7, annualHours=1200,
             usage=-0.15, newPremium=0.2, wear=0.3, rentToValue=math.log(0.0013), duration=-0.25, operator=0.35, sigma=0.22),
        dict(category="wheel-loaders", family="earthmoving", basePrice=260_000, ageRef=7, depreciation=-0.8, lambda_=0.6,
             sizes=[8, 12, 15, 18, 22, 28], sizeRef=18, sizeElasticity=0.6, annualHours=1300,
             usage=-0.12, newPremium=0.18, wear=0.25, rentToValue=math.log(0.0012), duration=-0.22, operator=0.3, sigma=0.24),
        dict(category="cranes", family="lifting", basePrice=900_000, ageRef=9, depreciation=-0.7, lambda_=0.8,
             sizes=[25, 40, 50, 80, 100, 160, 250], sizeRef=80, sizeElasticity=0.8, annualHours=900,
             usage=-0.1, newPremium=0.15, wear=0.15, rentToValue=math.log(0.0011), duration=-0.3, operator=0.25, sigma=0.26),
        dict(category="generators", family="power", basePrice=60_000, ageRef=5, depreciation=-1.1, lambda_=0.1,
             sizes=[20, 60, 100, 250, 500, 800, 1250], sizeRef=250, sizeElasticity=0.55, annualHours=2500,
             usage=-0.2, newPremium=0.22, wear=0, rentToValue=math.log(0.0025), duration=-0.35, operator=0, sigma=0.28),
        dict(category="compactors", family="earthmoving", basePrice=45_000, ageRef=6, depreciation=-0.85, lambda_=0.5,
             sizes=None, sizeRef=None, sizeElasticity=0, annualHours=800,
             usage=-0.1, newPremium=0.15, wear=0.2, rentToValue=math.log(0.0018), duration=-0.28, operator=0.2, sigma=0.3),
    ],
    "grade": {1: -0.45, 2: -0.18, 3: 0, 4: 0.12},
    "attachments": {"bucket": 0.03, "breaker": 0.1, "coupler": 0.04, "forks": 0.05},
    "emissions": {"tier2": -0.1, "tier3": 0, "tier4i": 0.05, "tier4f": 0.1},
    "spec": {"local": 0.05, "imported": -0.05},
    "seller": {"dealer": 0.1, "rental": -0.04, "private": -0.06},
    "verified": 0.06,
    "origin": {"japan": 0.08, "europe": 0.06, "usa": 0.05, "korea": -0.03, "china": -0.2},
    "brands": {
        "Alpha": {"origin": "japan", "effect": 0.05},
        "Bravo": {"origin": "japan", "effect": -0.02},
        "Charlie": {"origin": "europe", "effect": 0.04},
        "Delta": {"origin": "usa", "effect": 0.06},
        "Echo": {"origin": "korea", "effect": 0},
        "Foxtrot": {"origin": "china", "effect": 0.05},
        "Golf": {"origin": "china", "effect": -0.08},
        "Hotel": {"origin": "europe", "effect": -0.03},
    },
    "region": {"north": 0.04, "central": 0, "south": -0.05},
    "timeTrend": 0.004,
    "monthsOnMarket": 0.04,
    "completeness": 0.08,
}


def _uniform(seed: int) -> Callable[[], float]:
    state = (seed & 0xFFFFFFFF) or 1

    def next_() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return (state + 1) / 4294967297

    return next_


def true_log_value(truth: dict, listing: dict, age: float, hours: float) -> float:
    """The log value the truth assigns to a machine, before listing terms and noise."""
    c = next(x for x in truth["categories"] if x["category"] == listing["category"])
    ref = box_cox(c["ageRef"], c["lambda_"])
    beta = c["depreciation"] / box_cox(truth["horizon"], c["lambda_"])
    v = math.log(c["basePrice"]) + beta * (box_cox(age, c["lambda_"]) - ref)
    if c["sizeRef"] and listing.get("size"):
        v += c["sizeElasticity"] * math.log(listing["size"] / c["sizeRef"])
    v += c["usage"] * usage_ratio(hours, age, c["annualHours"])
    if listing.get("condition") == "new":
        v += c["newPremium"]
    if listing.get("wear") is not None:
        v += c["wear"] * (listing["wear"] - 0.5)
    return v


def synthetic_market(sale: int = 120, rent: int = 120, seed: int = 1, as_of_year: int = 2026, months: int = 24,
                     missing: float = 0.2, bad_price: float = 0.02, truth: dict | None = None) -> tuple[list[dict], dict]:
    """Sale and rental listings drawn from the model with known parameters, made messy."""
    truth = copy.deepcopy(SYNTHETIC_TRUTH) if truth is None else truth
    random = _uniform(seed)

    def gaussian() -> float:
        a = math.sqrt(-2 * math.log(random()))
        return a * math.cos(2 * math.pi * random())

    def pick(seq):
        return seq[math.floor(random() * len(seq))]

    def maybe(value):
        return None if random() < missing else value

    brand_names = list(truth["brands"])
    attachment_names = list(truth["attachments"])
    regions = list(truth["region"])
    sellers = list(truth["seller"])
    emissions = list(truth["emissions"])
    specs = list(truth["spec"])
    periods = [1, 7, 30]

    listings: list[dict] = []
    next_id = 1
    for c in truth["categories"]:
        for side in ("sale", "rent"):
            count = sale if side == "sale" else rent
            for _ in range(count):
                is_new = side == "sale" and random() < 0.12
                age = 0 if is_new else 1 + math.floor(random() * 15)
                hours = js_round(c["annualHours"] * age * math.exp(0.5 * gaussian()))
                brand = pick(brand_names)
                grade = 4 if is_new else pick([1, 2, 3, 3, 3, 4])
                attachments = [a for a in attachment_names if random() < 0.25]
                month = -math.floor(random() * months)
                months_on_market = math.floor(random() * 8)
                completeness = js_round(random() * 100) / 100
                listing = {
                    "id": next_id,
                    "side": side,
                    "category": c["category"],
                    "family": c["family"],
                    "brand": brand,
                    "origin": truth["brands"][brand]["origin"],
                    "year": as_of_year - age,
                    "size": pick(c["sizes"]) if c["sizes"] else None,
                    "hours": hours,
                    "condition": "new" if is_new else "used",
                    "grade": grade,
                    "attachments": attachments,
                    "emissions": pick(emissions),
                    "wear": js_round((0.2 + 0.8 * random()) * 100) / 100,
                    "spec": pick(specs),
                    "seller": ("rental" if random() < 0.8 else "dealer") if side == "rent" else pick(sellers),
                    "verified": random() < 0.3,
                    "region": pick(regions),
                    "price": 0,
                    "month": month,
                    "monthsOnMarket": months_on_market,
                    "completeness": completeness,
                }
                next_id += 1
                log = true_log_value(truth, listing, age, hours)
                log += truth["grade"][grade]
                for a in attachments:
                    log += truth["attachments"][a]
                log += truth["emissions"][listing["emissions"]]
                log += truth["spec"][listing["spec"]]
                log += truth["seller"][listing["seller"]]
                if listing["verified"]:
                    log += truth["verified"]
                log += truth["origin"][listing["origin"]] + truth["brands"][brand]["effect"]
                log += truth["region"][listing["region"]]
                log += truth["timeTrend"] * month
                log += truth["monthsOnMarket"] * math.log1p(months_on_market)
                log += truth["completeness"] * (completeness - 0.5)
                if side == "rent":
                    period = pick(periods)
                    operator = random() < 0.3
                    log += c["rentToValue"] + c["duration"] * math.log(period / 30)
                    if operator:
                        log += c["operator"]
                    listing["period"] = period
                    listing["operator"] = operator
                    listing["price"] = js_round(math.exp(log + c["sigma"] * gaussian()) * period)
                else:
                    listing["price"] = js_round(math.exp(log + c["sigma"] * gaussian()) / 100) * 100
                roll = random()
                if roll < bad_price / 2:
                    listing["price"] *= 1000
                elif roll < bad_price:
                    listing["price"] = max(1, js_round(listing["price"] / 1000))

                # Marketplace data: most optional fields are often empty.
                if is_new and random() < 0.5:
                    listing["year"] = None
                else:
                    listing["year"] = maybe(listing["year"])
                listing["size"] = None if listing["size"] is None else maybe(listing["size"])
                listing["hours"] = None if random() < 0.5 else listing["hours"]
                listing["grade"] = maybe(listing["grade"])
                listing["emissions"] = None if random() < 0.6 else listing["emissions"]
                listing["wear"] = None if random() < 0.6 else listing["wear"]
                listing["spec"] = maybe(listing["spec"])
                listing["seller"] = maybe(listing["seller"])
                listing["region"] = maybe(listing["region"])
                listings.append(listing)
    return listings, truth
