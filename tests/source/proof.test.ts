import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_VERIFIED_FIELDS,
  type Family,
  type FlyerAttestation,
  type Identity,
  type Offer,
  type Proof,
  type SourceSnapshot,
  type Validation,
  type ValidationFile,
} from "../../src/shared/contracts.js";
import {
  assembleProof,
  attestationFor,
  candidatePairs,
  checkProof,
  evaluateProof,
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
    proof: { validatedAt: "2026-09-24T13:00:00.000Z", families: ["kroger", "albertsons"], validations: offers.map(validationFor), pairs },
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
    const result = assembleProof(null, snap.offers, ["kroger", "albertsons"], "2026-09-24T13:00:00.000Z");
    expect(result.proof).toEqual({ validatedAt: "2026-09-24T13:00:00.000Z", families: ["kroger", "albertsons"], validations: [], pairs: [] });
    expect(checkProof({ ...snap, proof: result.proof }, NOW).ok).toBe(false);
  });

  it("keeps entries for collected offers and notes the rest", () => {
    const snap = snapshot();
    const file: ValidationFile = {
      schemaVersion: 1, attestations: [],
      validations: [...snap.proof.validations, { ...snap.proof.validations[0]!, offerId: "flipp:kroger:9199999998" }],
      pairs: [...snap.proof.pairs, { leftId: "flipp:kroger:9199999998", rightId: A0, category: "produce" }],
    };
    const result = assembleProof(file, snap.offers, ["kroger", "albertsons"], "2026-09-24T13:00:00.000Z");
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
