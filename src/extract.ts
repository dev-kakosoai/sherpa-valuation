import type { SizeUnit } from './types.js';

/*
  Reading what a listing's structured fields leave out. Marketplace listings
  often name the year only in the title or description ("Komatsu 3 Ton Mini
  Excavator 2003"), and size - which moves an excavator's price more than
  anything but age - is rarely a field at all.
*/

const YEAR = /\b(19[89]\d|20[0-4]\d)\b/g;

/**
 * The manufacture year in a listing's text: the first plausible year in the
 * title, else in the description. A year after `asOfYear` + 1 is a model
 * number or a typo, and ignored.
 */
export function extractYear(
  title: string,
  description: string | null,
  asOfYear: number
): number | null {
  for (const text of [title, description ?? '']) {
    for (const match of text.matchAll(YEAR)) {
      const year = Number(match[1]);
      if (year >= 1980 && year <= asOfYear + 1) return year;
    }
  }
  return null;
}

const TONS = /\b(\d{1,3}(?:\.\d{1,2})?)\s*(?:-\s*)?(?:tons?|tonnes?|t)\b/i;
const KVA = /\b(\d{1,4}(?:\.\d)?)\s*(?:-\s*)?kva\b/i;

/** Plausible bounds per unit: a "500 ton excavator" is a crane typed in the wrong box. */
const BOUNDS: Record<SizeUnit, [number, number]> = { ton: [0.5, 1500], kva: [2, 5000] };

/*
  Excavator model numbers carry the operating weight by industry convention:
  Komatsu PC200, Hitachi ZX200, Volvo EC210, Doosan DX225, Hyundai R220,
  Sany SY215 are 20-22 t class (the number / 10), and Caterpillar's 3xx series
  names the tonnes in its last two digits (303 = 3 t, 320 = 20 t, 336 = 36 t).
  Most excavator titles give a model and never "20 ton".
*/
const EXCAVATOR_MODEL = /\b(PC|ZX|EC|DX|R|SY|SK|JS|LG|SH|CX|HX)\s?-?(\d{2,3})[A-Z]{0,4}\b/i;
const CAT_MODEL = /\b3(\d{2})[A-Z]{0,3}\b/;
/** "Mini excavator" with no size given: the 1.5-6 t class, priced at its middle. */
const MINI = /\bmini\b/i;
const MINI_TONS = 3.5;

/**
 * An excavator's operating-weight class from its model number, or a mini
 * excavator's typical class; null when the text names neither.
 */
export function excavatorClassFromModel(text: string, brand: string | null): number | null {
  const cat = /\bcat(erpillar)?\b/i.test(brand ?? '') || /\bcat(erpillar)?\b/i.test(text);
  if (cat) {
    const match = text.match(CAT_MODEL);
    if (match) {
      const tons = Number(match[1]);
      if (tons >= 1 && tons <= 99) return tons;
    }
  }
  const match = text.match(EXCAVATOR_MODEL);
  if (match) {
    const number = Number(match[2]);
    const tons = number >= 100 ? number / 10 : number >= 10 ? number / 10 : null;
    if (tons && tons >= 1 && tons <= 120) return tons;
  }
  return MINI.test(text) ? MINI_TONS : null;
}

/** The machine's size in its category's unit, from the title then the description. */
export function extractSize(
  title: string,
  description: string | null,
  unit: SizeUnit | null
): number | null {
  if (!unit) return null;
  const pattern = unit === 'kva' ? KVA : TONS;
  const [min, max] = BOUNDS[unit];
  for (const text of [title, description ?? '']) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (value >= min && value <= max) return value;
    }
  }
  return null;
}

const HOURS = /\b(\d{1,3}(?:,\d{3})+|\d{2,6})\s*(?:working\s+)?(?:hrs|hours|hr|h)\b/i;

/** Engine hours from a structured value or the text; under 100,000 to be credible. */
export function extractHours(
  structured: string | number | null,
  title: string,
  description: string | null
): number | null {
  const parse = (raw: string) => Number(raw.replace(/,/g, ''));
  if (structured !== null && structured !== '') {
    const value = parse(String(structured));
    if (Number.isFinite(value) && value > 0 && value < 100_000) return value;
  }
  for (const text of [title, description ?? '']) {
    const match = text.match(HOURS);
    if (match) {
      const value = parse(match[1]);
      if (value > 0 && value < 100_000) return value;
    }
  }
  return null;
}

/**
 * A listing's size: stated in the text, else - for excavators, whose titles
 * name a model rather than a weight - the class its model number implies.
 */
export function extractMachineSize(
  category: string,
  unit: SizeUnit | null,
  title: string,
  description: string | null,
  brand: string | null
): number | null {
  const stated = extractSize(title, description, unit);
  if (stated !== null || category !== 'excavators') return stated;
  return excavatorClassFromModel(title, brand) ?? excavatorClassFromModel(description ?? '', brand);
}
