import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FlippDeferredError,
  FlippSourceError,
  fetchFlippJson,
  fetchFlippResponse,
  flippFlyerUrl,
  flippItemUrl,
  flippListingUrl,
  parseFlippFlyer,
  parseFlippItem,
  parseFlippListing,
} from "../../src/source/flipp.js";
import { item } from "../fixtures/source.js";

// Offline HTTP tests: every request goes to an injected fetcher; timers and
// the clock are faked. No live network.

const NOW = new Date("2026-09-24T19:00:00.000Z");
const ITEM_URL = new URL("https://backflipp.wishabi.com/flipp/items/1038428171");
const JSON_TYPE = "application/json; charset=utf-8";

function jsonResponse(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: { "content-type": init.contentType ?? JSON_TYPE } });
}

function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
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

/** Lets pending promise chains (including Response body reads) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function track<T>(promise: Promise<T>): { settled: () => boolean } {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return { settled: () => done };
}

function requestedUrl(fetcher: ReturnType<typeof sequence>, call: number): string {
  return String(fetcher.mock.calls[call]?.[0]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("URLs", () => {
  it("builds the fixed 98105 listing, flyer and item URLs", () => {
    expect(flippListingUrl("98105").href).toBe("https://backflipp.wishabi.com/flipp/flyers?postal_code=98105");
    expect(flippFlyerUrl(8132234, "98105").href).toBe("https://backflipp.wishabi.com/flipp/flyers/8132234?postal_code=98105");
    expect(flippItemUrl(1038428171).href).toBe("https://backflipp.wishabi.com/flipp/items/1038428171");
  });

  it("rejects non-positive or non-integer IDs", () => {
    expect(() => flippFlyerUrl(0, "98105")).toThrow(FlippSourceError);
    expect(() => flippItemUrl(1.5)).toThrow(FlippSourceError);
  });
});

describe("host allowlist", () => {
  it.each([
    ["plain http", "http://backflipp.wishabi.com/flipp/items/1"],
    ["another host", "https://example.com/flipp/items/1"],
    ["a look-alike suffix", "https://backflipp.wishabi.com.evil.test/flipp/items/1"],
    ["a subdomain", "https://evil.backflipp.wishabi.com/flipp/items/1"],
    ["a trailing-dot host", "https://backflipp.wishabi.com./flipp/items/1"],
    ["a non-default port", "https://backflipp.wishabi.com:8443/flipp/items/1"],
    ["a username", "https://user@backflipp.wishabi.com/flipp/items/1"],
    ["a username and password", "https://user:secret@backflipp.wishabi.com/flipp/items/1"],
  ])("rejects %s before any request", async (_label, url) => {
    const fetcher = sequence(() => jsonResponse("{}"));
    await expect(fetchFlippJson(new URL(url), fetcher)).rejects.toBeInstanceOf(FlippSourceError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts the explicit default port", async () => {
    const fetcher = sequence(() => jsonResponse('{"ok":true}'));
    await expect(fetchFlippJson(new URL("https://backflipp.wishabi.com:443/flipp/items/1"), fetcher)).resolves.toEqual({ ok: true });
  });

  it("sends GET with manual redirects and an abort signal", async () => {
    const fetcher = sequence(() => jsonResponse("{}"));
    await fetchFlippJson(ITEM_URL, fetcher);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("redirects", () => {
  it("follows a relative redirect to an allowed path", async () => {
    const fetcher = sequence(
      () => statusResponse(302, { location: "/flipp/items/2" }),
      () => jsonResponse('{"moved":true}'),
    );
    const response = await fetchFlippResponse(ITEM_URL, { fetcher });
    expect(response.json).toEqual({ moved: true });
    expect(requestedUrl(fetcher, 1)).toBe("https://backflipp.wishabi.com/flipp/items/2");
    expect(response.requestUrl).toBe(ITEM_URL.href);
    expect(response.finalUrl).toBe("https://backflipp.wishabi.com/flipp/items/2");
  });

  it.each([
    ["another host", "https://evil.test/flipp/items/1"],
    ["plain http", "http://backflipp.wishabi.com/flipp/items/1"],
    ["credentials", "https://user:pw@backflipp.wishabi.com/flipp/items/1"],
    ["a protocol-relative host", "//backflipp.wishabi.com.evil.test/x"],
  ])("rejects a redirect escape to %s", async (_label, location) => {
    const fetcher = sequence(() => statusResponse(301, { location }), () => jsonResponse("{}"));
    await expect(fetchFlippJson(ITEM_URL, fetcher)).rejects.toThrow(FlippSourceError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect without a Location header", async () => {
    const fetcher = sequence(() => statusResponse(307));
    await expect(fetchFlippJson(ITEM_URL, fetcher)).rejects.toThrow(/Location/);
  });

  it("follows exactly three redirects", async () => {
    const fetcher = sequence(
      () => statusResponse(301, { location: "/a" }),
      () => statusResponse(302, { location: "/b" }),
      () => statusResponse(308, { location: "/c" }),
      () => jsonResponse('{"hops":3}'),
    );
    await expect(fetchFlippJson(ITEM_URL, fetcher)).resolves.toEqual({ hops: 3 });
  });

  it("rejects more than three redirects", async () => {
    const fetcher = sequence(
      () => statusResponse(301, { location: "/a" }),
      () => statusResponse(302, { location: "/b" }),
      () => statusResponse(303, { location: "/c" }),
      () => statusResponse(307, { location: "/d" }),
      () => jsonResponse("{}"),
    );
    await expect(fetchFlippJson(ITEM_URL, fetcher)).rejects.toThrow(/redirect/i);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("timeout", () => {
  it("aborts a request after 15 s", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const promise = fetchFlippJson(ITEM_URL, fetcher);
    const state = track(promise);
    const assertion = expect(promise).rejects.toThrow(/timed out after 15 s/);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(state.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await expect(promise).rejects.toBeInstanceOf(FlippSourceError);
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out a body that never finishes, even if the fetcher ignores the signal", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }),
      { status: 200, headers: { "content-type": JSON_TYPE } },
    ));
    const promise = fetchFlippJson(ITEM_URL, fetcher);
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});

describe("retries", () => {
  it("honors Retry-After 2 on 429, then succeeds", async () => {
    const fetcher = sequence(
      () => statusResponse(429, { "retry-after": "2" }),
      () => jsonResponse('{"ok":true}'),
    );
    const promise = fetchFlippJson(ITEM_URL, fetcher);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestedUrl(fetcher, 1)).toBe(ITEM_URL.href);
  });

  it("retries 503 twice with a 1 s then 2 s backoff, then succeeds", async () => {
    const fetcher = sequence(
      () => statusResponse(503),
      () => statusResponse(503),
      () => jsonResponse('{"ok":true}'),
    );
    const promise = fetchFlippJson(ITEM_URL, fetcher);
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fails after 503 three times (at most two retries)", async () => {
    const fetcher = sequence(() => statusResponse(503), () => statusResponse(503), () => statusResponse(503), () => jsonResponse("{}"));
    const promise = fetchFlippJson(ITEM_URL, fetcher);
    const assertion = expect(promise).rejects.toThrow(/503/);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    await expect(promise).rejects.toBeInstanceOf(FlippSourceError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("defers when Retry-After exceeds 15 s and never retries early", async () => {
    const fetcher = sequence(() => statusResponse(429, { "retry-after": "60" }), () => jsonResponse("{}"));
    const error = await fetchFlippJson(ITEM_URL, fetcher).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FlippDeferredError);
    expect((error as FlippDeferredError).nextPermittedAt).toBe("2026-09-24T19:01:00.000Z");
    expect((error as FlippDeferredError).url).toBe(ITEM_URL.href);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("waits a Retry-After of exactly 15 s", async () => {
    const fetcher = sequence(() => statusResponse(503, { "retry-after": "15" }), () => jsonResponse('{"ok":1}'));
    const promise = fetchFlippJson(ITEM_URL, fetcher);
    await flush();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ ok: 1 });
  });

  it("honors Retry-After as an HTTP-date", async () => {
    const fetcher = sequence(
      () => statusResponse(429, { "retry-after": "Thu, 24 Sep 2026 19:00:05 GMT" }),
      () => jsonResponse('{"ok":true}'),
    );
    const promise = fetchFlippJson(ITEM_URL, fetcher);
    await flush();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("defers to a far HTTP-date with that exact next permitted time", async () => {
    const fetcher = sequence(() => statusResponse(503, { "retry-after": "Thu, 24 Sep 2026 19:05:00 GMT" }));
    const error = await fetchFlippJson(ITEM_URL, fetcher).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FlippDeferredError);
    expect((error as FlippDeferredError).nextPermittedAt).toBe("2026-09-24T19:05:00.000Z");
  });

  it("uses the injected clock for the next permitted time", async () => {
    const fetcher = sequence(() => statusResponse(429, { "retry-after": "120" }));
    const now = () => Date.parse("2026-09-24T20:00:00.000Z");
    const error = await fetchFlippResponse(ITEM_URL, { fetcher, now }).catch((caught: unknown) => caught);
    expect((error as FlippDeferredError).nextPermittedAt).toBe("2026-09-24T20:02:00.000Z");
  });

  it("does not retry 404", async () => {
    const fetcher = sequence(() => statusResponse(404), () => jsonResponse("{}"));
    await expect(fetchFlippJson(ITEM_URL, fetcher)).rejects.toThrow(/404/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry a network failure", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
    await expect(fetchFlippJson(ITEM_URL, fetcher)).rejects.toBeInstanceOf(FlippSourceError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("response validation", () => {
  it("returns the exact bytes, decoded text, request URL and parsed JSON", async () => {
    const body = JSON.stringify({ item: item(1039561900) });
    expect(body).toContain("®");
    const fetcher = sequence(() => jsonResponse(body));
    const response = await fetchFlippResponse(ITEM_URL, { fetcher });
    expect(Buffer.from(response.bytes).equals(Buffer.from(body, "utf8"))).toBe(true);
    expect(response.text).toBe(body);
    expect(response.json).toEqual({ item: item(1039561900) });
    expect(response.requestUrl).toBe(ITEM_URL.href);
    expect(response.finalUrl).toBe(ITEM_URL.href);
  });

  it("keeps a leading BOM in the bytes while parsing the JSON", async () => {
    const served = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"ok":true}')]);
    const fetcher = sequence(() => new Response(served, { status: 200, headers: { "content-type": JSON_TYPE } }));
    const response = await fetchFlippResponse(ITEM_URL, { fetcher });
    expect(Buffer.from(response.bytes).equals(Buffer.from(served))).toBe(true);
    expect(response.text).toBe('{"ok":true}');
    expect(response.json).toEqual({ ok: true });
  });

  it.each([
    ["an HTML bot page", () => jsonResponse("<!DOCTYPE html><html><body>Access denied</body></html>", { contentType: "text/html; charset=utf-8" }), /HTML/],
    ["HTML labeled as JSON", () => jsonResponse("\n  <html><title>Checking your browser</title></html>"), /HTML/],
    ["an empty body", () => jsonResponse(""), /empty/],
    ["a whitespace-only body", () => jsonResponse("  \n"), /empty/],
    ["malformed JSON", () => jsonResponse('{"item": '), /JSON/],
    ["a wrong content-type", () => jsonResponse('{"ok":true}', { contentType: "text/plain" }), /content-type/],
    ["a missing content-type", () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "" } }), /content-type/],
    ["a non-200 success status", () => jsonResponse('{"ok":true}', { status: 203 }), /203/],
    ["invalid UTF-8", () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200, headers: { "content-type": JSON_TYPE } }), /UTF-8/],
  ])("rejects %s", async (_label, response, message) => {
    const fetcher = sequence(response);
    const error = await fetchFlippJson(ITEM_URL, fetcher).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FlippSourceError);
    expect(String((error as Error).message)).toMatch(message);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency", () => {
  it("keeps at most two requests in flight across calls", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const fetcher = vi.fn<typeof fetch>(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          inFlight -= 1;
          resolve(jsonResponse('{"ok":true}'));
        });
      });
    });
    const all = Promise.all([1, 2, 3, 4, 5].map((id) => fetchFlippJson(flippItemUrl(id), fetcher)));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    while (releases.length > 0) {
      releases.shift()?.();
      await flush();
    }
    await expect(all).resolves.toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(2);
  });
});

describe("parsers", () => {
  it("parseFlippItem unwraps a valid item-detail response and keeps every field", () => {
    const record = item(1038428171);
    const parsed = parseFlippItem({ item: record });
    expect(parsed).toEqual(record);
    expect(parsed.cutout_image_url).toBe(record.cutout_image_url);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["no item", {}],
    ["a null item", { item: null }],
    ["a string id", { item: { id: "1038428171", name: "x" } }],
    ["a zero id", { item: { id: 0, name: "x" } }],
    ["a fractional id", { item: { id: 1.5, name: "x" } }],
    ["a missing name", { item: { id: 1 } }],
    ["a numeric name", { item: { id: 1, name: 7 } }],
  ])("parseFlippItem rejects %s", (_label, value) => {
    expect(() => parseFlippItem(value)).toThrow(FlippSourceError);
  });

  it("parseFlippListing validates flyers and keeps extra fields", () => {
    const flyers = parseFlippListing({
      flyers: [{ id: 8132234, merchant: "QFC", name: "Weekly Ad", valid_from: "a", valid_to: "b", is_store_select: true }],
      extra: 1,
    });
    expect(flyers).toEqual([{ id: 8132234, merchant: "QFC", name: "Weekly Ad", valid_from: "a", valid_to: "b", is_store_select: true }]);
  });

  it.each([
    ["no flyers", {}],
    ["flyers not an array", { flyers: {} }],
    ["a string id", { flyers: [{ id: "1", merchant: "QFC", name: "Weekly Ad", valid_from: "a", valid_to: "b" }] }],
    ["a missing merchant", { flyers: [{ id: 1, name: "Weekly Ad", valid_from: "a", valid_to: "b" }] }],
    ["a missing name", { flyers: [{ id: 1, merchant: "QFC", valid_from: "a", valid_to: "b" }] }],
    ["a numeric valid_to", { flyers: [{ id: 1, merchant: "QFC", name: "Weekly Ad", valid_from: "a", valid_to: 5 }] }],
    ["a null flyer", { flyers: [null] }],
  ])("parseFlippListing rejects %s", (_label, value) => {
    expect(() => parseFlippListing(value)).toThrow(FlippSourceError);
  });

  it("parseFlippFlyer validates rows and keeps extra fields", () => {
    expect(parseFlippFlyer({ items: [{ id: 5, name: "Organic Strawberries", price: "2.99" }], pages: [] }))
      .toEqual([{ id: 5, name: "Organic Strawberries", price: "2.99" }]);
  });

  it.each([
    ["no items", {}],
    ["items not an array", { items: null }],
    ["a row without a name", { items: [{ id: 1 }] }],
    ["a row with a negative id", { items: [{ id: -1, name: "x" }] }],
    ["a non-object row", { items: ["x"] }],
  ])("parseFlippFlyer rejects %s", (_label, value) => {
    expect(() => parseFlippFlyer(value)).toThrow(FlippSourceError);
  });
});
