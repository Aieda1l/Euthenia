import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_VERIFIED_FIELDS, type Family, type SourceSnapshot, type ValidationFile } from "../../src/shared/contracts.js";
import { collect, parseCollectArgs, type CollectOptions } from "../../src/source/collect.js";
import { checkProof } from "../../src/source/proof.js";
import { item } from "../fixtures/source.js";

// Collector tests. Every response comes from an injected fetcher: a synthetic
// listing, synthetic flyer rows and item bodies that are either the committed
// research fixture records or clearly synthetic records. Nothing here is a
// live run, and all writes go to a per-test temporary directory.

const NOW = new Date("2026-09-24T19:00:00.000Z");
const clock = () => new Date(NOW.getTime());
const BASE = "https://backflipp.wishabi.com/flipp";
const LISTING_URL = `${BASE}/flyers?postal_code=98105`;
const flyerUrl = (id: number) => `${BASE}/flyers/${id}?postal_code=98105`;
const itemUrl = (id: number) => `${BASE}/items/${id}`;

const CURRENT = { valid_from: "2026-09-23T00:00:00-04:00", valid_to: "2026-09-29T23:59:59-04:00" };
const EXPIRED = { valid_from: "2026-09-16T00:00:00-04:00", valid_to: "2026-09-22T23:59:59-04:00" };
const BIG_BOOK = { valid_from: "2026-09-08T00:00:00-04:00", valid_to: "2026-10-04T23:59:59-04:00" };

// Research fixture IDs (historical); flyer IDs match the fixture items' flyer_id.
const QFC_FLYER = 8123483;
const SAFEWAY_FLYER = 8129241;
const QFC_ITEMS = [1038428171, 1038427936, 1038427929];
const SAFEWAY_ITEMS = [1039562699, 1039561900, 1039561931];
const SEAFOOD_ROW = { id: 5001, name: "Wild Sockeye Salmon Fillets" };
const CHEESE_ROW = { id: 5002, name: "Tillamook Cheddar Cheese" };
const SHRIMP_ROW = { id: 5003, name: "Jumbo Raw Shrimp" };
const BACON_ROW = { id: 5004, name: "Oscar Mayer Bacon" };
const EXCLUDED_IDS = [SEAFOOD_ROW.id, CHEESE_ROW.id, SHRIMP_ROW.id, BACON_ROW.id];

type Body = string | (() => Response);

function flyer(id: number, merchant: string, name: string, window: { valid_from: string; valid_to: string }) {
  return { id, merchant, merchant_id: 1, name, ...window, is_store_select: true };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Injected fetcher over a URL -> body map. Unknown URLs are 404. */
function routes(map: Map<string, Body>) {
  const requested: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    requested.push(url);
    const body = map.get(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return typeof body === "string" ? jsonResponse(body) : body();
  });
  return { fetcher, requested };
}

/** Fixture world: current QFC and Safeway Weekly Ads plus distractors. */
function fixtureWorld(listingFlyers?: unknown[]) {
  const map = new Map<string, Body>();
  map.set(LISTING_URL, JSON.stringify({
    flyers: listingFlyers ?? [
      flyer(8000001, "QFC", "Weekly Ad", EXPIRED),
      flyer(QFC_FLYER, "QFC", "Weekly Ad", CURRENT),
      flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT),
      flyer(8000002, "Safeway", "Big Book of Savings", BIG_BOOK),
      flyer(8000003, "Fred Meyer", "Weekly Ad", CURRENT),
      flyer(8000004, "Albertsons", "Weekly Ad", CURRENT),
    ],
  }));
  const row = (id: number) => ({ id, name: item(id).name, price: item(id).current_price });
  map.set(flyerUrl(QFC_FLYER), JSON.stringify({ items: [...QFC_ITEMS.map(row), SEAFOOD_ROW, CHEESE_ROW] }));
  map.set(flyerUrl(SAFEWAY_FLYER), JSON.stringify({ items: [...SAFEWAY_ITEMS.map(row), SHRIMP_ROW, BACON_ROW] }));
  const bodies = new Map<number, string>();
  for (const id of [...QFC_ITEMS, ...SAFEWAY_ITEMS]) {
    const body = JSON.stringify({ item: item(id) });
    bodies.set(id, body);
    map.set(itemUrl(id), body);
  }
  return { map, bodies };
}

// --- Synthetic PASS world (fixture:-style synthetic records, not research data) ---

const SYN_QFC_FLYER = 9101;
const SYN_SAFEWAY_FLYER = 9102;
const SYN_NAMES = [
  "Organic Strawberries", "Organic Blueberries", "Organic Raspberries", "Organic Blackberries",
  "Organic Bananas", "Organic Lemons", "Organic Broccoli",
  "Fresh Boneless Skinless Chicken Breasts", "Fresh 93% Lean Ground Beef", "Fresh Boneless Pork Loin Chops",
];
const SYN_PAIRS = [0, 1, 2, 7, 8];

function syntheticItem(id: number, flyerId: number, merchant: string, name: string): Record<string, unknown> {
  return {
    id, flyer_id: flyerId, merchant, name, description: null,
    current_price: "2.99", pre_price_text: null, price_text: "lb", sale_story: null, disclaimer_text: null,
    ...CURRENT, timezone: "America/New_York",
    cutout_image_url: `https://example.invalid/cutouts/${id}.jpg`,
  };
}

function syntheticWorld() {
  const map = new Map<string, Body>();
  map.set(LISTING_URL, JSON.stringify({
    flyers: [flyer(SYN_QFC_FLYER, "QFC", "Weekly Ad", CURRENT), flyer(SYN_SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT)],
  }));
  const families: Array<[Family, number, string, number]> = [
    ["kroger", SYN_QFC_FLYER, "QFC", 7001],
    ["albertsons", SYN_SAFEWAY_FLYER, "Safeway", 8001],
  ];
  const evidenceIds = new Map<string, string>();
  for (const [family, flyerId, merchant, firstId] of families) {
    const rows = SYN_NAMES.map((name, index) => ({ id: firstId + index, name }));
    map.set(flyerUrl(flyerId), JSON.stringify({ items: [...rows, { id: firstId + 50, name: "Wild Salmon Fillets" }] }));
    for (const row of rows) {
      const body = JSON.stringify({ item: syntheticItem(row.id, flyerId, merchant, row.name) });
      map.set(itemUrl(row.id), body);
      evidenceIds.set(`flipp:${family}:${row.id}`, `flipp:item:${row.id}:${sha256(body).slice(0, 12)}`);
    }
  }
  const attestation = (family: Family, flyerId: number) => ({
    family, flyerId, checkedAt: "2026-09-24T18:00:00.000Z",
    applicability: "verified" as const, applicabilityEvidence: "synthetic test attestation",
    calendarRule: "verified-local-date" as const, calendarEvidence: "synthetic test calendar", startLocalTime: "07:00",
  });
  const file: ValidationFile = {
    schemaVersion: 1,
    attestations: [attestation("kroger", SYN_QFC_FLYER), attestation("albertsons", SYN_SAFEWAY_FLYER)],
    validations: [...evidenceIds].map(([offerId, evidenceId]) => ({
      offerId, checkedAt: "2026-09-24T18:30:00.000Z", evidenceIds: [evidenceId],
      verifiedFields: [...REQUIRED_VERIFIED_FIELDS],
      applicabilityEvidence: "synthetic", calendarEvidence: "synthetic",
    })),
    pairs: SYN_PAIRS.map((index) => ({
      leftId: `flipp:kroger:${7001 + index}`, rightId: `flipp:albertsons:${8001 + index}`,
      category: index >= 7 ? "meat" as const : "produce" as const,
    })),
  };
  return { map, file };
}

// --- Temporary directories ---

let root: string;
let dataDir: string;
let snapshotPath: string;
const PRIOR_SNAPSHOT = '{"prior":"snapshot","keep":true}\n';
const PRIOR_MTIME = new Date("2026-09-01T12:00:00.000Z");
const repoData = new URL("../../data/", import.meta.url);
let repoDataExisted: boolean;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "euthenia-collect-"));
  dataDir = join(root, "data");
  snapshotPath = join(dataDir, "snapshots", "m1-source.json");
  repoDataExisted = existsSync(repoData);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedPriorSnapshot(): void {
  mkdirSync(join(dataDir, "snapshots"), { recursive: true });
  writeFileSync(snapshotPath, PRIOR_SNAPSHOT);
  utimesSync(snapshotPath, PRIOR_MTIME, PRIOR_MTIME);
}

function expectPriorSnapshotPreserved(): void {
  expect(readFileSync(snapshotPath, "utf8")).toBe(PRIOR_SNAPSHOT);
  expect(statSync(snapshotPath).mtime.toISOString()).toBe(PRIOR_MTIME.toISOString());
  expect(readdirSync(join(dataDir, "snapshots"))).toEqual(["m1-source.json"]);
}

function writeValidations(value: unknown): string {
  const path = join(root, "validations.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

function run(fetcher: typeof fetch, overrides: Partial<CollectOptions> = {}) {
  return collect({ postalCode: "98105", dataDir, fetcher, clock, ...overrides });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function diagnostics(auditDir: string): Record<string, unknown> {
  return readJson(join(auditDir, "diagnostics.json"));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

describe("flyer selection (R11)", () => {
  it("selects the current QFC and Safeway Weekly Ads from the listing only", async () => {
    const { fetcher, requested } = routes(fixtureWorld().map);
    const result = await run(fetcher);
    const flyers = diagnostics(result.auditDir).flyers as Array<Record<string, unknown>>;
    expect(flyers.map((entry) => [entry.family, entry.retailer, entry.id, entry.name])).toEqual([
      ["kroger", "QFC", QFC_FLYER, "Weekly Ad"],
      ["albertsons", "Safeway", SAFEWAY_FLYER, "Weekly Ad"],
    ]);
    expect(flyers[0]).toMatchObject({ valid_from: CURRENT.valid_from, valid_to: CURRENT.valid_to });
    expect(requested).toContain(flyerUrl(QFC_FLYER));
    expect(requested).toContain(flyerUrl(SAFEWAY_FLYER));
    for (const ignored of [8000001, 8000002, 8000003, 8000004]) expect(requested).not.toContain(flyerUrl(ignored));
  });

  it("ignores an expired flyer and fails when no current Weekly Ad remains", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld([flyer(8000001, "QFC", "Weekly Ad", EXPIRED), flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT)]);
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/kroger/);
    expect(result.message).toMatch(/8000001/);
    expect(requested).toEqual([LISTING_URL]);
    expectPriorSnapshotPreserved();
  });

  it("fails when two current Weekly Ads match one family, listing both", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld([
      flyer(QFC_FLYER, "QFC", "Weekly Ad", CURRENT),
      flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT),
      flyer(8000009, "Safeway", "Weekly Ad - Seattle", CURRENT),
    ]);
    const { fetcher } = routes(world.map);
    const result = await run(fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/albertsons/);
    expect(result.message).toMatch(new RegExp(`${SAFEWAY_FLYER}[\\s\\S]*8000009`));
    expectPriorSnapshotPreserved();
  });

  it("fails when a family has no Weekly Ad at all", async () => {
    const world = fixtureWorld([flyer(QFC_FLYER, "QFC", "Weekly Ad", CURRENT), flyer(8000002, "Safeway", "Big Book of Savings", BIG_BOOK)]);
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/albertsons/);
  });
});

describe("item collection", () => {
  it("fetches details only for produce/meat rows and records the other rows as excluded", async () => {
    const { fetcher, requested } = routes(fixtureWorld().map);
    const result = await run(fetcher);
    for (const id of [...QFC_ITEMS, ...SAFEWAY_ITEMS]) expect(requested).toContain(itemUrl(id));
    for (const id of EXCLUDED_IDS) expect(requested).not.toContain(itemUrl(id));
    const excluded = diagnostics(result.auditDir).excludedRows as Array<Record<string, unknown>>;
    const reasonFor = (id: number) => excluded.find((entry) => entry.itemId === id)?.reason;
    expect(reasonFor(SEAFOOD_ROW.id)).toMatch(/seafood/);
    expect(reasonFor(SHRIMP_ROW.id)).toMatch(/seafood/);
    expect(reasonFor(BACON_ROW.id)).toMatch(/cured or processed/);
    expect(reasonFor(CHEESE_ROW.id)).toMatch(/non-produce/);
    expect(result.snapshot?.offers.map((offer) => offer.id)).toEqual([
      ...QFC_ITEMS.map((id) => `flipp:kroger:${id}`),
      ...SAFEWAY_ITEMS.map((id) => `flipp:albertsons:${id}`),
    ]);
  });

  it("binds evidence to the exact served body and keeps raw bodies in the audit", async () => {
    const world = fixtureWorld();
    const result = await run(routes(world.map).fetcher);
    for (const offer of result.snapshot?.offers ?? []) {
      const id = Number(offer.evidence[0]?.sourceItemId);
      const body = world.bodies.get(id) ?? "";
      expect(offer.evidence[0]?.rawSha256).toBe(sha256(body));
      expect(offer.evidence[0]?.id).toBe(`flipp:item:${id}:${sha256(body).slice(0, 12)}`);
      expect(offer.evidence[0]?.retrievedUrl).toBe(itemUrl(id));
      expect(offer.observedAt).toBe(NOW.toISOString());
      expect(offer.channel).toBe("in-store-ad");
      expect(offer.postalCode).toBe("98105");
      expect(readFileSync(join(result.auditDir, "raw", `item-${id}.json`), "utf8")).toBe(body);
    }
    expect(readFileSync(join(result.auditDir, "raw", "listing.json"), "utf8")).toBe(world.map.get(LISTING_URL));
    expect(readFileSync(join(result.auditDir, "raw", `flyer-${QFC_FLYER}.json`), "utf8")).toBe(world.map.get(flyerUrl(QFC_FLYER)));
  });

  it("hashes the exact served bytes, including a leading BOM, and stores those bytes", async () => {
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[1] ?? 0;
    const served = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ item: item(id) }), "utf8")]);
    world.map.set(itemUrl(id), () => new Response(served, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
    const result = await run(routes(world.map).fetcher);
    const hash = createHash("sha256").update(served).digest("hex");
    const offer = result.snapshot?.offers.find((candidate) => candidate.id === `flipp:albertsons:${id}`);
    expect(offer?.evidence[0]?.rawSha256).toBe(hash);
    expect(offer?.evidence[0]?.id).toBe(`flipp:item:${id}:${hash.slice(0, 12)}`);
    expect(readFileSync(join(result.auditDir, "raw", `item-${id}.json`)).equals(served)).toBe(true);
  });

  it("excludes an item whose detail re-classifies out of scope, without failing the run", async () => {
    const world = fixtureWorld();
    const id = QFC_ITEMS[1] ?? 0;
    world.map.set(itemUrl(id), JSON.stringify({ item: { ...item(id), description: "Cooked and seasoned" } }));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(1);
    const excluded = diagnostics(result.auditDir).excludedRows as Array<Record<string, unknown>>;
    expect(excluded.find((entry) => entry.itemId === id)).toMatchObject({ stage: "detail", reason: expect.stringMatching(/prepared/) });
    expect(result.snapshot?.offers.some((offer) => offer.id === `flipp:kroger:${id}`)).toBe(false);
  });

  it("excludes an item detail that names a different flyer", async () => {
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[0] ?? 0;
    world.map.set(itemUrl(id), JSON.stringify({ item: { ...item(id), flyer_id: 1 } }));
    const result = await run(routes(world.map).fetcher);
    const excluded = diagnostics(result.auditDir).excludedRows as Array<Record<string, unknown>>;
    expect(excluded.find((entry) => entry.itemId === id)).toMatchObject({ stage: "detail", reason: expect.stringMatching(/flyer_id 1 is not the selected flyer/) });
  });

  it("requests a repeated list row once and records the duplicate", async () => {
    const world = fixtureWorld();
    const id = QFC_ITEMS[0] ?? 0;
    const rows = [...QFC_ITEMS, id].map((rowId) => ({ id: rowId, name: item(rowId).name }));
    world.map.set(flyerUrl(QFC_FLYER), JSON.stringify({ items: rows }));
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(requested.filter((url) => url === itemUrl(id))).toHaveLength(1);
    const excluded = diagnostics(result.auditDir).excludedRows as Array<Record<string, unknown>>;
    expect(excluded).toContainEqual(expect.objectContaining({ itemId: id, stage: "list", reason: expect.stringMatching(/duplicate/) }));
  });
});

describe("gate outcomes and snapshot preservation", () => {
  it("without a validations file the run is BLOCKED, exits 1 and preserves the snapshot", async () => {
    seedPriorSnapshot();
    const reportPath = join(root, "reports", "proof.md");
    const result = await run(routes(fixtureWorld().map).fetcher, { reportPath });
    expect(result.status).toBe("BLOCKED");
    expect(result.exitCode).toBe(1);
    expect(result.snapshotWritten).toBe(false);
    expectPriorSnapshotPreserved();
    const report = readFileSync(join(result.auditDir, "report.md"), "utf8");
    expect(readFileSync(reportPath, "utf8")).toBe(report);
    expect(report).toMatch(/Status: BLOCKED/);
    expect(report).not.toMatch(/Status: PASS/);
    expect(report).not.toMatch(/\blive\b/i);
    expect(report).toMatch(/injected fetcher/);
    expect(report).toMatch(/no validation file/);
    expect(report).toContain("flipp:kroger:1038428171");
    expect(report).toContain("Wild Sockeye Salmon Fillets");
    const diag = diagnostics(result.auditDir);
    expect(diag).toMatchObject({ status: "BLOCKED", exitCode: 1, snapshotWritten: false });
    expect((diag.evaluation as { ok: boolean }).ok).toBe(false);
  });

  it("synthetic PASS: attested flyers and matching validations replace the snapshot atomically", async () => {
    seedPriorSnapshot();
    const world = syntheticWorld();
    const reportPath = join(root, "proof.md");
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file), reportPath });
    expect(result.status).toBe("PASS");
    expect(result.exitCode).toBe(0);
    expect(result.snapshotWritten).toBe(true);
    expect(readdirSync(join(dataDir, "snapshots"))).toEqual(["m1-source.json"]);
    const written = readJson(snapshotPath) as unknown as SourceSnapshot;
    expect(written).toEqual(result.snapshot);
    expect(written.offers).toHaveLength(20);
    expect(written.collectedAt).toBe(NOW.toISOString());
    expect(checkProof(written, NOW)).toEqual({ ok: true, reasons: [] });
    expect(written.offers.every((offer) => offer.applicability === "verified" && offer.calendarRule === "verified-local-date")).toBe(true);
    // A7 shapes, produced by the real flippEvidence/normalizeFlipp path.
    for (const offer of written.offers) {
      const evidence = offer.evidence[0];
      const id = evidence?.sourceItemId ?? "";
      expect(offer.id).toBe(`flipp:${offer.family}:${id}`);
      expect(evidence?.retrievedUrl).toBe(itemUrl(Number(id)));
      expect(evidence?.id).toBe(`flipp:item:${id}:${evidence?.rawSha256.slice(0, 12)}`);
    }
    const report = readFileSync(reportPath, "utf8");
    expect(report).toMatch(/Status: PASS/);
    expect(report).toMatch(/injected fetcher/);
  });

  it("an attestation for another flyer ID verifies nothing, so the run is BLOCKED", async () => {
    seedPriorSnapshot();
    const world = syntheticWorld();
    const file = { ...world.file, attestations: world.file.attestations.map((entry) => ({ ...entry, flyerId: entry.flyerId + 1 })) };
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(file) });
    expect(result.exitCode).toBe(1);
    expect(result.snapshot?.offers.every((offer) => offer.applicability === "unknown")).toBe(true);
    expectPriorSnapshotPreserved();
  });

  it("a source error exits 2 and preserves the snapshot", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    world.map.delete(itemUrl(SAFEWAY_ITEMS[0] ?? 0));
    const reportPath = join(root, "proof.md");
    const result = await run(routes(world.map).fetcher, { reportPath });
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/404/);
    expectPriorSnapshotPreserved();
    expect(readFileSync(reportPath, "utf8")).toMatch(/Status: ERROR/);
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "ERROR", exitCode: 2 });
  });

  it("an HTML bot page instead of the listing exits 2", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    world.map.set(LISTING_URL, () => new Response("<html>Access denied</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/HTML/);
    expectPriorSnapshotPreserved();
  });

  it("Retry-After beyond 15 s defers with exit 3, records the next permitted time and preserves the snapshot", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    world.map.set(itemUrl(QFC_ITEMS[0] ?? 0), () => new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(result.status).toBe("DEFERRED");
    expect(result.exitCode).toBe(3);
    expect(result.nextPermittedAt).toBe("2026-09-24T19:02:00.000Z");
    expect(requested.filter((url) => url === itemUrl(QFC_ITEMS[0] ?? 0))).toHaveLength(1);
    // No new detail request starts after the deferral (only the two workers' first items).
    expect(requested.filter((url) => url.includes("/flipp/items/"))).toHaveLength(2);
    for (const id of SAFEWAY_ITEMS) expect(requested).not.toContain(itemUrl(id));
    expectPriorSnapshotPreserved();
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "DEFERRED", exitCode: 3, nextPermittedAt: "2026-09-24T19:02:00.000Z" });
    const report = readFileSync(join(result.auditDir, "report.md"), "utf8");
    expect(report).toMatch(/Status: DEFERRED/);
    expect(report).toContain("2026-09-24T19:02:00.000Z");
  });
});

describe("inputs", () => {
  it.each([
    ["not JSON", "{ nope"],
    ["the wrong schemaVersion", { schemaVersion: 2, attestations: [], validations: [], pairs: [] }],
    ["validations that are not an array", { schemaVersion: 1, attestations: [], validations: "x", pairs: [] }],
    ["an attestation with a string flyerId", { schemaVersion: 1, attestations: [{ family: "kroger", flyerId: "1", checkedAt: "x", applicability: "verified", applicabilityEvidence: "x", calendarRule: "verified-local-date", calendarEvidence: "x", startLocalTime: "07:00" }], validations: [], pairs: [] }],
    ["an unknown family", { schemaVersion: 1, attestations: [{ family: "costco", flyerId: 1, checkedAt: "x", applicability: "verified", applicabilityEvidence: "x", calendarRule: "verified-local-date", calendarEvidence: "x", startLocalTime: "07:00" }], validations: [], pairs: [] }],
    ["a validation missing verifiedFields", { schemaVersion: 1, attestations: [], validations: [{ offerId: "a", checkedAt: "x", evidenceIds: [], applicabilityEvidence: "x", calendarEvidence: "x" }], pairs: [] }],
    ["a pair with a bad category", { schemaVersion: 1, attestations: [], validations: [], pairs: [{ leftId: "a", rightId: "b", category: "seafood" }] }],
    ["an unknown key", { schemaVersion: 1, attestations: [], validations: [], pairs: [], pair: [] }],
  ])("a validations file with %s exits 2 before any request", async (_label, content) => {
    seedPriorSnapshot();
    const { fetcher } = routes(fixtureWorld().map);
    const result = await run(fetcher, { validationsPath: writeValidations(content) });
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/validations/i);
    expect(fetcher).not.toHaveBeenCalled();
    expectPriorSnapshotPreserved();
  });

  it("a missing validations file exits 2", async () => {
    const { fetcher } = routes(fixtureWorld().map);
    const result = await run(fetcher, { validationsPath: join(root, "missing.json") });
    expect(result.exitCode).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a validations file with a UTF-8 BOM", async () => {
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(`\uFEFF${JSON.stringify(world.file)}`) });
    expect(result.exitCode).toBe(0);
  });

  it("any postal code other than 98105 is a usage error", async () => {
    const { fetcher } = routes(fixtureWorld().map);
    const result = await run(fetcher, { postalCode: "98106" });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/98105/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("parses CLI arguments strictly", () => {
    expect(parseCollectArgs(["--postal-code", "98105"])).toEqual({ ok: true, postalCode: "98105", validationsPath: null, reportPath: null });
    expect(parseCollectArgs(["--postal-code", "98105", "--validations", "v.json", "--report", "r.md"]))
      .toEqual({ ok: true, postalCode: "98105", validationsPath: "v.json", reportPath: "r.md" });
    expect(parseCollectArgs([])).toMatchObject({ ok: false, message: expect.stringMatching(/--postal-code/) });
    expect(parseCollectArgs(["--postal-code", "98105", "--bogus"])).toMatchObject({ ok: false });
    expect(parseCollectArgs(["--postal-code", "98105", "extra"])).toMatchObject({ ok: false });
  });
});

describe("write boundaries", () => {
  it("writes only inside the injected data directory and the report path", async () => {
    seedPriorSnapshot();
    const world = syntheticWorld();
    const validationsPath = writeValidations(world.file);
    const first = await run(routes(fixtureWorld().map).fetcher, { reportPath: join(root, "out", "blocked.md") });
    const second = await run(routes(world.map).fetcher, { validationsPath, reportPath: join(root, "out", "pass.md") });
    expect(first.runId).not.toBe(second.runId);
    const files = filesUnder(root);
    for (const file of files) {
      expect(
        file.startsWith(`data/audit/${first.runId}/`) || file.startsWith(`data/audit/${second.runId}/`) ||
        ["data/snapshots/m1-source.json", "out/blocked.md", "out/pass.md", "validations.json"].includes(file),
        file,
      ).toBe(true);
    }
    expect(files).toContain(`data/audit/${first.runId}/diagnostics.json`);
    expect(files).toContain(`data/audit/${first.runId}/report.md`);
    expect(first.runId).toMatch(/^[0-9TZ-]+$/);
    expect(existsSync(repoData)).toBe(repoDataExisted);
  });
});
