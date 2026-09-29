import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUIRED_VERIFIED_FIELDS,
  type Family,
  type Offer,
  type SourceSnapshot,
  type Validation,
  type ValidationFile,
} from "../../src/shared/contracts.js";
import { CATALOG_QUERIES } from "../../src/source/catalogQueries.js";
import { collect, parseCollectArgs, parseValidationFile, terminalSafe, type CollectOptions, type CollectResult } from "../../src/source/collect.js";
import { KROGER_TOKEN_URL, QFC_LOCATION_ID, krogerProductsUrl } from "../../src/source/kroger.js";
import { checkProof } from "../../src/source/proof.js";
import { item } from "../fixtures/source.js";

// Collector tests. Every response comes from an injected fetcher: a synthetic
// listing, synthetic flyer rows and item bodies that are either the committed
// research fixture records or clearly synthetic records, plus the SYNTHETIC
// Kroger fixtures under tests/fixtures/kroger/. The Kroger credentials and
// token are fake, distinctive values. Nothing here is a live run, and all
// writes go to a per-test temporary directory.

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

// The retailer-pickup gate cannot pass until S2 adds a Safeway catalog source,
// so the snapshot-write tests force the gate's verdict to PASS; everything
// else about the evaluation is the real one.
const gate = vi.hoisted(() => ({ forcePass: false }));
vi.mock("../../src/source/proof.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/source/proof.js")>();
  return {
    ...actual,
    evaluateProof: (...args: Parameters<typeof actual.evaluateProof>) => {
      const evaluation = actual.evaluateProof(...args);
      return gate.forcePass ? { ...evaluation, ok: true, failures: [] } : evaluation;
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
/** A synthetic store attestation (catalog amendment); 91000001 is an invented locationId. */
const STORE_ATTESTATION = {
  family: "kroger", provider: "kroger-api", storeId: "91000001", checkedAt: "2026-09-24T18:00:00.000Z",
  applicability: "verified", applicabilityEvidence: "synthetic store attestation",
} as const;
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

// --- Kroger catalog world (SYNTHETIC fixtures; fake credentials and token) ---

const CLIENT_ID = "fake-client-id-K2CQ4M";
const CLIENT_SECRET = "fake-client-secret-K2S8V3X";
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64");
const TOKEN = `fake-access-token-K2T7N5P-${"w".repeat(48)}`;
const SECRETS = [CLIENT_ID, CLIENT_SECRET, BASIC, TOKEN, "K2CQ4M", "K2S8V3X", "K2T7N5P"];
const ENV = { KROGER_CLIENT_ID: CLIENT_ID, KROGER_CLIENT_SECRET: CLIENT_SECRET };
const LOCATION_URL = `https://api.kroger.com/v1/locations/${QFC_LOCATION_ID}`;
const LOCATION_BYTES = readFileSync(new URL("../fixtures/kroger/location-70500807.json", import.meta.url));
const PRODUCTS_BYTES = readFileSync(new URL("../fixtures/kroger/products-synthetic.json", import.meta.url));
const PRODUCTS_HASH = createHash("sha256").update(PRODUCTS_BYTES).digest("hex");
const EMPTY_PRODUCTS = JSON.stringify({ data: [], meta: { pagination: { start: 0, limit: 20, total: 0 } } });
/** The fixture products that yield a keyed, priced offer (3 produce, 2 meat); the rest have data gaps. */
const COUNTABLE_PRODUCTS = ["0000000004133", "0000000094133", "9100000000401", "9100000000501", "0000000004958"];
const KROGER_OFFER_IDS = [
  "0000000004133", "0000000094133", "9100000000301", "9100000000401", "9100000000501", "0000000004011", "9100000000701", "0000000004958",
].map((id) => `kroger-api:kroger:${id}`);
/** A valid store attestation for QFC 70500807, checked before this run's collection. */
const KROGER_STORE = {
  family: "kroger", provider: "kroger-api", storeId: QFC_LOCATION_ID, checkedAt: "2026-09-24T18:00:00.000Z",
  applicability: "verified", applicabilityEvidence: "synthetic: the qfc.com store page matches the Location API",
} as const;

const productsUrl = (index: number) => krogerProductsUrl(CATALOG_QUERIES[index] ?? "", QFC_LOCATION_ID).href;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function authorization(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

/** A Kroger GET body served only with this run's Bearer token; anything else is a 401. */
function bearer(body: string | Uint8Array): (init?: RequestInit) => Response {
  return (init) => authorization(init) === `Bearer ${TOKEN}`
    ? new Response(body, { status: 200, headers: JSON_HEADERS })
    : new Response("missing bearer", { status: 401 });
}

/**
 * Adds the Kroger API: the token (a POST with the fake Basic credentials), the
 * QFC location and every CATALOG_QUERIES search. The first query serves the
 * synthetic products fixture; the others return no products.
 */
function addKroger(map: Map<string, Body>): void {
  map.set(KROGER_TOKEN_URL, (init) => init?.method === "POST" && authorization(init) === `Basic ${BASIC}`
    ? jsonResponse(JSON.stringify({ access_token: TOKEN, expires_in: 1800, token_type: "bearer" }))
    : new Response("bad credentials", { status: 401 }));
  map.set(LOCATION_URL, bearer(LOCATION_BYTES));
  CATALOG_QUERIES.forEach((_term, index) => map.set(productsUrl(index), bearer(index === 0 ? PRODUCTS_BYTES : EMPTY_PRODUCTS)));
}

/** A SYNTHETIC catalog validation for one fixture product, checked at the (fixed) collection time. */
function krogerValidation(productId: string, overrides: Partial<Validation> = {}): Validation {
  return {
    offerId: `kroger-api:kroger:${productId}`, checkedAt: NOW.toISOString(),
    evidenceIds: [`kroger-api:product:${productId}:${PRODUCTS_HASH.slice(0, 12)}`], verifiedFields: [...REQUIRED_VERIFIED_FIELDS],
    applicabilityEvidence: "synthetic: product page at QFC 70500807 in Pickup mode",
    calendarEvidence: `catalog price; no stated window; observed ${NOW.toISOString()}`,
    ...overrides,
  };
}

/** A validation file with the QFC store attestation and validations for every countable fixture product. */
function krogerFile(overrides: Partial<ValidationFile> = {}): ValidationFile {
  return { schemaVersion: 1, attestations: [], storeAttestations: [KROGER_STORE], validations: COUNTABLE_PRODUCTS.map((id) => krogerValidation(id)), pairs: [], ...overrides };
}

const isFlipp = (offer: Offer) => offer.evidence[0]?.provider === "flipp";
const isKroger = (offer: Offer) => offer.evidence[0]?.provider === "kroger-api";

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
  addKroger(map);
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
  addKroger(map);
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
  gate.forcePass = false;
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

/** A run with the fake Kroger credentials; tests never read process.env unless they say so. */
function run(fetcher: typeof fetch, overrides: Partial<CollectOptions> = {}) {
  return collect({ postalCode: "98105", dataDir, fetcher, clock, env: ENV, ...overrides });
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
    expect(result.snapshot?.offers.filter(isFlipp).map((offer) => offer.id)).toEqual([
      ...QFC_ITEMS.map((id) => `flipp:kroger:${id}`),
      ...SAFEWAY_ITEMS.map((id) => `flipp:albertsons:${id}`),
    ]);
  });

  it("binds evidence to the exact served body and keeps raw bodies in the audit", async () => {
    const world = fixtureWorld();
    const result = await run(routes(world.map).fetcher);
    for (const offer of result.snapshot?.offers.filter(isFlipp) ?? []) {
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
    expect(result.snapshot?.offers.filter(isFlipp)).toHaveLength(5);
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
    // Only the two workers' first items were ever requested, and nothing was sent to Kroger.
    expect(requested.filter((url) => url.includes("/flipp/items/")).sort()).toEqual([itemUrl(a), itemUrl(b)].sort());
    expect(requested.some((url) => url.startsWith("https://api.kroger.com/"))).toBe(false);
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
    // Listing, 2 flyers, 6 items, then the Kroger location and every catalog query (the token request is never recorded).
    expect(attempts).toHaveLength(1 + 2 + 6 + 1 + CATALOG_QUERIES.length);
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

  it("weekly ads: attested, validated Flipp offers are collected and reported but never count toward the retailer-pickup gate", async () => {
    seedPriorSnapshot();
    const world = syntheticWorld();
    const reportPath = join(root, "proof.md");
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file), reportPath });
    expect(result.status).toBe("BLOCKED");
    expect(result.exitCode).toBe(1);
    expect(result.snapshotWritten).toBe(false);
    expectPriorSnapshotPreserved();
    const snapshot = result.snapshot as SourceSnapshot;
    expect(snapshot.proof.channel).toBe("retailer-pickup");
    expect(snapshot.collectedAt).toBe(NOW.toISOString());
    const flipp = snapshot.offers.filter(isFlipp);
    expect(flipp).toHaveLength(20);
    expect(flipp.every((offer) => offer.channel === "in-store-ad" && offer.applicability === "verified" && offer.calendarRule === "verified-local-date")).toBe(true);
    // A7 shapes, produced by the real flippEvidence/normalizeFlipp path.
    for (const offer of flipp) {
      const evidence = offer.evidence[0];
      const id = evidence?.sourceItemId ?? "";
      expect(offer.id).toBe(`flipp:${offer.family}:${id}`);
      expect(evidence?.retrievedUrl).toBe(itemUrl(Number(id)));
      expect(evidence?.id).toBe(`flipp:item:${id}:${evidence?.rawSha256.slice(0, 12)}`);
    }
    // Section 1 (D2): every attested, validated weekly-ad offer is excluded for its channel alone.
    const evaluation = diagnostics(result.auditDir).evaluation as {
      excluded: Array<{ offerId: string; reasons: string[] }>; families: Record<Family, { count: number }>; countedPairs: unknown[];
    };
    const excluded = new Map(evaluation.excluded.map((entry) => [entry.offerId, entry.reasons]));
    for (const offer of flipp) expect(excluded.get(offer.id)).toEqual(["channel in-store-ad is not the gate channel"]);
    expect(evaluation.families.kroger.count).toBe(0); // no store attestation, so no catalog offer qualifies
    expect(evaluation.families.albertsons.count).toBe(0);
    expect(evaluation.countedPairs).toEqual([]);
    expect(checkProof(snapshot, NOW).ok).toBe(false);

    const report = readFileSync(reportPath, "utf8");
    expect(report).toMatch(/Status: BLOCKED/);
    expect(report).toMatch(/injected fetcher/);
    expect(report).toMatch(/Gate channel: retailer-pickup .*weekly-ad offers .*reference only/);
    expect(section(report, "Gate reasons")).toContain("- albertsons: 0 qualifying source items (need at least 10)");

    // Weekly-ad offers: package terms, raw validity and the full raw price and condition text, for reference.
    const weeklyAds = section(report, "Weekly-ad offers");
    const beef = weeklyAds.find((line) => line.startsWith(`| flipp:kroger:${7001 + SYN_PACKAGE_INDEX} |`)) ?? "";
    expect(beef).toContain("packageMassLb=3; packageCount=none; packageTotalCents=897");
    expect(beef).toContain(`valid_from=${CURRENT.valid_from}; valid_to=${CURRENT.valid_to}; timezone=America/New_York`);
    expect(beef).toContain('current_price="2.99"; price_text="lb"; description="3 lb Package for $8.97"');
    expect(beef).toContain('conditions.text=\\["lb"\\]'); // brackets are Markdown-escaped in cells
    expect(beef).toMatch(/\| excluded: channel in-store-ad is not the gate channel \|$/);
    // H5: a verified calendar shows the bare freshness state.
    expect(weeklyAds.find((line) => line.startsWith("| flipp:kroger:7001 |"))).toMatch(/\| fresh \|/);
    expect(section(report, "Catalog offers").some((line) => line.startsWith("| flipp:"))).toBe(false);

    // Nothing counts, and weekly-ad pairs are neither suggested nor counted in the retailer-pickup gate.
    expect(section(report, "Counted offers")).toContain("None.");
    expect(section(report, "Candidate cross-family pairs")).toContain("None.");
    expect(diagnostics(result.auditDir).candidatePairs).toEqual([]);
    expect(section(report, "Counted pairs")).toContain("None.");
    const skipped = section(report, "Skipped pairs").filter((line) => line.startsWith("| flipp:"));
    expect(skipped).toHaveLength(SYN_PAIRS.length);
    expect(skipped.every((line) => line.includes("is not a qualifying offer"))).toBe(true);
  });

  it("H4: the counted-offers table lists only validations that are valid for the offer", async () => {
    const valid = krogerValidation(COUNTABLE_PRODUCTS[0] ?? "");
    const invalid = { ...valid, verifiedFields: [], applicabilityEvidence: "invalid extra validation" };
    const file = krogerFile();
    const result = await run(routes(fixtureWorld().map).fetcher, { validationsPath: writeValidations({ ...file, validations: [...file.validations, invalid] }) });
    expect(result.status).toBe("BLOCKED"); // no albertsons catalog source until S2
    const counted = section(auditReport(result.auditDir), "Counted offers");
    expect(counted.filter((line) => line.startsWith(`| ${valid.offerId} |`))).toHaveLength(1);
    expect(counted.join("\n")).not.toContain("invalid extra validation");
    expect(counted.filter((line) => line.startsWith("| kroger-api:"))).toHaveLength(COUNTABLE_PRODUCTS.length);
  });

  it("H5: with an unknown calendar the freshness cell says it rests on observation age only", async () => {
    const result = await run(routes(fixtureWorld().map).fetcher);
    expect(result.status).toBe("BLOCKED");
    const rows = section(auditReport(result.auditDir), "Weekly-ad offers").filter((line) => line.startsWith("| flipp:"));
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

  it("retries the snapshot rename on EPERM/EBUSY, then replaces it (gate forced to PASS)", async () => {
    seedPriorSnapshot();
    gate.forcePass = true;
    renames.failures = ["EPERM", "EBUSY"];
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file) });
    expect(result.exitCode).toBe(0);
    expect(renames.calls).toBe(3);
    expect(readJson(snapshotPath)).toEqual(result.snapshot);
    expect(readdirSync(join(dataDir, "snapshots"))).toEqual(["m1-source.json"]);
  });

  it("gives up after five rename retries, preserving the prior snapshot (gate forced to PASS)", async () => {
    seedPriorSnapshot();
    gate.forcePass = true;
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

  it("does not retry a rename failure that is not a lock or permission error (gate forced to PASS)", async () => {
    seedPriorSnapshot();
    gate.forcePass = true;
    renames.failures = ["EXDEV"];
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(world.file) });
    expect(result.exitCode).toBe(2);
    expect(renames.calls).toBe(1);
    expectPriorSnapshotPreserved();
  });
});

describe("Kroger catalog collection (K2)", () => {
  const KROGER_HOST = "https://api.kroger.com/";
  const allProductUrls = () => CATALOG_QUERIES.map((_term, index) => productsUrl(index));
  const krogerRequests = (requested: string[]) => requested.filter((url) => url.startsWith(KROGER_HOST));

  function locationBody(overrides: Record<string, unknown>): string {
    const json = JSON.parse(LOCATION_BYTES.toString("utf8")) as { data: Record<string, unknown> };
    return JSON.stringify({ ...json, data: { ...json.data, ...overrides } });
  }

  interface KrogerLog {
    locationId: string;
    tokenObtained: boolean;
    location: Record<string, unknown> | null;
    store: { applicability: string; problems: string[] } | null;
    queries: Array<Record<string, unknown>>;
    excluded: Array<Record<string, unknown>>;
    notes: string[];
  }
  const krogerLog = (auditDir: string) => diagnostics(auditDir).kroger as KrogerLog;
  const evaluationOf = (auditDir: string) => diagnostics(auditDir).evaluation as {
    failures: string[]; excluded: Array<{ offerId: string; reasons: string[] }>;
    families: Record<Family, { count: number; produce: number; meat: number; offerIds: string[] }>;
  };

  describe("credentials", () => {
    it.each<[string, Record<string, string | undefined>, RegExp]>([
      ["both variables missing", {}, /^KROGER_CLIENT_ID and KROGER_CLIENT_SECRET are not set/],
      ["the secret missing", { KROGER_CLIENT_ID: CLIENT_ID }, /^KROGER_CLIENT_SECRET is not set/],
      ["a blank id", { KROGER_CLIENT_ID: "", KROGER_CLIENT_SECRET: CLIENT_SECRET }, /^KROGER_CLIENT_ID is not set/],
      ["a whitespace-only secret", { KROGER_CLIENT_ID: CLIENT_ID, KROGER_CLIENT_SECRET: " \t\n" }, /^KROGER_CLIENT_SECRET is not set/],
      ["a padded id", { KROGER_CLIENT_ID: ` ${CLIENT_ID}`, KROGER_CLIENT_SECRET: CLIENT_SECRET }, /^KROGER_CLIENT_ID has leading or trailing whitespace/],
      ["a secret with a trailing newline", { KROGER_CLIENT_ID: CLIENT_ID, KROGER_CLIENT_SECRET: `${CLIENT_SECRET}\n` }, /^KROGER_CLIENT_SECRET has leading or trailing whitespace/],
    ])("%s exits 2 before any request, Flipp included, naming only the variables", async (_label, env, message) => {
      seedPriorSnapshot();
      const { fetcher } = routes(fixtureWorld().map);
      const result = await run(fetcher, { env });
      expect(result).toMatchObject({ status: "ERROR", exitCode: 2, snapshotWritten: false, snapshot: null });
      expect(result.message).toMatch(message);
      expect(fetcher).not.toHaveBeenCalled();
      const report = auditReport(result.auditDir);
      expect(report).toMatch(/Responses: none/);
      for (const text of [result.message, report, readFileSync(join(result.auditDir, "diagnostics.json"), "utf8")]) {
        for (const secret of SECRETS) expect(text).not.toContain(secret);
      }
      expectPriorSnapshotPreserved();
    });

    it("reads process.env when no env is injected", async () => {
      vi.stubEnv("KROGER_CLIENT_ID", "");
      vi.stubEnv("KROGER_CLIENT_SECRET", "");
      try {
        const { fetcher } = routes(fixtureWorld().map);
        const missing = await collect({ postalCode: "98105", dataDir, fetcher, clock });
        expect(missing.exitCode).toBe(2);
        expect(missing.message).toMatch(/^KROGER_CLIENT_ID and KROGER_CLIENT_SECRET are not set/);
        expect(fetcher).not.toHaveBeenCalled();

        vi.stubEnv("KROGER_CLIENT_ID", CLIENT_ID);
        vi.stubEnv("KROGER_CLIENT_SECRET", CLIENT_SECRET);
        const present = await collect({ postalCode: "98105", dataDir, fetcher, clock });
        expect(present.status).toBe("BLOCKED"); // the token route accepted the Basic credentials from process.env
        expect(krogerLog(present.auditDir).tokenObtained).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("Flipp, then Kroger: BLOCKED without Safeway; validated Kroger offers count; raw files are audited; no snapshot", async () => {
    seedPriorSnapshot();
    const { fetcher, requested } = routes(fixtureWorld().map);
    const reportPath = join(root, "proof.md");
    const result = await run(fetcher, { validationsPath: writeValidations(krogerFile()), reportPath });
    expect(result).toMatchObject({ status: "BLOCKED", exitCode: 1, snapshotWritten: false });
    expectPriorSnapshotPreserved();

    // Every Flipp request first, then the token, the location and the queries in CATALOG_QUERIES order.
    const firstKroger = requested.indexOf(KROGER_TOKEN_URL);
    expect(firstKroger).toBeGreaterThan(0);
    expect(requested.slice(0, firstKroger).every((url) => url.startsWith(BASE))).toBe(true);
    expect(requested.slice(firstKroger)).toEqual([KROGER_TOKEN_URL, LOCATION_URL, ...allProductUrls()]);

    // The snapshot holds the weekly-ad offers (in-store-ad) and the Kroger catalog offers (retailer-pickup).
    const snapshot = result.snapshot as SourceSnapshot;
    expect(snapshot.proof).toMatchObject({ channel: "retailer-pickup", families: ["kroger", "albertsons"] });
    const flipp = snapshot.offers.filter(isFlipp);
    expect(flipp).toHaveLength(6);
    expect(flipp.every((offer) => offer.channel === "in-store-ad")).toBe(true);
    const kroger = snapshot.offers.filter(isKroger);
    expect(kroger.map((offer) => offer.id)).toEqual(KROGER_OFFER_IDS);
    for (const offer of kroger) {
      expect(offer).toMatchObject({
        family: "kroger", retailer: "QFC", channel: "retailer-pickup", applicability: "verified",
        calendarRule: "catalog-observation", startsAt: null, expiresAt: null, observedAt: NOW.toISOString(),
      });
      expect(offer.evidence[0]).toMatchObject({ provider: "kroger-api", retrievedUrl: productsUrl(0), rawSha256: PRODUCTS_HASH, observedAt: NOW.toISOString() });
    }

    // The gate counts only validated retailer-pickup offers; Safeway has no catalog source until S2.
    const evaluation = evaluationOf(result.auditDir);
    expect(evaluation.families.kroger).toMatchObject({
      count: 5, produce: 3, meat: 2, offerIds: COUNTABLE_PRODUCTS.map((id) => `kroger-api:kroger:${id}`),
    });
    expect(evaluation.failures).toContain("kroger: 5 qualifying source items (need at least 10)");
    expect(evaluation.failures).toContain("albertsons: 0 qualifying source items (need at least 10)");
    const excluded = new Map(evaluation.excluded.map((entry) => [entry.offerId, entry.reasons]));
    for (const offer of flipp) expect(excluded.get(offer.id)).toContain("channel in-store-ad is not the gate channel");

    // Raw audit: the location and every products response, byte for byte, with their hashes.
    const raw = (file: string) => readFileSync(join(result.auditDir, "raw", file));
    expect(raw("kroger-location.json").equals(LOCATION_BYTES)).toBe(true);
    expect(raw("kroger-products-1.json").equals(PRODUCTS_BYTES)).toBe(true);
    for (let query = 2; query <= CATALOG_QUERIES.length; query += 1) expect(raw(`kroger-products-${query}.json`).toString("utf8")).toBe(EMPTY_PRODUCTS);
    const diag = diagnostics(result.auditDir);
    expect(diag.requests).toContainEqual({
      requestUrl: productsUrl(0), finalUrl: productsUrl(0), file: "raw/kroger-products-1.json", receivedAt: NOW.toISOString(), sha256: PRODUCTS_HASH,
    });
    expect(diag.requests).toContainEqual(expect.objectContaining({ requestUrl: LOCATION_URL, finalUrl: LOCATION_URL, file: "raw/kroger-location.json" }));

    // Diagnostics: the gate channel and the Kroger log.
    expect(diag.gateChannel).toBe("retailer-pickup");
    const log = krogerLog(result.auditDir);
    expect(log).toMatchObject({
      locationId: QFC_LOCATION_ID, tokenObtained: true, location: { locationId: QFC_LOCATION_ID, chain: "QFC", name: "SYNTHETIC QFC store name" },
      store: { applicability: "verified", problems: [] }, notes: [],
    });
    expect(log.queries).toHaveLength(CATALOG_QUERIES.length);
    expect(log.queries[0]).toEqual({ query: 1, term: CATALOG_QUERIES[0], file: "raw/kroger-products-1.json", products: 9, offers: 8, excluded: 1, repeats: 0 });
    expect(log.queries.slice(1).every((entry) => entry.products === 0 && entry.offers === 0)).toBe(true);
    expect(log.excluded).toEqual([{
      query: 1, term: CATALOG_QUERIES[0], index: 7, productId: "9100000000801", description: "Boneless Skinless Chicken Thighs", reason: expect.stringMatching(/Deli/),
    }]);

    // Report: the gate channel, the Kroger section, catalog offers with their catalog fields, and counted offers.
    const report = readFileSync(reportPath, "utf8");
    expect(report).toMatch(/^- Gate channel: retailer-pickup .*weekly-ad offers .*reference only/m);
    const section_ = section(report, "Kroger catalog");
    const krogerText = section_.join("\n");
    expect(krogerText).toMatch(/Location lookup: 70500807, chain QFC, "SYNTHETIC QFC store name"/);
    expect(krogerText).toMatch(/Store attestation: verified/);
    expect(krogerText).toMatch(/Access token: obtained by this run; held in memory only and never recorded/);
    expect(section_).toContain(`| 1 | ${CATALOG_QUERIES[0]} | raw/kroger-products-1.json | 9 | 8 | 1 | 0 |`);
    expect(section_.some((line) => /^\| 1 \| .+ \| 7 \| 9100000000801 \| Boneless Skinless Chicken Thighs \| .*Deli/.test(line))).toBe(true);
    const gala = section(report, "Catalog offers").find((line) => line.startsWith("| kroger-api:kroger:0000000004133 |")) ?? "";
    expect(gala).toContain("| 0000000004133 | Gala Apple | produce |");
    expect(gala).toContain('regular="1.99"; promo="0"; size="1 lb"; soldBy="WEIGHT"');
    expect(gala).toContain("| $1.99/lb (exact 199 cents) |");
    expect(gala).toContain(`| verified | catalog-observation | ${NOW.toISOString()} |`);
    expect(gala).toContain(`| kroger-api:product:0000000004133:${PRODUCTS_HASH.slice(0, 12)} | ${productsUrl(0)} |`);
    expect(gala).toMatch(/\| counted \|$/);
    expect(section(report, "Catalog offers").filter((line) => line.startsWith("| kroger-api:"))).toHaveLength(KROGER_OFFER_IDS.length);
    expect(section(report, "Weekly-ad offers").filter((line) => line.startsWith("| flipp:"))).toHaveLength(6);
    const counted = section(report, "Counted offers");
    expect(counted.filter((line) => line.startsWith("| kroger-api:"))).toHaveLength(COUNTABLE_PRODUCTS.length);
    expect(counted).toContain(
      `| kroger-api:kroger:0000000004133 | 0000000004133 | ${NOW.toISOString()} | synthetic: product page at QFC 70500807 in Pickup mode | ` +
      `catalog price; no stated window; observed ${NOW.toISOString()} | kroger-api:product:0000000004133:${PRODUCTS_HASH.slice(0, 12)} |`);
  });

  it.each<[string, (map: Map<string, Body>) => void, RegExp, () => string[]]>([
    ["a token 401", (map) => map.set(KROGER_TOKEN_URL, () => new Response("denied", { status: 401 })),
      /^Kroger token request failed: HTTP 401/, () => [KROGER_TOKEN_URL]],
    ["a location 401", (map) => map.set(LOCATION_URL, () => new Response("expired", { status: 401 })),
      /unexpected HTTP 401/, () => [KROGER_TOKEN_URL, LOCATION_URL]],
    ["a location 403", (map) => map.set(LOCATION_URL, () => new Response("forbidden", { status: 403 })),
      /unexpected HTTP 403/, () => [KROGER_TOKEN_URL, LOCATION_URL]],
    ["a products 401", (map) => map.set(productsUrl(1), () => new Response("expired", { status: 401 })),
      /unexpected HTTP 401/, () => [KROGER_TOKEN_URL, LOCATION_URL, productsUrl(0), productsUrl(1)]],
    ["a products 403", (map) => map.set(productsUrl(0), () => new Response("forbidden", { status: 403 })),
      /unexpected HTTP 403/, () => [KROGER_TOKEN_URL, LOCATION_URL, productsUrl(0)]],
    ["a location with another locationId", (map) => map.set(LOCATION_URL, bearer(locationBody({ locationId: "70500999" }))),
      /returned locationId "70500999", not 70500807/, () => [KROGER_TOKEN_URL, LOCATION_URL]],
    ["a location of another chain", (map) => map.set(LOCATION_URL, bearer(locationBody({ chain: "FRED MEYER" }))),
      /returned chain "FRED MEYER", not QFC/, () => [KROGER_TOKEN_URL, LOCATION_URL]],
    ["every catalog query returning zero products", (map) => allProductUrls().forEach((url) => map.set(url, bearer(EMPTY_PRODUCTS))),
      /every Kroger catalog query .*returned zero products/, () => [KROGER_TOKEN_URL, LOCATION_URL, ...allProductUrls()]],
    ["a products response without a data array", (map) => map.set(productsUrl(2), bearer(JSON.stringify({ meta: {} }))),
      /schema: Kroger products response has no data array/, () => [KROGER_TOKEN_URL, LOCATION_URL, productsUrl(0), productsUrl(1), productsUrl(2)]],
  ])("%s is a source error (exit 2) and nothing is sent after it", async (_label, change, message, expected) => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    change(world.map);
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher, { validationsPath: writeValidations(krogerFile()) });
    expect(result).toMatchObject({ status: "ERROR", exitCode: 2, snapshotWritten: false, snapshot: null });
    expect(result.message).toMatch(message);
    expect(krogerRequests(requested)).toEqual(expected());
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "ERROR", exitCode: 2, error: { name: "FlippSourceError" } });
    expectPriorSnapshotPreserved();
  });

  it("a products response redirected to another URL is rejected (exit 2) and never audited", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    const otherStore = krogerProductsUrl(CATALOG_QUERIES[0] ?? "", "70500999").href;
    world.map.set(productsUrl(0), () => new Response(null, { status: 302, headers: { location: otherStore } }));
    world.map.set(otherStore, bearer(PRODUCTS_BYTES));
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(result).toMatchObject({ status: "ERROR", exitCode: 2, snapshot: null });
    expect(result.message).toMatch(/Kroger products query 1 was redirected to .*70500999/);
    expect(krogerRequests(requested)).toEqual([KROGER_TOKEN_URL, LOCATION_URL, productsUrl(0), otherStore]);
    expect(existsSync(join(result.auditDir, "raw", "kroger-products-1.json"))).toBe(false);
    expectPriorSnapshotPreserved();
  });

  it("a products 503 follows the existing retry rules, then the response is accepted", async () => {
    const world = fixtureWorld();
    let calls = 0;
    const products = bearer(PRODUCTS_BYTES);
    world.map.set(productsUrl(0), (init) => (calls++ === 0 ? new Response(null, { status: 503, headers: { "retry-after": "0" } }) : products(init)));
    const result = await run(routes(world.map).fetcher);
    expect(result.status).toBe("BLOCKED");
    expect(calls).toBe(2);
    expect(diagnostics(result.auditDir).attempts).toContainEqual(expect.objectContaining({
      url: productsUrl(0), attempt: 1, status: 503, error: expect.stringMatching(/retry 1 of 2/),
    }));
  });

  it("A12: a deferral during the catalog queries stops all traffic (exit 3)", async () => {
    seedPriorSnapshot();
    const world = fixtureWorld();
    world.map.set(productsUrl(2), () => new Response(null, DEFERRAL));
    const { fetcher, requested } = routes(world.map);
    const result = await run(fetcher);
    expect(result).toMatchObject({ status: "DEFERRED", exitCode: 3, nextPermittedAt: NEXT_PERMITTED, snapshotWritten: false });
    expect(krogerRequests(requested)).toEqual([KROGER_TOKEN_URL, LOCATION_URL, productsUrl(0), productsUrl(1), productsUrl(2)]);
    expect(diagnostics(result.auditDir)).toMatchObject({ status: "DEFERRED", error: { name: "FlippDeferredError", status: 429, url: productsUrl(2) } });
    expect(auditReport(result.auditDir)).toContain(`Next permitted request: ${NEXT_PERMITTED}`);
    expectPriorSnapshotPreserved();
  });

  it("dedupes across queries deterministically: CATALOG_QUERIES order, and the first occurrence wins", async () => {
    const product = (productId: string, description: string) => ({
      productId, description, categories: ["Produce"], items: [{ price: { regular: 1.99 }, size: "1 lb", soldBy: "WEIGHT" }],
    });
    const first = JSON.stringify({ data: [product("0000000004133", "Gala Apple")] });
    const second = JSON.stringify({ data: [product("0000000004133", "Gala Apple Repeated"), product("0000000004131", "Honeycrisp Apple")] });
    const results: CollectResult[] = [];
    for (let round = 0; round < 2; round += 1) {
      const world = fixtureWorld();
      world.map.set(productsUrl(0), bearer(first));
      world.map.set(productsUrl(1), bearer(second));
      results.push(await run(routes(world.map).fetcher));
    }
    const [one, two] = results;
    const offers = one?.snapshot?.offers.filter(isKroger) ?? [];
    expect(offers.map((offer) => [offer.id, offer.label, offer.evidence[0]?.retrievedUrl])).toEqual([
      ["kroger-api:kroger:0000000004133", "Gala Apple", productsUrl(0)],
      ["kroger-api:kroger:0000000004131", "Honeycrisp Apple", productsUrl(1)],
    ]);
    expect(two?.snapshot?.offers.filter(isKroger)).toEqual(offers);
    const log = krogerLog(one?.auditDir ?? "");
    expect(log.queries.slice(0, 2).map((entry) => [entry.products, entry.offers, entry.repeats])).toEqual([[1, 1, 0], [2, 1, 1]]);
    expect(log.notes).toEqual([
      `product 0000000004133 at data[0] of ${productsUrl(1)} repeats the first occurrence at ${productsUrl(0)} data[0]; the first occurrence wins`,
    ]);
    expect(krogerLog(two?.auditDir ?? "").notes).toEqual(log.notes);
    expect(section(auditReport(one?.auditDir ?? ""), "Kroger catalog").some((line) => line.includes("the first occurrence wins"))).toBe(true);
  });

  it.each<[string, Partial<ValidationFile> | null, "verified" | "unknown", RegExp | null]>([
    ["no validations file", null, "unknown", null],
    ["no store attestation", { storeAttestations: [] }, "unknown", null],
    ["an attestation for another store", { storeAttestations: [{ ...KROGER_STORE, storeId: "70500999" }] }, "unknown", null],
    ["an attestation checked before collection", {}, "verified", null],
    ["an attestation checked exactly at collection", { storeAttestations: [{ ...KROGER_STORE, checkedAt: NOW.toISOString() }] }, "verified", null],
    ["an attestation checked after collection", { storeAttestations: [{ ...KROGER_STORE, checkedAt: "2026-09-24T19:00:00.001Z" }] }, "unknown",
      /checkedAt 2026-09-24T19:00:00\.001Z is after this run's collection time 2026-09-24T19:00:00\.000Z/],
    ["an incomplete attestation", { storeAttestations: [{ ...KROGER_STORE, applicabilityEvidence: " " }] }, "unknown", /applicabilityEvidence is empty/],
  ])("applicability with %s", async (_label, overrides, applicability, problem) => {
    const options = overrides === null ? {} : { validationsPath: writeValidations(krogerFile(overrides)) };
    const result = await run(routes(fixtureWorld().map).fetcher, options);
    expect(result.exitCode).toBe(1);
    const kroger = result.snapshot?.offers.filter(isKroger) ?? [];
    expect(kroger).toHaveLength(KROGER_OFFER_IDS.length);
    expect(kroger.every((offer) => offer.applicability === applicability)).toBe(true);
    const store = krogerLog(result.auditDir).store;
    expect(store?.applicability).toBe(applicability);
    expect(store?.problems).toEqual(problem === null ? [] : [expect.stringMatching(problem)]);
    // Only verified catalog offers can count.
    expect(evaluationOf(result.auditDir).families.kroger.count).toBe(applicability === "verified" ? COUNTABLE_PRODUCTS.length : 0);
  });

  describe("secrets", () => {
    const printed: string[] = [];
    let spies: Array<{ mockRestore: () => void }> = [];
    beforeEach(() => {
      printed.length = 0;
      spies = (["log", "error", "warn", "info", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          printed.push(args.map(String).join(" "));
        }));
    });
    afterEach(() => {
      for (const spy of spies) spy.mockRestore();
    });

    /** Everything the run left behind: every audit file, the report, the returned result and anything printed. */
    function leftBehind(result: CollectResult, reportPath: string): string {
      const files = readdirSync(result.auditDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"));
      const report = existsSync(reportPath) ? readFileSync(reportPath, "latin1") : "";
      return [...files, report, JSON.stringify(result), ...printed].join("\n");
    }

    it.each<[string, (map: Map<string, Body>) => void, number, boolean]>([
      ["a BLOCKED run", () => undefined, 1, false],
      ["a token 401 whose body echoes the credentials",
        (map) => map.set(KROGER_TOKEN_URL, () => new Response(`bad ${CLIENT_ID} ${CLIENT_SECRET} Basic ${BASIC}`, { status: 401 })), 2, false],
      ["a location mismatch", (map) => map.set(LOCATION_URL, bearer(locationBody({ locationId: "70500999" }))), 2, false],
      ["a location 200 that echoes the token", (map) => map.set(LOCATION_URL, bearer(locationBody({ name: TOKEN }))), 2, false],
      ["a products 200 that echoes the token",
        (map) => map.set(productsUrl(0), bearer(JSON.stringify({ data: [{ productId: "0000000004133", description: `Gala Apple ${TOKEN}` }] }))), 2, false],
      ["a products 401 whose body echoes the token", (map) => map.set(productsUrl(1), () => new Response(`expired Bearer ${TOKEN}`, { status: 401 })), 2, true],
      ["a products redirect whose Location carries the token",
        (map) => map.set(productsUrl(0), () => new Response(null, { status: 302, headers: { location: `${productsUrl(0)}&t=${TOKEN}` } })), 2, true],
      ["a deferral whose body echoes the token", (map) => map.set(productsUrl(1), () => new Response(`slow down ${TOKEN}`, DEFERRAL)), 3, true],
    ])("%s leaves no client id, secret, Basic value or token anywhere", async (_label, change, exitCode, redacted) => {
      const world = fixtureWorld();
      change(world.map);
      const reportPath = join(root, "proof.md");
      const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(krogerFile()), reportPath });
      expect(result.exitCode).toBe(exitCode);
      const text = leftBehind(result, reportPath);
      for (const secret of SECRETS) expect(text).not.toContain(secret);
      // Where a server echoed the token into kept text, it was hidden rather than dropped silently.
      expect(text.includes("[redacted]")).toBe(redacted);
    });
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
    const result = await collect({ postalCode: "98105", dataDir, clock, env: ENV });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/disabled in tests/);
  });

  it("H3: a live run with no accepted response gives neutral counts, not retrieved live responses", async () => {
    const result = await collect({ postalCode: "98105", dataDir, clock, env: ENV });
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

describe("parseValidationFile storeAttestations (catalog amendment)", () => {
  const base = { schemaVersion: 1, attestations: [], validations: [], pairs: [] };
  const parse = (value: unknown) => parseValidationFile(JSON.stringify(value));

  it("absent storeAttestations means none", () => {
    const parsed = parse(base);
    expect(parsed).toEqual(base);
    expect("storeAttestations" in parsed).toBe(false);
  });

  it("parses valid store attestations exactly", () => {
    const safeway = { ...STORE_ATTESTATION, family: "albertsons", provider: "safeway-search", storeId: "9200" };
    expect(parse({ ...base, storeAttestations: [STORE_ATTESTATION, safeway] })).toEqual({ ...base, storeAttestations: [STORE_ATTESTATION, safeway] });
    expect(parse({ ...base, storeAttestations: [] })).toEqual({ ...base, storeAttestations: [] });
  });

  it.each<[string, unknown, RegExp]>([
    ["a null list", null, /storeAttestations must be an array/],
    ["an object list", {}, /storeAttestations must be an array/],
    ["a non-object entry", ["x"], /storeAttestations\[0\] must be an object/],
    ["an unknown key", [{ ...STORE_ATTESTATION, flyerId: 1 }], /storeAttestations\[0\] has unknown key flyerId/],
    ["a missing storeId", [{ ...STORE_ATTESTATION, storeId: undefined }], /storeAttestations\[0\] is missing storeId/],
    ["a numeric storeId", [{ ...STORE_ATTESTATION, storeId: 91000001 }], /storeAttestations\[0\]\.storeId must be a string/],
    ["an unknown family", [{ ...STORE_ATTESTATION, family: "costco" }], /storeAttestations\[0\]\.family must be one of/],
    ["an unknown provider", [{ ...STORE_ATTESTATION, provider: "flipp" }], /storeAttestations\[0\]\.provider must be one of "kroger-api", "safeway-search"/],
    ["an unverified applicability", [{ ...STORE_ATTESTATION, applicability: "unknown" }], /storeAttestations\[0\]\.applicability must be one of "verified"/],
    ["a non-string checkedAt", [{ ...STORE_ATTESTATION, checkedAt: 1 }], /storeAttestations\[0\]\.checkedAt must be a string/],
    ["a non-string applicabilityEvidence", [{ ...STORE_ATTESTATION, applicabilityEvidence: null }], /storeAttestations\[0\]\.applicabilityEvidence must be a string/],
  ])("rejects %s", (_label, storeAttestations, message) => {
    expect(() => parse({ ...base, storeAttestations })).toThrow(message);
  });

  it("still rejects other unknown root keys", () => {
    expect(() => parse({ ...base, storeAttestation: [] })).toThrow(/file has unknown key storeAttestation/);
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
    ["storeAttestations that is not an array", { schemaVersion: 1, attestations: [], storeAttestations: {}, validations: [], pairs: [] }],
    ["a store attestation with an unknown key", { schemaVersion: 1, attestations: [], storeAttestations: [{ ...STORE_ATTESTATION, note: "x" }], validations: [], pairs: [] }],
    ["a store attestation with an unknown provider", { schemaVersion: 1, attestations: [], storeAttestations: [{ ...STORE_ATTESTATION, provider: "flipp" }], validations: [], pairs: [] }],
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

  it("accepts a validations file with storeAttestations; the gate channel is retailer-pickup (D1)", async () => {
    const world = syntheticWorld();
    const file: ValidationFile = { ...world.file, storeAttestations: [STORE_ATTESTATION] };
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(file) });
    expect(result.status).toBe("BLOCKED");
    expect(result.exitCode).toBe(1);
    expect(result.snapshot?.proof.channel).toBe("retailer-pickup");
    // The attestation names another store, so no Kroger offer is verified.
    expect(result.snapshot?.offers.filter(isKroger).every((offer) => offer.applicability === "unknown")).toBe(true);
  });

  it("the collector's proof channel is retailer-pickup even without a validations file", async () => {
    const result = await run(routes(fixtureWorld().map).fetcher);
    expect(result.status).toBe("BLOCKED");
    expect(result.snapshot?.proof.channel).toBe("retailer-pickup");
  });

  it("accepts a validations file with a UTF-8 BOM", async () => {
    const world = syntheticWorld();
    const result = await run(routes(world.map).fetcher, { validationsPath: writeValidations(`\uFEFF${JSON.stringify(world.file)}`) });
    expect(result.exitCode).toBe(1);
    // The file was read: its flyer attestations verified the weekly-ad offers.
    expect(result.snapshot?.offers.filter(isFlipp).every((offer) => offer.applicability === "verified")).toBe(true);
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
  it("a failing cleanup never masks the original write error (gate forced to PASS)", async () => {
    seedPriorSnapshot();
    gate.forcePass = true;
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

  it("PASS keeps exit 0 and the written snapshot when the report cannot be written (gate forced to PASS)", async () => {
    seedPriorSnapshot();
    gate.forcePass = true;
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
    gate.forcePass = true; // the retailer-pickup gate cannot pass before S2; the snapshot write path still runs
    const second = await run(routes(world.map).fetcher, { validationsPath, reportPath: join(root, "out", "pass.md") });
    expect([first.status, second.status]).toEqual(["BLOCKED", "PASS"]);
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
