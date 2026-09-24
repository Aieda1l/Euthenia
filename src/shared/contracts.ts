// Frozen shared contracts for M1. The block between the markers is copied
// verbatim from the plan's "Shared contracts" section; later tasks consume it.
// Contract edits are coordinated and verified against every consumer.

// --- begin plan "Shared contracts" (verbatim) ---
export type Family = "kroger" | "albertsons" | "pcc";
export type Channel =
  | "in-store-ad" | "retailer-pickup" | "retailer-delivery"
  | "instacart-pickup" | "instacart-delivery";
export type Rational = { n: string; d: string };
export type Known<T> =
  | { state: "known"; value: T }
  | { state: "not-applicable" }
  | { state: "unknown" };

export type Identity =
  | { category: "produce"; kind: Known<string>; variety: Known<string>;
      form: Known<string>; organic: Known<boolean> }
  | { category: "meat"; species: Known<string>; cut: Known<string>;
      bone: Known<"in" | "out">; skin: Known<"on" | "off">;
      freshFrozen: Known<"fresh" | "frozen">; fatPercent: Known<number> };

export interface Evidence {
  id: string; provider: "flipp" | "pcc"; sourceItemId: string;
  retrievedUrl: string; sourceUrl: string; observedAt: string;
  rawSha256: string; rawValidity: Record<string, string | null>;
}
export interface Conditions {
  complete: boolean;
  loyaltyRequired: boolean | null;
  couponRequired: boolean | null;
  couponIds: string[];
  minimumUnits: number | null;
  maximumUnits: number | null;
  text: string[];
}
export interface Offer {
  id: string; family: Family; retailer: string; label: string;
  postalCode: string; storeName: string | null; storeAddress: string | null;
  applicability: "verified" | "unknown"; channel: Channel;
  identity: Identity;
  rawPrice: Record<string, string | null>;
  unitPrice: { basis: "lb" | "each"; cents: Rational } | null;
  normalizationIssue: string | null;
  packageMassLb: Rational | null; packageCount: number | null;
  packageTotalCents: number | null;
  conditions: Conditions; evidence: Evidence[];
  observedAt: string;
  startsAt: string | null; expiresAt: string | null;
  calendarRule: "verified-local-date" | "explicit-instant" | "unknown";
}
export interface Validation {
  offerId: string; checkedAt: string; evidenceIds: string[];
  verifiedFields: string[]; applicabilityEvidence: string; calendarEvidence: string;
}
export interface Proof {
  validatedAt: string; families: [Family, Family]; validations: Validation[];
  pairs: Array<{ leftId: string; rightId: string; category: "produce" | "meat" }>;
}
export interface SourceSnapshot {
  schemaVersion: 1; postalCode: "98105"; collectedAt: string;
  offers: Offer[]; proof: Proof;
}
export interface Profile {
  kind: "actual" | "test";
  families: Record<Family, {
    loyalty: "eligible" | "ineligible" | "unknown";
    activatedCouponIds: string[]; quantityConfirmedOfferIds: string[];
  }>;
}
export type Freshness = "fresh" | "stale" | "expired" | "upcoming";
export type Rating = "Exceptional" | "Strong" | "Good" | "Typical" | "Above comparison";
export interface Comparison {
  referenceCents: Rational; savings: Rational; rating: Rating;
  comparatorIds: string[]; comparatorFamilies: Family[];
  coverageText: string; referenceRange: [Rational, Rational];
}
export interface Deal {
  offer: Offer; freshness: Freshness;
  eligibility: "eligible" | "ineligible" | "unknown";
  reason: string | null; comparison: Comparison | null;
}
// --- end plan "Shared contracts" ---

/**
 * Offer fields a human validation must confirm against the source before an
 * offer can count toward the live gate (addendum R9). They cover the TEST_PLAN
 * "M1 acquisition gate" list: price, unit (and package terms), item,
 * location/region, channel, dates and promotion conditions. packageCount was
 * added by amendment A10.
 */
export const REQUIRED_VERIFIED_FIELDS = [
  "identity",
  "rawPrice",
  "unitPrice",
  "packageMassLb",
  "packageCount",
  "packageTotalCents",
  "conditions",
  "channel",
  "applicability",
  "startsAt",
  "expiresAt",
] as const satisfies readonly (keyof Offer)[];

/** Per-flyer human attestation (addendum R8/R9, amended 2026-09-24). */
export interface FlyerAttestation {
  family: Family;
  flyerId: number;
  checkedAt: string;
  applicability: "verified";
  applicabilityEvidence: string;
  calendarRule: "verified-local-date";
  calendarEvidence: string;
  /** Printed start time, 24-hour "HH:MM" in America/Los_Angeles. */
  startLocalTime: string;
}

/** Human validation input file for the collector (addendum R9). */
export interface ValidationFile {
  schemaVersion: 1;
  attestations: FlyerAttestation[];
  /** Bound to exact responses through raw-hash evidence IDs. */
  validations: Validation[];
  /** Human-checked cross-family pairs. */
  pairs: Proof["pairs"];
}
