"""The transforms of docs/MODEL.md §3.1 (a port of src/sherpa1/features.ts)."""

from __future__ import annotations

import math
from typing import Optional

#: Smoothing constant of the usage ratio, in hours.
USAGE_H0 = 250

#: The grid the curve shape λ is profiled over.
LAMBDA_GRID = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]


def box_cox(age: float, lam: float) -> float:
    """Box-Cox depreciation curve: ((1 + a)^λ − 1) / λ, and log(1 + a) at λ = 0."""
    a = max(0.0, age)
    return math.log1p(a) if abs(lam) < 1e-6 else ((1 + a) ** lam - 1) / lam


def usage_ratio(hours: float, age: float, annual_hours: float) -> float:
    """Usage relative to age: 0 is normal for the age, log 2 twice as hard as normal."""
    return math.log((hours + USAGE_H0) / (annual_hours * max(age, 0.5) + USAGE_H0))


def age_of(machine: dict, as_of_year: int) -> Optional[float]:
    """Age in years; a new machine without a year is taken as age 0."""
    year = machine.get("year")
    if year is not None:
        return max(0, as_of_year - year)
    return 0 if machine.get("condition") == "new" else None


def period_of(period) -> float:
    """Days a rental period covers; a missing period is a monthly rate."""
    return period if period and period > 0 else 30
