export * from './types.js';
export { median, quantile, robustSigma, theilSenSlope, shrink, Z50 } from './stats.js';
export {
  extractYear,
  extractSize,
  extractHours,
  extractMachineSize,
  excavatorClassFromModel,
} from './extract.js';
export { cleanListings, fitPriceModel, ageOf, type FitOptions } from './fit.js';
export { estimatePrice, roundPrice, distance } from './estimate.js';
export { leaveOneOut, type Evaluation } from './evaluate.js';
export {
  syntheticMarket,
  syntheticUnit,
  SYNTHETIC_CATEGORIES,
  type SyntheticCategory,
  type SyntheticOptions,
} from './synthetic.js';

/**
 * Changes whenever the fit or the estimate changes, so a cached fit made by an
 * older version is not reused.
 */
export const MODEL_VERSION = '0.1.0';

export * from './sherpa1/index.js';
