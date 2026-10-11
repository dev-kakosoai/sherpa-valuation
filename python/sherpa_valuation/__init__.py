"""SHERPA - Shrinkage-based Heavy Equipment Residual Price Analysis.

An explainable model of what a used heavy machine is worth and what it rents
for, fitted from marketplace listings. Python port of the TypeScript package
@equipmentsfinder/sherpa; listings and models are plain dicts with the same
keys in both languages.
"""

from .estimate import distance, estimate_sherpa
from .features import LAMBDA_GRID, age_of, box_cox, period_of, usage_ratio
from .fit import SHERPA1_VERSION, clean_listings, fit_core, fit_sherpa, missing_inputs, predict_listing
from .stats import median, robust_sigma, round_price, theil_sen_slope
from .synthetic import SYNTHETIC_TRUTH, synthetic_market, true_log_value

__version__ = "0.1.0"

__all__ = [
    "SHERPA1_VERSION", "SYNTHETIC_TRUTH", "LAMBDA_GRID", "age_of", "box_cox", "clean_listings", "distance",
    "estimate_sherpa", "fit_core", "fit_sherpa", "median", "missing_inputs", "period_of", "predict_listing",
    "robust_sigma", "round_price", "synthetic_market", "theil_sen_slope", "true_log_value", "usage_ratio",
]
