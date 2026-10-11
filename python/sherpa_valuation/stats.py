"""Robust statistics shared by the fit and the estimate (a port of src/stats.ts)."""

from __future__ import annotations

import math
from typing import Optional, Sequence

NAN = float("nan")

#: The inverse of the standard normal CDF at 0.75: half the width of a 50% interval.
Z50 = 0.6744897501960817


def median(values: Sequence[float]) -> float:
    if len(values) == 0:
        return NAN
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def robust_sigma(values: Sequence[float]) -> float:
    """Median absolute deviation, scaled to estimate a normal standard deviation."""
    if len(values) < 2:
        return NAN
    centre = median(values)
    return 1.4826 * median([abs(v - centre) for v in values])


def theil_sen_slope(xs: Sequence[float], ys: Sequence[float]) -> Optional[float]:
    """Median of the slopes between every pair of points with different x."""
    slopes = []
    n = len(xs)
    for i in range(n):
        xi, yi = xs[i], ys[i]
        for j in range(i + 1, n):
            dx = xs[j] - xi
            if abs(dx) > 1e-9:
                slopes.append((ys[j] - yi) / dx)
    return median(slopes) if n >= 3 and slopes else None


def js_round(x: float) -> int:
    """JavaScript's Math.round: halves round up, unlike Python's round()."""
    return math.floor(x + 0.5)


def round_price(value: float) -> int:
    """A price a person would write: 1,240 -> 1,250; 18,730 -> 18,750; 263,000 -> 265,000."""
    step = 50 if value < 2_000 else 250 if value < 20_000 else 1_000 if value < 200_000 else 5_000
    return max(step, js_round(value / step) * step)


def is_finite(x) -> bool:
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x)
