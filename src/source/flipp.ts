// Flipp HTTP client and response parsers (plan Task 1 network bullets,
// addendum R11). Only https://backflipp.wishabi.com on the default port is
// reachable; every redirect is checked against the same policy. Responses are
// validated before use and never cast unchecked.

const FLIPP_HOST = "backflipp.wishabi.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_RETRIES = 2;
const MAX_CONCURRENCY = 2;
/** A longer Retry-After ends the run as deferred instead of waiting. */
const MAX_RETRY_WAIT_MS = 15_000;
const FIXED_BACKOFF_MS = [1_000, 2_000];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Source, transport or schema failure. Not retried beyond the documented policy. */
export class FlippSourceError extends Error {
  override name = "FlippSourceError";
  constructor(message: string, readonly url: string | null = null) {
    super(url === null ? message : `${message} (${url})`);
  }
}

/** The source asked us to wait longer than we may; nothing may be retried before nextPermittedAt. */
export class FlippDeferredError extends Error {
  override name = "FlippDeferredError";
  constructor(readonly url: string, readonly status: number, readonly nextPermittedAt: string) {
    super(`HTTP ${status} with Retry-After beyond ${MAX_RETRY_WAIT_MS / 1000} s; next permitted request at ${nextPermittedAt} (${url})`);
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Why a URL is outside the allowlist, or null when it is allowed. */
function flippUrlProblem(url: URL): string | null {
  if (url.protocol !== "https:") return `protocol ${url.protocol} is not https`;
  if (url.hostname !== FLIPP_HOST) return `host ${url.hostname} is not ${FLIPP_HOST}`;
  if (url.port !== "") return `port ${url.port} is not the default`;
  if (url.username !== "" || url.password !== "") return "credentials are not allowed";
  return null;
}

function assertAllowed(url: URL, what: string): void {
  const problem = flippUrlProblem(url);
  if (problem !== null) throw new FlippSourceError(`${what} rejected: ${problem}`, url.href);
}

function positiveId(id: number, what: string): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new FlippSourceError(`${what} must be a positive integer, got ${String(id)}`);
  return id;
}

export function flippListingUrl(postalCode: "98105"): URL {
  return new URL(`https://${FLIPP_HOST}/flipp/flyers?postal_code=${encodeURIComponent(postalCode)}`);
}

export function flippFlyerUrl(flyerId: number, postalCode: "98105"): URL {
  return new URL(`https://${FLIPP_HOST}/flipp/flyers/${positiveId(flyerId, "flyer id")}?postal_code=${encodeURIComponent(postalCode)}`);
}

export function flippItemUrl(itemId: number): URL {
  return new URL(`https://${FLIPP_HOST}/flipp/items/${positiveId(itemId, "item id")}`);
}

// ---------------------------------------------------------------------------
// Concurrency: one limiter for every Flipp request in the process.
// ---------------------------------------------------------------------------

function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // slot handed over on release
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

const limit = createLimiter(MAX_CONCURRENCY);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface RawReply {
  url: URL;
  status: number;
  location: string | null;
  retryAfter: string | null;
  contentType: string;
  bytes: Uint8Array | null;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is not needed; a cancel failure changes nothing.
  }
}

/** One HTTP request with a 15 s timeout covering the response and its body. */
async function send(url: URL, fetcher: typeof fetch): Promise<RawReply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject first so the timeout, not the abort it causes, settles the race.
      reject(new FlippSourceError(`request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`, url.href));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  });
  const attempt = async (): Promise<RawReply> => {
    let response: Response;
    try {
      response = await fetcher(url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw new FlippSourceError(`request failed: ${error instanceof Error ? error.message : String(error)}`, url.href);
    }
    const reply: RawReply = {
      url,
      status: response.status,
      location: response.headers.get("location"),
      retryAfter: response.headers.get("retry-after"),
      contentType: response.headers.get("content-type") ?? "",
      bytes: null,
    };
    if (response.status !== 200) {
      await discard(response);
      return reply;
    }
    try {
      reply.bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new FlippSourceError(`reading the response body failed: ${error instanceof Error ? error.message : String(error)}`, url.href);
    }
    return reply;
  };
  try {
    return await Promise.race([attempt(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Follows at most three manual redirects, each checked against the allowlist. */
async function sendFollowingRedirects(start: URL, fetcher: typeof fetch): Promise<RawReply> {
  let current = start;
  for (let redirects = 0; ; redirects += 1) {
    const reply = await send(current, fetcher);
    if (!REDIRECT_STATUSES.has(reply.status)) return reply;
    if (reply.location === null || reply.location.trim() === "") {
      throw new FlippSourceError(`HTTP ${reply.status} redirect without a Location header`, current.href);
    }
    if (redirects >= MAX_REDIRECTS) throw new FlippSourceError(`more than ${MAX_REDIRECTS} redirects`, start.href);
    let next: URL;
    try {
      next = new URL(reply.location, current);
    } catch {
      throw new FlippSourceError(`redirect Location ${JSON.stringify(reply.location)} is not a URL`, current.href);
    }
    assertAllowed(next, "redirect");
    current = next;
  }
}

/** Milliseconds to wait from Retry-After (delta-seconds or HTTP-date), or null when absent/unusable. */
function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

// Strict decoding: invalid UTF-8 is a source error. The exact bytes are kept
// separately for evidence hashing and audit (addendum A9).
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** Success requires 200, non-empty non-HTML UTF-8 text, a JSON content-type and parseable JSON. */
function validated(reply: RawReply, requestUrl: URL): FlippResponse {
  const where = reply.url.href;
  if (reply.status !== 200 || reply.bytes === null) throw new FlippSourceError(`unexpected HTTP ${reply.status}`, where);
  const bytes = reply.bytes;
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new FlippSourceError("response body is not valid UTF-8", where);
  }
  if (text.trim() === "") throw new FlippSourceError("empty response body", where);
  const type = mediaType(reply.contentType);
  if (type === "text/html" || type === "application/xhtml+xml" || /^\s*</.test(text)) {
    throw new FlippSourceError("HTML page instead of JSON (possible bot check or interstitial page)", where);
  }
  if (type !== "application/json") {
    throw new FlippSourceError(`content-type ${JSON.stringify(reply.contentType)} is not application/json`, where);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FlippSourceError(`malformed JSON: ${error instanceof Error ? error.message : String(error)}`, where);
  }
  return { requestUrl: requestUrl.href, finalUrl: where, bytes, text, json };
}

export interface FlippResponse {
  /** The URL that was requested (Evidence.retrievedUrl). */
  requestUrl: string;
  /** The URL that answered after redirects. */
  finalUrl: string;
  /** The exact response body bytes as received, for evidence hashing and audit (A9). */
  bytes: Uint8Array;
  /** The body decoded as strict UTF-8 (a leading BOM is dropped); what `json` was parsed from. */
  text: string;
  json: unknown;
}

export interface FetchOptions {
  fetcher?: typeof fetch;
  /** Clock for Retry-After HTTP-dates and deferred times (epoch ms). */
  now?: () => number;
}

/**
 * Validated Flipp GET: allowlisted URL, manual redirects (at most three),
 * 15 s per request, at most two concurrent requests, at most two retries for
 * 429/5xx honoring Retry-After (1 s then 2 s without it). A Retry-After above
 * 15 s throws FlippDeferredError; everything else throws FlippSourceError.
 */
export async function fetchFlippResponse(url: URL, options: FetchOptions = {}): Promise<FlippResponse> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  assertAllowed(url, "request");
  return limit(async () => {
    for (let retry = 0; ; retry += 1) {
      const reply = await sendFollowingRedirects(url, fetcher);
      const retryable = reply.status === 429 || (reply.status >= 500 && reply.status <= 599);
      if (!retryable) return validated(reply, url);
      const nowMs = now();
      const requested = retryAfterMs(reply.retryAfter, nowMs);
      if (requested !== null && requested > MAX_RETRY_WAIT_MS) {
        const next = new Date(nowMs + requested);
        if (Number.isNaN(next.getTime())) throw new FlippSourceError(`HTTP ${reply.status} with an unusable Retry-After`, reply.url.href);
        throw new FlippDeferredError(reply.url.href, reply.status, next.toISOString());
      }
      if (retry >= MAX_RETRIES) throw new FlippSourceError(`HTTP ${reply.status} after ${MAX_RETRIES} retries`, reply.url.href);
      const wait = requested ?? FIXED_BACKOFF_MS[retry] ?? FIXED_BACKOFF_MS[FIXED_BACKOFF_MS.length - 1] ?? 0;
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  });
}

/** Plan contract: validated JSON from an allowlisted Flipp URL. */
export async function fetchFlippJson(url: URL, fetcher?: typeof fetch): Promise<unknown> {
  return (await fetchFlippResponse(url, { fetcher })).json;
}

// ---------------------------------------------------------------------------
// Parsers: validate the fields the collector relies on; keep everything else.
// ---------------------------------------------------------------------------

export type FlippFlyer = Record<string, unknown> & {
  id: number; merchant: string; name: string; valid_from: string; valid_to: string;
};
export type FlippRow = Record<string, unknown> & { id: number; name: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function schemaError(what: string, problem: string): FlippSourceError {
  return new FlippSourceError(`schema: ${what} ${problem}`);
}

function recordsIn(response: unknown, key: string, what: string): Record<string, unknown>[] {
  if (!isRecord(response)) throw schemaError(what, "response is not an object");
  const list = response[key];
  if (!Array.isArray(list)) throw schemaError(what, `has no ${key} array`);
  return list.map((entry: unknown, index) => {
    if (!isRecord(entry)) throw schemaError(what, `${key}[${index}] is not an object`);
    if (!isPositiveInteger(entry.id)) throw schemaError(what, `${key}[${index}].id is not a positive integer`);
    return entry;
  });
}

function requireStrings(entry: Record<string, unknown>, fields: readonly string[], where: string): void {
  for (const field of fields) {
    if (typeof entry[field] !== "string") throw schemaError(where, `.${field} is not a string`);
  }
}

/** Listing `{ flyers: [...] }`; each flyer needs id, merchant, name, valid_from, valid_to. */
export function parseFlippListing(response: unknown): FlippFlyer[] {
  return recordsIn(response, "flyers", "flyer listing").map((flyer, index) => {
    requireStrings(flyer, ["merchant", "name", "valid_from", "valid_to"], `flyer listing flyers[${index}]`);
    return { ...flyer } as FlippFlyer;
  });
}

/** Flyer detail `{ items: [...] }`; each row needs a numeric id and a name. */
export function parseFlippFlyer(response: unknown): FlippRow[] {
  return recordsIn(response, "items", "flyer detail").map((row, index) => {
    requireStrings(row, ["name"], `flyer detail items[${index}]`);
    return { ...row } as FlippRow;
  });
}

/** Plan contract: item detail `{ item: {...} }` with a positive integer id and a string name. */
export function parseFlippItem(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) throw schemaError("item detail", "response is not an object");
  const record = response.item;
  if (!isRecord(record)) throw schemaError("item detail", "has no item object");
  if (!isPositiveInteger(record.id)) throw schemaError("item detail", "item.id is not a positive integer");
  if (typeof record.name !== "string") throw schemaError("item detail", "item.name is not a string");
  return { ...record };
}
