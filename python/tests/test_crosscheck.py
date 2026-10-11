"""The Python port must agree with the TypeScript package.

test/fixtures/crosscheck.json holds a synthetic market and the TypeScript fits
of it (npm run fixtures). Python regenerates the market from the same seed and
fits it with the same options.

- The first rounds of backfitting must match to the last digit: that shows the
  two implementations run the same algorithm.
- After that, V8 and CPython differ in the last digits of pow and log, and the
  median updates amplify such differences about as much as they amplify any
  1e-9 change to the input prices. The full fit is therefore compared on its
  predictions, within the method's own numerical sensitivity.
"""

import json
import math
from pathlib import Path

import pytest

from sherpa_valuation import estimate_sherpa, fit_core, fit_sherpa, predict_listing, synthetic_market

FIXTURE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "crosscheck.json"


@pytest.fixture(scope="module")
def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def listings():
    return synthetic_market(sale=60, rent=60, seed=5)[0]


@pytest.fixture(scope="module")
def model(fixture, listings):
    return fit_sherpa(listings, fixture["options"])


def close(a, b, path="", tol=1e-9):
    """Deep comparison with a numeric tolerance."""
    if isinstance(a, dict):
        assert set(a) == set(b), f"{path}: keys {sorted(set(a) ^ set(b))}"
        for k in a:
            close(a[k], b[k], f"{path}.{k}", tol)
    elif isinstance(a, list):
        assert len(a) == len(b), f"{path}: length {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            close(x, y, f"{path}[{i}]", tol)
    elif isinstance(a, (int, float)) and not isinstance(a, bool) and b is not None:
        assert math.isclose(a, b, rel_tol=tol, abs_tol=tol), f"{path}: {a} != {b}"
    else:
        assert a == b, f"{path}: {a!r} != {b!r}"


def test_same_synthetic_market(fixture, listings):
    close(listings, fixture["listings"], "listings")


def test_same_algorithm_to_the_last_digit(fixture, listings):
    early = fit_core(listings, {**fixture["options"], "rounds": 3})
    early.pop("listings")
    close(early, fixture["early"], "model")


def test_same_predictions_within_numerical_sensitivity(fixture, model):
    diffs = sorted(abs(predict_listing(model, l) - fixture["predictions"][str(l["id"])]) for l in model["listings"])
    assert len(diffs) == len(fixture["predictions"])
    assert diffs[len(diffs) // 2] < 0.01, f"median log difference {diffs[len(diffs) // 2]:.4f}"
    assert diffs[-1] < 0.05, f"largest log difference {diffs[-1]:.4f}"


def test_same_estimate_within_numerical_sensitivity(fixture, model):
    e = estimate_sherpa(model, fixture["machine"], operator=True)
    assert e["missing"] == fixture["estimate"]["missing"]
    ts = fixture["estimate"]
    assert abs(e["value"]["typical"] / ts["value"]["typical"] - 1) < 0.03
    for period in ("daily", "weekly", "monthly"):
        assert abs(e["rates"][period]["typical"] / ts["rates"][period]["typical"] - 1) < 0.03
