import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_VERIFIED_FIELDS, type Family, type SourceSnapshot, type ValidationFile } from "../../src/shared/contracts.js";
import { comparisonKey } from "../../src/shared/identity.js";
import { collect, parseCollectArgs, terminalSafe, type CollectOptions } from "../../src/source/collect.js";
import { checkProof } from "../../src/source/proof.js";
import { item } from "../fixtures/source.js";

// Collector tests. Every response comes from an injected fetcher: a synthetic
// listing, synthetic flyer rows and item bodies that are either the committed
// research fixture records or clearly synthetic records. Nothing here is a
// live run, and all writes go to a per-test temporary directory.

// Snapshot renames can be made to fail with chosen error codes (item 9 retry),
// and the temp-file cleanup rm with another (H8).
const renames = vi.hoisted(() => ({ failures: [] as string[], calls: 0, rmFailure: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renames.calls += 1;
      const code = renames.failures.shift();
      if (code !== undefined) throw Object.assign(new Error(`${code}: simulated rename failure`), { code });
      return actual.rename(from, to);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const code = renames.rmFailure;
      if (code !== null) throw Object.assign(new Error(`${code}: simulated rm failure`), { code });
      return actual.rm(...args);
    },
  };
});

// normalizeFlipp can be made to throw for chosen item IDs (H1).
const normalizeFailures = vi.hoisted(() => ({ ids: new Set<number>() }));
vi.mock("../../src/source/normalize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/source/normalize.js")>();
  return {
    ...actual,
    normalizeFlipp: (...args: Parameters<typeof actual.normalizeFlipp>) => {
      if (normalizeFailures.ids.has(Number(args[0].id))) throw new Error("simulated normalization failure");
      return actual.normalizeFlipp(...args);
    },
  };
});

const NOW = new Date("2026-09-24T19:00:00.000Z");
const RUN_ID = "2026-09-24T19-00-00-000Z";
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
const QFC_ITEMS = [1038428171, 1038427936, 1038427929] as const;
const SAFEWAY_ITEMS = [1039562699, 1039561900, 1039561931] as const;
const SEAFOOD_ROW = { id: 5001, name: "Wild Sockeye Salmon Fillets" };
const CHEESE_ROW = { id: 5002, name: "Tillamook Cheddar Cheese" };
const SHRIMP_ROW = { id: 5003, name: "Jumbo Raw Shrimp" };
const BACON_ROW = { id: 5004, name: "Oscar Mayer Bacon" };
const EXCLUDED_IDS = [SEAFOOD_ROW.id, CHEESE_ROW.id, SHRIMP_ROW.id, BACON_ROW.id];
const DEFERRAL = { status: 429, headers: { "retry-after": "120" } };
const NEXT_PERMITTED = "2026-09-24T19:02:00.000Z";

type Body = string | ((init?: RequestInit) => Response | Promise<Response>);

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
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requested.push(url);
    const body = map.get(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return typeof body === "string" ? jsonResponse(body) : body(init);
  });
  return { fetcher, requested };
}

const listRow = (id: number) => ({ id, name: item(id).name, price: item(id).current_price });

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
  map.set(flyerUrl(QFC_FLYER), JSON.stringify({ items: [...QFC_ITEMS.map(listRow), SEAFOOD_ROW, CHEESE_ROW] }));
  map.set(flyerUrl(SAFEWAY_FLYER), JSON.stringify({ items: [...SAFEWAY_ITEMS.map(listRow), SHRIMP_ROW, BACON_ROW] }));
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
/** The ground beef rows carry package terms: 3 lb for $8.97 at 2.99/lb. */
const SYN_PACKAGE_INDEX = 8;

function syntheticItem(id: number, flyerId: number, merchant: string, name: string, description: string | null): Record<string, unknown> {
  return {
    id, flyer_id: flyerId, merchant, name, description,
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
    rows.forEach((row, index) => {
      const description = index === SYN_PACKAGE_INDEX ? "3 lb Package for $8.97" : null;
      const body = JSON.stringify({ item: syntheticItem(row.id, flyerId, merchant, row.name, description) });
      map.set(itemUrl(row.id), body);
      evidenceIds.set(`flipp:${family}:${row.id}`, `flipp:item:${row.id}:${sha256(body).slice(0, 12)}`);
    });
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
      applicabilityEvidence: "synthetic validation applicability", calendarEvidence: "synthetic validation calendar",
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
  renames.failures = [];
  renames.calls = 0;
  renames.rmFailure = null;
  normalizeFailures.ids.clear();
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

function auditReport(auditDir: string): string {
  return readFileSync(join(auditDir, "report.md"), "utf8");
}

function excludedRows(auditDir: string): Array<Record<string, unknown>> {
  return diagnostics(auditDir).excludedRows as Array<Record<string, unknown>>;
}

/** Lines of one "## " report section, without its heading. */
function section(report: string, heading: string): string[] {
  const lines = report.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${heading}`));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
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
    expect(flyers[0]).toMatchObject({ valid_from: CURRENT.valid_from, valid_to: CURRENT.valid_to, detailCandidates: 3 });
    expect(flyers[0]).not.toHaveProperty("detailRequests");
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

  it("does not treat flyer validity without an explicit offset or Z as current", async () => {
    const local = { valid_from: "2026-09-23T00:00:00", valid_to: "2026-09-29T23:59:59" };
    const world = fixtureWorld([flyer(QFC_FLYER, "QFC", "Weekly Ad", local), flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT)]);
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/kroger \(QFC\): 0 current/);
  });

  it("ignores malformed flyers from other merchants and notes them (A11)", async () => {
    const world = fixtureWorld([
      flyer(QFC_FLYER, "QFC", "Weekly Ad", CURRENT),
      flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT),
      { id: "bad", merchant: "Fred Meyer", name: "Weekly Ad", ...CURRENT },
      { id: 8000010, merchant: "Albertsons", name: null, ...CURRENT },
    ]);
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(1);
    const notes = diagnostics(result.auditDir).listingNotes as string[];
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/Fred Meyer/);
    expect(notes[1]).toMatch(/Albertsons/);
    expect(auditReport(result.auditDir)).toContain("Albertsons");
  });

  it("a malformed QFC flyer in the listing is a schema error (A11)", async () => {
    const world = fixtureWorld([
      { id: 8000011, merchant: "QFC", name: "Weekly Ad", valid_from: 5, valid_to: "x" },
      flyer(QFC_FLYER, "QFC", "Weekly Ad", CURRENT),
      flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT),
    ]);
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/schema/);
  });
});

describe("item collection", () => {
  it("fetches details only for produce/meat rows and records the other rows as excluded", async () => {
    const { fetcher, requested } = routes(fixtureWorld().map);
    const result = await run(fetcher);
    for (const id of [...QFC_ITEMS, ...SAFEWAY_ITEMS]) expect(requested).toContain(itemUrl(id));
    for (const id of EXCLUDED_IDS) expect(requested).not.toContain(itemUrl(id));
    const excluded = excludedRows(result.auditDir);
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
      const flyerId = offer.family === "kroger" ? QFC_FLYER : SAFEWAY_FLYER;
      const body = world.bodies.get(id) ?? "";
      expect(offer.evidence[0]?.rawSha256).toBe(sha256(body));
      expect(offer.evidence[0]?.id).toBe(`flipp:item:${id}:${sha256(body).slice(0, 12)}`);
      expect(offer.evidence[0]?.retrievedUrl).toBe(itemUrl(id));
      expect(offer.observedAt).toBe(NOW.toISOString());
      expect(offer.channel).toBe("in-store-ad");
      expect(offer.postalCode).toBe("98105");
      expect(readFileSync(join(result.auditDir, "raw", `item-${flyerId}-${id}.json`), "utf8")).toBe(body);
    }
    expect(readFileSync(join(result.auditDir, "raw", "listing.json"), "utf8")).toBe(world.map.get(LISTING_URL));
    expect(readFileSync(join(result.auditDir, "raw", `flyer-${QFC_FLYER}.json`), "utf8")).toBe(world.map.get(flyerUrl(QFC_FLYER)));
  });

  it("hashes the exact served bytes, including a leading BOM, and stores those bytes", async () => {
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[1];
    const served = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ item: item(id) }), "utf8")]);
    world.map.set(itemUrl(id), () => new Response(served, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
    const result = await run(routes(world.map).fetcher);
    const hash = createHash("sha256").update(served).digest("hex");
    const offer = result.snapshot?.offers.find((candidate) => candidate.id === `flipp:albertsons:${id}`);
    expect(offer?.evidence[0]?.rawSha256).toBe(hash);
    expect(offer?.evidence[0]?.id).toBe(`flipp:item:${id}:${hash.slice(0, 12)}`);
    expect(readFileSync(join(result.auditDir, "raw", `item-${SAFEWAY_FLYER}-${id}.json`)).equals(served)).toBe(true);
  });

  it("keeps raw file names unique when one item ID appears in both flyers", async () => {
    const world = fixtureWorld();
    const shared = QFC_ITEMS[0];
    world.map.set(flyerUrl(SAFEWAY_FLYER), JSON.stringify({ items: [...SAFEWAY_ITEMS, shared].map(listRow) }));
    const result = await run(routes(world.map).fetcher);
    expect(existsSync(join(result.auditDir, "raw", `item-${QFC_FLYER}-${shared}.json`))).toBe(true);
    expect(existsSync(join(result.auditDir, "raw", `item-${SAFEWAY_FLYER}-${shared}.json`))).toBe(true);
  });

  it("excludes an item whose detail re-classifies out of scope, without failing the run", async () => {
    const world = fixtureWorld();
    const id = QFC_ITEMS[1];
    world.map.set(itemUrl(id), JSON.stringify({ item: { ...item(id), description: "Cooked and seasoned" } }));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(1);
    expect(excludedRows(result.auditDir).find((entry) => entry.itemId === id)).toMatchObject({ stage: "detail", reason: expect.stringMatching(/prepared/) });
    expect(result.snapshot?.offers.some((offer) => offer.id === `flipp:kroger:${id}`)).toBe(false);
  });

  it("B3: an item detail that names a different flyer is a run-level source error (A11)", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[0];
    world.map.set(itemUrl(id), JSON.stringify({ item: { ...item(id), flyer_id: 1 } }));
    const result = await run(routes(world.map).fetcher);
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(new RegExp(`item detail flyer_id 1 is not the selected flyer ${SAFEWAY_FLYER}`));
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "ERROR", exitCode: 2, error: { name: "FlippSourceError", url: itemUrl(id) } });
    expect(excludedRows(result.auditDir).some((entry) => entry.itemId === id)).toBe(false);
    expectPriorSnapshotPreserved();
  });

  it.each<[string, (record: Record<string, unknown>) => Record<string, unknown>, RegExp]>([
    ["missing", (record) => {
      const copy = { ...record };
      delete copy.flyer_id;
      return copy;
    }, /schema: item detail flyer_id is missing/],
    ["null", (record) => ({ ...record, flyer_id: null }), /schema: item detail flyer_id null is not an integer/],
    ["a numeric string", (record) => ({ ...record, flyer_id: String(SAFEWAY_FLYER) }), new RegExp(`schema: item detail flyer_id "${SAFEWAY_FLYER}" is not an integer`)],
    ["a one-element array", (record) => ({ ...record, flyer_id: [SAFEWAY_FLYER] }), new RegExp(`schema: item detail flyer_id \\[${SAFEWAY_FLYER}\\] is not an integer`)],
    ["a fraction", (record) => ({ ...record, flyer_id: SAFEWAY_FLYER + 0.5 }), new RegExp(`schema: item detail flyer_id ${SAFEWAY_FLYER}\\.5 is not an integer`)],
  ])("F5: an item detail whose flyer_id is %s is a run-level schema error", async (_label, change, message) => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[0];
    world.map.set(itemUrl(id), JSON.stringify({ item: change(item(id)) }));
    const result = await run(routes(world.map).fetcher);
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(message);
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "ERROR", exitCode: 2, error: { name: "FlippSourceError", url: itemUrl(id) } });
    expect(result.snapshot).toBeNull();
    expectPriorSnapshotPreserved();
  });

  it("H1: a normalization failure ends the run as a source error, never a per-item exclusion", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[1];
    normalizeFailures.ids.add(id);
    const result = await run(routes(world.map).fetcher);
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/simulated normalization failure/);
    expect(excludedRows(result.auditDir).some((entry) => entry.itemId === id)).toBe(false);
    expectPriorSnapshotPreserved();
  });

  it("requests a repeated list row once and records the duplicate", async () => {
    const world = fixtureWorld();
    const id = QFC_ITEMS[0];
    world.map.set(flyerUrl(QFC_FLYER), JSON.stringify({ items: [...QFC_ITEMS, id].map(listRow) }));
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(requested.filter((url) => url === itemUrl(id))).toHaveLength(1);
    expect(excludedRows(result.auditDir)).toContainEqual(expect.objectContaining({ itemId: id, stage: "list", reason: expect.stringMatching(/duplicate/) }));
  });
});

describe("per-item and list-row failures (A11)", () => {
  it.each([404, 410])("an item-detail HTTP %i excludes only that item, with its URL and status", async (status) => {
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[0];
    world.map.set(itemUrl(id), () => new Response("gone", { status }));
    const result = await run(routes(world.map).fetcher);
    expect(result.status).toBe("BLOCKED");
    expect(result.exitCode).toBe(1);
    expect(excludedRows(result.auditDir).find((entry) => entry.itemId === id)).toEqual({
      family: "albertsons", flyerId: SAFEWAY_FLYER, itemId: id, name: item(id).name, stage: "detail",
      reason: expect.stringMatching(new RegExp(`HTTP ${status}`)), url: itemUrl(id), status,
    });
    expect(result.snapshot?.offers).toHaveLength(5);
  });

  it("when every detail request for a selected flyer fails, the run is a source error", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    for (const id of QFC_ITEMS) world.map.delete(itemUrl(id));
    const result = await run(routes(world.map).fetcher);
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(new RegExp(`kroger flyer ${QFC_FLYER}.*3 of 3`));
    expectPriorSnapshotPreserved();
  });

  it.each([401, 403])("an item-detail HTTP %i is a run-level source error", async (status) => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    world.map.set(itemUrl(SAFEWAY_ITEMS[0]), () => new Response("denied", { status }));
    const reportPath = join(root, "proof.md");
    const result = await run(routes(world.map).fetcher, { reportPath });
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(String(status));
    expectPriorSnapshotPreserved();
    expect(readFileSync(reportPath, "utf8")).toMatch(/Status: ERROR/);
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "ERROR", exitCode: 2, error: { status } });
  });

  it("a 404 for the listing or a flyer stays run-level", async () => {
    const world = fixtureWorld();
    world.map.delete(flyerUrl(SAFEWAY_FLYER));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/404/);
  });

  it.each<[string, Body, RegExp]>([
    ["a schema error", JSON.stringify({ item: { ...item(SAFEWAY_ITEMS[0]), name: 42 } }), /schema: item detail item\.name is not a string/],
    ["an HTML page on 200", () => new Response("<html>bot check</html>", { status: 200, headers: { "content-type": "text/html" } }), /HTML page instead of JSON/],
    ["a wrong content-type", () => new Response(JSON.stringify({ item: item(SAFEWAY_ITEMS[0]) }), { status: 200, headers: { "content-type": "text/plain" } }), /content-type "text\/plain" is not application\/json/],
    ["invalid UTF-8", () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200, headers: { "content-type": "application/json" } }), /not valid UTF-8/],
    ["malformed JSON", "{ nope", /malformed JSON/],
    ["5xx after retries", () => new Response(null, { status: 503, headers: { "retry-after": "0" } }), /HTTP 503 after 2 retries/],
    ["a transport failure", () => { throw new TypeError("fetch failed"); }, /request failed: fetch failed/],
  ])("H2: an item detail with %s is a run-level source error (exit 2)", async (_label, body, message) => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    world.map.set(itemUrl(SAFEWAY_ITEMS[0]), body);
    const result = await run(routes(world.map).fetcher);
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(message);
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "ERROR", exitCode: 2, error: { name: "FlippSourceError" } });
    expect(excludedRows(result.auditDir).some((entry) => entry.itemId === SAFEWAY_ITEMS[0])).toBe(false);
    expectPriorSnapshotPreserved();
  });

  it("an item-detail id mismatch is a run-level source error", async () => {
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[2];
    world.map.set(itemUrl(id), JSON.stringify({ item: { ...item(id), id: 42 } }));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/does not match requested item/);
  });

  it("a list row with a valid id but no string name is an excluded row, not a failure", async () => {
    const world = fixtureWorld();
    world.map.set(flyerUrl(QFC_FLYER), JSON.stringify({ items: [...QFC_ITEMS.map(listRow), { id: 5010 }, { id: 5011, name: 7 }] }));
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(result.exitCode).toBe(1);
    const excluded = excludedRows(result.auditDir);
    for (const id of [5010, 5011]) {
      expect(excluded).toContainEqual(expect.objectContaining({ itemId: id, name: null, stage: "list", reason: expect.stringMatching(/name/) }));
      expect(requested).not.toContain(itemUrl(id));
    }
  });

  it("a list row with an invalid id is still a schema error", async () => {
    const world = fixtureWorld();
    world.map.set(flyerUrl(QFC_FLYER), JSON.stringify({ items: [...QFC_ITEMS.map(listRow), { id: "5012", name: "Gala Apples" }] }));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/schema/);
  });
});

describe("deferral and run-wide abort (A12)", () => {
  interface Held { settleFirst?: () => void; settleSecond?: () => void }

  /**
   * Barrier for two item requests: each item's first request is held until
   * both have arrived, then both replies are settled in the given order in one
   * callback. The replies share a code path, so each is judged before either
   * failure stops the run, in that order. A later request for either item gets
   * a 500 (the tests count requests). If the barrier never fills, a settle
   * function stays undefined and the test's toBeDefined check fails loudly.
   */
  function settleTogether(world: ReturnType<typeof fixtureWorld>, first: [number, () => Response], second: [number, () => Response]): Held {
    const held: Held = {};
    const hold = (slot: keyof Held, reply: () => Response) => {
      let calls = 0;
      return () => (calls++ > 0 ? new Response(null, { status: 500 }) : new Promise<Response>((settle) => {
        held[slot] = () => settle(reply());
        if (held.settleFirst === undefined || held.settleSecond === undefined) return; // wait for the other request
        held.settleFirst();
        held.settleSecond();
      }));
    };
    world.map.set(itemUrl(first[0]), hold("settleFirst", first[1]));
    world.map.set(itemUrl(second[0]), hold("settleSecond", second[1]));
    return held;
  }

  it("a deferral stops all traffic: the other item's retry is never sent and the exit is 3", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    const [a, b] = QFC_ITEMS;
    // H10: b's 503 is settled before a's deferral, in one step, so b is
    // waiting to retry when the deferral stops the run.
    const held = settleTogether(world, [b, () => new Response(null, { status: 503 })], [a, () => new Response(null, DEFERRAL)]);
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(held.settleFirst).toBeDefined();
    expect(held.settleSecond).toBeDefined();
    expect(result.status).toBe("DEFERRED");
    expect(result.exitCode).toBe(3);
    expect(result.nextPermittedAt).toBe(NEXT_PERMITTED);
    expect(requested.filter((url) => url === itemUrl(a))).toHaveLength(1);
    expect(requested.filter((url) => url === itemUrl(b))).toHaveLength(1);
    const attempts = diagnostics(result.auditDir).attempts as Array<Record<string, unknown>>;
    expect(attempts).toContainEqual(expect.objectContaining({ url: itemUrl(b), status: 503, error: expect.stringMatching(/retry 1 of 2/) }));
    // Only the two workers' first items were ever requested.
    expect(requested.filter((url) => url.includes("/flipp/items/")).sort()).toEqual([itemUrl(a), itemUrl(b)].sort());
    expectPriorSnapshotPreserved();
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "DEFERRED", exitCode: 3, nextPermittedAt: NEXT_PERMITTED });
    const report = auditReport(result.auditDir);
    expect(report).toMatch(/Status: DEFERRED/);
    expect(report).toContain(NEXT_PERMITTED);
  });

  it("a run-level failure aborts in-flight requests and remains the reported error", async () => {
    const world = fixtureWorld();
    const [a, b] = QFC_ITEMS;
    let aSignal: AbortSignal | null | undefined;
    world.map.set(itemUrl(a), (init) => {
      aSignal = init?.signal;
      return new Promise<Response>(() => undefined); // would hang for the 15 s timeout without the abort
    });
    world.map.set(itemUrl(b), () => new Response("denied", { status: 403 }));
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(result.status).toBe("ERROR");
    expect(result.message).toMatch(/403/);
    // H10: the abort it caused is never recorded as another failure.
    expect(result.message).not.toMatch(/stopped/);
    expect(diagnostics(result.auditDir).otherFailures).toEqual([]);
    expect(aSignal?.aborted).toBe(true);
    expect(requested.filter((url) => url.includes("/flipp/items/"))).toHaveLength(2);
  });

  it("when a deferral and a source error both occur, DEFERRED is reported with its next permitted time and both failures", async () => {
    const world = fixtureWorld();
    const [a, b] = QFC_ITEMS;
    world.map.set(itemUrl(a), () => new Response(null, DEFERRAL));
    world.map.set(itemUrl(b), JSON.stringify({ item: { ...item(b), id: 42 } }));
    const result = await run(routes(world.map).fetcher);
    expect(result.status).toBe("DEFERRED");
    expect(result.exitCode).toBe(3);
    expect(result.nextPermittedAt).toBe(NEXT_PERMITTED);
    expect(result.message).toMatch(/does not match requested item/);
    const diag = diagnostics(result.auditDir);
    expect(diag.nextPermittedAt).toBe(NEXT_PERMITTED);
    expect(JSON.stringify(diag.otherFailures)).toMatch(/does not match requested item/);
    const report = auditReport(result.auditDir);
    expect(report).toContain(NEXT_PERMITTED);
    expect(report).toMatch(/does not match requested item/);
  });

  it("H10: a source error followed by a deferral is DEFERRED with the next permitted time", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    const [a, b] = QFC_ITEMS;
    const held = settleTogether(world, [a, () => new Response(null, { status: 403 })], [b, () => new Response(null, DEFERRAL)]);
    const result = await run(routes(world.map).fetcher);
    expect(held.settleFirst).toBeDefined();
    expect(held.settleSecond).toBeDefined();
    expect(result.status).toBe("DEFERRED");
    expect(result.exitCode).toBe(3);
    expect(result.nextPermittedAt).toBe(NEXT_PERMITTED);
    const diag = diagnostics(result.auditDir);
    // The source error came first and stays the reported error.
    expect(diag.error).toMatchObject({ name: "FlippSourceError", status: 403, url: itemUrl(a) });
    expect(diag.otherFailures).toEqual([expect.objectContaining({ name: "FlippDeferredError", status: 429 })]);
    expect(result.message).toMatch(/^unexpected HTTP 403.*; also: HTTP 429/);
    expectPriorSnapshotPreserved();
  });

  it("H6: with several deferrals, nextPermittedAt is the latest of them", async () => {
    const world = fixtureWorld();
    const [a, b] = QFC_ITEMS;
    const held = settleTogether(world,
      [a, () => new Response(null, { status: 429, headers: { "retry-after": "120" } })],
      [b, () => new Response(null, { status: 503, headers: { "retry-after": "600" } })]);
    const result = await run(routes(world.map).fetcher);
    expect(held.settleFirst).toBeDefined();
    expect(held.settleSecond).toBeDefined();
    expect(result.status).toBe("DEFERRED");
    expect(result.exitCode).toBe(3);
    const diag = diagnostics(result.auditDir);
    expect(diag.error).toMatchObject({ name: "FlippDeferredError", status: 429 });
    expect(diag.otherFailures).toEqual([expect.objectContaining({ name: "FlippDeferredError", status: 503 })]);
    expect(result.nextPermittedAt).toBe("2026-09-24T19:10:00.000Z");
    expect(diag.nextPermittedAt).toBe("2026-09-24T19:10:00.000Z");
    expect(auditReport(result.auditDir)).toContain("Next permitted request: 2026-09-24T19:10:00.000Z");
  });
});

describe("request audit", () => {
  it("records every request attempt and keeps rejected bodies under raw/failed/", async () => {
    const world = fixtureWorld();
    const id = SAFEWAY_ITEMS[0];
    world.map.set(itemUrl(id), () => new Response("<html>gone</html>", { status: 404, headers: { "content-type": "text/html" } }));
    const result = await run(routes(world.map).fetcher);
    const attempts = diagnostics(result.auditDir).attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1 + 2 + 6);
    expect(attempts[0]).toMatchObject({ requestUrl: LISTING_URL, url: LISTING_URL, attempt: 1, hop: 0, status: 200, error: null, failedBody: null });
    const failed = attempts.find((attempt) => attempt.url === itemUrl(id));
    expect(failed).toMatchObject({ requestUrl: itemUrl(id), attempt: 1, hop: 0, status: 404, error: expect.stringMatching(/404/) });
    expect(failed?.failedBody).toMatch(/^raw\/failed\/attempt-\d+\.bin$/);
    expect(readFileSync(join(result.auditDir, String(failed?.failedBody)), "utf8")).toBe("<html>gone</html>");
  });

  it("keeps an HTML listing body as failed evidence", async () => {
    const world = fixtureWorld();
    world.map.set(LISTING_URL, () => new Response("<html>Access denied</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/HTML/);
    const [attempt] = diagnostics(result.auditDir).attempts as Array<Record<string, unknown>>;
    expect(attempt).toMatchObject({ status: 200, error: expect.stringMatching(/HTML/) });
    expect(readFileSync(join(result.auditDir, String(attempt?.failedBody)), "utf8")).toBe("<html>Access denied</html>");
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
    const report = auditReport(result.auditDir);
    expect(readFileSync(reportPath, "utf8")).toBe(report);
    expect(report).toMatch(/Status: BLOCKED/);
    expect(report).not.toMatch(/Status: PASS/);
    expect(report).not.toMatch(/\blive\b/i);
    expect(report).toMatch(/injected fetcher/);
    expect(report).toMatch(/no validation file/);
    expect(report).toContain("flipp:kroger:1038428171");
    expect(report).toContain("Wild Sockeye Salmon Fillets");
    expect(report).toContain("## Excluded rows (list and detail stage)");
    const gate = section(report, "Gate reasons").filter((line) => line.startsWith("- "));
    expect(gate).toContain("- kroger: 0 qualifying source items (need at least 10)");
    expect(gate.some((line) => /^- (excluded|pair) /.test(line))).toBe(false);
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
    expect(section(report, "Gate reasons")).toContain("- none");

    // In-scope offers: package terms, raw validity and the full raw price and condition text.
    const beef = report.split("\n").find((line) => line.startsWith(`| flipp:kroger:${7001 + SYN_PACKAGE_INDEX} |`)) ?? "";
    expect(beef).toContain("packageMassLb=3; packageCount=none; packageTotalCents=897");
    expect(beef).toContain(`valid_from=${CURRENT.valid_from}; valid_to=${CURRENT.valid_to}; timezone=America/New_York`);
    expect(beef).toContain('current_price="2.99"; price_text="lb"; description="3 lb Package for $8.97"');
    expect(beef).toContain('conditions.text=\\["lb"\\]'); // brackets are Markdown-escaped in cells

    // Counted offers with their validation evidence.
    const counted = section(report, "Counted offers");
    expect(counted.some((line) => line.startsWith("| flipp:kroger:7001 | 7001 | 2026-09-24T18:30:00.000Z | synthetic validation applicability | synthetic validation calendar |"))).toBe(true);
    expect(counted.filter((line) => line.startsWith("| flipp:"))).toHaveLength(20);

    // Counted pairs name their shared comparisonKey and unit basis.
    const left = written.offers.find((offer) => offer.id === "flipp:kroger:7009");
    const key = left ? comparisonKey(left.identity) : null;
    expect(key).not.toBeNull();
    expect(section(report, "Counted pairs")).toContain(`| flipp:kroger:7009 | flipp:albertsons:8009 | meat | ${String(key).split("|").join("\\|")} | lb |`);

    // H5: a verified calendar shows the bare freshness state.
    const offersSection = section(report, "In-scope offers");
    expect(offersSection.find((line) => line.startsWith("| flipp:kroger:7001 |"))).toMatch(/\| fresh \|/);
  });

  it("H4: the counted-offers table lists only validations that are valid for the offer", async () => {
    const world = syntheticWorld();
    const [valid] = world.file.validations;
    if (!valid) throw new Error("synthetic world has no validations");
    const invalid = { ...valid, checkedAt: "2026-09-24T18:45:00.000Z", verifiedFields: [], applicabilityEvidence: "invalid extra validation" };
    const file = { ...world.file, validations: [...world.file.validations, invalid] };
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(file) });
    expect(result.status).toBe("PASS");
    const counted = section(auditReport(result.auditDir), "Counted offers");
    expect(counted.filter((line) => line.startsWith(`| ${valid.offerId} |`))).toHaveLength(1);
    expect(counted.join("\n")).not.toContain("invalid extra validation");
    expect(counted.filter((line) => line.startsWith("| flipp:"))).toHaveLength(20);
  });

  it("H5: with an unknown calendar the freshness cell says it rests on observation age only", async () => {
    const result = await run(routes(fixtureWorld().map).fetcher);
    expect(result.status).toBe("BLOCKED");
    const rows = section(auditReport(result.auditDir), "In-scope offers").filter((line) => line.startsWith("| flipp:"));
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      // Starts / expires, then Freshness.
      expect(row).toContain("| unknown / unknown | fresh (calendar unknown; observation age only) |");
      expect(row).not.toMatch(/\| fresh \|/);
    }
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

  it("an HTML bot page instead of the listing exits 2", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    world.map.set(LISTING_URL, () => new Response("<html>Access denied</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/HTML/);
    expectPriorSnapshotPreserved();
  });

  it("retries the snapshot rename on EPERM/EBUSY, then replaces it", async () => {
    seedPriorSnapshot();
    renames.failures = ["EPERM", "EBUSY"];
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file) });
    expect(result.exitCode).toBe(0);
    expect(renames.calls).toBe(3);
    expect(readJson(snapshotPath)).toEqual(result.snapshot);
    expect(readdirSync(join(dataDir, "snapshots"))).toEqual(["m1-source.json"]);
  });

  it("gives up after five rename retries, preserving the prior snapshot", async () => {
    seedPriorSnapshot();
    renames.failures = Array.from({ length: 6 }, () => "EACCES");
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file) });
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.snapshotWritten).toBe(false);
    expect(result.message).toMatch(/EACCES/);
    expect(renames.calls).toBe(6);
    expectPriorSnapshotPreserved();
  });

  it("does not retry a rename failure that is not a lock or permission error", async () => {
    seedPriorSnapshot();
    renames.failures = ["EXDEV"];
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file) });
    expect(result.exitCode).toBe(2);
    expect(renames.calls).toBe(1);
    expectPriorSnapshotPreserved();
  });
});

describe("report text safety", () => {
  it("escapes retailer text outside tables, including a lone carriage return", async () => {
    const injected = "Weekly Ad\r## Status: PASS\n- [x](javascript:alert) <b>bold</b>";
    const world = fixtureWorld([flyer(8000001, "QFC", injected, EXPIRED), flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT)]);
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    const report = auditReport(result.auditDir);
    expect(report).not.toMatch(/\r/);
    expect(report.split("\n").some((line) => /^\s*#+ Status/.test(line) || /^- \[x\]/.test(line))).toBe(false);
    expect(report).not.toContain("<b>");
    expect(report).not.toContain("[x](");
  });

  it("escapes a lone carriage return inside a table cell", async () => {
    const world = fixtureWorld();
    world.map.set(flyerUrl(QFC_FLYER), JSON.stringify({ items: [...QFC_ITEMS.map(listRow), { id: 5020, name: "Cheddar\rCheese" }] }));
    const result = await run(routes(world.map).fetcher);
    const report = auditReport(result.auditDir);
    expect(report).not.toMatch(/\r/);
    expect(report).toContain("Cheddar Cheese");
  });

  it("does not claim live responses when no request was made", async () => {
    const result = await collect({ postalCode: "98106", dataDir, clock });
    expect(result.exitCode).toBe(2);
    const report = auditReport(result.auditDir);
    expect(report).not.toMatch(/live HTTPS/);
    expect(report).toMatch(/Responses: none/);
  });

  it("an unintended live run in tests stops at the global fetch guard", async () => {
    const result = await collect({ postalCode: "98105", dataDir, clock });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/disabled in tests/);
  });

  it("H3: a live run with no accepted response gives neutral counts, not retrieved live responses", async () => {
    const result = await collect({ postalCode: "98105", dataDir, clock });
    const line = auditReport(result.auditDir).split("\n").find((entry) => entry.startsWith("- Responses:")) ?? "";
    expect(line).not.toMatch(/live HTTPS responses/);
    expect(line).not.toMatch(/retrieved/);
    expect(line).toBe("- Responses: no response accepted (0 accepted of 1 request attempts to backflipp.wishabi.com)");
  });

  it("shows the validations path relative to the repository root, or as a basename", async () => {
    const world = syntheticWorld();
    mkdirSync(join(root, "docs", "research"), { recursive: true });
    const inside = join(root, "docs", "research", "validations.json");
    writeFileSync(inside, JSON.stringify(world.file));
    const first = await run(routes(world.map).fetcher, { validationsPath: inside });
    expect(diagnostics(first.auditDir).validationsPath).toBe("docs/research/validations.json");
    expect(auditReport(first.auditDir)).toContain("Validations file: docs/research/validations.json");

    const elsewhere = mkdtempSync(join(tmpdir(), "euthenia-validations-"));
    try {
      const outside = join(elsewhere, "mine.json");
      writeFileSync(outside, JSON.stringify(world.file));
      const second = await run(routes(world.map).fetcher, { validationsPath: outside });
      expect(diagnostics(second.auditDir).validationsPath).toBe("mine.json");
      expect(readFileSync(join(second.auditDir, "diagnostics.json"), "utf8")).not.toContain(elsewhere);
      expect(auditReport(second.auditDir)).not.toContain(elsewhere);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
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

  it("a missing validations file exits 2 without leaking its absolute path", async () => {
    const { fetcher } = routes(fixtureWorld().map);
    const result = await run(fetcher, { validationsPath: join(root, "missing.json") });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/missing\.json/);
    expect(result.message).not.toContain(root);
    expect(readFileSync(join(result.auditDir, "diagnostics.json"), "utf8")).not.toContain(root);
    expect(auditReport(result.auditDir)).not.toContain(root);
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

  it.each<[string, () => { reportPath: string; validationsPath?: string }]>([
    ["an existing directory", () => {
      mkdirSync(join(root, "out"));
      return { reportPath: join(root, "out") };
    }],
    ["the snapshot path", () => ({ reportPath: snapshotPath })],
    ["a path inside data/snapshots", () => ({ reportPath: join(dataDir, "snapshots", "reports", "proof.md") })],
    ["the validations file", () => {
      const validationsPath = writeValidations(syntheticWorld().file);
      return { reportPath: validationsPath, validationsPath };
    }],
  ])("a --report path that is %s exits 2 before any request", async (_label, setup) => {
    seedPriorSnapshot();
    const paths = setup();
    const before = paths.validationsPath ? readFileSync(paths.validationsPath, "utf8") : null;
    const { fetcher } = routes(syntheticWorld().map);
    const result = await run(fetcher, paths);
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/--report/);
    expect(result.reportWritten).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expectPriorSnapshotPreserved();
    if (paths.validationsPath) expect(readFileSync(paths.validationsPath, "utf8")).toBe(before);
  });

  /**
   * Creates a symlink (a junction for directories on Windows), or returns false
   * only where the platform refuses links; any other error is a test failure.
   */
  function trySymlink(target: string, path: string, type: "file" | "dir"): boolean {
    try {
      symlinkSync(target, path, type === "dir" && process.platform === "win32" ? "junction" : type);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
      throw error;
    }
  }

  it.for<[string, () => { link: string; target: string; type: "file" | "dir"; reportPath: string; validationsPath?: string }, RegExp]>([
    ["a symlink to the snapshot", () => ({ link: join(root, "proof.md"), target: snapshotPath, type: "file", reportPath: join(root, "proof.md") }), /is a symbolic link/],
    ["a symlink to the validations file", () => {
      const validationsPath = writeValidations(syntheticWorld().file);
      return { link: join(root, "proof.md"), target: validationsPath, type: "file", reportPath: join(root, "proof.md"), validationsPath };
    }, /is a symbolic link/],
    ["inside a symlinked directory whose real path is data/snapshots", () => ({
      link: join(root, "snaps"), target: join(dataDir, "snapshots"), type: "dir", reportPath: join(root, "snaps", "proof.md"),
    }), /is inside data\/snapshots/],
    ["the validations file through a symlinked directory", () => {
      const validationsPath = writeValidations(syntheticWorld().file);
      return { link: join(root, "alias"), target: root, type: "dir", reportPath: join(root, "alias", "validations.json"), validationsPath };
    }, /is the validations file/],
  ])("H7: a --report path that is %s exits 2 before any request", async ([, setup, problem], context) => {
    seedPriorSnapshot();
    const { link, target, type, reportPath, validationsPath } = setup();
    if (!trySymlink(target, link, type)) {
      context.skip(); // symlinks not permitted here (for example Windows without developer mode)
      return;
    }
    const before = validationsPath ? readFileSync(validationsPath, "utf8") : null;
    const { fetcher } = routes(syntheticWorld().map);
    const result = await run(fetcher, { reportPath, validationsPath });
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/--report/);
    expect(result.message).toMatch(problem);
    expect(result.message).not.toContain(root);
    expect(result.reportWritten).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFileSync(snapshotPath, "utf8")).toBe(PRIOR_SNAPSHOT);
    if (validationsPath) expect(readFileSync(validationsPath, "utf8")).toBe(before);
  });

  it("H7: a --report path under a symlinked directory elsewhere is still allowed", async (context) => {
    const elsewhere = join(root, "real-reports");
    mkdirSync(elsewhere);
    if (!trySymlink(elsewhere, join(root, "reports-link"), "dir")) {
      context.skip();
      return;
    }
    const result = await run(routes(fixtureWorld().map).fetcher, { reportPath: join(root, "reports-link", "new", "proof.md") });
    expect(result.status).toBe("BLOCKED");
    expect(result.reportWritten).toBe(true);
    expect(readFileSync(join(elsewhere, "new", "proof.md"), "utf8")).toMatch(/Status: BLOCKED/);
  });
});

describe("snapshot temp-file cleanup (H8)", () => {
  it("a failing cleanup never masks the original write error", async () => {
    seedPriorSnapshot();
    renames.failures = ["EXDEV"];
    renames.rmFailure = "EBUSY";
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file) });
    expect(result.status).toBe("ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/EXDEV: simulated rename failure/);
    expect(result.message).not.toMatch(/simulated rm failure/);
    expect(readFileSync(snapshotPath, "utf8")).toBe(PRIOR_SNAPSHOT);
  });
});

describe("terminal safety (H9)", () => {
  /* eslint-disable no-control-regex -- these patterns detect control characters on purpose */
  const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
  const C0_CONTROLS = /[\u0000-\u001f]/;
  /* eslint-enable no-control-regex */

  it("terminalSafe escapes C0, DEL and C1 controls and keeps other text", () => {
    expect(terminalSafe("PASS: ok é✓")).toBe("PASS: ok é✓");
    expect(terminalSafe("a\u001b[2Jb\rc\nd\u007fe\u009bf\u0000")).toBe("a\\u001b[2Jb\\u000dc\\u000ad\\u007fe\\u009bf\\u0000");
    expect(terminalSafe("x\u001b]0;title\u0007")).not.toMatch(CONTROLS);
  });

  it("L3: terminalSafe escapes the Unicode line and paragraph separators and the bidi controls", () => {
    const bidi = ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"];
    for (const char of ["\u2028", "\u2029", ...bidi]) {
      const escaped = `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      expect(terminalSafe(`PASS${char}BLOCKED`)).toBe(`PASS${escaped}BLOCKED`);
    }
    // Neighbours of the escaped ranges are ordinary text.
    expect(terminalSafe("\u200d\u2030\u2065\u206a")).toBe("\u200d\u2030\u2065\u206a");
  });

  it("L3: report.md carries no ESC or C1 control from source text", async () => {
    /* eslint-disable-next-line no-control-regex -- detecting control characters is the point */
    const REPORT_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
    const world = fixtureWorld();
    world.map.set(flyerUrl(QFC_FLYER), JSON.stringify({ items: [...QFC_ITEMS.map(listRow), { id: 5030, name: "Cheddar\u001b[2J\u009b31mCheese" }] }));
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(1);
    const report = auditReport(result.auditDir);
    expect(report).not.toMatch(REPORT_CONTROLS);
    expect(report).toContain("Cheddar\\u001b\\[2J\\u009b31mCheese");
  });

  it("the flyer-selection error quotes listing names with their control characters escaped", async () => {
    const hostile = "Weekly Ad\u001b[2J\u001b]0;pwned\u0007\r\nPASS: forged";
    const world = fixtureWorld([flyer(8000001, "QFC", hostile, EXPIRED), flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT)]);
    const result = await run(routes(world.map).fetcher);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(JSON.stringify(hostile));
    expect(result.message).not.toMatch(C0_CONTROLS);
    expect(terminalSafe(result.message)).not.toMatch(CONTROLS);
  });

  it("C1 controls in a listing name are escaped for the terminal", async () => {
    const world = fixtureWorld([flyer(8000001, "QFC", "Weekly Ad\u009b2J", EXPIRED), flyer(SAFEWAY_FLYER, "Safeway", "Weekly Ad", CURRENT)]);
    const result = await run(routes(world.map).fetcher);
    expect(terminalSafe(result.message)).toContain("Weekly Ad\\u009b2J");
    expect(terminalSafe(result.message)).not.toMatch(CONTROLS);
  });
});

describe("post-outcome write failures keep the true outcome", () => {
  function blockedReportPath(): string {
    writeFileSync(join(root, "blocker"), "a file, not a directory");
    return join(root, "blocker", "proof.md");
  }

  it("PASS keeps exit 0 and the written snapshot when the report cannot be written", async () => {
    seedPriorSnapshot();
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file), reportPath: blockedReportPath() });
    expect(result).toMatchObject({ status: "PASS", exitCode: 0, snapshotWritten: true, reportWritten: false });
    expect(result.writeErrors.join("\n")).toMatch(/report/);
    expect(readJson(snapshotPath)).toEqual(result.snapshot);
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "PASS", exitCode: 0 });
  });

  it("BLOCKED keeps exit 1 when the report cannot be written", async () => {
    const result = await run(routes(fixtureWorld().map).fetcher, { reportPath: blockedReportPath() });
    expect(result).toMatchObject({ status: "BLOCKED", exitCode: 1, reportWritten: false });
    expect(result.writeErrors).toHaveLength(1);
  });

  it("DEFERRED keeps exit 3 and the next permitted time when the report cannot be written", async () => {
    const world = fixtureWorld();
    world.map.set(itemUrl(QFC_ITEMS[0]), () => new Response(null, DEFERRAL));
    const result = await run(routes(world.map).fetcher, { reportPath: blockedReportPath() });
    expect(result).toMatchObject({ status: "DEFERRED", exitCode: 3, nextPermittedAt: NEXT_PERMITTED, reportWritten: false });
    expect(result.writeErrors).toHaveLength(1);
  });

  it("a diagnostics write failure keeps the true status and still writes the report", async () => {
    const world = fixtureWorld();
    const listing = String(world.map.get(LISTING_URL));
    world.map.set(LISTING_URL, () => {
      mkdirSync(join(dataDir, "audit", RUN_ID, "diagnostics.json"));
      return jsonResponse(listing);
    });
    const reportPath = join(root, "proof.md");
    const result = await run(routes(world.map).fetcher, { reportPath });
    expect(result.runId).toBe(RUN_ID);
    expect(result).toMatchObject({ status: "BLOCKED", exitCode: 1, reportWritten: true });
    expect(result.writeErrors.join("\n")).toMatch(/diagnostics/);
    expect(auditReport(result.auditDir)).toMatch(/Status: BLOCKED/);
    expect(readFileSync(reportPath, "utf8")).toMatch(/Status: BLOCKED/);
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
