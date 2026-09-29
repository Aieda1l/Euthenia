import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_VERIFIED_FIELDS,
  type Evidence,
  type Family,
  type FlyerAttestation,
  type Identity,
  type Offer,
  type Proof,
  type SourceSnapshot,
  type StoreAttestation,
  type Validation,
  type ValidationFile,
} from "../../src/shared/contracts.js";
import {
  assembleProof,
  attestationFor,
  candidatePairs,
  checkProof,
  evaluateProof,
  storeAttestationFor,
  validValidationsFor,
} from "../../src/source/proof.js";

// SYNTHETIC proof fixtures, for exercising evaluateProof only. They are built
// to pass the gate: R7-shaped IDs (flipp:item:<id>:<hash> and
// flipp:<family>:<id>), backflipp item retrievedUrls and complete validation
// records. evaluateProof checks that shape and the ID/hash agreement; it
// fetches nothing and does not check the sourceUrl host, so inside these
// tests the offers do count. They are not live evidence because nothing was
// collected: the source item IDs are invented in reserved ranges (9100000000+
// kroger, 9200000000+ albertsons, 9300000000+ pcc), each rawSha256 hashes the
// placeholder text "synthetic body <id>" rather than a Flipp response, the
// example.invalid sourceUrls resolve nowhere, and the validations were written
// by the test, not by a person checking a printed ad. They must never appear
// in a snapshot or in docs/research/M1_SOURCE_PROOF.md.

const NOW = new Date("2026-09-24T19:00:00.000Z");
const OBSERVED_AT = "2026-09-24T12:00:00.000Z";

const known = <T>(value: T) => ({ state: "known" as const, value });
const na = { state: "not-applicable" as const };
const unknown = { state: "unknown" as const };

function fruit(kind: string): Identity {
  return { category: "produce", kind: known(kind), variety: na, form: known("whole"), organic: known(true) };
}
// R4 (amended): ground meat of any species has skin not-applicable.
function ground(species: string, fat: number): Identity {
  return { category: "meat", species: known(species), cut: known("ground"), bone: na, skin: na, freshFrozen: known("fresh"), fatPercent: known(fat) };
}
const chickenBreast: Identity = {
  category: "meat", species: known("chicken"), cut: known("breast"), bone: known("out"),
  skin: known("off"), freshFrozen: known("fresh"), fatPercent: na,
};

// Index i of each family shares identity i; pairs use indices 0..4.
const IDENTITIES: Identity[] = [
  fruit("strawberry"), fruit("blueberry"), fruit("raspberry"), ground("beef", 20), chickenBreast,
  fruit("lemon"), fruit("lime"), fruit("broccoli"), fruit("cauliflower"), ground("pork", 20),
];
const PRODUCE_ONLY: Identity[] = [
  fruit("strawberry"), fruit("blueberry"), fruit("raspberry"), fruit("blackberry"), fruit("banana"),
  fruit("lemon"), fruit("lime"), fruit("broccoli"), fruit("cauliflower"), fruit("celery"),
];

const SYNTHETIC_ID_BASE: Record<Family, number> = { kroger: 9_100_000_000, albertsons: 9_200_000_000, pcc: 9_300_000_000 };

/** Synthetic source item ID (never a real Flipp item). */
function itemId(family: Family, index: number): string {
  return String(SYNTHETIC_ID_BASE[family] + index);
}
function offerId(family: Family, index: number): string {
  return `flipp:${family}:${itemId(family, index)}`;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeOffer(family: Family, sourceItemId: string, identity: Identity): Offer {
  const rawSha256 = sha(`synthetic body ${sourceItemId}`);
  return {
    id: `flipp:${family}:${sourceItemId}`, family, retailer: `Synthetic ${family}`, label: `synthetic ${sourceItemId}`,
    postalCode: "98105", storeName: null, storeAddress: null,
    applicability: "verified", channel: "in-store-ad", identity,
    rawPrice: { current_price: "1.99", price_text: "/lb" },
    unitPrice: { basis: "lb", cents: { n: "199", d: "1" } },
    normalizationIssue: null, packageMassLb: null, packageCount: null, packageTotalCents: null,
    conditions: { complete: true, loyaltyRequired: null, couponRequired: null, couponIds: [], minimumUnits: null, maximumUnits: null, text: ["/lb"] },
    evidence: [{
      id: `flipp:item:${sourceItemId}:${rawSha256.slice(0, 12)}`, provider: "flipp", sourceItemId,
      retrievedUrl: `https://backflipp.wishabi.com/flipp/items/${sourceItemId}`,
      sourceUrl: `https://example.invalid/synthetic-cutouts/${sourceItemId}.jpg`,
      observedAt: OBSERVED_AT, rawSha256, rawValidity: { valid_from: "2026-09-23T00:00:00-04:00", valid_to: "2026-09-29T23:59:59-04:00" },
    }],
    observedAt: OBSERVED_AT,
    startsAt: "2026-09-23T14:00:00.000Z", expiresAt: "2026-09-30T07:00:00.000Z",
    calendarRule: "verified-local-date",
  };
}

function validationFor(offer: Offer): Validation {
  return {
    offerId: offer.id, checkedAt: "2026-09-24T13:00:00.000Z",
    evidenceIds: offer.evidence.map((evidence) => evidence.id),
    verifiedFields: [...REQUIRED_VERIFIED_FIELDS],
    applicabilityEvidence: "synthetic: printed ad names the store",
    calendarEvidence: "synthetic: printed ad dates",
  };
}

function snapshot(options: { kroger?: Identity[]; albertsons?: Identity[]; pairIndices?: number[] } = {}): SourceSnapshot {
  const kroger = (options.kroger ?? IDENTITIES).map((identity, i) => makeOffer("kroger", itemId("kroger", i), identity));
  const albertsons = (options.albertsons ?? IDENTITIES).map((identity, i) => makeOffer("albertsons", itemId("albertsons", i), identity));
  const offers = [...kroger, ...albertsons];
  const pairs = (options.pairIndices ?? [0, 1, 2, 3, 4]).map((i) => ({
    leftId: offerId("kroger", i), rightId: offerId("albertsons", i),
    category: (options.kroger ?? IDENTITIES)[i]!.category,
  }));
  return {
    schemaVersion: 1, postalCode: "98105", collectedAt: OBSERVED_AT, offers,
    proof: { validatedAt: "2026-09-24T13:00:00.000Z", families: ["kroger", "albertsons"], channel: "in-store-ad", validations: offers.map(validationFor), pairs },
  };
}

function offer(snap: SourceSnapshot, id: string): Offer {
  const found = snap.offers.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no offer ${id}`);
  return found;
}

function exclusion(snap: SourceSnapshot, id: string): string {
  const evaluation = evaluateProof(snap, NOW);
  return evaluation.excluded.find((entry) => entry.offerId === id)?.reasons.join("; ") ?? "";
}

const K0 = offerId("kroger", 0);
const A0 = offerId("albertsons", 0);

describe("checkProof passing case (synthetic)", () => {
  it("10+10 valid rows, both categories and 5 distinct supported pairs pass", () => {
    const result = checkProof(snapshot(), NOW);
    expect(result).toEqual({ ok: true, reasons: [] });
    const evaluation = evaluateProof(snapshot(), NOW);
    expect(evaluation.families.kroger).toMatchObject({ count: 10, produce: 7, meat: 3 });
    expect(evaluation.families.albertsons).toMatchObject({ count: 10, produce: 7, meat: 3 });
    expect(evaluation.countedPairs).toHaveLength(5);
    expect(evaluation.failures).toEqual([]);
  });
});

describe("evaluateProof failures field (synthetic)", () => {
  it("lists gate failures only, matching the leading reasons, and is empty exactly when ok", () => {
    const snap = snapshot();
    snap.proof.pairs = snap.proof.pairs.slice(0, 4);
    const evaluation = evaluateProof(snap, NOW);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures).toEqual(["4 counted pairs (need at least 5)"]);
    expect(evaluation.reasons.slice(0, evaluation.failures.length)).toEqual(evaluation.failures);
    expect(evaluation.failures.some((reason) => reason.startsWith("excluded ") || reason.startsWith("pair "))).toBe(false);
  });
});

describe("checkProof failure matrix (synthetic)", () => {
  it("9 qualifying rows in one family fail", () => {
    const snap = snapshot();
    snap.offers = snap.offers.filter((candidate) => candidate.id !== offerId("kroger", 9));
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/kroger: 9 qualifying source items/);
  });

  it("10 rows without meat in one family fail", () => {
    const result = checkProof(snapshot({ kroger: PRODUCE_ONLY, pairIndices: [0, 1, 2] }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/kroger: no qualifying meat/);
  });

  it("10 rows without produce in one family fail", () => {
    const meatOnly = Array.from({ length: 10 }, (_, i) => ground("beef", 10 + i));
    const result = checkProof(snapshot({ albertsons: meatOnly, pairIndices: [] }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/albertsons: no qualifying produce/);
  });

  it("4 independent comparable pairs fail", () => {
    const result = checkProof(snapshot({ pairIndices: [0, 1, 2, 3] }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/4 counted pairs/);
  });

  it("5 pairs but none in one required category fail", () => {
    const result = checkProof(snapshot({ pairIndices: [0, 1, 2, 5, 6] }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/no counted meat pair/);
  });

  it("duplicate source item IDs do not increase counts", () => {
    // With R7 IDs a repeated source item in one family repeats the offer id,
    // so both copies are excluded as ambiguous.
    const snap = snapshot();
    const duplicate = makeOffer("kroger", itemId("kroger", 8), IDENTITIES[8]!);
    snap.offers = snap.offers.filter((candidate) => candidate.id !== offerId("kroger", 9));
    snap.offers.push(duplicate);
    snap.proof.validations.push(validationFor(duplicate));
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(evaluateProof(snap, NOW).families.kroger.count).toBe(8);
    expect(exclusion(snap, offerId("kroger", 8))).toMatch(/duplicate offer id/);
  });

  it("a repeated pair does not increase counts", () => {
    const snap = snapshot({ pairIndices: [0, 1, 2, 3, 0] });
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(evaluateProof(snap, NOW).countedPairs).toHaveLength(4);
    expect(result.reasons.join("\n")).toMatch(/already counted/);
  });

  it("an OR item reused against a second counterpart does not increase counts", () => {
    const snap = snapshot({ pairIndices: [0, 1, 2, 3] });
    const extra = makeOffer("albertsons", itemId("albertsons", 10), IDENTITIES[0]!);
    snap.offers.push(extra);
    snap.proof.validations.push(validationFor(extra));
    snap.proof.pairs.push({ leftId: K0, rightId: extra.id, category: "produce" });
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(evaluateProof(snap, NOW).countedPairs).toHaveLength(4);
  });

  it("an unknown unit is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).unitPrice = null;
    expect(exclusion(snap, K0)).toMatch(/unit price/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("a nonpositive unit price is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).unitPrice = { basis: "lb", cents: { n: "0", d: "1" } };
    expect(exclusion(snap, K0)).toMatch(/positive/);
  });

  it("an unknown required identity attribute is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).identity = { ...fruit("strawberry"), organic: unknown } as Identity;
    expect(exclusion(snap, K0)).toMatch(/comparisonKey.*organic/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("unknown applicability is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).applicability = "unknown";
    expect(exclusion(snap, K0)).toMatch(/applicability/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("an unknown calendar is excluded", () => {
    const snap = snapshot();
    Object.assign(offer(snap, K0), { calendarRule: "unknown", startsAt: null, expiresAt: null });
    expect(exclusion(snap, K0)).toMatch(/calendar/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("a normalization issue is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).normalizationIssue = "synthetic issue";
    expect(exclusion(snap, K0)).toMatch(/normalization issue/);
  });

  it("missing validation fails", () => {
    const snap = snapshot();
    snap.proof.validations = snap.proof.validations.filter((validation) => validation.offerId !== K0);
    expect(exclusion(snap, K0)).toMatch(/no valid validation/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("no validations at all fails", () => {
    const snap = snapshot();
    snap.proof.validations = [];
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/kroger: 0 qualifying source items/);
  });

  it("an unknown evidence ID fails", () => {
    const snap = snapshot();
    snap.proof.validations[0]!.evidenceIds = [`flipp:item:${itemId("kroger", 0)}:000000000000`];
    expect(exclusion(snap, K0)).toMatch(/evidence ID .* not on the offer/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("a raw-hash mismatch fails", () => {
    const snap = snapshot();
    offer(snap, K0).evidence[0]!.rawSha256 = sha("a different body");
    expect(exclusion(snap, K0)).toMatch(/hash/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("missing required verifiedFields fails", () => {
    const snap = snapshot();
    snap.proof.validations[0]!.verifiedFields = REQUIRED_VERIFIED_FIELDS.filter((field) => field !== "unitPrice");
    expect(exclusion(snap, K0)).toMatch(/verifiedFields.*unitPrice/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("empty field evidence strings fail", () => {
    const snap = snapshot();
    snap.proof.validations[0]!.calendarEvidence = "  ";
    expect(exclusion(snap, K0)).toMatch(/calendarEvidence/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("a future row is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).startsAt = "2026-09-25T00:00:00.000Z";
    expect(exclusion(snap, K0)).toMatch(/upcoming/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("an expired row is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).expiresAt = NOW.toISOString();
    expect(exclusion(snap, K0)).toMatch(/expired/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("a stale row is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).observedAt = new Date(NOW.getTime() - 24 * 3_600_000 - 1).toISOString();
    expect(exclusion(snap, K0)).toMatch(/stale/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("an observation time after the check clock is excluded", () => {
    const snap = snapshot();
    offer(snap, K0).observedAt = "2026-09-24T19:00:00.001Z";
    expect(exclusion(snap, K0)).toMatch(/observedAt is after/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("the same family on both sides of a pair does not count", () => {
    const snap = snapshot({ pairIndices: [1, 2, 3, 4] });
    const twin = makeOffer("kroger", itemId("kroger", 10), IDENTITIES[0]!);
    snap.offers.push(twin);
    snap.proof.validations.push(validationFor(twin));
    snap.proof.pairs.unshift({ leftId: K0, rightId: twin.id, category: "produce" });
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/same family/);
  });

  it("a channel mismatch does not count", () => {
    const snap = snapshot();
    offer(snap, A0).channel = "retailer-pickup";
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/channel/);
  });

  it("a unit basis mismatch does not count", () => {
    const snap = snapshot();
    offer(snap, A0).unitPrice = { basis: "each", cents: { n: "199", d: "1" } };
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/basis/);
  });

  it("a comparisonKey mismatch or wrong declared category does not count", () => {
    const mismatched = snapshot();
    mismatched.proof.pairs[0] = { leftId: K0, rightId: offerId("albertsons", 5), category: "produce" };
    expect(checkProof(mismatched, NOW).reasons.join("\n")).toMatch(/comparisonKey/);
    expect(checkProof(mismatched, NOW).ok).toBe(false);

    const wrongCategory = snapshot();
    wrongCategory.proof.pairs[0]!.category = "meat";
    expect(checkProof(wrongCategory, NOW).reasons.join("\n")).toMatch(/category/);
    expect(checkProof(wrongCategory, NOW).ok).toBe(false);
  });

  it("a pair with a missing or nonqualifying side does not count", () => {
    const snap = snapshot();
    snap.proof.pairs[0]!.rightId = "flipp:albertsons:9299999999";
    expect(checkProof(snap, NOW).reasons.join("\n")).toMatch(/9299999999 is not a qualifying offer/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("offers outside the proof families and dangling validations are reported, not counted", () => {
    const snap = snapshot();
    const pcc = makeOffer("pcc", itemId("pcc", 0), fruit("strawberry"));
    snap.offers.push(pcc);
    snap.proof.validations.push(validationFor(pcc), { ...validationFor(pcc), offerId: "flipp:kroger:9199999999" });
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(true);
    expect(result.reasons.join("\n")).toMatch(/flipp:pcc:9300000000.*not one of the proof families/);
    expect(result.reasons.join("\n")).toMatch(/validation references unknown offer flipp:kroger:9199999999/);
  });

  it("N8: a validation naming a nonexistent offer is a note, not a failure", () => {
    const snap = snapshot();
    snap.proof.validations.push({ ...validationFor(offer(snap, K0)), offerId: "flipp:kroger:9199999999" });
    const evaluation = evaluateProof(snap, NOW);
    expect(evaluation.ok).toBe(true);
    expect(evaluation.failures).toEqual([]);
    expect(evaluation.notes).toEqual(["validation references unknown offer flipp:kroger:9199999999"]);
    expect(evaluation.reasons).toEqual(evaluation.notes);
  });

  it("duplicate offer IDs are excluded as ambiguous", () => {
    const snap = snapshot();
    snap.offers.push(makeOffer("kroger", itemId("kroger", 0), IDENTITIES[0]!));
    expect(exclusion(snap, K0)).toMatch(/duplicate offer id/);
  });

  it("invalid proof families fail", () => {
    const snap = snapshot();
    snap.proof.families = ["kroger", "kroger"];
    expect(checkProof(snap, NOW).ok).toBe(false);
    expect(checkProof(snap, NOW).reasons.join("\n")).toMatch(/families/);
  });

  it("A10: a validation without packageCount does not count", () => {
    expect(REQUIRED_VERIFIED_FIELDS).toContain("packageCount");
    const snap = snapshot();
    snap.proof.validations[0]!.verifiedFields = REQUIRED_VERIFIED_FIELDS.filter((field: string) => field !== "packageCount");
    expect(exclusion(snap, K0)).toMatch(/verifiedFields missing packageCount/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("an empty applicabilityEvidence in a validation is excluded", () => {
    const snap = snapshot();
    snap.proof.validations[0]!.applicabilityEvidence = "";
    expect(exclusion(snap, K0)).toMatch(/applicabilityEvidence/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("A8: a validation with a non-strict checkedAt does not count", () => {
    const snap = snapshot();
    snap.proof.validations[0]!.checkedAt = "1";
    expect(exclusion(snap, K0)).toMatch(/checkedAt/);
  });
});

describe("A8: calendar integrity in checkProof (synthetic)", () => {
  it.each([
    ["a missing startsAt", { startsAt: null }, /startsAt/],
    ["a missing expiresAt", { expiresAt: null }, /expiresAt/],
    ["an unparseable startsAt", { startsAt: "1" }, /startsAt/],
    ["a date-only expiresAt", { expiresAt: "2026-09-30" }, /expiresAt/],
    ["startsAt not before expiresAt", { startsAt: "2026-09-30T07:00:00.000Z", expiresAt: "2026-09-30T07:00:00.000Z" }, /startsAt is not before expiresAt/],
  ])("excludes a dated calendar rule with %s", (_label, change, reason) => {
    const snap = snapshot();
    Object.assign(offer(snap, K0), change);
    expect(exclusion(snap, K0)).toMatch(reason);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("applies the same check to explicit-instant", () => {
    const snap = snapshot();
    Object.assign(offer(snap, K0), { calendarRule: "explicit-instant", startsAt: null });
    expect(exclusion(snap, K0)).toMatch(/startsAt/);
  });

  it("excludes an offer observedAt that is not a strict ISO 8601 timestamp", () => {
    const snap = snapshot();
    offer(snap, K0).observedAt = "2026-09-24T12:00:00";
    expect(exclusion(snap, K0)).toMatch(/observedAt/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("excludes evidence whose observation time is not strict", () => {
    const snap = snapshot();
    offer(snap, K0).evidence[0]!.observedAt = "2026";
    expect(exclusion(snap, K0)).toMatch(/observation time/);
  });
});

describe("A7: R7 identity enforcement (synthetic)", () => {
  it("excludes an offer whose evidence uses a fixture: id", () => {
    const snap = snapshot();
    const evidence = offer(snap, K0).evidence[0]!;
    evidence.id = `fixture:item:${evidence.sourceItemId}:${evidence.rawSha256.slice(0, 12)}`;
    snap.proof.validations = snap.offers.map(validationFor);
    expect(exclusion(snap, K0)).toMatch(/R7/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("excludes an offer whose id is not flipp:<family>:<sourceItemId>", () => {
    const snap = snapshot();
    const renamed = offer(snap, K0);
    renamed.id = `fixture:kroger:${itemId("kroger", 0)}`;
    snap.proof.validations = snap.offers.map(validationFor);
    snap.proof.pairs[0]!.leftId = renamed.id;
    expect(exclusion(snap, renamed.id)).toMatch(/offer id .*R7/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("excludes an offer whose retrievedUrl is not the backflipp item URL", () => {
    const snap = snapshot();
    offer(snap, K0).evidence[0]!.retrievedUrl = `https://example.invalid/items/${itemId("kroger", 0)}`;
    expect(exclusion(snap, K0)).toMatch(/retrievedUrl/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("excludes evidence from a non-flipp provider", () => {
    const snap = snapshot();
    offer(snap, K0).evidence[0]!.provider = "pcc";
    expect(exclusion(snap, K0)).toMatch(/provider/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("excludes a non-numeric source item ID", () => {
    const snap = snapshot();
    const target = offer(snap, K0);
    const rawSha256 = target.evidence[0]!.rawSha256;
    target.id = "flipp:kroger:k0";
    target.evidence[0] = { ...target.evidence[0]!, sourceItemId: "k0", id: `flipp:item:k0:${rawSha256.slice(0, 12)}`, retrievedUrl: "https://backflipp.wishabi.com/flipp/items/k0" };
    snap.proof.validations = snap.offers.map(validationFor);
    expect(exclusion(snap, "flipp:kroger:k0")).toMatch(/sourceItemId/);
  });

  it("the same source item under two families is counted once and cannot pair", () => {
    const snap = snapshot({ pairIndices: [1, 2, 3, 4] });
    const shared = makeOffer("albertsons", itemId("kroger", 0), IDENTITIES[0]!);
    snap.offers = snap.offers.map((candidate) => (candidate.id === A0 ? shared : candidate));
    snap.proof.validations = snap.offers.map(validationFor);
    snap.proof.pairs.unshift({ leftId: K0, rightId: shared.id, category: "produce" });
    const evaluation = evaluateProof(snap, NOW);
    expect(evaluation.families.kroger.count).toBe(10);
    expect(evaluation.families.albertsons.count).toBe(9);
    expect(evaluation.countedPairs).toHaveLength(4);
    expect(evaluation.skippedPairs[0]?.reason).toMatch(/same source item/);
    expect(evaluation.ok).toBe(false);
  });

  it("a source item counted for another family cannot pair through its second offer", () => {
    const snap = snapshot({ pairIndices: [1, 2, 3, 4] });
    const shared = makeOffer("albertsons", itemId("kroger", 5), IDENTITIES[0]!);
    snap.offers.push(shared);
    snap.proof.validations.push(validationFor(shared));
    snap.proof.pairs.unshift({ leftId: K0, rightId: shared.id, category: "produce" });
    const evaluation = evaluateProof(snap, NOW);
    expect(evaluation.families.albertsons.count).toBe(10);
    expect(evaluation.countedPairs).toHaveLength(4);
    expect(evaluation.skippedPairs[0]?.reason).toMatch(/already counted/);
  });

  it("malformed snapshot entries are excluded with a reason, never thrown", () => {
    const snap = snapshot();
    const extra = (index: number, change: Record<string, unknown>): Offer =>
      ({ ...makeOffer("kroger", itemId("kroger", 20 + index), IDENTITIES[0]!), ...change }) as unknown as Offer;
    const malformed: Offer[] = [
      null as unknown as Offer,
      "not an offer" as unknown as Offer,
      extra(0, { identity: undefined }),
      extra(1, { evidence: "not an array" }),
      extra(2, { evidence: [null] }),
      extra(3, { identity: { ...fruit("strawberry"), category: "seafood" } }),
      extra(4, { channel: "telepathy" }),
      extra(5, { family: "walmart" }),
      extra(6, { unitPrice: { basis: "kg", cents: { n: "1", d: "1" } } }),
      extra(7, { calendarRule: "sometimes" }),
      extra(8, { applicability: "probably" }),
      extra(9, { identity: { ...chickenBreast, bone: known("sideways") } }),
      extra(10, { identity: { ...chickenBreast, skin: undefined } }),
      extra(11, { id: 42 }),
      // F4: well-shaped, but its variety is an ill-formed string (a lone surrogate).
      extra(12, { identity: { category: "produce", kind: known("apple"), variety: known("\ud800"), form: known("whole"), organic: known(true) } }),
    ];
    snap.offers.push(...malformed);
    snap.proof.validations.push(
      null as unknown as Validation,
      { offerId: 42 } as unknown as Validation,
      { ...validationFor(offer(snap, K0)), evidenceIds: [null, 7] } as unknown as Validation,
    );
    snap.proof.pairs.push(
      null as unknown as Proof["pairs"][number],
      { leftId: 1, rightId: null, category: "fish" } as unknown as Proof["pairs"][number],
    );
    let evaluation: ReturnType<typeof evaluateProof> | undefined;
    expect(() => { evaluation = evaluateProof(snap, NOW); }).not.toThrow();
    expect(evaluation?.ok).toBe(true);
    expect(evaluation?.families.kroger.count).toBe(10);
    expect(evaluation?.excluded).toHaveLength(malformed.length);
    for (const entry of evaluation?.excluded ?? []) expect(entry.reasons.length).toBeGreaterThan(0);
    const reasons = evaluation?.reasons.join("\n") ?? "";
    expect(reasons).toMatch(/offers\[20\].*not an offer object/);
    expect(reasons).toMatch(/category "seafood" is outside produce\/meat/);
    expect(reasons).toMatch(/channel "telepathy"/);
    expect(reasons).toMatch(/validations\[20\] is malformed/);
    expect(reasons).toMatch(/pairs\[5\] is malformed/);
    expect(exclusion(snap, offerId("kroger", 32))).toMatch(/no comparisonKey \(unknown or unsupported identity fields: variety\)/);
    expect(() => checkProof(snap, NOW)).not.toThrow();
  });

  it("an identity category outside produce and meat does not count", () => {
    const snap = snapshot();
    const seafood = makeOffer("kroger", itemId("kroger", 30), { ...fruit("strawberry"), category: "seafood" } as unknown as Identity);
    snap.offers = snap.offers.filter((candidate) => candidate.id !== offerId("kroger", 9));
    snap.offers.push(seafood);
    snap.proof.validations = snap.offers.map(validationFor);
    const evaluation = evaluateProof(snap, NOW);
    expect(evaluation.families.kroger.count).toBe(9);
    expect(exclusion(snap, seafood.id)).toMatch(/category/);
    expect(evaluation.ok).toBe(false);
  });

  it("checkProof throws only for an invalid clock", () => {
    expect(() => checkProof(snapshot(), new Date("not a date"))).toThrow(/now/);
  });
});

// SYNTHETIC catalog fixtures (catalog price amendment, section 3), for
// evaluateProof only. The product IDs are invented 13-digit values
// (9100000000000+ kroger, 9200000000000+ albertsons), the store scopes are
// invented 8-digit locationIds (91000001, 91000002), each rawSha256 hashes the
// placeholder text "synthetic search <url>" (so offers from one synthetic
// search share a hash, as real search responses do), and the example.invalid
// URLs resolve nowhere. Nothing was collected; they are not live evidence and
// must never appear in a snapshot or in docs/research/M1_SOURCE_PROOF.md.

type CatalogProvider = StoreAttestation["provider"];
const SCOPE = "91000001";
const OTHER_SCOPE = "91000002";
const CATALOG_ID_BASE: Record<Family, number> = { kroger: 9_100_000_000_000, albertsons: 9_200_000_000_000, pcc: 9_300_000_000_000 };
const SAFEWAY_PLACEHOLDER_URL = "https://example.invalid/synthetic-safeway-search?storeid=9200";

function catalogProvider(family: Family): CatalogProvider {
  return family === "albertsons" ? "safeway-search" : "kroger-api";
}
function catalogItemId(family: Family, index: number): string {
  return String(CATALOG_ID_BASE[family] + index);
}
function catalogOfferId(family: Family, index: number): string {
  return `${catalogProvider(family)}:${family}:${catalogItemId(family, index)}`;
}
function krogerProductsUrl(locationId: string): string {
  return `https://api.kroger.com/v1/products?filter.term=synthetic&filter.locationId=${locationId}&filter.limit=20`;
}

function makeCatalogOffer(
  family: Family, sourceItemId: string, identity: Identity,
  options: { provider?: CatalogProvider; retrievedUrl?: string } = {},
): Offer {
  const provider = options.provider ?? catalogProvider(family);
  const retrievedUrl = options.retrievedUrl ?? (provider === "kroger-api" ? krogerProductsUrl(SCOPE) : SAFEWAY_PLACEHOLDER_URL);
  const rawSha256 = sha(`synthetic search ${retrievedUrl}`);
  return {
    id: `${provider}:${family}:${sourceItemId}`, family, retailer: `Synthetic ${family}`, label: `synthetic catalog ${sourceItemId}`,
    postalCode: "98105", storeName: null, storeAddress: null,
    applicability: "verified", channel: "retailer-pickup", identity,
    rawPrice: { regular: "1.99", promo: null, size: "1 lb", soldBy: "WEIGHT" },
    unitPrice: { basis: "lb", cents: { n: "199", d: "1" } },
    normalizationIssue: null, packageMassLb: null, packageCount: null, packageTotalCents: null,
    conditions: { complete: true, loyaltyRequired: false, couponRequired: false, couponIds: [], minimumUnits: null, maximumUnits: null, text: [] },
    evidence: [{
      id: `${provider}:product:${sourceItemId}:${rawSha256.slice(0, 12)}`, provider, sourceItemId, retrievedUrl,
      sourceUrl: `https://example.invalid/synthetic-products/${sourceItemId}`,
      observedAt: OBSERVED_AT, rawSha256, rawValidity: {},
    }],
    observedAt: OBSERVED_AT,
    startsAt: null, expiresAt: null,
    calendarRule: "catalog-observation",
  };
}

/** 10 kroger-api + 10 safeway-search offers in retailer-pickup, pairs on indices 0..4. */
function catalogSnapshot(): SourceSnapshot {
  const offers = (["kroger", "albertsons"] as const).flatMap((family) =>
    IDENTITIES.map((identity, i) => makeCatalogOffer(family, catalogItemId(family, i), identity)));
  const pairs = [0, 1, 2, 3, 4].map((i) => ({ leftId: catalogOfferId("kroger", i), rightId: catalogOfferId("albertsons", i), category: IDENTITIES[i]!.category }));
  return {
    schemaVersion: 1, postalCode: "98105", collectedAt: OBSERVED_AT, offers,
    proof: { validatedAt: "2026-09-24T13:00:00.000Z", families: ["kroger", "albertsons"], channel: "retailer-pickup", validations: offers.map(validationFor), pairs },
  };
}

/** Replaces the offer at `id` and rebinds every validation to the current evidence. */
function replaceOffer(snap: SourceSnapshot, id: string, replacement: Offer): void {
  snap.offers = snap.offers.map((candidate) => (candidate.id === id ? replacement : candidate));
  snap.proof.validations = snap.offers.map(validationFor);
  for (const pair of snap.proof.pairs) {
    if (pair.leftId === id) pair.leftId = replacement.id;
    if (pair.rightId === id) pair.rightId = replacement.id;
  }
}

const KC0 = catalogOfferId("kroger", 0);
const AC0 = catalogOfferId("albertsons", 0);
const SAFEWAY_PENDING = /safeway-search evidence is excluded until S1 defines its pattern/;

describe("catalog channel gate (amendment section 3, synthetic)", () => {
  it("10+10 catalog offers with 5 pairs in retailer-pickup: every kroger-api offer counts; only the pending S1 safeway-search rule blocks the gate", () => {
    const evaluation = evaluateProof(catalogSnapshot(), NOW);
    expect(evaluation.families.kroger).toMatchObject({ count: 10, produce: 7, meat: 3 });
    expect(evaluation.excluded.filter((entry) => entry.offerId.startsWith("kroger-api:"))).toEqual([]);
    const albertsons = evaluation.excluded.filter((entry) => entry.offerId.startsWith("safeway-search:albertsons:"));
    expect(albertsons).toHaveLength(10);
    for (const entry of albertsons) expect(entry.reasons).toEqual([expect.stringMatching(SAFEWAY_PENDING)]);
    expect(evaluation.failures).toEqual([
      "albertsons: 0 qualifying source items (need at least 10)",
      "albertsons: no qualifying produce",
      "albertsons: no qualifying meat",
      "0 counted pairs (need at least 5)",
      "no counted produce pair",
      "no counted meat pair",
    ]);
    expect(evaluation.skippedPairs.map(({ reason }) => reason)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `${catalogOfferId("albertsons", i)} is not a qualifying offer`));
    expect(evaluation.ok).toBe(false);
  });

  it("5 ad + 5 catalog offers per chain fail: counts never add across channels", () => {
    const offers = (["kroger", "albertsons"] as const).flatMap((family) => IDENTITIES.map((identity, i) =>
      (i < 5 ? makeOffer(family, itemId(family, i), identity) : makeCatalogOffer(family, catalogItemId(family, i), identity))));
    const pairs = [
      ...[0, 1, 2, 3, 4].map((i) => ({ leftId: offerId("kroger", i), rightId: offerId("albertsons", i), category: IDENTITIES[i]!.category })),
      ...[5, 6, 7, 8, 9].map((i) => ({ leftId: catalogOfferId("kroger", i), rightId: catalogOfferId("albertsons", i), category: IDENTITIES[i]!.category })),
    ];
    const mixed = (channel: Proof["channel"]): SourceSnapshot => ({
      schemaVersion: 1, postalCode: "98105", collectedAt: OBSERVED_AT, offers,
      proof: { validatedAt: "2026-09-24T13:00:00.000Z", families: ["kroger", "albertsons"], channel, validations: offers.map(validationFor), pairs },
    });

    const pickup = evaluateProof(mixed("retailer-pickup"), NOW);
    expect(pickup.ok).toBe(false);
    expect(pickup.families.kroger.count).toBe(5);
    expect(pickup.failures).toContain("kroger: 5 qualifying source items (need at least 10)");
    expect(exclusion(mixed("retailer-pickup"), K0)).toMatch(/channel in-store-ad is not the gate channel/);

    const ad = evaluateProof(mixed("in-store-ad"), NOW);
    expect(ad.ok).toBe(false);
    expect(ad.families.kroger.count).toBe(5);
    expect(ad.families.albertsons.count).toBe(5);
    expect(ad.failures).toEqual(expect.arrayContaining([
      "kroger: 5 qualifying source items (need at least 10)",
      "albertsons: 5 qualifying source items (need at least 10)",
    ]));
    expect(exclusion(mixed("in-store-ad"), catalogOfferId("kroger", 5))).toMatch(/channel retailer-pickup is not the gate channel/);
  });

  it("rule 1: an offer outside proof.channel is excluded with a reason", () => {
    const snap = catalogSnapshot();
    offer(snap, KC0).channel = "in-store-ad";
    expect(exclusion(snap, KC0)).toMatch(/channel in-store-ad is not the gate channel/);
    expect(evaluateProof(snap, NOW).families.kroger.count).toBe(9);
  });

  it.each([
    ["missing", undefined],
    ["unknown", "telepathy"],
    ["not a string", 7],
  ])("rule 1: a %s proof.channel is a gate failure", (_label, channel) => {
    const snap = snapshot();
    (snap.proof as unknown as Record<string, unknown>).channel = channel;
    if (channel === undefined) delete (snap.proof as Partial<Proof>).channel;
    const evaluation = evaluateProof(snap, NOW);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.join("\n")).toMatch(/proof channel .* is missing or not a known channel/);
    expect(exclusion(snap, K0)).toMatch(/not the gate channel/);
  });

  it("rule 2: kroger-api evidence on albertsons is excluded", () => {
    const snap = catalogSnapshot();
    const stray = makeCatalogOffer("albertsons", catalogItemId("albertsons", 20), IDENTITIES[0]!, { provider: "kroger-api" });
    snap.offers.push(stray);
    snap.proof.validations.push(validationFor(stray));
    expect(stray.id).toBe(`kroger-api:albertsons:${catalogItemId("albertsons", 20)}`);
    expect(exclusion(snap, stray.id)).toMatch(/provider kroger-api is allowed only for family kroger/);
    expect(evaluateProof(snap, NOW).families.albertsons.count).toBe(0);
  });

  it("rule 2: safeway-search is excluded pending S1", () => {
    expect(exclusion(catalogSnapshot(), AC0)).toMatch(SAFEWAY_PENDING);
  });

  it("rule 2: a provider other than flipp, kroger-api or safeway-search is excluded", () => {
    const snap = catalogSnapshot();
    offer(snap, KC0).evidence[0]!.provider = "pcc";
    expect(exclusion(snap, KC0)).toMatch(/provider "pcc"/);
  });

  it("rule 2: a 13-digit kroger-api ID with leading zeros counts", () => {
    const snap = catalogSnapshot();
    const zeros = makeCatalogOffer("kroger", "0000000009100", IDENTITIES[0]!);
    replaceOffer(snap, KC0, zeros);
    const evaluation = evaluateProof(snap, NOW);
    expect(zeros.id).toBe("kroger-api:kroger:0000000009100");
    expect(exclusion(snap, zeros.id)).toBe("");
    expect(evaluation.families.kroger.count).toBe(10);
    expect(evaluation.families.kroger.sourceItemIds).toContain("0000000009100");
  });

  it.each([
    ["12 digits", "910000000000"],
    ["14 digits", "91000000000000"],
    ["a letter", "910000000000a"],
    ["a sign", "+910000000000"],
  ])("rule 2: a kroger-api sourceItemId with %s is excluded", (_label, id) => {
    const snap = catalogSnapshot();
    const bad = makeCatalogOffer("kroger", id, IDENTITIES[0]!);
    replaceOffer(snap, KC0, bad);
    expect(exclusion(snap, bad.id)).toMatch(/13-digit/);
  });

  it.each([
    ["http", `http://api.kroger.com/v1/products?filter.locationId=${SCOPE}`],
    ["another path", `https://api.kroger.com/v1/locations?filter.locationId=${SCOPE}`],
    ["another host", `https://api.kroger.com.example.invalid/v1/products?filter.locationId=${SCOPE}`],
    ["a credential", `https://user:secret@api.kroger.com/v1/products?filter.locationId=${SCOPE}`],
    ["no locationId", "https://api.kroger.com/v1/products?filter.term=synthetic"],
    ["a 7-digit locationId", "https://api.kroger.com/v1/products?filter.locationId=9100000"],
    ["a 9-digit locationId", "https://api.kroger.com/v1/products?filter.locationId=910000010"],
    ["two locationIds", `https://api.kroger.com/v1/products?filter.locationId=${SCOPE}&filter.locationId=${SCOPE}`],
  ])("rule 2: a kroger-api retrievedUrl with %s is excluded", (_label, retrievedUrl) => {
    const snap = catalogSnapshot();
    replaceOffer(snap, KC0, makeCatalogOffer("kroger", catalogItemId("kroger", 0), IDENTITIES[0]!, { retrievedUrl }));
    expect(exclusion(snap, KC0)).toMatch(/retrievedUrl is not https:\/\/api\.kroger\.com\/v1\/products\?/);
  });

  it("rule 2: catalog IDs are <provider>:product:<sourceItemId>:<hash12> and <provider>:<family>:<sourceItemId>", () => {
    const wrongEvidence = catalogSnapshot();
    const evidence = offer(wrongEvidence, KC0).evidence[0]!;
    evidence.id = `kroger-api:item:${evidence.sourceItemId}:${evidence.rawSha256.slice(0, 12)}`;
    wrongEvidence.proof.validations = wrongEvidence.offers.map(validationFor);
    expect(exclusion(wrongEvidence, KC0)).toMatch(/does not match its raw hash and source item \(catalog id kroger-api:product:/);

    const wrongOffer = catalogSnapshot();
    const renamed: Offer = { ...offer(wrongOffer, KC0), id: `flipp:kroger:${catalogItemId("kroger", 0)}` };
    replaceOffer(wrongOffer, KC0, renamed);
    expect(exclusion(wrongOffer, renamed.id)).toMatch(/offer id flipp:kroger:\d+ is not the catalog id kroger-api:kroger:/);
  });

  it("rule 3: a catalog offer with dates is excluded", () => {
    for (const change of [
      { startsAt: "2026-09-23T14:00:00.000Z", expiresAt: "2026-09-30T07:00:00.000Z" },
      { expiresAt: "2026-09-30T07:00:00.000Z" },
    ]) {
      const snap = catalogSnapshot();
      Object.assign(offer(snap, KC0), change);
      expect(exclusion(snap, KC0)).toMatch(/catalog-observation requires startsAt and expiresAt to be null/);
    }
  });

  it("rule 3: a catalog offer with another calendar rule is excluded", () => {
    const snap = catalogSnapshot();
    Object.assign(offer(snap, KC0), { calendarRule: "verified-local-date", startsAt: "2026-09-23T14:00:00.000Z", expiresAt: "2026-09-30T07:00:00.000Z" });
    expect(exclusion(snap, KC0)).toMatch(/catalog offer calendar rule verified-local-date is not catalog-observation/);
  });

  it("rule 3: Flipp may not use catalog-observation", () => {
    const snap = snapshot();
    Object.assign(offer(snap, K0), { calendarRule: "catalog-observation", startsAt: null, expiresAt: null });
    expect(exclusion(snap, K0)).toMatch(/calendar rule catalog-observation is only for catalog providers/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("rule 4: two locationIds in one family exclude that family's catalog offers", () => {
    const snap = catalogSnapshot();
    const id = catalogOfferId("kroger", 9);
    replaceOffer(snap, id, makeCatalogOffer("kroger", catalogItemId("kroger", 9), IDENTITIES[9]!, { retrievedUrl: krogerProductsUrl(OTHER_SCOPE) }));
    const evaluation = evaluateProof(snap, NOW);
    expect(evaluation.families.kroger.count).toBe(0);
    for (const i of [0, 9]) {
      expect(exclusion(snap, catalogOfferId("kroger", i))).toMatch(
        new RegExp(`kroger catalog offers span more than one store scope \\(filter\\.locationId=${SCOPE}, filter\\.locationId=${OTHER_SCOPE}\\)`));
    }
  });

  // Rule 5 (provider-keyed counting) across two catalog providers can only be
  // shown once S1 defines safeway-search offers; see the S1 accept list.

  it("provider-channel binding: Flipp ad offers relabeled retailer-pickup never count in the catalog gate", () => {
    const snap = catalogSnapshot();
    const flipps = IDENTITIES.map((identity, i) => ({ ...makeOffer("albertsons", catalogItemId("kroger", i), identity), channel: "retailer-pickup" as const }));
    snap.offers = [...snap.offers.filter((candidate) => candidate.family === "kroger"), ...flipps];
    snap.proof.validations = snap.offers.map(validationFor);
    snap.proof.pairs = [0, 1, 2, 3, 4].map((i) => ({ leftId: catalogOfferId("kroger", i), rightId: flipps[i]!.id, category: IDENTITIES[i]!.category }));
    const evaluation = evaluateProof(snap, NOW);
    expect(evaluation.families.kroger.count).toBe(10);
    expect(evaluation.families.albertsons.count).toBe(0);
    expect(evaluation.countedPairs).toHaveLength(0);
    expect(exclusion(snap, flipps[0]!.id)).toMatch(/provider flipp requires channel in-store-ad, not retailer-pickup/);
    expect(evaluation.ok).toBe(false);
  });

  it("provider-channel binding: a catalog offer labeled in-store-ad never counts in the ad gate", () => {
    const snap = snapshot();
    const catalog = { ...makeCatalogOffer("kroger", catalogItemId("kroger", 0), IDENTITIES[0]!), channel: "in-store-ad" as const };
    snap.offers.push(catalog);
    snap.proof.validations.push(validationFor(catalog));
    expect(exclusion(snap, catalog.id)).toMatch(/provider kroger-api requires channel retailer-pickup, not in-store-ad/);
  });

  it.each([
    ["before the observation", "2026-09-24T11:59:59.999Z"],
    ["more than 24 h after the observation", "2026-09-25T12:00:00.001Z"],
  ])("a catalog validation checked %s does not count (section 4, D5)", (_label, checkedAt) => {
    const snap = catalogSnapshot();
    snap.proof.validations = snap.proof.validations.map((validation) =>
      (validation.offerId === KC0 ? { ...validation, checkedAt } : validation));
    expect(exclusion(snap, KC0)).toMatch(/catalog validation checkedAt is not within 24 h after observedAt/);
  });

  it("a catalog validation checked exactly at the observation or 24 h later still counts", () => {
    for (const checkedAt of ["2026-09-24T12:00:00.000Z", "2026-09-25T12:00:00.000Z"]) {
      const snap = catalogSnapshot();
      snap.proof.validations = snap.proof.validations.map((validation) =>
        (validation.offerId === KC0 ? { ...validation, checkedAt } : validation));
      const later = new Date(Math.max(Date.parse(checkedAt), NOW.getTime()));
      const reasons = evaluateProof(snap, later).excluded.find((entry) => entry.offerId === KC0)?.reasons.join("; ") ?? "";
      expect(reasons).not.toMatch(/checkedAt/);
    }
  });

  it("validValidationsFor applies the same check-time rule as evaluateProof when given now", () => {
    const snap = snapshot();
    const target = offer(snap, K0);
    const early = validationFor(target);
    const late = { ...early, checkedAt: "2026-09-24T19:00:00.001Z" };
    expect(validValidationsFor(target, [early, late], NOW)).toEqual([early]);
    expect(validValidationsFor(target, [early, late])).toEqual([early, late]);
  });

  it("any validation checked after the gate's check time does not count", () => {
    const snap = snapshot();
    snap.proof.validations = snap.proof.validations.map((validation) =>
      (validation.offerId === K0 ? { ...validation, checkedAt: "2026-09-24T19:00:00.001Z" } : validation));
    expect(exclusion(snap, K0)).toMatch(/checkedAt is after the check time/);
  });

  it("catalog evidence may carry rawValidity {}", () => {
    const snap = catalogSnapshot();
    const evidence: Evidence = offer(snap, KC0).evidence[0]!;
    expect(evidence.rawValidity).toEqual({});
    expect(exclusion(snap, KC0)).toBe("");
  });
});

describe("storeAttestationFor (amendment section 3)", () => {
  const store: StoreAttestation = {
    family: "kroger", provider: "kroger-api", storeId: SCOPE, checkedAt: "2026-09-24T12:00:00.000Z",
    applicability: "verified", applicabilityEvidence: "synthetic: store page matches the Location API name and address",
  };
  const file: ValidationFile = { schemaVersion: 1, attestations: [], storeAttestations: [store], validations: [], pairs: [] };
  const none = { applicability: "unknown", attestation: null };

  it("defaults to unknown without a file, without storeAttestations or without an exact match", () => {
    expect(storeAttestationFor(null, "kroger", "kroger-api", SCOPE)).toMatchObject(none);
    expect(storeAttestationFor({ schemaVersion: 1, attestations: [], validations: [], pairs: [] }, "kroger", "kroger-api", SCOPE)).toMatchObject(none);
    expect(storeAttestationFor(file, "kroger", "kroger-api", OTHER_SCOPE)).toMatchObject(none);
    expect(storeAttestationFor(file, "kroger", "safeway-search", SCOPE)).toMatchObject(none);
    expect(storeAttestationFor(file, "albertsons", "kroger-api", SCOPE)).toMatchObject(none);
  });

  it("verifies an exactly matching, well-formed attestation", () => {
    expect(storeAttestationFor(file, "kroger", "kroger-api", SCOPE)).toEqual({ applicability: "verified", attestation: store, problems: [] });
    const safeway: StoreAttestation = { ...store, family: "albertsons", provider: "safeway-search", storeId: "9200" };
    expect(storeAttestationFor({ ...file, storeAttestations: [safeway] }, "albertsons", "safeway-search", "9200"))
      .toEqual({ applicability: "verified", attestation: safeway, problems: [] });
  });

  it("any invalid matching entry makes the store unknown, even beside a valid one", () => {
    const bad = { ...store, applicabilityEvidence: "" };
    for (const storeAttestations of [[store, bad], [bad, store]]) {
      const result = storeAttestationFor({ ...file, storeAttestations }, "kroger", "kroger-api", SCOPE);
      expect(result).toMatchObject(none);
      expect(result.problems.join("\n")).toMatch(/applicabilityEvidence/);
    }
    const otherStore = { ...bad, storeId: OTHER_SCOPE };
    expect(storeAttestationFor({ ...file, storeAttestations: [store, otherStore] }, "kroger", "kroger-api", SCOPE)).toMatchObject({ applicability: "verified" });
  });

  it("ignores malformed entries and a malformed list without throwing", () => {
    const storeAttestations = [null, "x", store] as unknown as StoreAttestation[];
    expect(storeAttestationFor({ ...file, storeAttestations }, "kroger", "kroger-api", SCOPE)).toMatchObject({ applicability: "verified" });
    const notAList = { ...file, storeAttestations: "x" } as unknown as ValidationFile;
    expect(storeAttestationFor(notAList, "kroger", "kroger-api", SCOPE)).toMatchObject(none);
  });

  it.each([
    ["a non-strict checkedAt", { checkedAt: "1" }, /checkedAt/],
    ["an unparseable checkedAt", { checkedAt: "yesterday" }, /checkedAt/],
    ["empty applicability evidence", { applicabilityEvidence: " " }, /applicabilityEvidence/],
    ["a missing applicability evidence", { applicabilityEvidence: undefined }, /applicabilityEvidence/],
    ["an applicability other than verified", { applicability: "unknown" }, /applicability must be verified/],
  ])("rejects %s", (_label, change, problem) => {
    const bad = { ...store, ...change } as StoreAttestation;
    const result = storeAttestationFor({ ...file, storeAttestations: [bad] }, "kroger", "kroger-api", SCOPE);
    expect(result).toMatchObject(none);
    expect(result.problems.join("\n")).toMatch(problem);
  });

  it("a kroger-api storeId must be an 8-digit locationId", () => {
    for (const storeId of ["9100001", "910000010", "9100000a", ""]) {
      const result = storeAttestationFor({ ...file, storeAttestations: [{ ...store, storeId }] }, "kroger", "kroger-api", storeId);
      expect(result).toMatchObject(none);
      expect(result.problems.join("\n")).toMatch(/8-digit/);
    }
  });

  it("a safeway-search storeId must be non-empty", () => {
    const safeway: StoreAttestation = { ...store, family: "albertsons", provider: "safeway-search", storeId: " " };
    const result = storeAttestationFor({ ...file, storeAttestations: [safeway] }, "albertsons", "safeway-search", " ");
    expect(result).toMatchObject(none);
    expect(result.problems.join("\n")).toMatch(/storeId/);
  });

  it("a provider attested for the wrong family is never verified", () => {
    const wrong: StoreAttestation[] = [
      { ...store, family: "albertsons" },
      { ...store, provider: "safeway-search", storeId: "9200" },
    ];
    expect(storeAttestationFor({ ...file, storeAttestations: [wrong[0]!] }, "albertsons", "kroger-api", SCOPE).problems.join("\n"))
      .toMatch(/provider kroger-api is allowed only for family kroger/);
    expect(storeAttestationFor({ ...file, storeAttestations: [wrong[1]!] }, "kroger", "safeway-search", "9200").problems.join("\n"))
      .toMatch(/provider safeway-search is allowed only for family albertsons/);
    for (const [entry, family] of [[wrong[0]!, "albertsons"], [wrong[1]!, "kroger"]] as const) {
      expect(storeAttestationFor({ ...file, storeAttestations: [entry] }, family, entry.provider, entry.storeId)).toMatchObject(none);
    }
  });
});

describe("attestationFor (R8/R9, amended)", () => {
  const attestation: FlyerAttestation = {
    family: "albertsons", flyerId: 8139228, checkedAt: "2026-09-24T12:00:00.000Z",
    applicability: "verified", applicabilityEvidence: "synthetic: store list",
    calendarRule: "verified-local-date", calendarEvidence: "synthetic: available 7 a.m. Wednesday",
    startLocalTime: "07:00",
  };
  const file: ValidationFile = { schemaVersion: 1, attestations: [attestation], validations: [], pairs: [] };

  it("defaults to unknown without a file or a matching entry", () => {
    const none = { applicability: "unknown", calendarRule: "unknown", startLocalTime: null, attestation: null };
    expect(attestationFor(null, "albertsons", 8139228)).toMatchObject(none);
    expect(attestationFor(file, "albertsons", 8139229)).toMatchObject(none);
    expect(attestationFor(file, "kroger", 8139228)).toMatchObject(none);
  });

  it("marks an exactly matching flyer verified with its printed start time", () => {
    expect(attestationFor(file, "albertsons", 8139228)).toEqual({
      applicability: "verified", calendarRule: "verified-local-date", startLocalTime: "07:00", attestation, problems: [],
    });
  });

  it("A8: any invalid attestation for the flyer makes it unknown, even beside a valid one", () => {
    const bad = { ...attestation, calendarEvidence: "" };
    for (const attestations of [[attestation, bad], [bad, attestation]]) {
      const result = attestationFor({ ...file, attestations }, "albertsons", 8139228);
      expect(result).toMatchObject({ applicability: "unknown", calendarRule: "unknown", startLocalTime: null, attestation: null });
      expect(result.problems.join("\n")).toMatch(/calendarEvidence/);
    }
    const otherFlyer = { ...bad, flyerId: 8139229 };
    expect(attestationFor({ ...file, attestations: [attestation, otherFlyer] }, "albertsons", 8139228)).toMatchObject({ applicability: "verified" });
  });

  it("valid attestations that disagree make the flyer unknown", () => {
    const other = { ...attestation, startLocalTime: "00:00" };
    const result = attestationFor({ ...file, attestations: [attestation, other] }, "albertsons", 8139228);
    expect(result).toMatchObject({ applicability: "unknown", calendarRule: "unknown" });
    expect(result.problems.join("\n")).toMatch(/disagree/);
  });

  it("ignores malformed attestation entries without throwing", () => {
    const attestations = [null, attestation] as unknown as FlyerAttestation[];
    expect(attestationFor({ ...file, attestations }, "albertsons", 8139228)).toMatchObject({ applicability: "verified" });
  });

  it.each([
    ["a non-strict checkedAt", { checkedAt: "1" }, /checkedAt/],
    ["an invalid startLocalTime", { startLocalTime: "7:00" }, /startLocalTime/],
    ["a missing startLocalTime", { startLocalTime: undefined }, /startLocalTime/],
    ["empty applicability evidence", { applicabilityEvidence: "" }, /applicabilityEvidence/],
    ["empty calendar evidence", { calendarEvidence: " " }, /calendarEvidence/],
    ["an unparseable checkedAt", { checkedAt: "yesterday" }, /checkedAt/],
  ])("rejects %s", (_label, change, problem) => {
    const bad = { ...attestation, ...change } as FlyerAttestation;
    const result = attestationFor({ ...file, attestations: [bad] }, "albertsons", 8139228);
    expect(result).toMatchObject({ applicability: "unknown", calendarRule: "unknown", startLocalTime: null, attestation: null });
    expect(result.problems.join("\n")).toMatch(problem);
  });
});

describe("assembleProof (synthetic)", () => {
  it("builds an empty proof without a validation file", () => {
    const snap = snapshot();
    const result = assembleProof(null, snap.offers, ["kroger", "albertsons"], "2026-09-24T13:00:00.000Z", "in-store-ad");
    expect(result.proof).toEqual({ validatedAt: "2026-09-24T13:00:00.000Z", families: ["kroger", "albertsons"], channel: "in-store-ad", validations: [], pairs: [] });
    expect(checkProof({ ...snap, proof: result.proof }, NOW).ok).toBe(false);
  });

  it("carries the gate channel it is given (proof.channel, amendment D2)", () => {
    const snap = snapshot();
    const file: ValidationFile = { schemaVersion: 1, attestations: [], validations: snap.proof.validations, pairs: snap.proof.pairs };
    const pickup = assembleProof(file, snap.offers, ["kroger", "albertsons"], "2026-09-24T13:00:00.000Z", "retailer-pickup");
    expect(pickup.proof.channel).toBe("retailer-pickup");
    // The ad offers are then outside the gate channel, so nothing counts.
    expect(checkProof({ ...snap, proof: pickup.proof }, NOW).ok).toBe(false);
    const ad = assembleProof(file, snap.offers, ["kroger", "albertsons"], "2026-09-24T13:00:00.000Z", "in-store-ad");
    expect(ad.proof.channel).toBe("in-store-ad");
    expect(checkProof({ ...snap, proof: ad.proof }, NOW).ok).toBe(true);
  });

  it("keeps entries for collected offers and notes the rest", () => {
    const snap = snapshot();
    const file: ValidationFile = {
      schemaVersion: 1, attestations: [],
      validations: [...snap.proof.validations, { ...snap.proof.validations[0]!, offerId: "flipp:kroger:9199999998" }],
      pairs: [...snap.proof.pairs, { leftId: "flipp:kroger:9199999998", rightId: A0, category: "produce" }],
    };
    const result = assembleProof(file, snap.offers, ["kroger", "albertsons"], "2026-09-24T13:00:00.000Z", "in-store-ad");
    expect(result.proof.validations).toHaveLength(20);
    expect(result.proof.pairs).toEqual(snap.proof.pairs);
    expect(result.notes.join("\n")).toMatch(/flipp:kroger:9199999998/);
    expect(checkProof({ ...snap, proof: result.proof }, NOW).ok).toBe(true);
  });
});

describe("candidatePairs (synthetic)", () => {
  it("proposes cross-family pairs with the same key, channel and basis only", () => {
    const snap = snapshot();
    offer(snap, offerId("albertsons", 1)).unitPrice = { basis: "each", cents: { n: "199", d: "1" } };
    offer(snap, offerId("albertsons", 2)).channel = "retailer-delivery";
    offer(snap, offerId("kroger", 3)).identity = { ...ground("beef", 20), freshFrozen: unknown } as Identity;
    const candidates = candidatePairs(snap.offers);
    const ids = candidates.map((candidate) => `${candidate.leftId}|${candidate.rightId}`);
    expect(ids).toContain(`${K0}|${A0}`);
    for (const i of [1, 2, 3]) expect(ids).not.toContain(`${offerId("kroger", i)}|${offerId("albertsons", i)}`);
    expect(candidates).toHaveLength(7);
    for (const candidate of candidates) {
      expect(offer(snap, candidate.leftId).family).not.toBe(offer(snap, candidate.rightId).family);
    }
    expect(candidates[0]).toMatchObject({ category: "produce", channel: "in-store-ad", basis: "lb", comparisonKey: expect.any(String) });
  });
});
