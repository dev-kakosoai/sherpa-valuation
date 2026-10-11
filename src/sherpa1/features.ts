/*
  SHERPA-1 - the transforms of docs/MODEL.md §3.1, shared by the fit, the
  estimate and the synthetic generator so all three use exactly one definition.
*/

/** Box-Cox depreciation curve: ((1 + a)^λ − 1) / λ, and log(1 + a) at λ = 0. */
export function boxCox(age: number, lambda: number): number {
  const a = Math.max(0, age);
  return Math.abs(lambda) < 1e-6 ? Math.log1p(a) : (Math.pow(1 + a, lambda) - 1) / lambda;
}

/** Smoothing constant of the usage ratio, in hours. */
export const USAGE_H0 = 250;

/** Usage relative to age: 0 is normal for the age, log 2 twice as hard as normal. */
export function usageRatio(hours: number, age: number, annualHours: number): number {
  return Math.log((hours + USAGE_H0) / (annualHours * Math.max(age, 0.5) + USAGE_H0));
}

/** Age in years; a new machine without a year is taken as age 0. */
export function ageOf(
  machine: { year?: number | null; condition?: 'new' | 'used' | null },
  asOfYear: number
): number | null {
  if (machine.year !== null && machine.year !== undefined) return Math.max(0, asOfYear - machine.year);
  return machine.condition === 'new' ? 0 : null;
}

/** The grid λ is profiled over. */
export const LAMBDA_GRID = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];

/** Days a rental `period` covers; a missing period is a monthly rate. */
export function periodOf(period: number | null | undefined): number {
  return period && period > 0 ? period : 30;
}
