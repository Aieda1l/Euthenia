import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_VERIFIED_FIELDS,
  type Family,
  type FlyerAttestation,
  type Identity,
  type Offer,
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

// Synthetic proof fixtures. IDs start with "fixture:" and URLs use
// example.invalid; they are never collected or counted as live evidence.

const NOW = new Date("2026-09-24T19:00:00.000Z");
const OBSERVED_AT = "2026-09-24T12:00:00.000Z";

const known = <T>(value: T) => ({ state: "known" as const, value });
const na = { state: "not-applicable" as const };
const unknown = { state: "unknown" as const };

function fruit(kind: string): Identity {
  return { category: "produce", kind: known(kind), variety: na, form: known("whole"), organic: known(true) };
}
function ground(species: string, fat: number): Identity {
  return { category: "meat", species: known(species), cut: known("ground"), bone: na, skin: species === "beef" || species === "pork" ? na : unknown, freshFrozen: known("fresh"), fatPercent: known(fat) };
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

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeOffer(family: Family, sourceItemId: string, identity: Identity, offerId = `fixture:${family}:${sourceItemId}`): Offer {
  const rawSha256 = sha(`fixture body ${sourceItemId}`);
  return {
    id: offerId, family, retailer: `Fixture ${family}`, label: `fixture ${sourceItemId}`,
    postalCode: "98105", storeName: null, storeAddress: null,
    applicability: "verified", channel: "in-store-ad", identity,
    rawPrice: { current_price: "1.99", price_text: "/lb" },
    unitPrice: { basis: "lb", cents: { n: "199", d: "1" } },
    normalizationIssue: null, packageMassLb: null, packageCount: null, packageTotalCents: null,
    conditions: { complete: true, loyaltyRequired: null, couponRequired: null, couponIds: [], minimumUnits: null, maximumUnits: null, text: ["/lb"] },
    evidence: [{
      id: `fixture:item:${sourceItemId}:${rawSha256.slice(0, 12)}`, provider: "flipp", sourceItemId,
      retrievedUrl: `https://example.invalid/items/${sourceItemId}`, sourceUrl: `https://example.invalid/cutouts/${sourceItemId}.jpg`,
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
    applicabilityEvidence: "fixture: printed ad names the store",
    calendarEvidence: "fixture: printed ad dates",
  };
}

function snapshot(options: { kroger?: Identity[]; albertsons?: Identity[]; pairIndices?: number[] } = {}): SourceSnapshot {
  const kroger = (options.kroger ?? IDENTITIES).map((identity, i) => makeOffer("kroger", `k${i}`, identity));
  const albertsons = (options.albertsons ?? IDENTITIES).map((identity, i) => makeOffer("albertsons", `a${i}`, identity));
  const offers = [...kroger, ...albertsons];
  const pairs = (options.pairIndices ?? [0, 1, 2, 3, 4]).map((i) => ({
    leftId: `fixture:kroger:k${i}`, rightId: `fixture:albertsons:a${i}`,
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

const K0 = "fixture:kroger:k0";
const A0 = "fixture:albertsons:a0";

describe("checkProof passing case", () => {
  it("10+10 valid rows, both categories and 5 distinct supported pairs pass", () => {
    const result = checkProof(snapshot(), NOW);
    expect(result).toEqual({ ok: true, reasons: [] });
    const evaluation = evaluateProof(snapshot(), NOW);
    expect(evaluation.families.kroger).toMatchObject({ count: 10, produce: 7, meat: 3 });
    expect(evaluation.families.albertsons).toMatchObject({ count: 10, produce: 7, meat: 3 });
    expect(evaluation.countedPairs).toHaveLength(5);
  });
});

describe("checkProof failure matrix", () => {
  it("9 qualifying rows in one family fail", () => {
    const snap = snapshot();
    snap.offers = snap.offers.filter((candidate) => candidate.id !== "fixture:kroger:k9");
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
    const snap = snapshot();
    const duplicate = makeOffer("kroger", "k8", IDENTITIES[8]!, "fixture:kroger:k8-duplicate");
    snap.offers = snap.offers.filter((candidate) => candidate.id !== "fixture:kroger:k9");
    snap.offers.push(duplicate);
    snap.proof.validations.push(validationFor(duplicate));
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(false);
    expect(evaluateProof(snap, NOW).families.kroger.count).toBe(9);
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
    const extra = makeOffer("albertsons", "a10", IDENTITIES[0]!);
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
    offer(snap, K0).normalizationIssue = "fixture issue";
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
    snap.proof.validations[0]!.evidenceIds = ["fixture:item:k0:000000000000"];
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
    const twin = makeOffer("kroger", "k10", IDENTITIES[0]!);
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
    mismatched.proof.pairs[0] = { leftId: K0, rightId: "fixture:albertsons:a5", category: "produce" };
    expect(checkProof(mismatched, NOW).reasons.join("\n")).toMatch(/comparisonKey/);
    expect(checkProof(mismatched, NOW).ok).toBe(false);

    const wrongCategory = snapshot();
    wrongCategory.proof.pairs[0]!.category = "meat";
    expect(checkProof(wrongCategory, NOW).reasons.join("\n")).toMatch(/category/);
    expect(checkProof(wrongCategory, NOW).ok).toBe(false);
  });

  it("a pair with a missing or nonqualifying side does not count", () => {
    const snap = snapshot();
    snap.proof.pairs[0]!.rightId = "fixture:albertsons:ghost";
    expect(checkProof(snap, NOW).reasons.join("\n")).toMatch(/ghost.*not a qualifying offer/);
    expect(checkProof(snap, NOW).ok).toBe(false);
  });

  it("offers outside the proof families and dangling validations are reported, not counted", () => {
    const snap = snapshot();
    const pcc = makeOffer("pcc", "p0", fruit("strawberry"));
    snap.offers.push(pcc);
    snap.proof.validations.push(validationFor(pcc), { ...validationFor(pcc), offerId: "fixture:kroger:ghost" });
    const result = checkProof(snap, NOW);
    expect(result.ok).toBe(true);
    expect(result.reasons.join("\n")).toMatch(/fixture:pcc:p0.*not one of the proof families/);
    expect(result.reasons.join("\n")).toMatch(/validation references unknown offer fixture:kroger:ghost/);
  });

  it("duplicate offer IDs are excluded as ambiguous", () => {
    const snap = snapshot();
    snap.offers.push(makeOffer("kroger", "k0", IDENTITIES[0]!));
    expect(exclusion(snap, K0)).toMatch(/duplicate offer id/);
  });

  it("invalid proof families fail", () => {
    const snap = snapshot();
    snap.proof.families = ["kroger", "kroger"];
    expect(checkProof(snap, NOW).ok).toBe(false);
    expect(checkProof(snap, NOW).reasons.join("\n")).toMatch(/families/);
  });
});

describe("attestationFor (R8/R9, amended)", () => {
  const attestation: FlyerAttestation = {
    family: "albertsons", flyerId: 8139228, checkedAt: "2026-09-24T12:00:00.000Z",
    applicability: "verified", applicabilityEvidence: "fixture: store list",
    calendarRule: "verified-local-date", calendarEvidence: "fixture: available 7 a.m. Wednesday",
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

  it.each([
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

describe("assembleProof", () => {
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
      validations: [...snap.proof.validations, { ...snap.proof.validations[0]!, offerId: "fixture:kroger:gone" }],
      pairs: [...snap.proof.pairs, { leftId: "fixture:kroger:gone", rightId: A0, category: "produce" }],
    };
    const result = assembleProof(file, snap.offers, ["kroger", "albertsons"], "2026-09-24T13:00:00.000Z");
    expect(result.proof.validations).toHaveLength(20);
    expect(result.proof.pairs).toEqual(snap.proof.pairs);
    expect(result.notes.join("\n")).toMatch(/fixture:kroger:gone/);
    expect(checkProof({ ...snap, proof: result.proof }, NOW).ok).toBe(true);
  });
});

describe("candidatePairs", () => {
  it("proposes cross-family pairs with the same key, channel and basis only", () => {
    const snap = snapshot();
    offer(snap, "fixture:albertsons:a1").unitPrice = { basis: "each", cents: { n: "199", d: "1" } };
    offer(snap, "fixture:albertsons:a2").channel = "retailer-delivery";
    offer(snap, "fixture:kroger:k3").identity = { ...ground("beef", 20), freshFrozen: unknown } as Identity;
    const candidates = candidatePairs(snap.offers);
    const ids = candidates.map((candidate) => `${candidate.leftId}|${candidate.rightId}`);
    expect(ids).toContain(`${K0}|${A0}`);
    expect(ids).not.toContain("fixture:kroger:k1|fixture:albertsons:a1");
    expect(ids).not.toContain("fixture:kroger:k2|fixture:albertsons:a2");
    expect(ids).not.toContain("fixture:kroger:k3|fixture:albertsons:a3");
    expect(candidates).toHaveLength(7);
    for (const candidate of candidates) {
      expect(offer(snap, candidate.leftId).family).not.toBe(offer(snap, candidate.rightId).family);
    }
    expect(candidates[0]).toMatchObject({ category: "produce", channel: "in-store-ad", basis: "lb", comparisonKey: expect.any(String) });
  });
});
