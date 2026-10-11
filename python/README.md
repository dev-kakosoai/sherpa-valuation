# sherpa-valuation (Python)

Python port of **SHERPA** - *Shrinkage-based Heavy Equipment Residual Price Analysis*: an
explainable model of what a used heavy machine is worth and what it rents for, fitted from
marketplace listings. No dependencies beyond the standard library.

Listings and fitted models are plain dicts with the same keys as the TypeScript package
[`@equipmentsfinder/sherpa`](https://github.com/dev-kakosoai/sherpa-valuation), so data and
models move between the two as JSON. A cross-language test keeps the implementations in step.

```bash
pip install sherpa-valuation
```

```python
from sherpa_valuation import synthetic_market, fit_sherpa, estimate_sherpa

listings, truth = synthetic_market(sale=120, rent=120, seed=1)  # or your own listings
model = fit_sherpa(listings, {"market": "XX", "currency": "USD", "asOfYear": 2026})

estimate_sherpa(model, {
    "category": "excavators", "brand": "Alpha", "origin": "japan",
    "year": 2016, "size": 20, "hours": 9000, "grade": 3, "attachments": ["breaker"],
})
# {'value': {'low', 'typical', 'high'}, 'rates': {'daily', 'weekly', 'monthly'},
#  'monthlyYield', 'paybackMonths', 'confidence', 'factors', 'missing', 'comparables'}
```

The model is specified in [docs/MODEL.md](https://github.com/dev-kakosoai/sherpa-valuation/blob/main/docs/MODEL.md).

Built and maintained by [EquipmentsFinder](https://www.equipmentsfinder.com), the
heavy-equipment marketplace for the UAE and Saudi Arabia; the model was designed around the
listings on [equipmentsfinder.com](https://www.equipmentsfinder.com). Apache License 2.0.
