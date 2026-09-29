import { createHash } from "node:crypto";
import type { Channel, Conditions, Evidence, Identity, Known, Offer, Rational } from "../shared/contracts.js";
import { classifyText, deriveIdentity, normalizeText } from "../shared/identity.js";
import { compareRational, divideRational, makeRational, pounds, usdCents } from "../shared/money.js";
import { FlippSourceError, fetchFlippResponse, type FetchOptions, type FlippResponse } from "./flipp.js";

// Kroger Public API client and product normalizer for QFC catalog prices
// (catalog price amendment, section 5 K1; DEC-20260928-002). The response
// shapes follow Kroger's public documentation and are unverified until K3
// checks real responses.
//
// Secrets: the client id and secret are read from the given env object at
// call time and never stored. The access token lives only in the caller's
// memory; it is sent as a header, never put in a URL, and never appears in an
// error, attempt or audit record. There is no refresh: a mid-run 401 is a
// source error.
//
// Normalization is fail-closed (DEC-20260924-004): only documented structured
// patterns yield a known unit price or identity value; anything else is null
// or unknown with an explicit issue or exclusion reason.

const KROGER_API = "https://api.kroger.com";
export const KROGER_TOKEN_URL = `${KROGER_API}/v1/connect/oauth2/token`;
const TOKEN_BODY = "grant_type=client_credentials&scope=product.compact";
const TOKEN_TIMEOUT_MS = 15_000;
/** QFC University Village: division 705 + store 00807 (amendment section 1). */
export const QFC_LOCATION_ID = "70500807";
/** The exact prefix proof.ts requires of a kroger-api retrievedUrl (section 3, rule 2). */
const PRODUCTS_URL_PREFIX = `${KROGER_API}/v1/products?`;
const PRODUCTS_LIMIT = "20";
const LOCATION_ID = /^\d{8}$/;
/** A productId is exactly 13 digits; leading zeros are significant (section 3, rule 2). */
const PRODUCT_ID = /^\d{13}$/;
/** Visible ASCII without spaces, so a token is always one safe header token. */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;
/** D1: catalog prices are labeled and validated as retailer-pickup; equals proof.ts CATALOG_CHANNEL. */
const CATALOG_CHANNEL: Channel = "retailer-pickup";
const ZERO = makeRational(0);
const ONE = makeRational(1);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * A server value for an error or reason: short plain strings are quoted, and
 * anything else is described by its type only, so a long value (a token a
 * server echoed back) is never shown.
 */
function shown(value: unknown): string {
  if (typeof value === "string") return /^[A-Za-z0-9 .&'-]{0,32}$/.test(value) ? JSON.stringify(value) : "(a string not shown)";
  return `(${value === null ? "null" : typeof value})`;
}

/** Raw evidence value: strings verbatim, numbers and booleans stringified, absent as null. */
function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** Missing or unusable credentials: a usage error, raised before any request. It never holds a value. */
export class KrogerCredentialsError extends Error {
  override name = "KrogerCredentialsError";
}

/** The environment the credentials are read from (process.env in the CLI). */
export type KrogerEnv = Readonly<Record<string, string | undefined>>;

function credentials(env: KrogerEnv): { id: string; secret: string } {
  const id = env.KROGER_CLIENT_ID;
  const secret = env.KROGER_CLIENT_SECRET;
  if (!nonEmptyString(id) || !nonEmptyString(secret)) {
    const missing = [nonEmptyString(id) ? null : "KROGER_CLIENT_ID", nonEmptyString(secret) ? null : "KROGER_CLIENT_SECRET"]
      .filter((name) => name !== null);
    throw new KrogerCredentialsError(`${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set; ` +
      "set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in the environment (never in a file)");
  }
  // RFC 7617: HTTP Basic auth cannot carry a user id containing ':'.
  if (id.includes(":")) throw new KrogerCredentialsError("KROGER_CLIENT_ID contains ':', which HTTP Basic auth cannot carry; check the value");
  return { id, secret };
}

/** A token-request failure. It carries the status (or a failure kind) only, never a request or response value. */
function tokenError(detail: string, status: number | null = null): FlippSourceError {
  return new FlippSourceError(`Kroger token request failed: ${detail}`, KROGER_TOKEN_URL, status);
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * A transport failure described by its cause's code (ECONNRESET, UND_ERR_*)
 * or the error's name only. The fetcher's message is never used: it could
 * quote the request, including the Authorization header.
 */
function transportDetail(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) ? cause.code : undefined;
  if (typeof code === "string" && SAFE_NAME.test(code)) return `transport error (${code})`;
  const name = error instanceof Error ? error.name : "";
  return SAFE_NAME.test(name) ? `transport error (${name})` : "transport error";
}

// Strict decoding: invalid UTF-8 is an error.
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The access token from a 200 body. No failure quotes the body, which holds the token. */
function parseToken(bytes: Uint8Array, contentType: string): string {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw tokenError("response body is not valid UTF-8", 200);
  }
  if (mediaType(contentType) !== "application/json") throw tokenError("response content-type is not application/json", 200);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw tokenError(`malformed JSON (${error instanceof Error && SAFE_NAME.test(error.name) ? error.name : "parse error"})`, 200);
  }
  if (!isRecord(json) || typeof json.access_token !== "string" || !TOKEN_CHARS.test(json.access_token)) {
    throw tokenError("response has no usable access_token", 200);
  }
  if (typeof json.token_type !== "string" || json.token_type.toLowerCase() !== "bearer") {
    throw tokenError("response token_type is not bearer", 200);
  }
  return json.access_token;
}

/**
 * OAuth2 client-credentials token (scope product.compact). A single POST
 * through the injected fetcher with the allowlisted client's safety rules: a
 * fixed https URL, no redirects (any non-200 is an error), 15 s covering the
 * response and its body, strict JSON, and no retries. Credentials are read
 * from `env` at call time. The optional run-wide `signal` (A12) stops the
 * request, and the call then rejects with the signal's reason.
 */
export async function krogerToken(env: KrogerEnv, fetcher: typeof fetch, options: { signal?: AbortSignal } = {}): Promise<string> {
  const { id, secret } = credentials(env);
  const { signal } = options;
  signal?.throwIfAborted();
  const authorization = `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject first so the timeout, not the abort it causes, settles the race.
      reject(tokenError(`timed out after ${TOKEN_TIMEOUT_MS / 1000} s`));
      controller.abort();
    }, TOKEN_TIMEOUT_MS);
    onAbort = () => {
      reject(signal?.reason);
      controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const exchange = async (): Promise<string> => {
    let response: Response;
    try {
      response = await fetcher(KROGER_TOKEN_URL, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: { authorization, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: TOKEN_BODY,
      });
    } catch (error) {
      throw tokenError(transportDetail(error));
    }
    if (response.status !== 200) {
      // Neither the body nor a Location header is read: either could echo a credential.
      void response.body?.cancel().catch(() => undefined);
      throw tokenError(`HTTP ${response.status}`, response.status);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw tokenError("reading the response body failed", response.status);
    }
    return parseToken(bytes, response.headers.get("content-type") ?? "");
  };
  try {
    return await Promise.race([exchange(), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Location and products (GET through the allowlisted client)
// ---------------------------------------------------------------------------

/** Options passed through to fetchFlippResponse, for the collector's audit and run-wide abort. */
export type KrogerRequestOptions = Pick<FetchOptions, "now" | "signal" | "onAttempt">;

function bearer(token: string): Record<string, string> {
  if (typeof token !== "string" || !TOKEN_CHARS.test(token)) {
    throw new FlippSourceError("Kroger request rejected: the access token is empty or malformed");
  }
  return { Authorization: `Bearer ${token}` };
}

function checkedLocationId(locationId: string): string {
  if (typeof locationId !== "string" || !LOCATION_ID.test(locationId)) {
    throw new FlippSourceError("Kroger locationId must be 8 digits (division + store)");
  }
  return locationId;
}

export interface KrogerLocation {
  locationId: string;
  chain: "QFC";
  name: string;
  address: { addressLine1: string; city: string; state: string; zipCode: string };
}

function parseLocation(response: FlippResponse, locationId: string): KrogerLocation {
  const fail = (problem: string) => new FlippSourceError(`Kroger location ${locationId}: ${problem}`, response.requestUrl);
  const data = isRecord(response.json) ? response.json.data : undefined;
  if (!isRecord(data)) throw fail("schema: response has no data object");
  if (data.locationId !== locationId) throw fail(`the lookup returned locationId ${shown(data.locationId)}, not ${locationId}`);
  if (data.chain !== "QFC") throw fail(`the lookup returned chain ${shown(data.chain)}, not QFC`);
  const text = (value: unknown, field: string): string => {
    if (!nonEmptyString(value)) throw fail(`schema: data.${field} is not a non-empty string`);
    return value;
  };
  const name = text(data.name, "name");
  const address = data.address;
  if (!isRecord(address)) throw fail("schema: data.address is not an object");
  return {
    locationId,
    chain: "QFC",
    name,
    address: {
      addressLine1: text(address.addressLine1, "address.addressLine1"),
      city: text(address.city, "address.city"),
      state: text(address.state, "address.state"),
      zipCode: text(address.zipCode, "address.zipCode"),
    },
  };
}

/**
 * GET /v1/locations/<locationId> with the Bearer token. The store must be
 * exactly that locationId with chain QFC; anything else is a source error.
 * Returns the parsed store and the raw response for the audit.
 */
export async function krogerLocation(
  token: string,
  fetcher: typeof fetch,
  locationId: string = QFC_LOCATION_ID,
  options: KrogerRequestOptions = {},
): Promise<{ location: KrogerLocation; response: FlippResponse }> {
  const url = new URL(`${KROGER_API}/v1/locations/${checkedLocationId(locationId)}`);
  const response = await fetchFlippResponse(url, { ...options, fetcher, headers: bearer(token) });
  return { location: parseLocation(response, locationId), response };
}

/**
 * The exact products request URL: https://api.kroger.com/v1/products? with
 * filter.term, filter.locationId and filter.limit=20, encoded by
 * URLSearchParams so a term can never add or replace a parameter.
 */
export function krogerProductsUrl(query: string, locationId: string): URL {
  if (!nonEmptyString(query)) throw new FlippSourceError("Kroger product query must be a non-empty term");
  const params = new URLSearchParams({
    "filter.term": query,
    "filter.locationId": checkedLocationId(locationId),
    "filter.limit": PRODUCTS_LIMIT,
  });
  return new URL(`${PRODUCTS_URL_PREFIX}${params.toString()}`);
}

/** GET one products search with the Bearer token; the response keeps the exact bytes for evidence (A9). */
export async function krogerProducts(
  token: string,
  fetcher: typeof fetch,
  query: string,
  locationId: string,
  options: KrogerRequestOptions = {},
): Promise<FlippResponse> {
  const url = krogerProductsUrl(query, locationId);
  return fetchFlippResponse(url, { ...options, fetcher, headers: bearer(token) });
}

// ---------------------------------------------------------------------------
// Evidence (section 3, the R7/A7 analogue)
// ---------------------------------------------------------------------------

function sha256(body: Uint8Array | string): string {
  const hash = createHash("sha256");
  if (typeof body === "string") hash.update(body, "utf8");
  else hash.update(body);
  return hash.digest("hex");
}

/** The product page as an absolute https URL without credentials, or null (a relative URI is not used). */
function productPageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" ? value : null;
}

function evidenceFor(productId: string, product: Record<string, unknown>, rawSha256: string, retrievedUrl: string, observedAt: string): Evidence {
  return {
    id: `kroger-api:product:${productId}:${rawSha256.slice(0, 12)}`,
    provider: "kroger-api",
    sourceItemId: productId,
    retrievedUrl,
    sourceUrl: productPageUrl(product.productPageURI) ?? retrievedUrl,
    observedAt,
    rawSha256,
    rawValidity: {},
  };
}

/**
 * Evidence for one product of a products response. `rawBody` is the exact
 * response bytes (a string is hashed as UTF-8, for tests only), so every
 * product of one response shares its rawSha256. `retrievedUrl` is the exact
 * request URL; sourceUrl is the product page when the product names an
 * absolute https one, otherwise retrievedUrl.
 */
export function krogerEvidence(input: {
  rawBody: Uint8Array | string;
  product: Record<string, unknown>;
  retrievedUrl: string;
  observedAt: string;
}): Evidence {
  const productId = input.product.productId;
  if (typeof productId !== "string" || !PRODUCT_ID.test(productId)) throw new Error("kroger product has no 13-digit productId");
  return evidenceFor(productId, input.product, sha256(input.rawBody), input.retrievedUrl, input.observedAt);
}

// ---------------------------------------------------------------------------
// Category agreement and D4 structured identity
// ---------------------------------------------------------------------------

const PRODUCE_CATEGORY = "Produce";
const MEAT_CATEGORIES: readonly string[] = ["Meat", "Meat & Seafood"];

function temperatureOf(product: Record<string, unknown>): string | null {
  const temperature = product.temperature;
  return isRecord(temperature) && typeof temperature.indicator === "string" ? temperature.indicator : null;
}

/**
 * The API's categories must be present and agree with the text category:
 * produce needs "Produce" and no meat category; meat needs "Meat" or "Meat &
 * Seafood" and no "Produce". Produce the API keeps frozen is excluded (R2).
 * Returns the exclusion reason, or null when they agree.
 */
function categoryDisagreement(category: "produce" | "meat", product: Record<string, unknown>): string | null {
  const categories = product.categories;
  if (!Array.isArray(categories) || categories.length === 0 || !categories.every((entry) => typeof entry === "string")) {
    return "categories are missing or not a list of strings";
  }
  const list = categories as string[];
  const produce = list.includes(PRODUCE_CATEGORY);
  const meat = list.some((entry) => MEAT_CATEGORIES.includes(entry));
  const named = JSON.stringify(list);
  if (category === "produce") {
    if (!produce) return `categories ${named} do not include Produce, but the description is produce`;
    if (meat) return `categories ${named} also include a meat category`;
    if (temperatureOf(product) === "Frozen") return "frozen produce (temperature Frozen)";
    return null;
  }
  if (!meat) return `categories ${named} do not include Meat or Meat & Seafood, but the description is meat`;
  if (produce) return `categories ${named} also include Produce`;
  return null;
}

/** The PLU range 3000-4999 that D4 reads from a loose-produce productId. */
function inPluRange(digits: string | undefined): boolean {
  const plu = Number(digits);
  return plu >= 3000 && plu <= 4999;
}

/**
 * D4: organic status from a loose-produce PLU. The productId is the PLU padded
 * to 13 digits: a 4-digit PLU in 3000-4999 ("0000000004133") is conventional,
 * and a 5-digit PLU of 9 plus a 3000-4999 code ("0000000094133") is organic.
 * Anything else (a UPC, an 8-prefixed or out-of-range code) gives no signal.
 */
function pluOrganic(productId: string): boolean | null {
  const four = /^0{9}(\d{4})$/.exec(productId);
  if (four) return inPluRange(four[1]) ? false : null;
  const five = /^0{8}9(\d{4})$/.exec(productId);
  if (five) return inPluRange(five[1]) ? true : null;
  return null;
}

/** D4: fresh/frozen from Kroger's temperature indicator (Refrigerated is fresh, Frozen is frozen). */
function temperatureFreshFrozen(product: Record<string, unknown>): "fresh" | "frozen" | null {
  const indicator = temperatureOf(product);
  return indicator === "Refrigerated" ? "fresh" : indicator === "Frozen" ? "frozen" : null;
}

// Text that states organic or fresh/frozen status at all. When the text rules
// still resolve it to unknown (alternatives, negation), the text is explicit
// but ambiguous, and a structured signal must not settle it.
const ORGANIC_WORDS = /\b(?:organic\w*|conventional\w*)\b/;
const FRESH_FROZEN_WORDS = /\b(?:fresh|frozen)\b/;

/**
 * D4 merge: explicit text wins. A structured value applies only when the text
 * value is unknown and the text does not mention the field, or when it agrees
 * with a known text value; a conflict makes the field unknown.
 */
function merged<T>(fromText: Known<T>, structured: T | null, textMentions: boolean): Known<T> {
  if (structured === null) return fromText;
  if (fromText.state === "known") return fromText.value === structured ? fromText : { state: "unknown" };
  if (fromText.state === "unknown" && !textMentions) return { state: "known", value: structured };
  return fromText;
}

function withStructuredIdentity(identity: Identity, productId: string, product: Record<string, unknown>, description: string): Identity {
  const text = normalizeText(description);
  if (identity.category === "produce") {
    return { ...identity, organic: merged(identity.organic, pluOrganic(productId), ORGANIC_WORDS.test(text)) };
  }
  return { ...identity, freshFrozen: merged(identity.freshFrozen, temperatureFreshFrozen(product), FRESH_FROZEN_WORDS.test(text)) };
}

// ---------------------------------------------------------------------------
// D3 price and unit rules
// ---------------------------------------------------------------------------

const RAW_PRICE_FIELDS = ["regular", "promo", "regularPerUnitEstimate", "promoPerUnitEstimate"] as const;

/**
 * Exact cents from the structured regular price: a positive JSON number with
 * at most 2 decimals, read through its shortest round-trip text.
 */
function regularCents(value: unknown): { cents: number } | { issue: string } {
  if (value === undefined || value === null) return { issue: "price.regular is missing (no price at this location); price unknown (never zero)" };
  if (typeof value !== "number") return { issue: `price.regular is not a JSON number (${typeof value}); price unknown` };
  if (!Number.isFinite(value) || value <= 0) return { issue: `price.regular ${String(value)} is not positive or not finite; price unknown (never zero)` };
  const cents = usdCents(String(value));
  if (cents === null) return { issue: `price.regular ${String(value)} has more than 2 decimals or is not a plain amount; price unknown` };
  return { cents };
}

interface UnitBasis {
  basis: "lb" | "each";
  divisor: Rational;
  packageMassLb: Rational | null;
  packageCount: number | null;
  /** True when the size names a package (N lb, N oz, N ct): its total is the regular price. */
  isPackage: boolean;
}

/** WEIGHT sizes that mean the regular price is per lb. */
const PER_LB_SIZES: ReadonlySet<string> = new Set(["1 lb", "per lb", "lb"]);
const SIZE_MASS = /^((?:0|[1-9]\d*)(?:\.\d+)?) ?(lb|lbs|oz)$/;
const SIZE_COUNT = /^([1-9]\d*) ?ct$/;

/**
 * D3 unit basis, from documented soldBy/size patterns only:
 * - soldBy WEIGHT with size "1 lb", "per lb" or "lb": lb at the regular price;
 * - soldBy UNIT with size "N lb" or "N oz": lb at the regular price / mass;
 * - soldBy UNIT with size "each": each at the regular price;
 * - soldBy UNIT with size "N ct": each at the regular price / N.
 * Anything else, including "each" or "N ct" sold by WEIGHT (the price may be
 * per lb), has no basis.
 */
function unitBasis(soldBy: unknown, size: unknown): UnitBasis | { issue: string } {
  if (soldBy === undefined || soldBy === null) return { issue: "items[0].soldBy is missing; unit unknown" };
  if (soldBy !== "WEIGHT" && soldBy !== "UNIT") return { issue: `items[0].soldBy ${shown(soldBy)} is not WEIGHT or UNIT; unit unknown` };
  if (!nonEmptyString(size)) return { issue: "items[0].size is missing; unit unknown" };
  const text = size.trim().toLowerCase().replace(/\s+/g, " ");
  if (soldBy === "WEIGHT") {
    if (PER_LB_SIZES.has(text)) return { basis: "lb", divisor: ONE, packageMassLb: null, packageCount: null, isPackage: false };
    return { issue: `sold by WEIGHT with size ${JSON.stringify(size)} (only a per-lb size is supported); unit unknown` };
  }
  if (text === "each") return { basis: "each", divisor: ONE, packageMassLb: null, packageCount: null, isPackage: false };
  const count = SIZE_COUNT.exec(text);
  if (count) {
    const n = Number(count[1]);
    if (Number.isSafeInteger(n)) return { basis: "each", divisor: makeRational(n), packageMassLb: null, packageCount: n, isPackage: true };
  }
  const mass = SIZE_MASS.exec(text);
  if (mass) {
    const lb = pounds(mass[1] ?? "", mass[2] === "oz" ? "oz" : "lb");
    if (compareRational(lb, ZERO) > 0) return { basis: "lb", divisor: lb, packageMassLb: lb, packageCount: null, isPackage: true };
  }
  return { issue: `unsupported size ${JSON.stringify(size)} for soldBy UNIT (supported: N lb, N oz, N ct, each); unit unknown` };
}

// Sizes stated in the description: masses (lb, pound, oz, ounce) and counts
// (ct, count, pk, pack). Hyphenated forms ("3-lb", "4-ct") count too.
const MASS_UNIT = /^(?:lbs?|pounds?|oz|ounces?)$/;
const OUNCE_UNIT = /^(?:oz|ounces?)$/;
const SIZE_UNIT = String.raw`(lbs?|pounds?|oz|ounces?|cts?|counts?|pks?|packs?)\b`;
const DESCRIPTION_SIZE = new RegExp(String.raw`(\d[\d.,/⁄]*)[\s-]*${SIZE_UNIT}`, "g");
const DESCRIPTION_RANGE = new RegExp(String.raw`\d\s*(?:-|–|to)\s*\d[\d.,/⁄]*[\s-]*${SIZE_UNIT}`);
const CANONICAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CANONICAL_COUNT = /^[1-9]\d*$/;

/**
 * F2 analogue: the size field must be the only size the description states. A
 * stated mass or count that differs from it (or a range, fraction or
 * non-canonical amount) may be another package, so the unit is unknown.
 */
function descriptionSizeProblem(description: string, size: string, basis: UnitBasis): string | null {
  const text = normalizeText(description);
  const range = DESCRIPTION_RANGE.exec(text);
  if (range) return `description states a size range ${JSON.stringify(range[0])}; unit unknown`;
  for (const match of text.matchAll(DESCRIPTION_SIZE)) {
    const amount = match[1] ?? "";
    const unit = match[2] ?? "";
    const agrees = MASS_UNIT.test(unit)
      ? CANONICAL_AMOUNT.test(amount) && basis.packageMassLb !== null &&
        compareRational(pounds(amount, OUNCE_UNIT.test(unit) ? "oz" : "lb"), basis.packageMassLb) === 0
      : CANONICAL_COUNT.test(amount) && basis.packageCount !== null && Number(amount) === basis.packageCount;
    if (!agrees) return `description states a size ${JSON.stringify(match[0])} that differs from the size field ${JSON.stringify(size)}; unit unknown`;
  }
  return null;
}

interface PriceTerms {
  rawPrice: Record<string, string | null>;
  unitPrice: Offer["unitPrice"];
  packageMassLb: Rational | null;
  packageCount: number | null;
  packageTotalCents: number | null;
  issues: string[];
}

/**
 * D3: exactly one items[] entry with a positive regular price of at most 2
 * decimals; the unit basis from unitBasis. regular, promo, size, soldBy and
 * the per-unit estimates stay verbatim in rawPrice; the promo price and the
 * estimates never become the unit price.
 */
function normalizePrice(items: unknown, description: string): PriceTerms {
  const rawPrice: Record<string, string | null> = {
    itemCount: null, regular: null, promo: null, regularPerUnitEstimate: null, promoPerUnitEstimate: null, size: null, soldBy: null,
  };
  const none = (issues: string[]): PriceTerms =>
    ({ rawPrice, unitPrice: null, packageMassLb: null, packageCount: null, packageTotalCents: null, issues });
  if (!Array.isArray(items)) return none(["items is missing or not a list; price unknown"]);
  rawPrice.itemCount = String(items.length);
  if (items.length !== 1) return none([`${items.length} items[] entries (exactly one is required); price unknown`]);
  const [item] = items;
  if (!isRecord(item)) return none(["items[0] is not an object; price unknown"]);
  rawPrice.size = raw(item.size);
  rawPrice.soldBy = raw(item.soldBy);

  const issues: string[] = [];
  let cents: number | null = null;
  const price = item.price;
  if (price === undefined || price === null) issues.push("price.regular is missing (no price at this location); price unknown (never zero)");
  else if (!isRecord(price)) issues.push("price is not an object; price unknown");
  else {
    for (const field of RAW_PRICE_FIELDS) rawPrice[field] = raw(price[field]);
    const regular = regularCents(price.regular);
    if ("issue" in regular) issues.push(regular.issue);
    else cents = regular.cents;
  }

  const basis = unitBasis(item.soldBy, item.size);
  if ("issue" in basis) return none([...issues, basis.issue]);
  const sizeProblem = descriptionSizeProblem(description, String(item.size), basis);
  if (sizeProblem !== null) return none([...issues, sizeProblem]);
  return {
    rawPrice,
    unitPrice: cents === null ? null : { basis: basis.basis, cents: divideRational(makeRational(cents), basis.divisor) },
    packageMassLb: basis.packageMassLb,
    packageCount: basis.packageCount,
    packageTotalCents: basis.isPackage ? cents : null,
    issues,
  };
}

/** D3 (section 3): the regular price is by definition unconditional; the human confirms it. */
function regularPriceConditions(): Conditions {
  return { complete: true, loyaltyRequired: false, couponRequired: false, couponIds: [], minimumUnits: null, maximumUnits: null, text: [] };
}

// ---------------------------------------------------------------------------
// normalizeKroger
// ---------------------------------------------------------------------------

export interface KrogerContext {
  family: "kroger";
  /** "QFC" for location 70500807. */
  retailer: string;
  postalCode: "98105";
  observedAt: string;
  /** Evidence for this product (krogerEvidence); it must name this product and store. */
  evidence: Evidence;
  /** Verified only from a valid StoreAttestation plus this run's matching store lookup (section 3). */
  applicability: "verified" | "unknown";
  /** The run's store scope; the evidence URL's filter.locationId must equal it. */
  locationId: string;
}

export type KrogerResult = Offer | { excluded: string };

function productIdOf(product: Record<string, unknown>): { productId: string } | { excluded: string } {
  const productId = product.productId;
  if (typeof productId !== "string" || !PRODUCT_ID.test(productId)) return { excluded: `productId ${shown(productId)} is not a 13-digit string` };
  return { productId };
}

/** The single filter.locationId of a products request URL, or null. */
function locationIdIn(url: string): string | null {
  if (!url.startsWith(PRODUCTS_URL_PREFIX)) return null;
  try {
    const ids = new URL(url).searchParams.getAll("filter.locationId");
    return ids.length === 1 ? ids[0] ?? null : null;
  } catch {
    return null;
  }
}

/** Caller errors: evidence for another provider, product or store. */
function checkContext(productId: string, context: KrogerContext): void {
  const { evidence } = context;
  if (evidence.provider !== "kroger-api") throw new Error(`evidence provider ${evidence.provider} is not kroger-api`);
  if (evidence.sourceItemId !== productId) throw new Error(`evidence sourceItemId ${evidence.sourceItemId} does not match product ${productId}`);
  if (!LOCATION_ID.test(context.locationId)) throw new Error("context locationId must be 8 digits");
  const scope = locationIdIn(evidence.retrievedUrl);
  if (scope !== context.locationId) {
    throw new Error(`evidence retrievedUrl filter.locationId ${scope ?? "(none)"} is not the context locationId ${context.locationId}`);
  }
}

/**
 * Normalizes one product of a products response into exactly one catalog
 * Offer, or an exclusion with a reason. The category comes from the
 * description and must agree with the API's categories; identity is
 * deriveIdentity plus the D4 overrides; the price follows D3. Throws only for
 * a caller error (evidence for another provider, product or store).
 */
export function normalizeKroger(product: unknown, context: KrogerContext): KrogerResult {
  if (!isRecord(product)) return { excluded: "product is not an object" };
  const id = productIdOf(product);
  if ("excluded" in id) return id;
  const { productId } = id;
  checkContext(productId, context);
  const description = product.description;
  if (!nonEmptyString(description)) return { excluded: "description is missing or not a string" };
  const classification = classifyText(description);
  if (classification.category === "excluded") return { excluded: classification.reason };
  const disagreement = categoryDisagreement(classification.category, product);
  if (disagreement !== null) return { excluded: disagreement };
  const identity = withStructuredIdentity(deriveIdentity(classification.category, description), productId, product, description);
  const price = normalizePrice(product.items, description);

  return {
    id: `kroger-api:${context.family}:${productId}`,
    family: context.family,
    retailer: context.retailer,
    label: description,
    postalCode: context.postalCode,
    storeName: null,
    storeAddress: null,
    applicability: context.applicability,
    channel: CATALOG_CHANNEL,
    identity,
    rawPrice: price.rawPrice,
    unitPrice: price.unitPrice,
    normalizationIssue: price.issues.length > 0 ? price.issues.join("; ") : null,
    packageMassLb: price.packageMassLb,
    packageCount: price.packageCount,
    packageTotalCents: price.packageTotalCents,
    conditions: regularPriceConditions(),
    evidence: [{ ...context.evidence, rawValidity: { ...context.evidence.rawValidity } }],
    observedAt: context.observedAt,
    startsAt: null,
    expiresAt: null,
    calendarRule: "catalog-observation",
  };
}

export interface KrogerExclusion {
  /** Position in the response's data[]. */
  index: number;
  productId: string | null;
  description: string | null;
  reason: string;
}

/**
 * Maps a whole products response to offers and exclusions. Every product's
 * evidence hashes the exact response bytes and names the request URL. Dedupes
 * by productId, first occurrence wins, with a note; pass one `seen` map across
 * a run's responses to dedupe across queries. A response without a data
 * array is a schema error.
 */
export function normalizeKrogerResponse(
  response: Pick<FlippResponse, "requestUrl" | "bytes" | "json">,
  context: Omit<KrogerContext, "evidence">,
  seen: Map<string, string> = new Map(),
): { offers: Offer[]; excluded: KrogerExclusion[]; notes: string[] } {
  const json = response.json;
  if (!isRecord(json) || !Array.isArray(json.data)) {
    throw new FlippSourceError("schema: Kroger products response has no data array", response.requestUrl);
  }
  const rawSha256 = sha256(response.bytes);
  const offers: Offer[] = [];
  const excluded: KrogerExclusion[] = [];
  const notes: string[] = [];
  json.data.forEach((product: unknown, index) => {
    if (!isRecord(product)) {
      excluded.push({ index, productId: null, description: null, reason: "product is not an object" });
      return;
    }
    const description = typeof product.description === "string" ? product.description : null;
    const id = productIdOf(product);
    if ("excluded" in id) {
      excluded.push({ index, productId: null, description, reason: id.excluded });
      return;
    }
    const { productId } = id;
    const where = `${response.requestUrl} data[${index}]`;
    const first = seen.get(productId);
    if (first !== undefined) {
      notes.push(`product ${productId} at data[${index}] of ${response.requestUrl} repeats the first occurrence at ${first}; the first occurrence wins`);
      return;
    }
    seen.set(productId, where);
    const evidence = evidenceFor(productId, product, rawSha256, response.requestUrl, context.observedAt);
    const result = normalizeKroger(product, { ...context, evidence });
    if ("excluded" in result) excluded.push({ index, productId, description, reason: result.excluded });
    else offers.push(result);
  });
  return { offers, excluded, notes };
}
