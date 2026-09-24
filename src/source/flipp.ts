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
/** Rejected response bodies are kept for the audit up to this many bytes. */
export const FAILED_BODY_LIMIT_BYTES = 1024 * 1024;

/** Source, transport or schema failure. Not retried beyond the documented policy. */
export class FlippSourceError extends Error {
  override name = "FlippSourceError";
  /**
   * `status` is the HTTP status of the response that caused the failure, or
   * null when there was none (transport error, timeout, schema problem).
   * A11: the collector treats an item-detail 404/410 as a per-item exclusion.
   */
  constructor(message: string, readonly url: string | null = null, readonly status: number | null = null) {
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

/** One HTTP exchange, reported through FetchOptions.onAttempt for the audit. */
export interface FlippAttempt {
  /** The URL the caller asked for. */
  requestUrl: string;
  /** The URL of this exchange (a redirect target on hops 1-3). */
  url: string;
  /** 1 for the first try, 2 and 3 for retries after 429/5xx. */
  attempt: number;
  /** 0 for the first request of a try, 1-3 for redirect hops. */
  hop: number;
  /** HTTP status, or null when no response arrived (transport error, timeout, abort). */
  status: number | null;
  /** Why this exchange did not yield an accepted response; null when accepted or a followed redirect. */
  error: string | null;
  /** Body of a rejected response, at most FAILED_BODY_LIMIT_BYTES; null otherwise. */
  body: Uint8Array | null;
  /** True when the rejected body was longer than the kept bytes. */
  bodyTruncated: boolean;
}

interface RawReply {
  url: URL;
  status: number;
  location: string | null;
  retryAfter: string | null;
  contentType: string;
  /** The whole body for 200; at most FAILED_BODY_LIMIT_BYTES for any other status. */
  bytes: Uint8Array;
  truncated: boolean;
}

/** One fetchFlippResponse call: what every request, retry and hop shares. */
interface Exchange {
  requestUrl: URL;
  fetcher: typeof fetch;
  signal: AbortSignal | undefined;
  onAttempt: (attempt: FlippAttempt) => void;
}

/**
 * An error's message plus its cause's code and message. Node's fetch reports
 * only "fetch failed" and puts ECONNRESET, UND_ERR_*, CERT_* and similar on
 * `cause`, which is what makes a network failure diagnosable.
 */
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

/** Reads at most `limit` bytes of a body for the audit; a read failure keeps what arrived. */
async function readCapped(response: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        chunks.push(value.subarray(0, limit - size));
        size = limit;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    truncated = true;
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks, size)), truncated };
}

/** One HTTP request, ended by the 15 s timeout or the run-wide abort (A12), covering the response and its body. */
async function send(url: URL, exchange: Exchange): Promise<RawReply> {
  const { signal } = exchange;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject first so the timeout, not the abort it causes, settles the race.
      reject(new FlippSourceError(`request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`, url.href));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    // A12: a run-wide abort ends the in-flight request at once, with the run's reason.
    onAbort = () => {
      reject(signal?.reason);
      controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const attempt = async (): Promise<RawReply> => {
    let response: Response;
    try {
      response = await exchange.fetcher(url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw new FlippSourceError(`request failed: ${describeError(error)}`, url.href);
    }
    const reply = {
      url,
      status: response.status,
      location: response.headers.get("location"),
      retryAfter: response.headers.get("retry-after"),
      contentType: response.headers.get("content-type") ?? "",
    };
    // Any status but 200 is rejected, retried or redirected; its body is kept (capped) for the audit.
    if (response.status !== 200) return { ...reply, ...(await readCapped(response, FAILED_BODY_LIMIT_BYTES)) };
    try {
      return { ...reply, bytes: new Uint8Array(await response.arrayBuffer()), truncated: false };
    } catch (error) {
      throw new FlippSourceError(`reading the response body failed: ${describeError(error)}`, url.href, response.status);
    }
  };
  try {
    return await Promise.race([attempt(), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Reports one exchange; a rejected response's body (capped) goes with it. */
function report(
  exchange: Exchange,
  where: { url: URL; attempt: number; hop: number },
  outcome: { reply: RawReply } | { status: number | null },
  error: string | null,
): void {
  const reply = "reply" in outcome ? outcome.reply : null;
  // A copy, so a large rejected body is not kept alive by its first megabyte.
  const body = error !== null && reply !== null ? reply.bytes.slice(0, FAILED_BODY_LIMIT_BYTES) : null;
  exchange.onAttempt({
    requestUrl: exchange.requestUrl.href,
    url: where.url.href,
    attempt: where.attempt,
    hop: where.hop,
    status: "reply" in outcome ? outcome.reply.status : outcome.status,
    error,
    body,
    bodyTruncated: body !== null && reply !== null && (reply.truncated || reply.bytes.byteLength > body.byteLength),
  });
}

/** Follows at most three manual redirects, each checked against the allowlist. */
async function sendFollowingRedirects(exchange: Exchange, attempt: number): Promise<{ reply: RawReply; hop: number }> {
  let current = exchange.requestUrl;
  for (let hop = 0; ; hop += 1) {
    exchange.signal?.throwIfAborted(); // A12: no request, retry or redirect hop after a run-wide abort
    const where = { url: current, attempt, hop };
    let reply: RawReply;
    try {
      reply = await send(current, exchange);
    } catch (error) {
      report(exchange, where, { status: error instanceof FlippSourceError ? error.status : null }, describeError(error));
      throw error;
    }
    if (!REDIRECT_STATUSES.has(reply.status)) return { reply, hop };
    let next: URL;
    try {
      next = redirectTarget(reply, hop, exchange.requestUrl);
    } catch (error) {
      report(exchange, where, { reply }, describeError(error));
      throw error;
    }
    report(exchange, where, { reply }, null);
    current = next;
  }
}

/** The allowlisted target of redirect number `hop + 1`, or a FlippSourceError. */
function redirectTarget(reply: RawReply, hop: number, start: URL): URL {
  const from = reply.url.href;
  if (reply.location === null || reply.location.trim() === "") {
    throw new FlippSourceError(`HTTP ${reply.status} redirect without a Location header`, from, reply.status);
  }
  if (hop >= MAX_REDIRECTS) throw new FlippSourceError(`more than ${MAX_REDIRECTS} redirects`, start.href, reply.status);
  let next: URL;
  try {
    next = new URL(reply.location, reply.url);
  } catch {
    throw new FlippSourceError(`redirect Location ${JSON.stringify(reply.location)} is not a URL`, from, reply.status);
  }
  const problem = flippUrlProblem(next);
  if (problem !== null) throw new FlippSourceError(`redirect rejected: ${problem}`, next.href, reply.status);
  return next;
}

// Retry-After (RFC 9110): delta-seconds or an IMF-fixdate such as
// "Sun, 06 Nov 1994 08:49:37 GMT". Anything else (fractions, signs, ISO
// dates, obsolete RFC 850/asctime dates, impossible dates or weekdays) is
// unusable and falls back to the fixed backoff.
const DELTA_SECONDS = /^\d+$/;
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Milliseconds to wait, or null when Retry-After is absent or unusable. A past
 * HTTP-date allows an immediate retry, still bounded by the retry count.
 */
function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (DELTA_SECONDS.test(text)) return Number(text) * 1000;
  if (!IMF_FIXDATE.test(text)) return null;
  const date = Date.parse(text);
  // Round-tripping rejects impossible days and wrong weekdays, which Date.parse accepts.
  if (Number.isNaN(date) || new Date(date).toUTCString() !== text) return null;
  return Math.max(0, date - nowMs);
}

/** Retry backoff that ends early, with the run's reason, on a run-wide abort (A12). */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  const fail = (message: string) => new FlippSourceError(message, where, reply.status);
  if (reply.status !== 200) throw fail(`unexpected HTTP ${reply.status}`);
  const bytes = reply.bytes;
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw fail("response body is not valid UTF-8");
  }
  if (text.trim() === "") throw fail("empty response body");
  const type = mediaType(reply.contentType);
  if (type === "text/html" || type === "application/xhtml+xml" || /^\s*</.test(text)) {
    throw fail("HTML page instead of JSON (possible bot check or interstitial page)");
  }
  if (type !== "application/json") throw fail(`content-type ${JSON.stringify(reply.contentType)} is not application/json`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw fail(`malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
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
  /**
   * Run-wide abort (A12): checked before every request, retry and redirect
   * hop, ends retry waits, and is forwarded to the in-flight request. The
   * call then rejects with `signal.reason`.
   */
  signal?: AbortSignal;
  /** Called once per HTTP exchange, including failed and redirected ones, for the audit. */
  onAttempt?: (attempt: FlippAttempt) => void;
}

/**
 * Validated Flipp GET: allowlisted URL, manual redirects (at most three),
 * 15 s per request, at most two concurrent requests, at most two retries for
 * 429/5xx honoring a strict Retry-After (1 s then 2 s without a usable one).
 * A Retry-After above 15 s throws FlippDeferredError; an abort rejects with
 * the signal's reason; everything else throws FlippSourceError.
 */
export async function fetchFlippResponse(url: URL, options: FetchOptions = {}): Promise<FlippResponse> {
  assertAllowed(url, "request");
  options.signal?.throwIfAborted();
  const exchange: Exchange = {
    requestUrl: url,
    fetcher: options.fetcher ?? fetch,
    signal: options.signal,
    onAttempt: options.onAttempt ?? (() => undefined),
  };
  const now = options.now ?? Date.now;
  return limit(async () => {
    for (let retry = 0; ; retry += 1) {
      const attempt = retry + 1;
      const { reply, hop } = await sendFollowingRedirects(exchange, attempt);
      const done = (error: string | null) => report(exchange, { url: reply.url, attempt, hop }, { reply }, error);
      const retryable = reply.status === 429 || (reply.status >= 500 && reply.status <= 599);
      if (!retryable) {
        let response: FlippResponse;
        try {
          response = validated(reply, url);
        } catch (error) {
          done(describeError(error));
          throw error;
        }
        done(null);
        return response;
      }
      const nowMs = now();
      const requested = retryAfterMs(reply.retryAfter, nowMs);
      if (requested !== null && requested > MAX_RETRY_WAIT_MS) {
        const next = new Date(nowMs + requested);
        const error = Number.isNaN(next.getTime())
          ? new FlippSourceError(`HTTP ${reply.status} with an unusable Retry-After`, reply.url.href, reply.status)
          : new FlippDeferredError(reply.url.href, reply.status, next.toISOString());
        done(error.message);
        throw error;
      }
      if (retry >= MAX_RETRIES) {
        const error = new FlippSourceError(`HTTP ${reply.status} after ${MAX_RETRIES} retries`, reply.url.href, reply.status);
        done(error.message);
        throw error;
      }
      const wait = requested ?? FIXED_BACKOFF_MS[retry] ?? FIXED_BACKOFF_MS[FIXED_BACKOFF_MS.length - 1] ?? 0;
      done(`HTTP ${reply.status}; retry ${attempt} of ${MAX_RETRIES} after ${wait} ms`);
      await pause(wait, exchange.signal);
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
/** A flyer list row with a valid id; its name may be missing (the collector excludes it, A11). */
export type FlippRow = Record<string, unknown> & { id: number };

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

const FLYER_STRINGS = ["merchant", "name", "valid_from", "valid_to"] as const;

/** Why a listing entry lacks the fields the collector relies on; empty when it has them. */
function flyerProblems(entry: unknown): string[] {
  if (!isRecord(entry)) return ["is not an object"];
  const problems = isPositiveInteger(entry.id) ? [] : [".id is not a positive integer"];
  for (const field of FLYER_STRINGS) if (typeof entry[field] !== "string") problems.push(`.${field} is not a string`);
  return problems;
}

/**
 * Listing `{ flyers: [...] }`; a flyer needs id, merchant, name, valid_from and
 * valid_to. A11: a malformed flyer from one of `merchants` (the collected
 * QFC/Safeway merchants) is a schema error; a malformed flyer from any other
 * merchant is ignored and described in `ignored`.
 */
export function parseFlippListing(response: unknown, merchants: readonly string[]): { flyers: FlippFlyer[]; ignored: string[] } {
  if (!isRecord(response)) throw schemaError("flyer listing", "response is not an object");
  const list = response.flyers;
  if (!Array.isArray(list)) throw schemaError("flyer listing", "has no flyers array");
  const flyers: FlippFlyer[] = [];
  const ignored: string[] = [];
  list.forEach((entry: unknown, index) => {
    const where = `flyer listing flyers[${index}]`;
    const problems = flyerProblems(entry);
    if (problems.length === 0) {
      flyers.push({ ...(entry as FlippFlyer) });
      return;
    }
    const merchant = isRecord(entry) && typeof entry.merchant === "string" ? entry.merchant : null;
    if (merchant !== null && merchants.includes(merchant.trim())) throw schemaError(where, problems.join("; "));
    ignored.push(`${where} (merchant ${merchant === null ? "unknown" : JSON.stringify(merchant)}) ignored: ${problems.join("; ")}`);
  });
  return { flyers, ignored };
}

/**
 * Flyer detail `{ items: [...] }`; each row needs a positive integer id. A11:
 * a row without a string name is kept for the collector to exclude.
 */
export function parseFlippFlyer(response: unknown): FlippRow[] {
  return recordsIn(response, "items", "flyer detail").map((row) => ({ ...row }) as FlippRow);
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
