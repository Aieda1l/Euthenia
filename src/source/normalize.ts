import { createHash } from "node:crypto";
import type { Conditions, Evidence, Family, Offer, Rational } from "../shared/contracts.js";
import { calendarDate, verifiedLocalDateWindow } from "../shared/freshness.js";
import { classifyText, deriveIdentity, normalizeText, replaceEach, type ItemCategory, type MatchGroups } from "../shared/identity.js";
import { compareRational, divideRational, makeRational, multiplyRational, pounds, usdCents } from "../shared/money.js";

// Flipp item-detail normalization (addendum R3, R5-R8). Pure: no network,
// no clock. Unsupported data becomes an explicit normalizationIssue and a
// null value, never a guessed unit, price, condition or date.

export interface FlippContext {
  family: Family;
  retailer: string;
  postalCode: "98105";
  observedAt: string;
  evidence: Evidence;
  applicability: "verified" | "unknown";
  calendarRule: Offer["calendarRule"];
  /** Attested printed start time (HH:MM, America/Los_Angeles); required for verified-local-date. */
  startLocalTime?: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Raw evidence value: strings verbatim, scalars stringified, absent as null. */
function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function sourceItemIdOf(item: Record<string, unknown>): string {
  const id = item.id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === "string" && /^[1-9]\d*$/.test(id)) return id;
  throw new Error(`flipp item has no usable id: ${JSON.stringify(id)}`);
}

/**
 * R2 list-row classifier. Works on flyer list rows (name only) and on
 * item-detail records (name plus description), so the collector can filter
 * before fetching details and re-check afterwards.
 */
export function classifyListRow(row: Record<string, unknown>): ItemCategory {
  const name = text(row.name);
  if (name === null) return { category: "excluded", reason: "missing or non-string name" };
  return classifyText(name, text(row.description));
}

/**
 * R7 evidence for one item-detail response body. A9: pass the exact response
 * bytes, which are hashed as-is; a string (tests only) is hashed as UTF-8.
 */
export function flippEvidence(input: {
  rawBody: string | Uint8Array;
  item: Record<string, unknown>;
  retrievedUrl: string;
  observedAt: string;
}): Evidence {
  const sourceItemId = sourceItemIdOf(input.item);
  const hash = createHash("sha256");
  if (typeof input.rawBody === "string") hash.update(input.rawBody, "utf8");
  else hash.update(input.rawBody);
  const rawSha256 = hash.digest("hex");
  const rawValidity: Record<string, string | null> = {
    valid_from: raw(input.item.valid_from),
    valid_to: raw(input.item.valid_to),
  };
  if ("available_to" in input.item) rawValidity.available_to = raw(input.item.available_to);
  rawValidity.timezone = raw(input.item.timezone);
  const cutout = text(input.item.cutout_image_url);
  return {
    id: `flipp:item:${sourceItemId}:${rawSha256.slice(0, 12)}`,
    provider: "flipp",
    sourceItemId,
    retrievedUrl: input.retrievedUrl,
    sourceUrl: cutout !== null && cutout.length > 0 ? cutout : input.retrievedUrl,
    observedAt: input.observedAt,
    rawSha256,
    rawValidity,
  };
}

// ---------------------------------------------------------------------------
// Units (R5)
// ---------------------------------------------------------------------------

/** Offset and length of a phrase in the raw description. */
interface TextRange {
  index: number;
  length: number;
}

interface Units {
  unitPrice: Offer["unitPrice"];
  packageMassLb: Rational | null;
  packageCount: number | null;
  packageTotalCents: number | null;
  issues: string[];
  /** B1: the package-total phrase(s) accepted as consistent; only these are not conditions. */
  acceptedPackagePhrases: TextRange[];
}

// Quantities are canonical numbers, (0|[1-9]\d*) with an optional fraction;
// a leading-zero quantity ("01 lb", "02 for") is a normalization issue.
const LB_BASIS = /\b(?:lbs?|pounds?)\b/;
const EACH_BASIS = /\b(?:ea|each)\b/;
const N_FOR = /(?<![\d.])(0|[1-9]\d*) for\b/;
/** Largest supported "N for" multi-buy; anything above is a normalization issue. */
const MAX_MULTI_BUY = 100;
const MULTI_LB_FOR = /\b\d+(?:\.\d+)? ?(?:lbs?|pounds?) for\b/;
const LB_PACKAGE_ONLY = /^\s*((?:0|[1-9]\d*)(?:\.\d+)?)\s*lbs?\.?\s+package\s*$/i;
// N4/B2: the amount may not continue with a digit or with "." and a digit, so
// "$14.975" never parses as $14 or $14.97, while a sentence-final "$8.97." does.
// B1: the text between mass and price may not hold another "N lb", so each
// total takes its nearest mass ("1 lb or 3 lb ... for $8.97" is 3 lb).
const PACKAGE_TOTAL = /(?<![\d.])((?:0|[1-9]\d*)(?:\.\d+)?)\s*lbs?\b(?:(?!\d+(?:\.\d+)?\s*lbs?\b)[^$])*?\bfor\s*\$\s*((?:0|[1-9]\d*)(?:\.\d{1,2})?)(?!\d|\.\d)/gi;
const LEADING_ZERO_QUANTITY = /(?<![\d.])0\d+(?:\.\d+)?\s*(?:lbs?|pounds?|oz|ounces?|kg|ct|count|for)\b/;
const UNSUPPORTED_UNITS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bpints?\b/, "pint"],
  [/\bquarts?\b/, "quart"],
  [/\bbunch(?:es)?\b/, "bunch"],
  [/\bbags?\b/, "bag"],
  [/\b(?:clamshells?|containers?|baskets?|box|boxes)\b/, "container"],
];
const SIZE_RANGE = /\d+(?:\.\d+)?\s*(?:-|\u2013|to)\s*\d+(?:\.\d+)?\s*(?:lbs?|oz|ounces?|ct|count|pounds?)\b/;
const STATED_MASS = /\b\d+(?:\.\d+)?\s*(?:oz|ounces?|lbs?|pounds?|kg|g|grams?)\b/g;
const STATED_COUNT = /(?<![\d.])(0|[1-9]\d*)\s*(?:ct|count)\b/g;

// Loyalty phrases shared by the R6 condition rules and the A5 price vocabulary.
const NO_LOYALTY = /\bno (?:card|membership) (?:needed|required)\b/g;
const LOYALTY_WITH_CARD = /\bwith (?:your |a )?(?:club ?card|rewards card|loyalty card|card)\b/g;
const LOYALTY_CARD_PRICE = /\bclub ?card(?: price)?\b|\bcard price\b/g;
const LOYALTY_MEMBER = /\bmembers?(?: only)?(?: prices?| pricing| deals?| specials?)?\b/g;

/**
 * A5: the only wording pre_price_text and price_text may contain beside
 * punctuation: lb/each bases, "N for", and loyalty or member phrases. Any
 * leftover wording, digits or money signs ("2/", "Starting at", "Save", "Up
 * to", "BOGO", "off", coupon wording, and N3: "¢", "$", "%") makes the unit
 * price unknown.
 */
const PRICE_VOCABULARY: readonly RegExp[] = [
  new RegExp(N_FOR.source, "g"),
  /\bper (?:lb|pound|each|ea)\b/g,
  /\b(?:lbs?|pounds?|ea|each)\b/g,
  NO_LOYALTY, LOYALTY_WITH_CARD, LOYALTY_CARD_PRICE, LOYALTY_MEMBER,
];

/** A5 issues: leftover price wording and any stated discount. */
function priceWordingIssues(item: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const field of ["pre_price_text", "price_text"] as const) {
    const value = text(item[field]);
    if (value === null) continue;
    let rest = normalizeText(value);
    for (const pattern of PRICE_VOCABULARY) rest = rest.replace(pattern, " ");
    const leftover = rest.replace(/[^a-z0-9¢$%]+/g, " ").trim();
    if (leftover.length > 0) issues.push(`unrecognized ${field} wording ${JSON.stringify(value)} ("${leftover}"); unit price unknown`);
  }
  for (const field of ["dollars_off", "percent_off"] as const) {
    const value = item[field];
    if (value !== null && value !== undefined) issues.push(`${field} ${JSON.stringify(value)} states a discount; unit price unknown`);
  }
  return issues;
}

function normalizeUnits(item: Record<string, unknown>): Units {
  const issues: string[] = [];
  const priceValue = item.current_price;
  let cents: number | null = null;
  if (typeof priceValue !== "string") {
    issues.push(priceValue === null || priceValue === undefined
      ? "current_price is missing; price unknown (never zero)"
      : "current_price is not a string; price unknown");
  } else {
    cents = usdCents(priceValue);
    if (cents === null) issues.push(`current_price ${JSON.stringify(priceValue)} is empty or not a plain USD amount; price unknown (never zero)`);
  }

  const name = text(item.name) ?? "";
  const description = text(item.description) ?? "";
  const priceText = normalizeText(`${text(item.pre_price_text) ?? ""} ${text(item.price_text) ?? ""}`);
  const allText = normalizeText(`${name} ${description} ${priceText}`);

  const lb = LB_BASIS.test(priceText);
  const each = EACH_BASIS.test(priceText);
  const nFor = N_FOR.exec(priceText);

  let basis: "lb" | "each" | null = null;
  let divisor: Rational = makeRational(1);
  let packageMassLb: Rational | null = null;
  let packageTotalCents: number | null = null;
  let blocked = false;

  const wording = priceWordingIssues(item);
  if (wording.length > 0) {
    issues.push(...wording);
    blocked = true;
  }
  const leadingZero = LEADING_ZERO_QUANTITY.exec(allText);
  if (leadingZero) {
    issues.push(`leading-zero quantity "${leadingZero[0]}" is not a canonical number; unit price unknown`);
    blocked = true;
  }
  // B1: a count is the package count only when it is the only package size
  // stated. Several distinct counts, or a count beside a mass ("Kiwi 1 lb or
  // Apple Pears 3 ct"), may belong to different packages or alternatives.
  const sizeText = normalizeText(`${name} ${description}`);
  const countMatches = [...sizeText.matchAll(STATED_COUNT)];
  const massMatches = [...sizeText.matchAll(STATED_MASS)];
  const counts = new Set(countMatches.map((match) => match[1]));
  let packageCount: number | null = null;
  let countAmbiguous = false;
  if (counts.size > 1 || (counts.size === 1 && massMatches.length > 0)) {
    const sizes = [...massMatches, ...countMatches].sort((a, b) => a.index - b.index).map((match) => JSON.stringify(match[0]));
    issues.push(`several package sizes stated (${sizes.join(", ")}); package count unknown`);
    countAmbiguous = true;
  } else if (countMatches[0]) {
    const count = Number(countMatches[0][1]);
    if (Number.isSafeInteger(count)) packageCount = count;
    else {
      issues.push(`package count "${countMatches[0][0]}" is out of range`);
      blocked = true;
    }
  }

  const multiLb = MULTI_LB_FOR.exec(priceText);
  if (multiLb) {
    issues.push(`unsupported multi-pound price "${multiLb[0]}"`);
  } else if (nFor && lb) {
    issues.push(`conflicting unit basis: "${nFor[0]}" with a per-lb price`);
  } else if (lb && each) {
    issues.push("conflicting unit basis: both lb and each in price text");
  } else if (nFor) {
    const quantity = Number(nFor[1]);
    if (quantity >= 1 && quantity <= MAX_MULTI_BUY) {
      basis = "each";
      divisor = makeRational(quantity);
    } else {
      issues.push(`unsupported multi-buy quantity "${nFor[0]}" (supported: 1 to ${MAX_MULTI_BUY})`);
    }
  } else if (lb) {
    basis = "lb";
  } else if (each) {
    basis = "each";
  } else {
    const packageOnly = LB_PACKAGE_ONLY.exec(description);
    if (packageOnly) {
      const mass = pounds(packageOnly[1] ?? "", "lb");
      if (compareRational(mass, makeRational(0)) > 0) {
        basis = "lb";
        divisor = mass;
        packageMassLb = mass;
        packageTotalCents = cents;
      } else {
        issues.push("package mass is zero");
      }
    } else {
      issues.push("no explicit unit basis (lb or each) in price text; unit unknown");
    }
  }

  for (const [pattern, label] of UNSUPPORTED_UNITS) {
    if (pattern.test(allText)) {
      issues.push(`unsupported unit or container (${label}); no lb/each conversion`);
      blocked = true;
    }
  }
  const range = SIZE_RANGE.exec(allText);
  if (range) {
    issues.push(`size range "${range[0]}" cannot support a precise unit price`);
    blocked = true;
  }
  if (basis === "each" && massMatches.length > 0) {
    issues.push("each-priced item states a package mass; not converted");
    blocked = true;
  }
  if (basis === "each" && packageCount !== null && packageCount > 1) {
    issues.push(`each-priced item states a package count (${packageCount}); not converted`);
    blocked = true;
  }
  if (basis === "each" && countAmbiguous) {
    issues.push("each-priced item states several package sizes; not converted");
    blocked = true;
  }

  // R5 package totals ("3 lb ... for $14.97"). B1: every stated option is read.
  // Package terms are set, and the phrase stops being a condition, only for a
  // single option that agrees with a known per-lb price. Several distinct
  // options, or one that contradicts the price, leave everything unknown.
  const acceptedPackagePhrases: TextRange[] = [];
  if (basis === "lb" && packageMassLb === null) {
    const options = [...description.matchAll(PACKAGE_TOTAL)].map((match) => {
      const massText = match[1] ?? "";
      const totalText = match[2] ?? "";
      return {
        massText,
        totalText,
        mass: pounds(massText, "lb"),
        totalCents: usdCents(totalText),
        range: { index: match.index, length: match[0].length },
      };
    });
    type Option = (typeof options)[number];
    const same = (a: Option, b: Option) => a.totalCents === b.totalCents && compareRational(a.mass, b.mass) === 0;
    const distinct = options.filter((option, index) => options.findIndex((other) => same(other, option)) === index);
    const only = distinct.length === 1 ? distinct[0] : undefined;
    const label = (option: Option) => `${option.massText} lb for $${option.totalText}`;
    if (distinct.length > 1) {
      issues.push(`description states ${distinct.length} package options (${distinct.map(label).join("; ")}); package terms and unit price unknown`);
      blocked = true;
    } else if (only && (only.totalCents === null || compareRational(only.mass, makeRational(0)) <= 0)) {
      issues.push(`package total "${label(only)}" has no positive mass; package terms and unit price unknown`);
      blocked = true;
    } else if (only && only.totalCents !== null && cents !== null) {
      // Consistent when price x mass is within one cent of the stated total (rounding).
      const expected = multiplyRational(makeRational(cents), only.mass);
      const consistent = compareRational(expected, makeRational(only.totalCents - 1)) > 0 &&
        compareRational(expected, makeRational(only.totalCents + 1)) < 0;
      if (consistent) {
        packageMassLb = only.mass;
        packageTotalCents = only.totalCents;
        acceptedPackagePhrases.push(...options.filter((option) => same(option, only)).map((option) => option.range));
      } else {
        issues.push(`package total ${only.totalText} for ${only.massText} lb contradicts the per-lb price; package terms and unit price unknown`);
        blocked = true;
      }
    }
  }

  const unitPrice = basis !== null && cents !== null && !blocked
    ? { basis, cents: divideRational(makeRational(cents), divisor) }
    : null;
  return { unitPrice, packageMassLb, packageCount, packageTotalCents, issues, acceptedPackagePhrases };
}

// ---------------------------------------------------------------------------
// Conditions (R6)
// ---------------------------------------------------------------------------

interface ConditionState {
  loyalty: Set<boolean>;
  coupon: Set<boolean>;
  minimum: Set<number>;
  maximum: Set<number>;
}

// Recognized condition phrases. Everything else in a condition-bearing
// segment is unrecognized and makes the conditions incomplete.
const CONDITION_RULES: ReadonlyArray<readonly [RegExp, (groups: MatchGroups, state: ConditionState) => void]> = [
  [NO_LOYALTY, (_, s) => s.loyalty.add(false)],
  [LOYALTY_WITH_CARD, (_, s) => s.loyalty.add(true)],
  [LOYALTY_CARD_PRICE, (_, s) => s.loyalty.add(true)],
  [LOYALTY_MEMBER, (_, s) => s.loyalty.add(true)],
  // N1: "no coupon required/needed" and "coupon not required" say no coupon.
  [/\b(?:no (?:digital )?coupons?(?: (?:needed|required|necessary))?|(?:digital )?coupons? not (?:needed|required|necessary))\b/g,
    (_, s) => s.coupon.add(false)],
  [/\b(?:with )?(?:digital )?coupons?(?: required)?\b/g, (_, s) => s.coupon.add(true)],
  [/\blimit (\d+)(?: per (?:household|customer|transaction|order|day|visit))?\b/g, (g, s) => s.maximum.add(Number(g[1]))],
  [/\b(?:must buy|must purchase|when you buy|minimum(?: purchase)?(?: of)?|min)\s+(\d+)\b/g, (g, s) => s.minimum.add(Number(g[1]))],
  [/\b\d+ for\b/g, () => undefined],
  [/\bper (?:lb|pound|each)\b|\b(?:lbs?|ea|each)\b/g, () => undefined],
  [/\bmix (?:and|&) match\b/g, () => undefined],
];
const CONDITION_FILLER = /\b(?:price|prices|only|and|with|sale|special)\b/g;
// A6: purchase, spend, required, additional and any $amount also signal conditions.
const CONDITION_INDICATOR = /\b(?:limit|members?|card|coupons?|digital|clip|must|buy|get|free|bogo|save|off|min(?:imum)?|rebate|rewards?|points|mix (?:and|&) match|equal or lesser|purchases?|spend|required|additional)\b|\$\s*\d/;

/** The text with each range blanked out. */
function blankRanges(text: string, ranges: readonly TextRange[]): string {
  let out = text;
  for (const { index, length } of ranges) out = `${out.slice(0, index)}${" ".repeat(length)}${out.slice(index + length)}`;
  return out;
}

/** Applies recognized phrases; returns the unrecognized remainder. */
function applyConditionRules(segment: string, state: ConditionState): string {
  let rest = segment;
  for (const [pattern, apply] of CONDITION_RULES) {
    rest = replaceEach(rest, pattern, (groups) => {
      apply(groups, state);
      return " ";
    });
  }
  return rest;
}

/**
 * `acceptedPackagePhrases` are the R5 package totals accepted by
 * normalizeUnits: price statements, not conditions (B1). Any other package
 * phrase or `$amount` in the description is unrecognized condition text.
 */
function parseConditions(item: Record<string, unknown>, acceptedPackagePhrases: readonly TextRange[]): Conditions {
  const state: ConditionState = { loyalty: new Set(), coupon: new Set(), minimum: new Set(), maximum: new Set() };
  const kept: string[] = [];
  let complete = true;

  for (const field of ["pre_price_text", "price_text", "sale_story", "disclaimer_text"] as const) {
    const value = text(item[field]);
    if (value === null || value.trim() === "") continue;
    kept.push(value);
    const rest = applyConditionRules(normalizeText(value), state)
      .replace(CONDITION_FILLER, " ")
      .replace(/[^a-z0-9]+/g, "");
    if (rest.length > 0) complete = false;
  }

  const description = text(item.description);
  const descriptionText = description === null ? "" : normalizeText(blankRanges(description, acceptedPackagePhrases));
  if (description !== null && CONDITION_INDICATOR.test(descriptionText)) {
    kept.push(description);
    if (CONDITION_INDICATOR.test(applyConditionRules(descriptionText, state))) complete = false;
  }

  const loyaltyRequired = state.loyalty.size === 1 ? [...state.loyalty][0] ?? null : null;
  if (state.loyalty.size > 1) complete = false;
  const couponRequired = state.coupon.size === 1 ? [...state.coupon][0] ?? null : null;
  if (state.coupon.size > 1) complete = false;
  const minimumUnits = state.minimum.size === 1 ? [...state.minimum][0] ?? null : null;
  if (state.minimum.size > 1) complete = false;
  const maximumUnits = state.maximum.size === 1 ? [...state.maximum][0] ?? null : null;
  if (state.maximum.size > 1) complete = false;

  return {
    complete,
    loyaltyRequired,
    couponRequired,
    couponIds: [],
    minimumUnits,
    maximumUnits,
    text: kept,
  };
}

// ---------------------------------------------------------------------------
// Calendar (R8)
// ---------------------------------------------------------------------------

function rawValidityContradicts(item: Record<string, unknown>): boolean {
  const fromDate = calendarDate(item.valid_from);
  const toDate = calendarDate(item.valid_to);
  if (fromDate !== null && toDate !== null &&
    Date.UTC(fromDate.y, fromDate.m - 1, fromDate.d) > Date.UTC(toDate.y, toDate.m - 1, toDate.d)) return true;
  // Lenient parsing on purpose: any detectable contradiction makes the calendar unknown.
  const from = typeof item.valid_from === "string" ? Date.parse(item.valid_from) : Number.NaN;
  const to = typeof item.valid_to === "string" ? Date.parse(item.valid_to) : Number.NaN;
  return Number.isFinite(from) && Number.isFinite(to) && from >= to;
}

function normalizeCalendar(item: Record<string, unknown>, context: FlippContext):
  Pick<Offer, "startsAt" | "expiresAt" | "calendarRule"> & { issues: string[] } {
  const unknownCalendar = { startsAt: null, expiresAt: null, calendarRule: "unknown" as const };
  if (rawValidityContradicts(item)) {
    return { ...unknownCalendar, issues: ["contradictory validity: valid_from is not before valid_to; calendar unknown"] };
  }
  if (context.calendarRule === "verified-local-date") {
    const window = verifiedLocalDateWindow(item.valid_from, item.valid_to, context.startLocalTime);
    if ("issue" in window) return { ...unknownCalendar, issues: [`${window.issue}; calendar unknown`] };
    return { ...window, calendarRule: "verified-local-date", issues: [] };
  }
  if (context.calendarRule === "explicit-instant") {
    return { ...unknownCalendar, issues: ["explicit-instant is not supported for Flipp weekly-ad dates; calendar unknown"] };
  }
  return { ...unknownCalendar, issues: [] };
}

// ---------------------------------------------------------------------------
// normalizeFlipp
// ---------------------------------------------------------------------------

const RAW_PRICE_FIELDS = [
  "current_price", "original_price", "pre_price_text", "price_text", "sale_story",
  "description", "disclaimer_text", "dollars_off", "percent_off",
  "current_price_range", "original_price_range",
] as const;

/**
 * Normalizes one validated Flipp item-detail record into exactly one Offer
 * (R3). Throws for items outside the M1 categories (call classifyListRow
 * first) and for evidence that belongs to a different source item.
 */
export function normalizeFlipp(item: Record<string, unknown>, context: FlippContext): Offer {
  const sourceItemId = sourceItemIdOf(item);
  if (context.evidence.sourceItemId !== sourceItemId) {
    throw new Error(`evidence sourceItemId ${context.evidence.sourceItemId} does not match item ${sourceItemId}`);
  }
  const classification = classifyListRow(item);
  if (classification.category === "excluded") {
    throw new Error(`flipp item ${sourceItemId} is excluded: ${classification.reason}`);
  }
  const name = text(item.name) ?? "";
  const units = normalizeUnits(item);
  const calendar = normalizeCalendar(item, context);
  const issues = [...units.issues, ...calendar.issues];
  const rawPrice: Record<string, string | null> = {};
  for (const field of RAW_PRICE_FIELDS) rawPrice[field] = raw(item[field]);

  return {
    id: `flipp:${context.family}:${sourceItemId}`,
    family: context.family,
    retailer: context.retailer,
    label: name,
    postalCode: context.postalCode,
    storeName: null,
    storeAddress: null,
    applicability: context.applicability,
    channel: "in-store-ad",
    identity: deriveIdentity(classification.category, name, text(item.description)),
    rawPrice,
    unitPrice: units.unitPrice,
    normalizationIssue: issues.length > 0 ? issues.join("; ") : null,
    packageMassLb: units.packageMassLb,
    packageCount: units.packageCount,
    packageTotalCents: units.packageTotalCents,
    conditions: parseConditions(item, units.acceptedPackagePhrases),
    evidence: [{ ...context.evidence, rawValidity: { ...context.evidence.rawValidity } }],
    observedAt: context.observedAt,
    startsAt: calendar.startsAt,
    expiresAt: calendar.expiresAt,
    calendarRule: calendar.calendarRule,
  };
}
