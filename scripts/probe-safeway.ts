import { randomInt } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// S0 - Safeway feasibility probe (plan: "Catalog price amendment", section 5).
// Run on the user's PC from the repository root:  npx tsx scripts/probe-safeway.ts
//
// One question: from a residential connection, does Safeway's store-scoped
// product search return JSON prices for store 2980 in both modes?
// Standalone on purpose: plain Node fetch, only https://www.safeway.com, no
// retries, at most 6 search requests. The subscription key is read from the
// public weekly-ad page at run time, kept in memory, sent only as a header and
// never printed or saved (a self-check enforces this before any output).
// Exit codes: 0 FEASIBLE, 1 NOT FEASIBLE, 2 error or self-check failure.

export const ORIGIN = "https://www.safeway.com";
export const STORE_ID = "2980";
export const QUERIES = ["gala apples", "bananas", "80% lean ground beef"] as const;
/** In-store, then the D1 mode (retailer-pickup). The "pickup" channel value is unverified; S0 records what it does. */
export const MODES = [
  { name: "instore", channel: "instore" },
  { name: "pickup", channel: "pickup" },
] as const;
export const D1_MODE = "pickup";
export const MAX_SEARCH_REQUESTS = 6;
export const REQUEST_TIMEOUT_MS = 15_000;
export const REQUEST_GAP_MS = 1_000;
const ROWS = 30;
/** Feasible: at least this many of the 3 queries return HTTP 200 JSON with store-scoped prices in the D1 mode. */
const FEASIBLE_MIN = 2;
const KEY_HEADER = "ocp-apim-subscription-key";
const PRINT_LIMIT = 120;

export const CONFIG_NAMES = {
  searchPath: "apimProgramSearchPath",
  productsEndpoint: "apimProgramSearchProductsEndpoint",
  key: "apimProgramSubscriptionKey",
} as const;

export type ProbeConfig = Record<keyof typeof CONFIG_NAMES, string | null>;

/**
 * Reads the three values from `"name":"value"` pairs by their exact names, with
 * no eval. A value holds no quote, backslash or whitespace. A name that is
 * absent, or that appears with two different values, gives null.
 */
export function extractConfig(html: string): ProbeConfig {
  const read = (name: string): string | null => {
    const pattern = new RegExp(`"${name}"\\s*:\\s*"([^"\\\\\\s]+)"`, "g");
    const values = new Set(Array.from(html.matchAll(pattern), (match) => match[1] ?? ""));
    const [only] = values;
    return values.size === 1 && only !== undefined && only !== "" ? only : null;
  };
  return {
    searchPath: read(CONFIG_NAMES.searchPath),
    productsEndpoint: read(CONFIG_NAMES.productsEndpoint),
    key: read(CONFIG_NAMES.key),
  };
}

export type Product = Record<string, unknown>;

export interface SearchReply {
  /** HTTP status, or null when no response arrived (transport error, timeout). */
  status: number | null;
  contentType: string;
  body: Uint8Array;
}

export interface SearchAnalysis {
  json: boolean;
  products: Product[];
  count: number;
  numFound: number | null;
  /** Products with at least one positive numeric price field. */
  priced: number;
  /** Distinct values of any storeId-like field in the response. */
  storeIds: string[];
  /** Meets the per-query criterion: HTTP 200 JSON with store-scoped prices. */
  counts: boolean;
  reason: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

function positiveNumber(value: unknown): boolean {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0;
}

const hasPrice = (product: Product): boolean =>
  Object.entries(product).some(([name, value]) => /price/i.test(name) && positiveNumber(value));

/** Calls `visit` on every object in the JSON value, breadth-first, up to a fixed node budget. */
function walk(root: unknown, visit: (value: unknown) => boolean | void): void {
  const queue: unknown[] = [root];
  for (let seen = 0; queue.length > 0 && seen < 100_000; seen += 1) {
    const value = queue.shift();
    if (visit(value) === true) return;
    if (Array.isArray(value)) queue.push(...value);
    else if (isRecord(value)) queue.push(...Object.values(value));
  }
}

/** `response.docs` when present (the known shape); otherwise the first array of objects that carries a price. */
function findProducts(json: unknown): Product[] {
  const docs = isRecord(json) && isRecord(json.response) ? json.response.docs : undefined;
  if (Array.isArray(docs)) return docs.filter(isRecord);
  let found: Product[] = [];
  walk(json, (value) => {
    if (Array.isArray(value) && value.length > 0 && value.every(isRecord) && value.some(hasPrice)) {
      found = value;
      return true;
    }
  });
  return found;
}

function findStoreIds(json: unknown): string[] {
  const ids = new Set<string>();
  walk(json, (value) => {
    if (!isRecord(value)) return;
    for (const [name, field] of Object.entries(value)) {
      if (/^store_?id$/i.test(name) && (typeof field === "string" || typeof field === "number")) ids.add(String(field));
    }
  });
  return [...ids].sort();
}

export function analyzeSearch(reply: SearchReply): SearchAnalysis {
  const empty = { json: false, products: [], count: 0, numFound: null, priced: 0, storeIds: [] };
  if (reply.status === null) return { ...empty, counts: false, reason: "no response" };
  let parsed: unknown;
  let json = false;
  if (/json/i.test(reply.contentType)) {
    try {
      parsed = JSON.parse(decode(reply.body));
      json = true;
    } catch {
      // Reported below as "not valid JSON".
    }
  }
  const products = json ? findProducts(parsed) : [];
  const response = isRecord(parsed) && isRecord(parsed.response) ? parsed.response : parsed;
  const numFound = isRecord(response) && typeof response.numFound === "number" ? response.numFound : null;
  const storeIds = json ? findStoreIds(parsed) : [];
  const analysis = { json, products, count: products.length, numFound, priced: products.filter(hasPrice).length, storeIds };
  const otherStores = storeIds.filter((id) => id !== STORE_ID);
  const reason =
    reply.status !== 200 ? `HTTP ${reply.status}`
    : !/json/i.test(reply.contentType) ? `content type ${reply.contentType || "(none)"} is not JSON`
    : !json ? "body is not valid JSON"
    : products.length === 0 ? "no products"
    : analysis.priced === 0 ? "no product with a price"
    : otherStores.length > 0 ? `response names other store(s) ${otherStores.join(", ")}`
    : "counts";
  return { ...analysis, counts: reason === "counts", reason };
}

export function feasibility(results: ReadonlyArray<{ mode: string; counts: boolean }>): { met: number; needed: number; feasible: boolean } {
  const met = results.filter((result) => result.mode === D1_MODE && result.counts).length;
  return { met, needed: FEASIBLE_MIN, feasible: met >= FEASIBLE_MIN };
}

const ID_FIELDS = ["id", "pid", "productId", "upc", "bpn", "itemId"];

function productId(product: Product): string | null {
  for (const name of ID_FIELDS) {
    const value = product[name];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}

function shorten(text: string): string {
  return text.length > PRINT_LIMIT ? `${text.slice(0, PRINT_LIMIT)}...` : text;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return shorten(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return shorten(JSON.stringify(value) ?? String(value));
}

/** Every price-named field, sorted by name, as `name=value` pairs. */
function priceSignature(product: Product): string {
  return Object.keys(product)
    .filter((name) => /price/i.test(name))
    .sort()
    .map((name) => `${name}=${formatValue(product[name])}`)
    .join(" ");
}

export interface PriceDifference {
  id: string;
  instore: string;
  pickup: string;
}

/** Matches products by ID across the two modes and lists the shared ones whose price fields differ. */
export function comparePrices(instore: Product[], pickup: Product[]): { shared: number; differing: PriceDifference[] } {
  const pickupById = new Map<string, Product>();
  for (const product of pickup) {
    const id = productId(product);
    if (id !== null && !pickupById.has(id)) pickupById.set(id, product);
  }
  const seen = new Set<string>();
  const differing: PriceDifference[] = [];
  for (const product of instore) {
    const id = productId(product);
    const other = id === null ? undefined : pickupById.get(id);
    if (id === null || other === undefined || seen.has(id)) continue;
    seen.add(id);
    const [a, b] = [priceSignature(product), priceSignature(other)];
    if (a !== b) differing.push({ id, instore: a, pickup: b });
  }
  return { shared: seen.size, differing };
}

export function redact(text: string, key: string | null): string {
  return key === null || key === "" ? text : text.split(key).join("[redacted]");
}

/** Names each output that contains the key: "printed output" and/or file names. */
export function findKeyLeaks(key: string, output: string, files: ReadonlyArray<{ name: string; bytes: Uint8Array }>): string[] {
  const leaks = output.includes(key) ? ["printed output"] : [];
  for (const file of files) if (Buffer.from(file.bytes).includes(key)) leaks.push(file.name);
  return leaks;
}

/** Escapes control and bidi characters so a printed line cannot drive the terminal. */
function safe(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The error's message plus its cause's code and message (Node fetch puts the network detail on `cause`). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (cause === undefined || cause === null) return error.message;
  const code: unknown = typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  const detail = [code === undefined || code === null ? "" : String(code), cause instanceof Error ? cause.message : String(cause)]
    .filter((part) => part !== "")
    .join(": ");
  return detail === "" ? error.message : `${error.message} (cause: ${detail})`;
}

interface Reply extends SearchReply {
  ms: number;
  location: string | null;
  /** Transport or timeout error, already redacted. */
  error: string | null;
}

/** One GET to www.safeway.com: no redirects followed, no retry, 15 s covering headers and body. */
async function request(fetcher: typeof fetch, url: URL, headers: Record<string, string>, key: string | null): Promise<Reply> {
  if (url.origin !== ORIGIN) throw new Error(`refusing to request ${url.host}; only ${ORIGIN} is allowed`);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000} s`));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  });
  const exchange = (async () => {
    const response = await fetcher(url.href, { method: "GET", headers, redirect: "manual", signal: controller.signal });
    const body = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, contentType: response.headers.get("content-type") ?? "", location: response.headers.get("location"), body };
  })();
  try {
    const reply = await Promise.race([exchange, timeout]);
    return { ...reply, ms: elapsed(), error: null };
  } catch (error) {
    return { status: null, contentType: "", location: null, body: new Uint8Array(), ms: elapsed(), error: redact(describeError(error), key) };
  } finally {
    clearTimeout(timer);
  }
}

function describeReply(reply: Reply, key: string | null): string {
  if (reply.status === null) return `no response after ${reply.ms} ms: ${reply.error ?? "unknown error"}`;
  const location = reply.location === null ? "" : `, location ${shorten(redact(reply.location, key))}`;
  return `HTTP ${reply.status}, ${reply.ms} ms, ${reply.contentType || "(no content type)"}, ${reply.body.byteLength} bytes${location}`;
}

/** The search URL: the config's path and endpoint on www.safeway.com, with the key never in it. */
function searchUrl(base: URL, query: string, channel: string): URL {
  const params: Record<string, string> = {
    "request-id": `${Date.now()}${randomInt(100, 1000)}`,
    rows: String(ROWS),
    start: "0",
    "search-type": "keyword",
    storeid: STORE_ID,
    q: query,
    channel,
    banner: "safeway",
  };
  const url = new URL(base.href);
  url.search = Object.entries(params).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
  return url;
}

const SAMPLE_FIELD = /^(id|pid|upc|bpn|productId|itemId|name|productTitle)$|price|unit|uom|size|weight|qty|quantity|sellBy|measure/i;

function sampleFields(product: Product): string {
  const fields = Object.entries(product).filter(([name]) => SAMPLE_FIELD.test(name));
  return fields.length === 0 ? "(no ID, name, price, unit or size fields)" : fields.map(([name, value]) => `${name}=${formatValue(value)}`).join("; ");
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface SearchResult {
  index: number;
  query: string;
  mode: string;
  reply: Reply;
  analysis: SearchAnalysis;
}

export interface ProbeDeps {
  fetcher: typeof fetch;
  /** Search bodies go to <auditRoot>/safeway-probe-<timestamp>/. */
  auditRoot: string;
  /** Receives the whole summary text once. */
  print: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type ExitCode = 0 | 1 | 2;

export async function runProbe(deps: ProbeDeps): Promise<ExitCode> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const startedAt = (deps.now ?? (() => new Date()))();
  let key: string | null = null;
  try {
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);
    say(`Safeway feasibility probe (S0), ${startedAt.toISOString()}`);
    say(`origin ${ORIGIN}; store ${STORE_ID}; modes ${MODES.map((mode) => `${mode.name} (channel=${mode.channel})`).join(", ")}; D1 mode ${D1_MODE}`);

    // 1. The weekly-ad page carries the search config. Its HTML is never saved or printed.
    const ad = await request(deps.fetcher, new URL("/weeklyad", ORIGIN), { accept: "text/html" }, null);
    say(`weekly-ad: GET /weeklyad -> ${describeReply(ad, null)}`);
    const config: ProbeConfig = ad.status === 200 ? extractConfig(decode(ad.body)) : { searchPath: null, productsEndpoint: null, key: null };
    key = config.key;
    say(`config: ${CONFIG_NAMES.searchPath}=${config.searchPath ?? "(missing)"}; ${CONFIG_NAMES.productsEndpoint}=${config.productsEndpoint ?? "(missing)"}`);
    say(`keyFound: ${key !== null}`);
    say(`keyLength: ${key?.length ?? 0}`);

    let stop: string | null = null;
    let base: URL | null = null;
    const missing = (Object.keys(CONFIG_NAMES) as (keyof typeof CONFIG_NAMES)[]).filter((name) => config[name] === null).map((name) => CONFIG_NAMES[name]);
    if (ad.status !== 200) stop = "the weekly-ad page did not return HTTP 200";
    else if (missing.length > 0) stop = `config missing or ambiguous: ${missing.join(", ")}`;
    else {
      try {
        base = new URL(`${config.searchPath}${config.productsEndpoint}`, ORIGIN);
      } catch {
        stop = "the config does not form a valid search URL";
      }
      if (base !== null && base.origin !== ORIGIN) {
        stop = `the config names search host ${base.host}, which is not www.safeway.com; not requested`;
        base = null;
      }
    }

    // 2. Each query in both modes, sequentially, at most MAX_SEARCH_REQUESTS, never retried.
    const results: SearchResult[] = [];
    if (base !== null && key !== null) {
      const plan = QUERIES.flatMap((query) => MODES.map((mode) => ({ query, mode }))).slice(0, MAX_SEARCH_REQUESTS);
      say(`search: GET ${base.pathname}; ${plan.length} requests (cap ${MAX_SEARCH_REQUESTS}), sequential, ${REQUEST_TIMEOUT_MS / 1000} s timeout, ${REQUEST_GAP_MS / 1000} s gap, no retries`);
      for (const [position, { query, mode }] of plan.entries()) {
        await sleep(REQUEST_GAP_MS);
        const headers = { accept: "application/json", [KEY_HEADER]: key };
        const reply = await request(deps.fetcher, searchUrl(base, query, mode.channel), headers, key);
        const analysis = analyzeSearch(reply);
        results.push({ index: position + 1, query, mode: mode.name, reply, analysis });
        const found = !analysis.json ? "" : `; products ${analysis.count}${analysis.numFound === null ? "" : ` (numFound ${analysis.numFound})`}, priced ${analysis.priced}, ${analysis.storeIds.length === 0 ? "store not echoed" : `store ids ${analysis.storeIds.join(", ")}`}`;
        say(`[${position + 1}] ${mode.name} "${query}": ${describeReply(reply, key)}${found} -> ${analysis.counts ? "counts" : `not counted: ${analysis.reason}`}`);
      }
    } else {
      say(`search: not sent (${stop ?? "no search config"})`);
    }

    // 3. One product's shape, and whether the two modes price shared products differently.
    if (results.length > 0) {
      const withProducts = (mode: string) => results.find((result) => result.mode === mode && result.analysis.products.length > 0);
      const source = withProducts(D1_MODE) ?? results.find((result) => result.analysis.products.length > 0);
      const product = source?.analysis.products[0];
      if (source !== undefined && product !== undefined) {
        say(`product fields (${source.mode} "${source.query}", first product): ${Object.keys(product).join(", ")}`);
        say(`product sample: ${sampleFields(product)}`);
      } else {
        say("product fields: no products returned");
      }
      let shared = 0;
      const differing: (PriceDifference & { query: string })[] = [];
      for (const query of QUERIES) {
        const [instore, pickup] = MODES.map((mode) => results.find((result) => result.query === query && result.mode === mode.name)?.analysis.products ?? []);
        if (instore === undefined || pickup === undefined || instore.length === 0 || pickup.length === 0) {
          say(`mode prices "${query}": not compared (a mode returned no products)`);
          continue;
        }
        const comparison = comparePrices(instore, pickup);
        shared += comparison.shared;
        differing.push(...comparison.differing.map((difference) => ({ query, ...difference })));
        say(`mode prices "${query}": ${comparison.shared} shared products, ${comparison.differing.length} priced differently`);
      }
      say(`modePricesDiffer: ${shared === 0 ? "unknown (no shared products)" : `${differing.length > 0 ? "yes" : "no"} (${differing.length} of ${shared} shared products)`}`);
      for (const difference of differing.slice(0, 3)) {
        say(`  "${difference.query}" id ${difference.id}: instore ${difference.instore} | pickup ${difference.pickup}`);
      }
    }

    // 4. Only the search bodies are saved.
    const dir = join(deps.auditRoot, `safeway-probe-${startedAt.toISOString().replace(/[:.]/g, "-")}`);
    const files = results
      .filter((result) => result.reply.status !== null)
      .map((result) => ({
        name: `${result.index}-${result.mode}-${slug(result.query)}.${/json/i.test(result.reply.contentType) ? "json" : "txt"}`,
        bytes: result.reply.body,
      }));
    say(files.length > 0 ? `saved: ${files.length} search bodies to ${relative(process.cwd(), dir) || dir}` : "saved: nothing (no search responses)");

    const verdict = feasibility(results.map((result) => ({ mode: result.mode, counts: result.analysis.counts })));
    if (stop !== null) say(`stopped: ${stop}`);
    say(`criterion: ${verdict.met}/${QUERIES.length} ${D1_MODE} queries returned HTTP 200 JSON with store-scoped prices (need ${verdict.needed})`);
    say(verdict.feasible ? "FEASIBLE" : "NOT FEASIBLE");

    // 5. Self-check before anything is printed or saved.
    const text = lines.map(safe).join("\n");
    if (key !== null) {
      const leaks = findKeyLeaks(key, text, files);
      if (leaks.length > 0) {
        deps.print(safe(`SELF-CHECK FAILED: the key appears in ${leaks.join(", ")}. Nothing was saved and no summary was printed.`));
        return 2;
      }
    }
    if (files.length > 0) {
      try {
        await mkdir(dir, { recursive: true });
        for (const file of files) await writeFile(join(dir, file.name), file.bytes, { flag: "wx" });
      } catch (error) {
        deps.print(text);
        deps.print(safe(`ERROR: could not save the search bodies: ${redact(describeError(error), key)}`));
        return 2;
      }
    }
    deps.print(text);
    return verdict.feasible ? 0 : 1;
  } catch (error) {
    deps.print(safe(`ERROR: ${redact(describeError(error), key)}`));
    return 2;
  }
}

/** True only when this file is the process entry point (not when a test imports it). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const canonical = (file: string): string => {
    const real = realpathSync(file);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  try {
    return canonical(resolve(entry)) === canonical(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const auditRoot = fileURLToPath(new URL("../data/audit/", import.meta.url));
  process.exitCode = await runProbe({ fetcher: fetch, auditRoot, print: (text) => console.log(text) });
}
