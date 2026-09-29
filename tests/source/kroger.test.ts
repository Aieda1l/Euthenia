import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_VERIFIED_FIELDS, type Offer, type SourceSnapshot, type Validation } from "../../src/shared/contracts.js";
import { comparisonKey } from "../../src/shared/identity.js";
import { CATALOG_QUERIES, MEAT_QUERIES, PRODUCE_QUERIES } from "../../src/source/catalogQueries.js";
import { FlippSourceError } from "../../src/source/flipp.js";
import {
  KROGER_TOKEN_URL,
  KrogerCredentialsError,
  QFC_LOCATION_ID,
  krogerEvidence,
  krogerLocation,
  krogerProducts,
  krogerProductsUrl,
  krogerToken,
  normalizeKroger,
  normalizeKrogerResponse,
  type KrogerContext,
} from "../../src/source/kroger.js";
import { evaluateProof } from "../../src/source/proof.js";

// Offline tests for task K1. Every request goes to an injected fetcher and
// timers are faked; nothing touches the network. The fixtures under
// tests/fixtures/kroger/ are SYNTHETIC (see their "_synthetic" field): shapes
// follow public Kroger documentation, unverified until K3. The credentials
// and token below are fake, distinctive values used only to prove that no
// error ever carries them.

const NOW = new Date("2026-09-29T19:00:00.000Z");
const OBSERVED_AT = "2026-09-29T18:00:00.000Z";
const CLIENT_ID = "fake-client-id-K1Q7ZX";
const CLIENT_SECRET = "fake-client-secret-S3CR3T9D8F";
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64");
const TOKEN = `fake-access-token-T0K3N7W-${"q".repeat(64)}`;
const SECRETS = [CLIENT_ID, CLIENT_SECRET, BASIC, TOKEN, "K1Q7ZX", "S3CR3T9D8F", "T0K3N7W"];
const ENV = { KROGER_CLIENT_ID: CLIENT_ID, KROGER_CLIENT_SECRET: CLIENT_SECRET };
const JSON_TYPE = "application/json; charset=utf-8";

const LOCATION_BYTES = readFileSync(new URL("../fixtures/kroger/location-70500807.json", import.meta.url));
const PRODUCTS_BYTES = readFileSync(new URL("../fixtures/kroger/products-synthetic.json", import.meta.url));
const PRODUCTS_URL = "https://api.kroger.com/v1/products?filter.term=apples&filter.locationId=70500807&filter.limit=20";

function productsJson(): { data: Record<string, unknown>[] } {
  return JSON.parse(PRODUCTS_BYTES.toString("utf8")) as { data: Record<string, unknown>[] };
}
function fixtureProduct(productId: string): Record<string, unknown> {
  const found = productsJson().data.find((product) => product.productId === productId);
  if (!found) throw new Error(`fixture: no product ${productId}`);
  return found;
}

function jsonResponse(body: string | Uint8Array, init: { status?: number; contentType?: string; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: { "content-type": init.contentType ?? JSON_TYPE, ...init.headers } });
}

/** Fetcher that serves the given responses in order and fails on extra calls. */
function sequence(...responses: Array<() => Response>) {
  let index = 0;
  return vi.fn<typeof fetch>(async () => {
    const next = responses[index++];
    if (!next) throw new Error("unexpected extra request");
    return next();
  });
}

/** A fetcher whose request never answers until its signal aborts. */
function hanging() {
  return vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
}

function tokenBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ access_token: TOKEN, expires_in: 1800, token_type: "bearer", ...overrides });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** Neither the message nor util.inspect of the error holds any credential, Basic value or token. */
function expectNoSecrets(error: unknown): void {
  const shown = `${error instanceof Error ? error.message : String(error)}\n${inspect(error, { depth: 10 })}`;
  for (const secret of SECRETS) expect(shown).not.toContain(secret);
}

function requestInit(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): RequestInit {
  const init = fetcher.mock.calls[call]?.[1];
  if (!init) throw new Error("no request init");
  return init;
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

describe("krogerToken", () => {
  it("POSTs client credentials with Basic auth to the fixed token URL and returns the token", async () => {
    const fetcher = sequence(() => jsonResponse(tokenBody()));
    await expect(krogerToken(ENV, fetcher)).resolves.toBe(TOKEN);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.kroger.com/v1/connect/oauth2/token");
    expect(KROGER_TOKEN_URL).toBe("https://api.kroger.com/v1/connect/oauth2/token");
    const init = requestInit(fetcher);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(header(init, "authorization")).toBe(`Basic ${BASIC}`);
    expect(header(init, "content-type")).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBe("grant_type=client_credentials&scope=product.compact");
  });

  it("reads the credentials from the env object at call time", async () => {
    const env: Record<string, string | undefined> = {};
    const fetcher = sequence(() => jsonResponse(tokenBody()));
    await expect(krogerToken(env, fetcher)).rejects.toBeInstanceOf(KrogerCredentialsError);
    env.KROGER_CLIENT_ID = CLIENT_ID;
    env.KROGER_CLIENT_SECRET = CLIENT_SECRET;
    await expect(krogerToken(env, fetcher)).resolves.toBe(TOKEN);
  });

  it.each([
    ["both missing", {}, /KROGER_CLIENT_ID and KROGER_CLIENT_SECRET/],
    ["the secret missing", { KROGER_CLIENT_ID: CLIENT_ID }, /KROGER_CLIENT_SECRET is not set/],
    ["the id missing", { KROGER_CLIENT_SECRET: CLIENT_SECRET }, /KROGER_CLIENT_ID is not set/],
    ["an empty secret", { KROGER_CLIENT_ID: CLIENT_ID, KROGER_CLIENT_SECRET: "" }, /KROGER_CLIENT_SECRET is not set/],
    ["a blank id", { KROGER_CLIENT_ID: "   ", KROGER_CLIENT_SECRET: CLIENT_SECRET }, /KROGER_CLIENT_ID is not set/],
  ])("is a usage error with %s, before any request and without printing any value", async (_label, env, message) => {
    const fetcher = sequence(() => jsonResponse(tokenBody()));
    const error = await caught(krogerToken(env, fetcher));
    expect(error).toBeInstanceOf(KrogerCredentialsError);
    expect((error as Error).message).toMatch(message);
    expectNoSecrets(error);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a client id containing ':' without printing it", async () => {
    const fetcher = sequence(() => jsonResponse(tokenBody()));
    const error = await caught(krogerToken({ KROGER_CLIENT_ID: `${CLIENT_ID}:x`, KROGER_CLIENT_SECRET: CLIENT_SECRET }, fetcher));
    expect(error).toBeInstanceOf(KrogerCredentialsError);
    expectNoSecrets(error);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 400, 403, 500, 503])("fails on HTTP %i with only the status, once, never retried", async (status) => {
    const fetcher = sequence(() => jsonResponse(JSON.stringify({ error: "invalid_client", echo: `${CLIENT_ID}:${CLIENT_SECRET} ${BASIC}` }), {
      status, headers: { "www-authenticate": `Basic realm="${BASIC}"` },
    }));
    const error = await caught(krogerToken(ENV, fetcher));
    expect(error).toBeInstanceOf(FlippSourceError);
    expect((error as FlippSourceError).status).toBe(status);
    expect((error as Error).message).toMatch(new RegExp(`Kroger token request failed: HTTP ${status}\\b`));
    expectNoSecrets(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never follows a redirect, even to the same host", async () => {
    const fetcher = sequence(() => new Response(null, {
      status: 302, headers: { location: `https://api.kroger.com/v1/connect/oauth2/token?c=${CLIENT_SECRET}&t=${TOKEN}` },
    }));
    const error = await caught(krogerToken(ENV, fetcher));
    expect(error).toBeInstanceOf(FlippSourceError);
    expect((error as FlippSourceError).status).toBe(302);
    expectNoSecrets(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out after 15 s with fake timers", async () => {
    const fetcher = hanging();
    const pending = caught(krogerToken(ENV, fetcher));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requestInit(fetcher).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(FlippSourceError);
    expect((error as Error).message).toMatch(/timed out after 15 s/);
    expect(requestInit(fetcher).signal?.aborted).toBe(true);
    expectNoSecrets(error);
  });

  it("the timeout covers a body that never ends", async () => {
    const endless = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`{"access_token":"${TOKEN}"`)); } });
    const fetcher = sequence(() => new Response(endless, { status: 200, headers: { "content-type": JSON_TYPE } }));
    const pending = caught(krogerToken(ENV, fetcher));
    await vi.advanceTimersByTimeAsync(15_000);
    const error = await pending;
    expect((error as Error).message).toMatch(/timed out after 15 s/);
    expectNoSecrets(error);
  });

  it.each([
    ["malformed JSON that holds the token", () => jsonResponse(`{"access_token":"${TOKEN}","token_type":`), /malformed JSON/],
    ["an HTML body", () => jsonResponse(`<html>${TOKEN}</html>`, { contentType: "text/html" }), /not application\/json/],
    ["a non-JSON content type", () => jsonResponse(tokenBody(), { contentType: `text/plain; x=${CLIENT_SECRET}` }), /not application\/json/],
    ["invalid UTF-8", () => jsonResponse(new Uint8Array([0x7b, 0xff, 0x7d])), /UTF-8/],
    ["a JSON array", () => jsonResponse(`["${TOKEN}"]`), /no usable access_token/],
    ["no access_token", () => jsonResponse(JSON.stringify({ token_type: "bearer", note: TOKEN })), /no usable access_token/],
    ["an empty access_token", () => jsonResponse(tokenBody({ access_token: "" })), /no usable access_token/],
    ["an access_token with whitespace", () => jsonResponse(tokenBody({ access_token: `${TOKEN} x` })), /no usable access_token/],
    ["a non-bearer token_type", () => jsonResponse(tokenBody({ token_type: `mac ${TOKEN}` })), /token_type is not bearer/],
  ])("fails on %s without the token", async (_label, reply, message) => {
    const error = await caught(krogerToken(ENV, sequence(reply)));
    expect(error).toBeInstanceOf(FlippSourceError);
    expect((error as Error).message).toMatch(message);
    expectNoSecrets(error);
  });

  it("accepts token_type Bearer in any case", async () => {
    await expect(krogerToken(ENV, sequence(() => jsonResponse(tokenBody({ token_type: "Bearer" }))))).resolves.toBe(TOKEN);
  });

  it("a transport error names only its code, never the fetcher's message", async () => {
    const cause = Object.assign(new Error(`socket said ${CLIENT_SECRET}`), { code: "ECONNRESET" });
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`fetch failed for Basic ${BASIC}`, { cause });
    });
    const error = await caught(krogerToken(ENV, fetcher));
    expect(error).toBeInstanceOf(FlippSourceError);
    expect((error as Error).message).toMatch(/transport error \(ECONNRESET\)/);
    expectNoSecrets(error);
  });

  it("sends nothing after a run-wide abort and rejects with its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("run stopped");
    controller.abort(reason);
    const fetcher = sequence(() => jsonResponse(tokenBody()));
    await expect(krogerToken(ENV, fetcher, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a run-wide abort ends the in-flight token request", async () => {
    const controller = new AbortController();
    const reason = new Error("run stopped");
    const fetcher = hanging();
    const pending = caught(krogerToken(ENV, fetcher, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(requestInit(fetcher).signal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

function locationBody(data: Record<string, unknown>): string {
  const base = JSON.parse(LOCATION_BYTES.toString("utf8")) as { data: Record<string, unknown> };
  return JSON.stringify({ data: { ...base.data, ...data } });
}

describe("krogerLocation", () => {
  it("GETs /v1/locations/70500807 with the Bearer token and returns the parsed store plus the raw response", async () => {
    const fetcher = sequence(() => jsonResponse(LOCATION_BYTES));
    const { location, response } = await krogerLocation(TOKEN, fetcher);
    expect(QFC_LOCATION_ID).toBe("70500807");
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.kroger.com/v1/locations/70500807");
    const init = requestInit(fetcher);
    expect(init.method).toBe("GET");
    expect(header(init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(location).toEqual({
      locationId: "70500807",
      chain: "QFC",
      name: "SYNTHETIC QFC store name",
      address: { addressLine1: "123 Synthetic Example St", city: "Seattle", state: "WA", zipCode: "98105" },
    });
    expect(Buffer.from(response.bytes).equals(LOCATION_BYTES)).toBe(true);
    expect(response.requestUrl).toBe("https://api.kroger.com/v1/locations/70500807");
  });

  it.each([
    ["another locationId", { locationId: "70500808" }, /locationId/],
    ["a numeric locationId", { locationId: 70500807 }, /locationId/],
    ["another chain", { chain: "KROGER" }, /chain/],
    ["a lowercase chain", { chain: "qfc" }, /chain/],
    ["no name", { name: undefined }, /name/],
    ["no address", { address: undefined }, /address/],
    ["an address without zipCode", { address: { addressLine1: "x", city: "Seattle", state: "WA" } }, /address/],
  ])("is a source error for %s", async (_label, data, message) => {
    const error = await caught(krogerLocation(TOKEN, sequence(() => jsonResponse(locationBody(data)))));
    expect(error).toBeInstanceOf(FlippSourceError);
    expect((error as Error).message).toMatch(message);
    expectNoSecrets(error);
  });

  it("is a source error when data is missing, without quoting a long server value", async () => {
    const error = await caught(krogerLocation(TOKEN, sequence(() => jsonResponse(JSON.stringify({ data: [TOKEN] })))));
    expect(error).toBeInstanceOf(FlippSourceError);
    expectNoSecrets(error);
    const echoed = await caught(krogerLocation(TOKEN, sequence(() => jsonResponse(locationBody({ chain: TOKEN })))));
    expect((echoed as Error).message).toMatch(/chain/);
    expectNoSecrets(echoed);
  });

  it("checks a caller-supplied locationId and rejects a malformed one before any request", async () => {
    const other = sequence(() => jsonResponse(locationBody({ locationId: "70500123" })));
    await expect(krogerLocation(TOKEN, other, "70500123")).resolves.toMatchObject({ location: { locationId: "70500123" } });
    for (const bad of ["705008", "7050080a", "../70500807", ""]) {
      const fetcher = sequence(() => jsonResponse(LOCATION_BYTES));
      await expect(krogerLocation(TOKEN, fetcher, bad)).rejects.toBeInstanceOf(FlippSourceError);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("a 401 (expired token) is a source error that never shows the token", async () => {
    const fetcher = sequence(() => jsonResponse(JSON.stringify({ error: "invalid_token", token: TOKEN }), { status: 401 }));
    const error = await caught(krogerLocation(TOKEN, fetcher));
    expect(error).toBeInstanceOf(FlippSourceError);
    expect((error as FlippSourceError).status).toBe(401);
    expectNoSecrets(error);
  });

  it("rejects an empty or malformed token before any request, without printing it", async () => {
    for (const bad of ["", "has space", `${TOKEN}\n`]) {
      const fetcher = sequence(() => jsonResponse(LOCATION_BYTES));
      const error = await caught(krogerLocation(bad, fetcher));
      expect(error).toBeInstanceOf(FlippSourceError);
      expectNoSecrets(error);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Products URL and request
// ---------------------------------------------------------------------------

describe("krogerProductsUrl and krogerProducts", () => {
  it("builds the exact products URL the proof expects", () => {
    expect(krogerProductsUrl("gala apples", "70500807").href)
      .toBe("https://api.kroger.com/v1/products?filter.term=gala+apples&filter.locationId=70500807&filter.limit=20");
  });

  it.each(["ground beef 80/20", "a&filter.locationId=11111111", "x#y", "café 100%"])("encodes %j so it stays one filter.term", (query) => {
    const url = krogerProductsUrl(query, "70500807");
    expect(url.href.startsWith("https://api.kroger.com/v1/products?")).toBe(true);
    expect(url.href).not.toContain("#");
    expect(url.searchParams.getAll("filter.term")).toEqual([query]);
    expect(url.searchParams.getAll("filter.locationId")).toEqual(["70500807"]);
    expect(url.searchParams.getAll("filter.limit")).toEqual(["20"]);
    expect([...url.searchParams.keys()]).toEqual(["filter.term", "filter.locationId", "filter.limit"]);
  });

  it("rejects an empty query or a malformed locationId", () => {
    expect(() => krogerProductsUrl("  ", "70500807")).toThrow(FlippSourceError);
    expect(() => krogerProductsUrl("apples", "7050080")).toThrow(FlippSourceError);
    expect(() => krogerProductsUrl("apples", "7050080x")).toThrow(FlippSourceError);
  });

  it("GETs the products URL with the Bearer token and returns the exact bytes", async () => {
    const fetcher = sequence(() => jsonResponse(PRODUCTS_BYTES));
    const response = await krogerProducts(TOKEN, fetcher, "apples", "70500807");
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(PRODUCTS_URL);
    expect(header(requestInit(fetcher), "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(response.requestUrl).toBe(PRODUCTS_URL);
    expect(Buffer.from(response.bytes).equals(PRODUCTS_BYTES)).toBe(true);
  });

  it("passes the run's attempt hook through without the token", async () => {
    const attempts: unknown[] = [];
    const fetcher = sequence(() => jsonResponse(PRODUCTS_BYTES));
    await krogerProducts(TOKEN, fetcher, "apples", "70500807", { onAttempt: (attempt) => attempts.push(attempt) });
    expect(attempts).toHaveLength(1);
    expect(JSON.stringify(attempts)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Catalog queries
// ---------------------------------------------------------------------------

describe("CATALOG_QUERIES", () => {
  it("is one fixed list of about 20 produce and 15 meat terms", () => {
    expect(PRODUCE_QUERIES.length).toBeGreaterThanOrEqual(18);
    expect(PRODUCE_QUERIES.length).toBeLessThanOrEqual(22);
    expect(MEAT_QUERIES.length).toBeGreaterThanOrEqual(13);
    expect(MEAT_QUERIES.length).toBeLessThanOrEqual(17);
    expect(CATALOG_QUERIES).toEqual([...PRODUCE_QUERIES, ...MEAT_QUERIES]);
    expect(new Set(CATALOG_QUERIES).size).toBe(CATALOG_QUERIES.length);
  });

  it("holds plain lowercase terms of 3+ characters and at most 8 words that build valid URLs", () => {
    for (const query of CATALOG_QUERIES) {
      expect(query).toBe(query.trim().toLowerCase());
      expect(query.length).toBeGreaterThanOrEqual(3);
      expect(query.split(/\s+/).length).toBeLessThanOrEqual(8);
      expect(krogerProductsUrl(query, QFC_LOCATION_ID).searchParams.get("filter.term")).toBe(query);
    }
  });
});

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

const CONTEXT_BASE: Omit<KrogerContext, "evidence"> = {
  family: "kroger", retailer: "QFC", postalCode: "98105", observedAt: OBSERVED_AT, applicability: "verified", locationId: "70500807",
};

function contextFor(product: Record<string, unknown>): KrogerContext {
  return {
    ...CONTEXT_BASE,
    evidence: krogerEvidence({ rawBody: PRODUCTS_BYTES, product, retrievedUrl: PRODUCTS_URL, observedAt: OBSERVED_AT }),
  };
}

function normalize(product: Record<string, unknown>): Offer {
  const result = normalizeKroger(product, contextFor(product));
  if ("excluded" in result) throw new Error(`unexpectedly excluded: ${result.excluded}`);
  return result;
}

let syntheticId = 9_100_000_009_000;
/** A SYNTHETIC product in the documented shape; overrides replace whole fields. */
function product(overrides: Record<string, unknown> = {}, item: Record<string, unknown> = {}): Record<string, unknown> {
  const productId = String(syntheticId++);
  return {
    productId, upc: productId, brand: "Kroger", description: "Gala Apple", categories: ["Produce"],
    temperature: { indicator: "Ambient", heatSensitive: false },
    items: [{ itemId: productId, price: { regular: 3.99, promo: 0 }, size: "1 lb", soldBy: "WEIGHT", ...item }],
    ...overrides,
  };
}
function meat(description: string, indicator: string | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return product({
    description, categories: ["Meat & Seafood"],
    temperature: indicator === null ? undefined : { indicator, heatSensitive: true },
    ...overrides,
  });
}

const known = <T>(value: T) => ({ state: "known" as const, value });
const unknown = { state: "unknown" as const };

describe("normalizeKroger: fixture cases", () => {
  it("loose PLU 4133: conventional produce, per-lb regular price, D3 conditions and a catalog calendar", () => {
    const offer = normalize(fixtureProduct("0000000004133"));
    const hash = createHash("sha256").update(PRODUCTS_BYTES).digest("hex");
    expect(offer).toEqual({
      id: "kroger-api:kroger:0000000004133",
      family: "kroger",
      retailer: "QFC",
      label: "Gala Apple",
      postalCode: "98105",
      storeName: null,
      storeAddress: null,
      applicability: "verified",
      channel: "retailer-pickup",
      identity: { category: "produce", kind: known("apple"), variety: known("gala"), form: known("whole"), organic: known(false) },
      rawPrice: {
        itemCount: "1", regular: "1.99", promo: "0", regularPerUnitEstimate: null, promoPerUnitEstimate: null, size: "1 lb", soldBy: "WEIGHT",
      },
      unitPrice: { basis: "lb", cents: { n: "199", d: "1" } },
      normalizationIssue: null,
      packageMassLb: null,
      packageCount: null,
      packageTotalCents: null,
      conditions: { complete: true, loyaltyRequired: false, couponRequired: false, couponIds: [], minimumUnits: null, maximumUnits: null, text: [] },
      evidence: [{
        id: `kroger-api:product:0000000004133:${hash.slice(0, 12)}`,
        provider: "kroger-api",
        sourceItemId: "0000000004133",
        retrievedUrl: PRODUCTS_URL,
        sourceUrl: PRODUCTS_URL,
        observedAt: OBSERVED_AT,
        rawSha256: hash,
        rawValidity: {},
      }],
      observedAt: OBSERVED_AT,
      startsAt: null,
      expiresAt: null,
      calendarRule: "catalog-observation",
    });
    expect(comparisonKey(offer.identity)).toBe("produce|kind=apple|variety=gala|form=whole|organic=false");
  });

  it("organic PLU 94133: organic, regular price only; promo and estimates stay raw", () => {
    const offer = normalize(fixtureProduct("0000000094133"));
    expect(offer.identity).toMatchObject({ organic: known(true), variety: known("gala") });
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "249", d: "1" } });
    expect(offer.rawPrice).toMatchObject({ regular: "2.49", promo: "1.99", regularPerUnitEstimate: "0.83", promoPerUnitEstimate: "0.66" });
    expect(offer.conditions).toMatchObject({ complete: true, loyaltyRequired: false, couponRequired: false });
  });

  it("3 lb bag: UNIT 3 lb gives lb via the package; no PLU leaves organic unknown", () => {
    const offer = normalize(fixtureProduct("9100000000301"));
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "599", d: "3" } });
    expect(offer.packageMassLb).toEqual({ n: "3", d: "1" });
    expect(offer.packageTotalCents).toBe(599);
    expect(offer.packageCount).toBeNull();
    expect(offer.normalizationIssue).toBeNull();
    expect(offer.identity).toMatchObject({ kind: known("apple"), variety: known("honeycrisp"), organic: unknown });
    expect(comparisonKey(offer.identity)).toBeNull();
  });

  it("80/20 ground beef by WEIGHT: fresh from Refrigerated, fat 20, per-lb price", () => {
    const offer = normalize(fixtureProduct("9100000000401"));
    expect(offer.identity).toEqual({
      category: "meat", species: known("beef"), cut: known("ground"), bone: { state: "not-applicable" },
      skin: { state: "not-applicable" }, freshFrozen: known("fresh"), fatPercent: known(20),
    });
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "549", d: "1" } });
    expect(offer.rawPrice.regularPerUnitEstimate).toBe("5.49");
  });

  it("frozen chicken: temperature Frozen gives frozen", () => {
    const offer = normalize(fixtureProduct("9100000000501"));
    expect(offer.identity).toMatchObject({ species: known("chicken"), cut: known("breast"), bone: known("out"), skin: known("off"), freshFrozen: known("frozen") });
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "333", d: "1" } });
    expect(comparisonKey(offer.identity)).not.toBeNull();
  });

  it("no price: unit price null with an issue, never zero", () => {
    const offer = normalize(fixtureProduct("0000000004011"));
    expect(offer.unitPrice).toBeNull();
    expect(offer.packageTotalCents).toBeNull();
    expect(offer.normalizationIssue).toMatch(/price\.regular is missing/);
    expect(offer.rawPrice).toMatchObject({ regular: null, promo: null, size: "1 lb", soldBy: "WEIGHT" });
  });

  it("multiple items: unit price null with an issue", () => {
    const offer = normalize(fixtureProduct("9100000000701"));
    expect(offer.unitPrice).toBeNull();
    expect(offer.normalizationIssue).toMatch(/2 items\[\] entries/);
    expect(offer.rawPrice).toMatchObject({ itemCount: "2", regular: null, size: null });
    expect(offer.packageMassLb).toBeNull();
  });

  it("category conflict: excluded with a reason", () => {
    const product = fixtureProduct("9100000000801");
    expect(normalizeKroger(product, contextFor(product))).toEqual({ excluded: expect.stringMatching(/categories .*Deli.* do not include Meat/) });
  });

  it("loose lemon sold each", () => {
    const offer = normalize(fixtureProduct("0000000004958"));
    expect(offer.unitPrice).toEqual({ basis: "each", cents: { n: "79", d: "1" } });
    expect(comparisonKey(offer.identity)).toBe("produce|kind=lemon|variety=n%2Fa|form=whole|organic=false");
  });
});

describe("normalizeKroger: category agreement", () => {
  it.each([
    ["missing categories", { categories: undefined }, /categories are missing/],
    ["empty categories", { categories: [] }, /categories are missing/],
    ["non-string categories", { categories: [1] }, /categories are missing/],
    ["produce text without a Produce category", { categories: ["Snacks"] }, /do not include Produce/],
    ["produce text with a meat category too", { categories: ["Produce", "Meat & Seafood"] }, /also include a meat category/],
    ["frozen produce by temperature", { temperature: { indicator: "Frozen", heatSensitive: true } }, /frozen produce/],
    ["an excluded description", { description: "Apple Juice" }, /juice/],
    ["a missing description", { description: undefined }, /description/],
  ])("excludes %s", (_label, overrides, reason) => {
    const item = product(overrides);
    const result = normalizeKroger(item, contextFor(item));
    expect(result).toEqual({ excluded: expect.stringMatching(reason) });
  });

  it("accepts Meat or Meat & Seafood for meat, and extra non-conflicting categories", () => {
    expect(normalize(meat("Boneless Pork Chops", "Refrigerated", { categories: ["Meat"] })).identity.category).toBe("meat");
    expect(normalize(meat("Boneless Pork Chops", "Refrigerated", { categories: ["Meat & Seafood", "Natural & Organic"] })).identity.category).toBe("meat");
    const excluded = meat("Boneless Pork Chops", "Refrigerated", { categories: ["Meat & Seafood", "Produce"] });
    expect(normalizeKroger(excluded, contextFor(excluded))).toEqual({ excluded: expect.stringMatching(/also include Produce/) });
  });

  it.each([
    ["not an object", "x"],
    ["no productId", { description: "Gala Apple" }],
    ["a numeric productId", { productId: 4133 }],
    ["a 12-digit productId", { productId: "000000004133" }],
  ])("excludes a product with %s", (_label, value) => {
    const context = contextFor(fixtureProduct("0000000004133"));
    expect(normalizeKroger(value, context)).toEqual({ excluded: expect.stringMatching(/productId|not an object/) });
  });
});

describe("normalizeKroger: D4 organic from the loose PLU", () => {
  it.each([
    ["4-digit PLU 3000-4999 with silent text", "0000000004131", "Fuji Apple", known(false)],
    ["4-digit PLU at the 3000 bound", "0000000003000", "Fuji Apple", known(false)],
    ["4-digit PLU at the 4999 bound", "0000000004999", "Fuji Apple", known(false)],
    ["9-prefixed 5-digit PLU with silent text", "0000000094131", "Fuji Apple", known(true)],
    ["organic text agreeing with a 9-prefixed PLU", "0000000094131", "Organic Fuji Apple", known(true)],
    ["organic text conflicting with a conventional PLU", "0000000004131", "Organic Fuji Apple", unknown],
    ["conventional text conflicting with an organic PLU", "0000000094131", "Conventional Fuji Apple", unknown],
    ["conventional text agreeing with a conventional PLU", "0000000004131", "Conventional Fuji Apple", known(false)],
    ["organic text without a PLU", "9100000000999", "Organic Fuji Apple", known(true)],
    ["silent text without a PLU", "9100000000999", "Fuji Apple", unknown],
    ["a 4-digit code outside 3000-4999", "0000000002999", "Fuji Apple", unknown],
    ["a 4-digit code above 4999", "0000000005000", "Fuji Apple", unknown],
    ["an 8-prefixed 5-digit code", "0000000084131", "Fuji Apple", unknown],
    ["a 9-prefixed code outside 3000-4999", "0000000092999", "Fuji Apple", unknown],
    ["a longer code", "0000000194131", "Fuji Apple", unknown],
    ["ambiguous organic text beside a PLU", "0000000004131", "Fuji Apple (excludes organic)", unknown],
  ])("%s", (_label, productId, description, organic) => {
    const offer = normalize(product({ productId, upc: productId, description }));
    expect(offer.identity).toMatchObject({ category: "produce", organic });
  });
});

describe("normalizeKroger: D4 fresh/frozen from temperature", () => {
  it.each([
    ["Refrigerated with silent text", "Boneless Skinless Chicken Thighs", "Refrigerated", known("fresh")],
    ["Frozen with silent text", "Boneless Skinless Chicken Thighs", "Frozen", known("frozen")],
    ["Frozen agreeing with frozen text", "Frozen Boneless Skinless Chicken Thighs", "Frozen", known("frozen")],
    ["Refrigerated agreeing with fresh text", "Fresh Boneless Skinless Chicken Thighs", "Refrigerated", known("fresh")],
    ["Frozen conflicting with fresh text", "Fresh Boneless Skinless Chicken Thighs", "Frozen", unknown],
    ["Refrigerated conflicting with previously frozen text", "Previously Frozen Boneless Skinless Chicken Thighs", "Refrigerated", unknown],
    ["Refrigerated beside ambiguous text", "Fresh or Frozen Boneless Skinless Chicken Thighs", "Refrigerated", unknown],
    ["Ambient", "Boneless Skinless Chicken Thighs", "Ambient", unknown],
    ["no temperature", "Boneless Skinless Chicken Thighs", null, unknown],
    ["fresh text without temperature", "Fresh Boneless Skinless Chicken Thighs", null, known("fresh")],
  ])("%s", (_label, description, indicator, freshFrozen) => {
    const offer = normalize(meat(description, indicator));
    expect(offer.identity).toMatchObject({ category: "meat", freshFrozen });
  });

  it("an unknown indicator value gives no signal", () => {
    expect(normalize(meat("Boneless Skinless Chicken Thighs", "frozen")).identity).toMatchObject({ freshFrozen: unknown });
  });

  it("temperature never sets produce fields and a PLU never sets meat fields", () => {
    const offer = normalize(meat("Boneless Pork Chops", "Refrigerated", { productId: "0000000004131" }));
    expect(offer.identity).toMatchObject({ category: "meat", freshFrozen: known("fresh") });
    expect(normalize(product({ temperature: { indicator: "Refrigerated" } })).identity).toMatchObject({ category: "produce", organic: unknown });
  });
});

describe("normalizeKroger: D3 unit rules", () => {
  it.each([
    ["WEIGHT 1 lb", "WEIGHT", "1 lb", 3.99, { basis: "lb", cents: { n: "399", d: "1" } }, null, null, null],
    ["WEIGHT per lb", "WEIGHT", "per lb", 3.99, { basis: "lb", cents: { n: "399", d: "1" } }, null, null, null],
    ["WEIGHT 1 LB (case)", "WEIGHT", "1 LB", 3.99, { basis: "lb", cents: { n: "399", d: "1" } }, null, null, null],
    ["UNIT 3 lb", "UNIT", "3 lb", 5.99, { basis: "lb", cents: { n: "599", d: "3" } }, { n: "3", d: "1" }, null, 599],
    ["UNIT 2.5 lbs", "UNIT", "2.5 lbs", 10, { basis: "lb", cents: { n: "400", d: "1" } }, { n: "5", d: "2" }, null, 1000],
    ["UNIT 12 oz", "UNIT", "12 oz", 3.99, { basis: "lb", cents: { n: "532", d: "1" } }, { n: "3", d: "4" }, null, 399],
    ["UNIT 1 lb", "UNIT", "1 lb", 2.5, { basis: "lb", cents: { n: "250", d: "1" } }, { n: "1", d: "1" }, null, 250],
    ["UNIT each", "UNIT", "each", 0.79, { basis: "each", cents: { n: "79", d: "1" } }, null, null, null],
    ["UNIT 1 ct", "UNIT", "1 ct", 1.25, { basis: "each", cents: { n: "125", d: "1" } }, null, 1, 125],
    ["UNIT 4 ct", "UNIT", "4 ct", 4.99, { basis: "each", cents: { n: "499", d: "4" } }, null, 4, 499],
  ])("%s", (_label, soldBy, size, regular, unitPrice, packageMassLb, packageCount, packageTotalCents) => {
    const offer = normalize(product({ description: "Lemons" }, { soldBy, size, price: { regular, promo: 0 } }));
    expect(offer.unitPrice).toEqual(unitPrice);
    expect(offer.packageMassLb).toEqual(packageMassLb);
    expect(offer.packageCount).toBe(packageCount);
    expect(offer.packageTotalCents).toBe(packageTotalCents);
    expect(offer.normalizationIssue).toBeNull();
    expect(offer.rawPrice).toMatchObject({ size, soldBy });
  });

  it.each([
    ["WEIGHT with a package size", "WEIGHT", "3 lb", /sold by WEIGHT with size "3 lb"/],
    ["WEIGHT each", "WEIGHT", "each", /sold by WEIGHT with size "each"/],
    ["WEIGHT 4 ct", "WEIGHT", "4 ct", /sold by WEIGHT with size "4 ct"/],
    ["UNIT per lb", "UNIT", "per lb", /unsupported size "per lb"/],
    ["UNIT pint", "UNIT", "1 pt", /unsupported size "1 pt"/],
    ["UNIT fluid ounces", "UNIT", "12 fl oz", /unsupported size "12 fl oz"/],
    ["UNIT bunch", "UNIT", "1 bunch", /unsupported size "1 bunch"/],
    ["UNIT size range", "UNIT", "2-3 lb", /unsupported size "2-3 lb"/],
    ["UNIT zero mass", "UNIT", "0 lb", /unsupported size "0 lb"/],
    ["UNIT leading-zero mass", "UNIT", "03 lb", /unsupported size "03 lb"/],
    ["UNIT zero count", "UNIT", "0 ct", /unsupported size "0 ct"/],
    ["UNIT kilograms", "UNIT", "1 kg", /unsupported size "1 kg"/],
    ["a lowercase soldBy", "weight", "1 lb", /soldBy "weight" is not WEIGHT or UNIT/],
    ["a missing soldBy", undefined, "1 lb", /soldBy is missing/],
    ["a missing size", "UNIT", undefined, /size is missing/],
    ["an empty size", "UNIT", "", /size is missing/],
  ])("%s gives a null unit price with a specific issue", (_label, soldBy, size, issue) => {
    const offer = normalize(product({ description: "Lemons" }, { soldBy, size }));
    expect(offer.unitPrice).toBeNull();
    expect(offer.packageMassLb).toBeNull();
    expect(offer.packageCount).toBeNull();
    expect(offer.packageTotalCents).toBeNull();
    expect(offer.normalizationIssue).toMatch(issue);
  });

  it.each([
    ["a description mass that differs from the size", "Honeycrisp Apples 5 lb Bag", "UNIT", "3 lb"],
    ["a description count that differs from the size", "Lemons 6 ct Bag", "UNIT", "4 ct"],
    ["a description mass beside an each size", "Lemons 2 lb Bag", "UNIT", "each"],
    ["a description mass beside a per-lb weight size", "Honeycrisp Apples 3 lb Bag", "WEIGHT", "per lb"],
    ["a description size range", "Honeycrisp Apples 2-3 lb", "UNIT", "3 lb"],
    ["a description fraction", "Honeycrisp Apples 1 1/2 lb", "UNIT", "3 lb"],
    ["a description pack count beside an each size", "Lemons 6 Pack", "UNIT", "each"],
    ["a description mass in pounds that differs", "Russet Potatoes 10 Pounds", "UNIT", "5 lb"],
  ])("%s gives a null unit price with an issue", (_label, description, soldBy, size) => {
    const offer = normalize(product({ description }, { soldBy, size }));
    expect(offer.unitPrice).toBeNull();
    expect(offer.packageMassLb).toBeNull();
    expect(offer.normalizationIssue).toMatch(/description states a size/);
  });

  it("a meat description count that differs from the size field gives a null unit price", () => {
    // Produce followed by "counts" is already excluded by A2's head-noun rule; meat has no such rule.
    const offer = normalize(meat("Chicken Drumsticks 6 Counts", "Refrigerated", {
      items: [{ itemId: "x", price: { regular: 4.99, promo: 0 }, size: "4 ct", soldBy: "UNIT" }],
    }));
    expect(offer.unitPrice).toBeNull();
    expect(offer.packageCount).toBeNull();
    expect(offer.normalizationIssue).toMatch(/description states a size "6 counts"/);
  });

  it("accepts a description size that agrees with the size field", () => {
    expect(normalize(product({ description: "Honeycrisp Apples 48 oz Bag" }, { soldBy: "UNIT", size: "3 lb" })).unitPrice)
      .toEqual({ basis: "lb", cents: { n: "133", d: "1" } });
    expect(normalize(product({ description: "Lemons 4-ct Bag" }, { soldBy: "UNIT", size: "4 ct" })).unitPrice)
      .toEqual({ basis: "each", cents: { n: "399", d: "4" } });
    expect(normalize(product({ description: "Lemons 4 Pack" }, { soldBy: "UNIT", size: "4 ct" })).unitPrice)
      .toEqual({ basis: "each", cents: { n: "399", d: "4" } });
    expect(normalize(product({ description: "Russet Potatoes 5 Pounds" }, { soldBy: "UNIT", size: "5 lb" })).unitPrice)
      .toEqual({ basis: "lb", cents: { n: "399", d: "5" } });
  });

  it.each([
    ["3 decimals", 2.999, /more than 2 decimals/],
    ["zero", 0, /not positive/],
    ["negative zero", -0, /not positive/],
    ["a negative value", -1.5, /not positive/],
    ["a string", "2.99", /not a JSON number/],
    ["NaN", Number.NaN, /not positive/],
    ["Infinity", Number.POSITIVE_INFINITY, /not positive/],
    ["an exponent-sized value", 1e21, /more than 2 decimals|not a plain amount/],
    ["a tiny value", 1e-7, /more than 2 decimals|not a plain amount/],
    ["null", null, /price\.regular is missing/],
  ])("a regular price of %s gives a null unit price plus an issue", (_label, regular, issue) => {
    const offer = normalize(product({}, { price: { regular, promo: 0 } }));
    expect(offer.unitPrice).toBeNull();
    expect(offer.packageTotalCents).toBeNull();
    expect(offer.normalizationIssue).toMatch(issue);
  });

  it("a non-object price or item gives a null unit price with an issue", () => {
    expect(normalize(product({}, { price: "3.99" })).normalizationIssue).toMatch(/price is not an object/);
    expect(normalize(product({ items: ["x"] })).normalizationIssue).toMatch(/items\[0\] is not an object/);
    expect(normalize(product({ items: [] })).normalizationIssue).toMatch(/0 items\[\] entries/);
    expect(normalize(product({ items: undefined })).normalizationIssue).toMatch(/items is missing/);
  });

  it("the promo price and estimates never become the unit price", () => {
    const offer = normalize(product({}, { price: { regular: 3.99, promo: 2.5, regularPerUnitEstimate: 1.1, promoPerUnitEstimate: 0.9 } }));
    expect(offer.unitPrice).toEqual({ basis: "lb", cents: { n: "399", d: "1" } });
    expect(offer.rawPrice).toMatchObject({ regular: "3.99", promo: "2.5", regularPerUnitEstimate: "1.1", promoPerUnitEstimate: "0.9" });
  });
});

describe("normalizeKroger: evidence and context", () => {
  it("uses an absolute https product page URL as sourceUrl, else the request URL", () => {
    const withPage = product({ productPageURI: "https://www.qfc.com/p/synthetic/9100000009999" });
    expect(normalize(withPage).evidence[0]?.sourceUrl).toBe("https://www.qfc.com/p/synthetic/9100000009999");
    for (const productPageURI of ["/p/synthetic/1", "http://www.qfc.com/p/1", "https://user:pw@www.qfc.com/p/1", "", 5]) {
      expect(normalize(product({ productPageURI })).evidence[0]?.sourceUrl).toBe(PRODUCTS_URL);
    }
  });

  it("throws when the evidence belongs to another product, provider or store", () => {
    const item = fixtureProduct("0000000004133");
    const other = contextFor(fixtureProduct("0000000094133"));
    expect(() => normalizeKroger(item, other)).toThrow(/sourceItemId/);
    expect(() => normalizeKroger(item, { ...contextFor(item), locationId: "70500808" })).toThrow(/locationId/);
    const flipp = contextFor(item);
    expect(() => normalizeKroger(item, { ...flipp, evidence: { ...flipp.evidence, provider: "flipp" } })).toThrow(/kroger-api/);
  });
});

describe("normalizeKrogerResponse", () => {
  const response = { requestUrl: PRODUCTS_URL, bytes: new Uint8Array(PRODUCTS_BYTES), json: productsJson() as unknown };

  it("maps a whole response to offers and exclusions, sharing one raw hash", () => {
    const result = normalizeKrogerResponse(response, CONTEXT_BASE);
    const hash = createHash("sha256").update(PRODUCTS_BYTES).digest("hex");
    expect(result.offers.map((offer) => offer.id)).toEqual([
      "kroger-api:kroger:0000000004133", "kroger-api:kroger:0000000094133", "kroger-api:kroger:9100000000301",
      "kroger-api:kroger:9100000000401", "kroger-api:kroger:9100000000501", "kroger-api:kroger:0000000004011",
      "kroger-api:kroger:9100000000701", "kroger-api:kroger:0000000004958",
    ]);
    expect(result.excluded).toEqual([{ index: 7, productId: "9100000000801", description: "Boneless Skinless Chicken Thighs", reason: expect.stringMatching(/Deli/) }]);
    expect(result.notes).toEqual([]);
    for (const offer of result.offers) {
      const [evidence] = offer.evidence;
      expect(evidence?.rawSha256).toBe(hash);
      expect(evidence?.id).toBe(`kroger-api:product:${evidence?.sourceItemId}:${hash.slice(0, 12)}`);
      expect(evidence?.retrievedUrl).toBe(PRODUCTS_URL);
    }
  });

  it("dedupes by productId within a response: the first wins, with a note", () => {
    const json = productsJson();
    const first = json.data[0]!;
    json.data.push({ ...first, description: "Honeycrisp Apple" });
    const result = normalizeKrogerResponse({ ...response, json }, CONTEXT_BASE);
    expect(result.offers.filter((offer) => offer.id === "kroger-api:kroger:0000000004133")).toHaveLength(1);
    expect(result.offers.find((offer) => offer.id === "kroger-api:kroger:0000000004133")?.label).toBe("Gala Apple");
    expect(result.notes).toEqual([expect.stringMatching(/product 0000000004133 at data\[9\] .*first occurrence.*data\[0\]/)]);
  });

  it("dedupes across responses through a shared seen map", () => {
    const seen = new Map<string, string>();
    const first = normalizeKrogerResponse(response, CONTEXT_BASE, seen);
    const secondUrl = PRODUCTS_URL.replace("apples", "gala");
    const second = normalizeKrogerResponse({ ...response, requestUrl: secondUrl }, CONTEXT_BASE, seen);
    expect(first.offers).toHaveLength(8);
    expect(second.offers).toHaveLength(0);
    expect(second.excluded).toHaveLength(0);
    expect(second.notes).toHaveLength(9);
    expect(second.notes[0]).toMatch(/first occurrence/);
    expect(second.notes[0]).toContain(PRODUCTS_URL);
  });

  it("an invalid product entry is excluded with its index", () => {
    const json = { data: ["x", { productId: "12" }] };
    const result = normalizeKrogerResponse({ ...response, json }, CONTEXT_BASE);
    expect(result.offers).toEqual([]);
    expect(result.excluded).toEqual([
      { index: 0, productId: null, description: null, reason: expect.stringMatching(/not an object/) },
      { index: 1, productId: null, description: null, reason: expect.stringMatching(/productId/) },
    ]);
  });

  it.each([
    ["no data array", { meta: {} }],
    ["a data object", { data: {} }],
    ["a non-object body", [1, 2]],
  ])("a response with %s is a schema error", (_label, json) => {
    expect(() => normalizeKrogerResponse({ ...response, json }, CONTEXT_BASE)).toThrow(FlippSourceError);
    expect(() => normalizeKrogerResponse({ ...response, json }, CONTEXT_BASE)).toThrow(/schema/);
  });
});

// ---------------------------------------------------------------------------
// Proof compatibility
// ---------------------------------------------------------------------------

describe("proof compatibility (synthetic)", () => {
  it("normalized fixture offers pass evaluateProof's shape and catalog rules; only keyed, priced offers count", () => {
    const { offers } = normalizeKrogerResponse(
      { requestUrl: PRODUCTS_URL, bytes: new Uint8Array(PRODUCTS_BYTES), json: productsJson() }, CONTEXT_BASE);
    // SYNTHETIC validations written by the test, 1 h after observation.
    const validations: Validation[] = offers.map((offer) => ({
      offerId: offer.id, checkedAt: "2026-09-29T18:30:00.000Z", evidenceIds: offer.evidence.map((evidence) => evidence.id),
      verifiedFields: [...REQUIRED_VERIFIED_FIELDS], applicabilityEvidence: "synthetic: store page matches",
      calendarEvidence: `catalog price; no stated window; observed ${OBSERVED_AT}`,
    }));
    const snapshot: SourceSnapshot = {
      schemaVersion: 1, postalCode: "98105", collectedAt: OBSERVED_AT, offers,
      proof: { validatedAt: NOW.toISOString(), families: ["kroger", "albertsons"], channel: "retailer-pickup", validations, pairs: [] },
    };
    const evaluation = evaluateProof(snapshot, NOW);
    expect(evaluation.families.kroger).toMatchObject({
      count: 5, produce: 3, meat: 2,
      offerIds: [
        "kroger-api:kroger:0000000004133", "kroger-api:kroger:0000000094133", "kroger-api:kroger:9100000000401",
        "kroger-api:kroger:9100000000501", "kroger-api:kroger:0000000004958",
      ],
    });
    // The rest are excluded only for the documented data gaps, never for shape, evidence, channel or calendar.
    const reasons = Object.fromEntries(evaluation.excluded.map((entry) => [entry.offerId, entry.reasons.join("; ")]));
    expect(Object.keys(reasons).sort()).toEqual([
      "kroger-api:kroger:0000000004011", "kroger-api:kroger:9100000000301", "kroger-api:kroger:9100000000701",
    ]);
    expect(reasons["kroger-api:kroger:9100000000301"]).toBe("no comparisonKey (unknown or unsupported identity fields: organic)");
    expect(reasons["kroger-api:kroger:0000000004011"]).toMatch(/^no unit price; has a normalization issue: /);
    expect(reasons["kroger-api:kroger:9100000000701"]).toMatch(/^no unit price; has a normalization issue: /);
  });
});
