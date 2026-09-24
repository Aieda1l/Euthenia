import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Family, Offer } from "../../src/shared/contracts.js";
import { comparisonKey } from "../../src/shared/identity.js";
import {
  classifyListRow,
  flippEvidence,
  normalizeFlipp,
  type FlippContext,
} from "../../src/source/normalize.js";
import { item } from "../fixtures/source.js";

const OBSERVED_AT = "2026-09-19T09:47:11.437Z";
const QFC_GROUND_CHUCK = 1038428171;
const QFC_APPLES = 1038427936;
const QFC_CHICKEN = 1038427929;
const SAFEWAY_BROCCOLI = 1039562699;
const SAFEWAY_BEEF = 1039561900;
const SAFEWAY_MELONS = 1039561931;
const ALL_FIXTURE_IDS = [QFC_GROUND_CHUCK, QFC_APPLES, QFC_CHICKEN, SAFEWAY_BROCCOLI, SAFEWAY_BEEF, SAFEWAY_MELONS];

const known = <T>(value: T) => ({ state: "known" as const, value });
const unknown = { state: "unknown" as const };

function familyOf(record: Record<string, unknown>): Family {
  return record.merchant === "QFC" ? "kroger" : "albertsons";
}

function context(
  record: Record<string, unknown>,
  overrides: Partial<FlippContext> = {},
): FlippContext {
  const retrievedUrl = `https://backflipp.wishabi.com/flipp/items/${String(record.id)}`;
  return {
    family: familyOf(record),
    retailer: String(record.merchant),
    postalCode: "98105",
    observedAt: OBSERVED_AT,
    evidence: flippEvidence({
      rawBody: JSON.stringify({ item: record }),
      item: record,
      retrievedUrl,
      observedAt: OBSERVED_AT,
    }),
    applicability: "unknown",
    calendarRule: "unknown",
    ...overrides,
  };
}

function normalize(record: Record<string, unknown>, overrides: Partial<FlippContext> = {}): Offer {
  return normalizeFlipp(record, context(record, overrides));
}

function synthetic(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    ...item(SAFEWAY_BROCCOLI),
    id: 9000000001,
    name: "Organic Strawberries",
    description: null,
    pre_price_text: null,
    price_text: "ea",
    disclaimer_text: null,
    sale_story: null,
    current_price: "3.99",
    ...fields,
  };
}

describe("fixture helper (R1)", () => {
  it("returns unwrapped item-detail records unchanged", () => {
    const record = item(SAFEWAY_BEEF);
    expect(record.id).toBe(SAFEWAY_BEEF);
    expect(record.current_price).toBe("4.99");
    expect(record).not.toHaveProperty("item");
  });
});

describe("normalizeFlipp on the committed research fixture", () => {
  it("QFC ground chuck: 1 lb package at 7.99 with card is 799 cents/lb", () => {
    const offer = normalize(item(QFC_GROUND_CHUCK));
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "799", d: "1" } });
    expect(offer.packageMassLb).toEqual({ n: "1", d: "1" });
    expect(offer.packageTotalCents).toBe(799);
    expect(offer.conditions.loyaltyRequired).toBe(true);
    expect(offer.conditions.complete).toBe(true);
    expect(offer.identity).toMatchObject({ category: "meat", species: known("beef"), cut: known("ground chuck"), bone: { state: "not-applicable" }, fatPercent: unknown });
    expect(offer.normalizationIssue).toBeNull();
  });

  it("QFC apples: /lb With Card is lb basis 177, kind apple, variety unknown", () => {
    const offer = normalize(item(QFC_APPLES));
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "177", d: "1" } });
    expect(offer.conditions.loyaltyRequired).toBe(true);
    expect(offer.identity).toMatchObject({ category: "produce", kind: known("apple"), variety: unknown });
    expect(comparisonKey(offer.identity)).toBeNull();
  });

  it("QFC chicken: empty current_price stays unknown, never zero", () => {
    const offer = normalize(item(QFC_CHICKEN));
    expect(offer.unitPrice).toBeNull();
    expect(offer.normalizationIssue).toMatch(/current_price/);
    expect(offer.rawPrice.current_price).toBe("");
    expect(offer.packageTotalCents).toBeNull();
    expect(offer.conditions.loyaltyRequired).toBe(true);
    expect(offer.conditions.complete).toBe(false);
    expect(offer.identity).toMatchObject({ species: known("chicken"), cut: unknown });
  });

  it("Safeway broccoli/cauliflower: lb basis 249 but kind unknown, so no key", () => {
    const offer = normalize(item(SAFEWAY_BROCCOLI));
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "249", d: "1" } });
    expect(offer.identity).toMatchObject({ category: "produce", kind: unknown });
    expect(comparisonKey(offer.identity)).toBeNull();
    expect(offer.conditions.loyaltyRequired).toBe(true);
  });

  it("Safeway beef: 499/lb, 3 lb package totaling 1497, limit 1, member price, 20% fat", () => {
    const offer = normalize(item(SAFEWAY_BEEF));
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "499", d: "1" } });
    expect(offer.packageMassLb).toEqual({ n: "3", d: "1" });
    expect(offer.packageTotalCents).toBe(1497);
    expect(offer.conditions.maximumUnits).toBe(1);
    expect(offer.conditions.minimumUnits).toBeNull();
    expect(offer.conditions.loyaltyRequired).toBe(true);
    expect(offer.conditions.complete).toBe(true);
    expect(offer.conditions.text).toEqual(["lb member price", "Limit 1"]);
    expect(offer.identity).toMatchObject({ category: "meat", species: known("beef"), cut: known("ground"), fatPercent: known(20), skin: { state: "not-applicable" } });
    expect(offer.normalizationIssue).toBeNull();
  });

  it("Safeway melons: 2 for 5.00 keeps the quantity, is each at 250, no mandatory minimum", () => {
    const offer = normalize(item(SAFEWAY_MELONS));
    expect(offer.unitPrice).toEqual({ basis: "each", cents: { n: "250", d: "1" } });
    expect(offer.rawPrice.pre_price_text).toBe("2 for");
    expect(offer.rawPrice.current_price).toBe("5.0");
    expect(offer.conditions.text).toContain("2 for");
    expect(offer.conditions.minimumUnits).toBeNull();
    expect(offer.conditions.loyaltyRequired).toBe(true);
    expect(offer.identity).toMatchObject({ category: "produce", kind: unknown });
  });

  it("no record gets expiry from available_to; unknown calendar keeps raw validity only", () => {
    for (const id of ALL_FIXTURE_IDS) {
      const offer = normalize({ ...item(id), available_to: "2026-10-31T23:59:59-04:00" });
      expect(offer.calendarRule).toBe("unknown");
      expect(offer.startsAt).toBeNull();
      expect(offer.expiresAt).toBeNull();
      expect(offer.evidence[0]?.rawValidity.available_to).toBe("2026-10-31T23:59:59-04:00");
    }
  });

  it("verified-local-date uses valid_to, not available_to, and keeps raw -04:00 strings in evidence", () => {
    const record = { ...item(SAFEWAY_MELONS), available_to: "2026-09-22T23:59:59-04:00" };
    const offer = normalize(record, { calendarRule: "verified-local-date", applicability: "verified", startLocalTime: "00:00" });
    expect(offer.calendarRule).toBe("verified-local-date");
    expect(offer.startsAt).toBe("2026-09-18T07:00:00.000Z");
    expect(offer.expiresAt).toBe("2026-09-19T07:00:00.000Z");
    expect(offer.evidence[0]?.rawValidity).toEqual({
      valid_from: "2026-09-18T00:00:00-04:00",
      valid_to: "2026-09-18T23:59:59-04:00",
      available_to: "2026-09-22T23:59:59-04:00",
      timezone: "-240",
    });
  });

  it("verified-local-date applies the attested start time", () => {
    const record = { ...item(SAFEWAY_BEEF), valid_from: "2026-09-23T00:00:00-04:00", valid_to: "2026-09-29T23:59:59-04:00" };
    const offer = normalize(record, { calendarRule: "verified-local-date", applicability: "verified", startLocalTime: "07:00" });
    expect(offer.startsAt).toBe("2026-09-23T14:00:00.000Z");
    expect(offer.expiresAt).toBe("2026-09-30T07:00:00.000Z");
    expect(offer.applicability).toBe("verified");
  });

  it("verified-local-date without a valid startLocalTime falls back to unknown with an issue", () => {
    const offer = normalize(item(SAFEWAY_BEEF), { calendarRule: "verified-local-date", applicability: "verified" });
    expect(offer.calendarRule).toBe("unknown");
    expect(offer.startsAt).toBeNull();
    expect(offer.expiresAt).toBeNull();
    expect(offer.normalizationIssue).toMatch(/startLocalTime/);
  });

  it("contradictory validity makes the calendar unknown with an issue", () => {
    const record = { ...item(SAFEWAY_BEEF), valid_from: "2026-09-23T00:00:00-04:00", valid_to: "2026-09-22T23:59:59-04:00" };
    const verified = normalize(record, { calendarRule: "verified-local-date", applicability: "verified", startLocalTime: "00:00" });
    expect(verified.calendarRule).toBe("unknown");
    expect(verified.startsAt).toBeNull();
    expect(verified.expiresAt).toBeNull();
    expect(verified.normalizationIssue).toMatch(/contradictory/);
    expect(normalize(record).normalizationIssue).toMatch(/contradictory/);
  });

  it("explicit-instant is not supported for Flipp and degrades to unknown", () => {
    const offer = normalize(item(SAFEWAY_BEEF), { calendarRule: "explicit-instant", applicability: "verified" });
    expect(offer.calendarRule).toBe("unknown");
    expect(offer.expiresAt).toBeNull();
    expect(offer.normalizationIssue).toMatch(/explicit-instant/);
  });

  it("builds IDs, provenance and context fields per R7", () => {
    const record = item(SAFEWAY_BEEF);
    const body = JSON.stringify({ item: record });
    const sha = createHash("sha256").update(body, "utf8").digest("hex");
    const offer = normalize(record, { applicability: "verified" });
    expect(offer.id).toBe("flipp:albertsons:1039561900");
    expect(offer.family).toBe("albertsons");
    expect(offer.retailer).toBe("Safeway");
    expect(offer.label).toBe("Signature SELECT® Lean Ground Beef");
    expect(offer.postalCode).toBe("98105");
    expect(offer.channel).toBe("in-store-ad");
    expect(offer.storeName).toBeNull();
    expect(offer.storeAddress).toBeNull();
    expect(offer.applicability).toBe("verified");
    expect(offer.observedAt).toBe(OBSERVED_AT);
    expect(offer.evidence).toEqual([
      {
        id: `flipp:item:1039561900:${sha.slice(0, 12)}`,
        provider: "flipp",
        sourceItemId: "1039561900",
        retrievedUrl: "https://backflipp.wishabi.com/flipp/items/1039561900",
        sourceUrl: "http://f.wishabi.net/page_items/433409071/1789051001/extra_large.jpg",
        observedAt: OBSERVED_AT,
        rawSha256: sha,
        rawValidity: { valid_from: "2026-09-16T00:00:00-04:00", valid_to: "2026-09-22T23:59:59-04:00", timezone: "-240" },
      },
    ]);
  });

  it("A9: hashes exact response bytes as-is and a string as UTF-8", () => {
    const record = item(SAFEWAY_BEEF);
    const body = JSON.stringify({ item: record });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(body, "utf8")]);
    const input = { item: record, retrievedUrl: "https://backflipp.wishabi.com/flipp/items/1039561900", observedAt: OBSERVED_AT };
    const fromBytes = flippEvidence({ ...input, rawBody: bytes });
    const fromString = flippEvidence({ ...input, rawBody: body });
    expect(fromBytes.rawSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(fromString.rawSha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
    expect(fromBytes.rawSha256).not.toBe(fromString.rawSha256);
    expect(fromBytes.id).toBe(`flipp:item:1039561900:${fromBytes.rawSha256.slice(0, 12)}`);
  });

  it("A8: verified-local-date requires T00:00:00 and T23:59:59 raw times with an explicit offset", () => {
    const cases: Array<[string, string]> = [
      ["2026-09-23T07:00:00-04:00", "2026-09-29T23:59:59-04:00"],
      ["2026-09-23T00:00:00-04:00", "2026-09-30T00:00:00-04:00"],
      ["2026-09-23T00:00:00Z", "2026-09-29T23:59:59Z"],
      ["2026-09-23T00:00:00", "2026-09-29T23:59:59"],
      ["2026-09-23", "2026-09-29"],
    ];
    for (const [validFrom, validTo] of cases) {
      const record = { ...item(SAFEWAY_BEEF), valid_from: validFrom, valid_to: validTo };
      const offer = normalize(record, { calendarRule: "verified-local-date", applicability: "verified", startLocalTime: "00:00" });
      expect(offer.calendarRule).toBe("unknown");
      expect(offer.startsAt).toBeNull();
      expect(offer.expiresAt).toBeNull();
      expect(offer.normalizationIssue).toMatch(/valid_(?:from|to).*T(?:00:00:00|23:59:59)/);
    }
  });

  it("falls back to retrievedUrl when there is no cutout_image_url", () => {
    const record = { ...item(SAFEWAY_BEEF), cutout_image_url: null };
    const evidence = flippEvidence({ rawBody: "{}", item: record, retrievedUrl: "https://backflipp.wishabi.com/flipp/items/1039561900", observedAt: OBSERVED_AT });
    expect(evidence.sourceUrl).toBe("https://backflipp.wishabi.com/flipp/items/1039561900");
  });

  it("rejects evidence for a different source item", () => {
    const record = item(SAFEWAY_BEEF);
    const wrong = context(item(QFC_APPLES));
    expect(() => normalizeFlipp(record, wrong)).toThrow(/sourceItemId/);
  });
});

describe("unit basis (R5) on synthetic text", () => {
  it("/lb is lb and each is each", () => {
    expect(normalize(synthetic({ price_text: "/lb" })).unitPrice).toEqual({ basis: "lb", cents: { n: "399", d: "1" } });
    expect(normalize(synthetic({ price_text: "ea" })).unitPrice).toEqual({ basis: "each", cents: { n: "399", d: "1" } });
    expect(normalize(synthetic({ price_text: "each" })).unitPrice).toEqual({ basis: "each", cents: { n: "399", d: "1" } });
  });

  it("3 for keeps an exact rational each price", () => {
    const offer = normalize(synthetic({ pre_price_text: "3 for", price_text: null, current_price: "5.00" }));
    expect(offer.unitPrice).toEqual({ basis: "each", cents: { n: "500", d: "3" } });
  });

  it("an explicit required purchase sets minimumUnits", () => {
    const offer = normalize(synthetic({ pre_price_text: "2 for", price_text: null, current_price: "5.00", disclaimer_text: "Must Buy 2" }));
    expect(offer.conditions.minimumUnits).toBe(2);
    expect(offer.conditions.complete).toBe(true);
  });

  it.each([
    ["pint", { name: "Organic Blueberries 1 Pint", price_text: "ea" }, /pint/],
    ["bunch", { name: "Organic Cilantro", price_text: "bunch" }, /bunch|basis/],
    ["bag", { name: "Organic Gala Apples 3 lb Bag", price_text: "ea" }, /bag/],
    ["size range", { name: "Organic Strawberries", description: "2-4 lb", price_text: "/lb" }, /range/],
    ["missing basis", { price_text: "member price" }, /basis/],
    ["each with a stated mass", { description: "16 oz", price_text: "ea" }, /mass/],
    ["conflicting bases", { price_text: "/lb ea" }, /conflict/],
    ["N for with a per-lb basis", { pre_price_text: "2 for", price_text: "/lb" }, /conflict/],
    ["multi-pound price", { pre_price_text: "2 lbs for", price_text: null }, /2 lbs for/],
    ["numeric price", { current_price: 3.99 }, /current_price/],
  ])("%s stays unknown with a specific issue", (_label, fields, issue) => {
    const offer = normalize(synthetic(fields));
    expect(offer.unitPrice).toBeNull();
    expect(offer.normalizationIssue).toMatch(issue);
  });

  it("zero stays distinguishable from missing", () => {
    expect(normalize(synthetic({ current_price: "0.00" })).unitPrice).toEqual({ basis: "each", cents: { n: "0", d: "1" } });
    expect(normalize(synthetic({ current_price: null })).unitPrice).toBeNull();
  });

  it.each([
    ["a leading-zero package", { price_text: null, description: "01 lb Package", current_price: "7.99" }],
    ["a leading-zero package total", { name: "Fresh 80% Lean Ground Beef", price_text: "lb", description: "03 lb Twin Pack for $14.97", current_price: "4.99" }],
    ["a huge N for", { pre_price_text: "99999999999999999999 for", price_text: null }],
    ["N for above the cap of 100", { pre_price_text: "101 for", price_text: null }],
    ["a leading-zero N for", { pre_price_text: "02 for", price_text: null }],
  ])("%s becomes a normalization issue, never a throw", (_label, fields) => {
    let offer: Offer | undefined;
    expect(() => { offer = normalize(synthetic(fields)); }).not.toThrow();
    expect(offer?.unitPrice).toBeNull();
    expect(offer?.normalizationIssue).toMatch(/leading-zero|multi-buy quantity/);
  });

  it("N for up to the cap of 100 is still supported", () => {
    expect(normalize(synthetic({ pre_price_text: "100 for", price_text: null, current_price: "5.00" })).unitPrice)
      .toEqual({ basis: "each", cents: { n: "5", d: "1" } });
  });

  it("a package total that contradicts the per-lb price is not trusted", () => {
    const offer = normalize(synthetic({ name: "Fresh Lean Ground Beef", description: "80% Sold in a 3 lb pack for $12.00", price_text: "lb", current_price: "4.99" }));
    expect(offer.unitPrice).toBeNull();
    expect(offer.normalizationIssue).toMatch(/package total/);
  });
});

describe("A5: leftover price wording and discounts on synthetic text", () => {
  it.each([
    ["2/ with a 1 lb package", { pre_price_text: "2/", price_text: null, description: "1 lb Package", current_price: "7.00" }, /pre_price_text.*"2\/"/],
    ["Starting at", { pre_price_text: "Starting at", price_text: "lb" }, /pre_price_text.*Starting at/],
    ["SAVE", { pre_price_text: "SAVE", price_text: "lb", current_price: "2.00" }, /pre_price_text.*SAVE/],
    ["up to", { pre_price_text: "Up to", price_text: "lb" }, /Up to/],
    ["as low as", { pre_price_text: "As low as", price_text: "ea" }, /As low as/],
    ["BOGO", { price_text: "ea BOGO" }, /price_text.*BOGO/],
    ["buy ... get", { price_text: "Buy 1 Get 1 ea" }, /Buy 1 Get 1/],
    ["off", { price_text: "lb off" }, /price_text.*off/],
    ["a dollars_off discount", { price_text: "lb", dollars_off: "1.00" }, /dollars_off/],
    ["a percent_off discount", { price_text: "lb", percent_off: "20" }, /percent_off/],
  ])("%s gives unitPrice null with a specific issue", (_label, fields, issue) => {
    const offer = normalize(synthetic(fields));
    expect(offer.unitPrice).toBeNull();
    expect(offer.normalizationIssue).toMatch(issue);
  });

  it("recognized vocabulary alone leaves the unit price intact", () => {
    expect(normalize(synthetic({ price_text: "/lb With Card" })).unitPrice).toEqual({ basis: "lb", cents: { n: "399", d: "1" } });
    expect(normalize(synthetic({ price_text: "lb member price" })).unitPrice).toEqual({ basis: "lb", cents: { n: "399", d: "1" } });
    expect(normalize(synthetic({ pre_price_text: "2 for", price_text: "Club Card Price", current_price: "5.00" })).unitPrice)
      .toEqual({ basis: "each", cents: { n: "250", d: "1" } });
    expect(normalize(synthetic({ price_text: "per lb" })).normalizationIssue).toBeNull();
  });

  it("every committed fixture record keeps its unit result", () => {
    const units = ALL_FIXTURE_IDS.map((id) => normalize(item(id)).unitPrice);
    expect(units).toEqual([
      { basis: "lb", cents: { n: "799", d: "1" } },
      { basis: "lb", cents: { n: "177", d: "1" } },
      null,
      { basis: "lb", cents: { n: "249", d: "1" } },
      { basis: "lb", cents: { n: "499", d: "1" } },
      { basis: "each", cents: { n: "250", d: "1" } },
    ]);
    for (const id of [QFC_GROUND_CHUCK, QFC_APPLES, SAFEWAY_BROCCOLI, SAFEWAY_BEEF, SAFEWAY_MELONS]) {
      expect(normalize(item(id)).normalizationIssue).toBeNull();
    }
  });
});

describe("conditions (R6) on synthetic text", () => {
  it("A6: purchase, spend, required, additional and $amount are condition indicators", () => {
    expect(normalize(synthetic({ price_text: "ea", description: "Limit 4 with $25 purchase" })).conditions)
      .toMatchObject({ maximumUnits: 4, complete: false });
    expect(normalize(synthetic({ price_text: "ea", description: "Limit 2, additional at regular price" })).conditions.complete).toBe(false);
    expect(normalize(synthetic({ price_text: "ea", description: "When you spend $50" })).conditions.complete).toBe(false);
    expect(normalize(synthetic({ price_text: "ea", description: "Purchase required" })).conditions.complete).toBe(false);
  });

  it("silence gives null loyalty and coupon requirements", () => {
    const offer = normalize(synthetic({ price_text: "ea" }));
    expect(offer.conditions).toEqual({
      complete: true, loyaltyRequired: null, couponRequired: null, couponIds: [],
      minimumUnits: null, maximumUnits: null, text: ["ea"],
    });
  });

  it("explicit coupon text requires a coupon", () => {
    const offer = normalize(synthetic({ price_text: "ea with digital coupon" }));
    expect(offer.conditions.couponRequired).toBe(true);
    expect(offer.conditions.complete).toBe(true);
    // A5 lists only lb/each, "N for" and loyalty/member phrases as price
    // vocabulary, so coupon wording in price_text leaves the unit price unknown.
    expect(offer.unitPrice).toBeNull();
    expect(offer.normalizationIssue).toMatch(/price_text.*digital coupon/);
  });

  it("unrecognized condition text marks conditions incomplete", () => {
    const offer = normalize(synthetic({ price_text: "ea", sale_story: "Buy 1 Get 1 Free" }));
    expect(offer.conditions.complete).toBe(false);
    expect(offer.conditions.text).toContain("Buy 1 Get 1 Free");
  });

  it("condition words in the description are parsed or flagged", () => {
    expect(normalize(synthetic({ price_text: "ea", description: "Limit 4" })).conditions).toMatchObject({ maximumUnits: 4, complete: true });
    expect(normalize(synthetic({ price_text: "ea", description: "Save $2 when you buy 3" })).conditions.complete).toBe(false);
  });

  it("conflicting limits leave maximumUnits null and incomplete", () => {
    const offer = normalize(synthetic({ price_text: "ea", disclaimer_text: "Limit 1", description: "Limit 4" }));
    expect(offer.conditions.maximumUnits).toBeNull();
    expect(offer.conditions.complete).toBe(false);
  });
});

describe("list-row classification (R2)", () => {
  it("classifies list rows by their current text", () => {
    expect(classifyListRow({ id: 1, name: "Cosmic Crisp, Envy or Pink Lady Apples", price: "1.77" })).toEqual({ category: "produce", reason: null });
    expect(classifyListRow({ id: 2, name: "Signature SELECT® Lean Ground Beef" })).toEqual({ category: "meat", reason: null });
    expect(classifyListRow({ id: 3, name: "Wild Sockeye Salmon Fillets" })).toMatchObject({ category: "excluded", reason: expect.stringMatching(/seafood/) });
    expect(classifyListRow({ id: 4, name: 42 })).toMatchObject({ category: "excluded" });
  });

  it("uses the description on detail records", () => {
    expect(classifyListRow({ id: 5, name: "Blueberries", description: "Frozen, 3 lb" })).toMatchObject({ category: "excluded", reason: expect.stringMatching(/frozen produce/) });
  });

  it("normalizeFlipp refuses excluded items", () => {
    const record = synthetic({ name: "Wild Sockeye Salmon Fillets" });
    expect(() => normalize(record)).toThrow(/excluded/);
  });
});

describe("second fix round: price wording, package totals and coupons (synthetic)", () => {
  it("N1: 'no coupon required' wording gives couponRequired false, not true", () => {
    expect(normalize(synthetic({ price_text: "ea", description: "No coupon required" })).conditions)
      .toMatchObject({ couponRequired: false, complete: true });
    expect(normalize(synthetic({ price_text: "ea", sale_story: "No digital coupon needed" })).conditions)
      .toMatchObject({ couponRequired: false, complete: true });
    expect(normalize(synthetic({ price_text: "ea", sale_story: "Coupon not required" })).conditions)
      .toMatchObject({ couponRequired: false, complete: true });
  });

  it("N1: contradictory coupon statements leave couponRequired null and incomplete", () => {
    const offer = normalize(synthetic({ price_text: "ea", sale_story: "Digital coupon required", description: "No coupon needed" }));
    expect(offer.conditions).toMatchObject({ couponRequired: null, complete: false });
  });

  it.each([
    ["¢ in price_text", { price_text: "¢ lb", current_price: "99" }, /price_text.*"¢ lb".*\("¢"\)/],
    ["$ in pre_price_text", { pre_price_text: "$", price_text: "lb" }, /pre_price_text.*"\$"/],
    ["% in price_text", { price_text: "% lb" }, /price_text.*"% lb"/],
  ])("N3: %s is leftover wording, so the unit price is null", (_label, fields, issue) => {
    const offer = normalize(synthetic(fields));
    expect(offer.unitPrice).toBeNull();
    expect(offer.normalizationIssue).toMatch(issue);
  });

  it("N4: a package total with more than two decimals never parses as a truncated amount", () => {
    const offer = normalize(synthetic({ name: "Fresh 80% Lean Ground Beef", description: "3 lb pack for $14.975", price_text: "lb", current_price: "4.99" }));
    expect(offer.packageTotalCents).toBeNull();
    expect(offer.packageMassLb).toBeNull();
    // The unparsed amount still marks the conditions incomplete.
    expect(offer.conditions.complete).toBe(false);
  });

  it("N6 (pinned): pre_price_text \"2\" with price_text \"for\" gives a null unit price with an issue", () => {
    const offer = normalize(synthetic({ pre_price_text: "2", price_text: "for", current_price: "5.00" }));
    expect(offer.unitPrice).toBeNull();
    expect(offer.normalizationIssue).toMatch(/pre_price_text wording "2"/);
    expect(offer.normalizationIssue).toMatch(/price_text wording "for"/);
  });
});
