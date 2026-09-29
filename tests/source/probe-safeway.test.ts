import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeSearch,
  comparePrices,
  CONFIG_NAMES,
  extractConfig,
  feasibility,
  findKeyLeaks,
  MAX_SEARCH_REQUESTS,
  MODES,
  QUERIES,
  redact,
  REQUEST_GAP_MS,
  runProbe,
} from "../../scripts/probe-safeway.js";

// S0 probe tests. Everything is offline: the weekly-ad HTML and every search
// response below are synthetic, served by an injected fetcher. KEY is a made-up
// 32-character value shaped like the real one; it is not a real credential.

const KEY = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const ORIGIN = "https://www.safeway.com";
const SEARCH_PATH = "/abs/pub/xapi/pgmsearch/v1/search/products";

const DECOYS =
  '"apimSubscriptionKey":"decoy000000000000000000000000001",' +
  '"xapiSubscriptionKey":"decoy000000000000000000000000002",' +
  '"apimP13nSubscriptionKey":"decoy000000000000000000000000003",' +
  '"apimProgramSubscriptionKeyV2":"decoy000000000000000000000000004",' +
  '"xApimProgramSubscriptionKey":"decoy000000000000000000000000005",' +
  '"apimSearchPath":"/decoy/path","apimSearchProductsEndpoint":"/decoy/search/products"';

interface PageConfig {
  searchPath?: string;
  endpoint?: string;
  key?: string;
}

function weeklyAdHtml(config: PageConfig = {}): string {
  const pairs = [
    DECOYS,
    `"apimProgramSearchPath":"${config.searchPath ?? "/abs/pub/xapi"}"`,
    `"apimProgramSearchProductsEndpoint":"${config.endpoint ?? "/pgmsearch/v1/search/products"}"`,
    `"apimProgramSubscriptionKey":"${config.key ?? KEY}"`,
    '"recipeByIdEndpoint":"/recipes"',
  ];
  return `<!doctype html><html><head><script>window.SWY={${pairs.join(",")}};</script></head><body>WEEKLY-AD-HTML-MARKER</body></html>`;
}

interface SyntheticProduct {
  id: string;
  price: number | string | null;
}

function searchJson(products: SyntheticProduct[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    appCode: "200",
    response: {
      numFound: products.length,
      start: 0,
      docs: products.map(({ id, price }) => ({
        id,
        pid: id,
        name: `Synthetic product ${id}`,
        price,
        basePrice: price,
        pricePer: price,
        unitOfMeasure: "LB",
        itemSizeQty: "1",
        aisleName: "Synthetic aisle",
      })),
    },
    ...extra,
  });
}

const json = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });

type SearchHandler = (url: URL, headers: Headers) => Response | Promise<Response>;

const defaultSearch: SearchHandler = () =>
  json(searchJson([{ id: "970000001", price: 1.99 }, { id: "970000002", price: 2.49 }], { storeId: "2980" }));

interface Call {
  url: string;
  headers: Headers;
  redirect: RequestInit["redirect"];
}

function fakeSite(options: { html?: string; search?: SearchHandler } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url: url.href, headers, redirect: init?.redirect });
    if (url.pathname === "/weeklyad") {
      return new Response(options.html ?? weeklyAdHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return (options.search ?? defaultSearch)(url, headers);
  }) as typeof fetch;
  return { fetcher, calls };
}

const tempDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(fetcher: typeof fetch) {
  const auditRoot = mkdtempSync(join(tmpdir(), "probe-safeway-"));
  tempDirs.push(auditRoot);
  const printed: string[] = [];
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const code = await runProbe({
    fetcher,
    auditRoot,
    print: (text) => printed.push(text),
    sleep,
    now: () => new Date("2026-09-28T20:00:00.000Z"),
  });
  const output = printed.join("\n");
  return { code, output, auditRoot, sleep, lines: output.split("\n") };
}

/** Every saved file under the audit root, as { name, text }. */
function savedFiles(auditRoot: string): { name: string; text: string }[] {
  return readdirSync(auditRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, text: readFileSync(join(entry.parentPath, entry.name), "utf8") }));
}

const searchCalls = (calls: Call[]) => calls.filter((call) => new URL(call.url).pathname !== "/weeklyad");

describe("extractConfig", () => {
  it("reads the three values by their exact names", () => {
    expect(extractConfig(weeklyAdHtml())).toEqual({
      searchPath: "/abs/pub/xapi",
      productsEndpoint: "/pgmsearch/v1/search/products",
      key: KEY,
    });
    expect(CONFIG_NAMES).toEqual({
      searchPath: "apimProgramSearchPath",
      productsEndpoint: "apimProgramSearchProductsEndpoint",
      key: "apimProgramSubscriptionKey",
    });
  });

  it("reports each missing name as null", () => {
    expect(extractConfig("<html>no config here</html>")).toEqual({ searchPath: null, productsEndpoint: null, key: null });
    const onlyKey = `<script>{"apimProgramSubscriptionKey":"${KEY}"}</script>`;
    expect(extractConfig(onlyKey)).toEqual({ searchPath: null, productsEndpoint: null, key: KEY });
  });

  it("never picks a key-like value from another config name", () => {
    // The real page carries many *SubscriptionKey and apimSearch* names; none may stand in.
    expect(extractConfig(`<script>{${DECOYS}}</script>`)).toEqual({ searchPath: null, productsEndpoint: null, key: null });
    const config = extractConfig(weeklyAdHtml());
    expect(config.key).toBe(KEY);
    expect(config.searchPath).toBe("/abs/pub/xapi");
  });

  it("treats two different values for one name as missing", () => {
    const html = `${weeklyAdHtml()}<script>{"apimProgramSubscriptionKey":"ffffffffffffffffffffffffffffffff"}</script>`;
    expect(extractConfig(html).key).toBeNull();
  });
});

describe("analyzeSearch", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("counts HTTP 200 JSON with a priced product", () => {
    const result = analyzeSearch({ status: 200, contentType: "application/json", body: bytes(searchJson([{ id: "1", price: 3.49 }])) });
    expect(result).toMatchObject({ json: true, count: 1, numFound: 1, priced: 1, counts: true });
  });

  it("does not count a non-200, non-JSON, unparsable or unpriced response", () => {
    const good = searchJson([{ id: "1", price: 3.49 }]);
    expect(analyzeSearch({ status: 403, contentType: "application/json", body: bytes(good) }).counts).toBe(false);
    expect(analyzeSearch({ status: null, contentType: "", body: new Uint8Array() }).counts).toBe(false);
    expect(analyzeSearch({ status: 200, contentType: "text/html", body: bytes(good) }).counts).toBe(false);
    expect(analyzeSearch({ status: 200, contentType: "application/json", body: bytes("<html>") }).counts).toBe(false);
    const unpriced = analyzeSearch({ status: 200, contentType: "application/json", body: bytes(searchJson([{ id: "1", price: null }])) });
    expect(unpriced).toMatchObject({ json: true, count: 1, priced: 0, counts: false });
    const empty = analyzeSearch({ status: 200, contentType: "application/json", body: bytes(searchJson([])) });
    expect(empty).toMatchObject({ count: 0, counts: false });
  });

  it("does not count a response that names a different store", () => {
    const other = searchJson([{ id: "1", price: 3.49 }], { storeId: "1234" });
    const result = analyzeSearch({ status: 200, contentType: "application/json", body: bytes(other) });
    expect(result.storeIds).toEqual(["1234"]);
    expect(result.counts).toBe(false);
    const same = searchJson([{ id: "1", price: 3.49 }], { storeId: 2980 });
    expect(analyzeSearch({ status: 200, contentType: "application/json", body: bytes(same) })).toMatchObject({ storeIds: ["2980"], counts: true });
  });
});

describe("feasibility", () => {
  const result = (mode: string, counts: boolean) => ({ mode, counts });

  it("needs at least 2 of 3 queries to count in pickup mode", () => {
    expect(feasibility([result("pickup", true), result("pickup", true), result("pickup", false)])).toEqual({ met: 2, needed: 2, feasible: true });
    expect(feasibility([result("pickup", true), result("pickup", false), result("pickup", false)])).toMatchObject({ met: 1, feasible: false });
  });

  it("ignores in-store results", () => {
    const results = [result("instore", true), result("instore", true), result("instore", true), result("pickup", true)];
    expect(feasibility(results)).toMatchObject({ met: 1, feasible: false });
  });
});

describe("comparePrices", () => {
  const product = (id: string, price: number, basePrice = price) => ({ id, name: `p${id}`, price, basePrice });

  it("reports shared products whose prices differ between modes", () => {
    const result = comparePrices([product("1", 1.99), product("2", 2.49), product("3", 5)], [product("1", 1.99), product("2", 2.79), product("4", 9)]);
    expect(result.shared).toBe(2);
    expect(result.differing).toHaveLength(1);
    expect(result.differing[0]).toMatchObject({ id: "2" });
    expect(result.differing[0]?.instore).toContain("2.49");
    expect(result.differing[0]?.pickup).toContain("2.79");
  });

  it("treats any price field difference as a difference, and equal prices as none", () => {
    expect(comparePrices([product("1", 1.99, 2.49)], [product("1", 1.99, 2.99)]).differing).toHaveLength(1);
    expect(comparePrices([product("1", 1.99)], [product("1", 1.99)])).toEqual({ shared: 1, differing: [] });
    expect(comparePrices([product("1", 1.99)], [product("2", 1.99)])).toEqual({ shared: 0, differing: [] });
  });
});

describe("key redaction helpers", () => {
  it("redacts every occurrence of the key", () => {
    expect(redact(`a ${KEY} b ${KEY}`, KEY)).toBe("a [redacted] b [redacted]");
    expect(redact("nothing", null)).toBe("nothing");
  });

  it("names every output or file that contains the key", () => {
    expect(findKeyLeaks(KEY, "clean", [{ name: "a.json", bytes: new TextEncoder().encode("{}") }])).toEqual([]);
    const leaks = findKeyLeaks(KEY, `x${KEY}`, [{ name: "a.json", bytes: new TextEncoder().encode(`{"k":"${KEY}"}`) }]);
    expect(leaks).toEqual(["printed output", "a.json"]);
  });
});

describe("runProbe evidence for the channel and store (review N2, N3)", () => {
  it("prints the response's top-level fields, any echoed channel values and how many counting responses echoed store 2980", async () => {
    const site = fakeSite({
      search: (url) => json(searchJson([{ id: "970000001", price: 1.99 }],
        url.searchParams.get("channel") === "pickup" ? { storeId: "2980", channel: "pickup" } : {})),
    });
    const { output, lines } = await run(site.fetcher);
    expect(output).toMatch(/response fields: appCode, response, storeId, channel/);
    expect(output).toMatch(/pickup "gala apples":.*channel echoed pickup/);
    expect(output).toMatch(/instore "gala apples":.*channel not echoed/);
    expect(output).toContain("criterion: 3/3 pickup queries returned HTTP 200 JSON with store-scoped prices (need 2); 3 of them echoed store 2980");
    expect(lines.at(-1)).toBe("FEASIBLE");
  });

  it("says whether the pickup mode was echoed by the response", async () => {
    const echoing = fakeSite({
      search: (url) => json(searchJson([{ id: "970000001", price: 1.99 }], { storeId: "2980", channel: url.searchParams.get("channel") ?? "" })),
    });
    expect((await run(echoing.fetcher)).output).toContain("pickup mode: echoed by the response");
    const silent = fakeSite();
    expect((await run(silent.fetcher)).output).toContain("pickup mode: not confirmed by the response");
  });

  it("hints that the pickup parameter may be wrong when in-store searches count but pickup ones do not", async () => {
    const site = fakeSite({
      search: (url) => (url.searchParams.get("channel") === "pickup"
        ? json('{"error":"bad channel"}', 400)
        : json(searchJson([{ id: "970000001", price: 1.99 }], { storeId: "2980" }))),
    });
    const { output, lines } = await run(site.fetcher);
    expect(output).toContain("hint: in-store searches counted but fewer than 2 pickup searches did; the pickup parameter value may be wrong");
    expect(lines.at(-1)).toBe("NOT FEASIBLE");
  });

  it("says so when no counting response echoed the store", async () => {
    const site = fakeSite({ search: () => json(searchJson([{ id: "970000001", price: 1.99 }])) });
    const { output } = await run(site.fetcher);
    expect(output).toContain("(need 2); 0 of them echoed store 2980 (store scope not confirmed by the response)");
  });
});

describe("runProbe", () => {
  it("prints a feasible summary and saves only the six search bodies", async () => {
    const site = fakeSite();
    const { code, output, lines, auditRoot } = await run(site.fetcher);

    expect(code).toBe(0);
    expect(lines.at(-1)).toBe("FEASIBLE");
    expect(output).toContain("HTTP 200");
    expect(output).toContain("application/json");
    expect(output).toMatch(/\d+ ms/);
    expect(output).toContain("keyFound: true");
    expect(output).toContain("keyLength: 32");
    expect(output).toMatch(/products 2/);
    // One product's top-level field names and its ID/name/price/unit/size fields.
    expect(output).toContain("id, pid, name, price, basePrice, pricePer, unitOfMeasure, itemSizeQty, aisleName");
    expect(output).toContain(
      "product sample: id=970000001; pid=970000001; name=Synthetic product 970000001; price=1.99; basePrice=1.99; pricePer=1.99; unitOfMeasure=LB; itemSizeQty=1",
    );
    expect(output).toContain("modePricesDiffer: no");
    expect(output).not.toContain(KEY);

    const files = savedFiles(auditRoot);
    expect(files).toHaveLength(MAX_SEARCH_REQUESTS);
    expect(readdirSync(auditRoot)).toEqual(["safeway-probe-2026-09-28T20-00-00-000Z"]);
    for (const file of files) {
      expect(file.text).not.toContain("WEEKLY-AD-HTML-MARKER");
      expect(file.text).not.toContain(KEY);
    }
  });

  it("requests only https://www.safeway.com, without following redirects", async () => {
    const site = fakeSite();
    await run(site.fetcher);
    expect(site.calls.length).toBe(1 + MAX_SEARCH_REQUESTS);
    for (const call of site.calls) {
      expect(new URL(call.url).origin).toBe(ORIGIN);
      expect(call.redirect).toBe("manual");
    }
    expect(new URL(site.calls[0]!.url).pathname).toBe("/weeklyad");
  });

  it("sends each query in both modes to store 2980 with the documented parameters", async () => {
    const site = fakeSite();
    await run(site.fetcher);
    const seen = searchCalls(site.calls).map((call) => {
      const url = new URL(call.url);
      expect(url.pathname).toBe(SEARCH_PATH);
      expect(url.searchParams.get("storeid")).toBe("2980");
      expect(url.searchParams.get("search-type")).toBe("keyword");
      expect(url.searchParams.get("banner")).toBe("safeway");
      expect(url.searchParams.get("request-id")).toMatch(/^\d+$/);
      expect(url.searchParams.get("rows")).toMatch(/^\d+$/);
      expect(url.searchParams.get("start")).toBe("0");
      return `${url.searchParams.get("q")}|${url.searchParams.get("channel")}`;
    });
    expect(seen.sort()).toEqual(QUERIES.flatMap((query) => MODES.map((mode) => `${query}|${mode.channel}`)).sort());
    expect(MODES.map((mode) => mode.channel)).toEqual(["instore", "pickup"]);
  });

  it("sends the key only in the ocp-apim-subscription-key header, never in a URL", async () => {
    const site = fakeSite();
    await run(site.fetcher);
    const [adCall, ...searches] = site.calls;
    expect(adCall!.headers.get("ocp-apim-subscription-key")).toBeNull();
    for (const call of site.calls) expect(decodeURIComponent(call.url)).not.toContain(KEY);
    for (const call of searches) {
      expect(call.headers.get("ocp-apim-subscription-key")).toBe(KEY);
      const others = [...call.headers.entries()].filter(([name]) => name !== "ocp-apim-subscription-key");
      for (const [, value] of others) expect(value).not.toContain(KEY);
    }
  });

  it("reports a search host other than www.safeway.com and never requests it", async () => {
    const site = fakeSite({ html: weeklyAdHtml({ searchPath: "https://api.example.com/abs/pub/xapi" }) });
    const { code, output, lines, auditRoot } = await run(site.fetcher);
    expect(site.calls).toHaveLength(1);
    expect(output).toContain("api.example.com");
    expect(output).toContain("not requested");
    expect(lines.at(-1)).toBe("NOT FEASIBLE");
    expect(code).toBe(1);
    expect(savedFiles(auditRoot)).toEqual([]);
  });

  it("reports a protocol-relative search host and never requests it", async () => {
    const site = fakeSite({ html: weeklyAdHtml({ searchPath: "//api.example.com/abs/pub/xapi" }) });
    const { code, output } = await run(site.fetcher);
    expect(site.calls).toHaveLength(1);
    expect(output).toContain("api.example.com");
    expect(code).toBe(1);
  });

  it("does not follow a search redirect to another host", async () => {
    const site = fakeSite({
      search: () => new Response(null, { status: 302, headers: { location: "https://captcha.example.net/challenge" } }),
    });
    const { code, output } = await run(site.fetcher);
    expect(site.calls).toHaveLength(1 + MAX_SEARCH_REQUESTS);
    for (const call of site.calls) expect(new URL(call.url).origin).toBe(ORIGIN);
    expect(output).toContain("HTTP 302");
    expect(output).toContain("captcha.example.net");
    expect(code).toBe(1);
  });

  it("stops before searching when the config is missing, and reports keyFound false", async () => {
    const site = fakeSite({ html: "<html>no config</html>" });
    const { code, output, lines } = await run(site.fetcher);
    expect(site.calls).toHaveLength(1);
    expect(output).toContain("keyFound: false");
    expect(output).toContain("keyLength: 0");
    expect(output).toContain("apimProgramSubscriptionKey");
    expect(lines.at(-1)).toBe("NOT FEASIBLE");
    expect(code).toBe(1);
  });

  it("is NOT FEASIBLE when only in-store mode returns prices", async () => {
    const site = fakeSite({
      search: (url) =>
        url.searchParams.get("channel") === "pickup"
          ? new Response("<html>Access denied</html>", { status: 403, headers: { "content-type": "text/html" } })
          : defaultSearch(url, new Headers()),
    });
    const { code, output, lines } = await run(site.fetcher);
    expect(output).toContain("HTTP 403");
    expect(output).toContain("text/html");
    expect(output).toMatch(/pickup "bananas": HTTP 403, \d+ ms, text\/html, \d+ bytes -> not counted: HTTP 403/);
    expect(lines.at(-1)).toBe("NOT FEASIBLE");
    expect(code).toBe(1);
  });

  it("is FEASIBLE when exactly 2 of 3 pickup queries return prices", async () => {
    const site = fakeSite({
      search: (url) =>
        url.searchParams.get("q") === "bananas"
          ? json(searchJson([]))
          : defaultSearch(url, new Headers()),
    });
    const { code, lines } = await run(site.fetcher);
    expect(lines.at(-1)).toBe("FEASIBLE");
    expect(code).toBe(0);
  });

  it("reports when a shared product is priced differently between modes", async () => {
    const site = fakeSite({
      search: (url) => {
        const pickup = url.searchParams.get("channel") === "pickup";
        return json(searchJson([{ id: "970000001", price: pickup ? 2.29 : 1.99 }, { id: "970000002", price: 2.49 }]));
      },
    });
    const { output } = await run(site.fetcher);
    expect(output).toContain("modePricesDiffer: yes");
    expect(output).toMatch(/"gala apples" id 970000001: instore .*price=1\.99.* \| pickup .*price=2\.29/);
  });

  it("never lets the key reach the summary, saved files or errors", async () => {
    let n = 0;
    const site = fakeSite({
      search: (url, headers) => {
        n += 1;
        const key = headers.get("ocp-apim-subscription-key");
        if (n === 2) throw new Error(`socket hang up; header was ${key}`);
        if (n === 3) throw new TypeError("fetch failed", { cause: Object.assign(new Error(`connect refused ${key}`), { code: "ECONNREFUSED" }) });
        return defaultSearch(url, headers);
      },
    });
    const { output, auditRoot } = await run(site.fetcher);
    expect(output).toContain("socket hang up; header was [redacted]");
    expect(output).toContain("ECONNREFUSED");
    expect(output).not.toContain(KEY);
    const files = savedFiles(auditRoot);
    expect(files).toHaveLength(MAX_SEARCH_REQUESTS - 2);
    for (const file of files) expect(file.text).not.toContain(KEY);
  });

  it("aborts with exit code 2, saving and printing nothing else, when a response echoes the key", async () => {
    const site = fakeSite({
      search: (url, headers) =>
        url.searchParams.get("q") === "bananas"
          ? json(JSON.stringify({ error: `invalid subscription key ${headers.get("ocp-apim-subscription-key")}` }), 401)
          : defaultSearch(url, headers),
    });
    const { code, output, auditRoot } = await run(site.fetcher);
    expect(code).toBe(2);
    expect(output).toContain("SELF-CHECK FAILED");
    expect(output).not.toContain(KEY);
    expect(output).not.toContain("FEASIBLE\n");
    expect(savedFiles(auditRoot)).toEqual([]);
    expect(existsSync(join(auditRoot, "safeway-probe-2026-09-28T20-00-00-000Z"))).toBe(false);
  });

  it("caps searches at 6, waits 1 s before each request and never retries a failure", async () => {
    const site = fakeSite({ search: () => new Response("busy", { status: 503, headers: { "content-type": "text/plain" } }) });
    const { code, sleep, lines } = await run(site.fetcher);
    expect(MAX_SEARCH_REQUESTS).toBe(6);
    expect(searchCalls(site.calls)).toHaveLength(6);
    expect(new Set(searchCalls(site.calls).map((call) => call.url.replace(/request-id=\d+/, ""))).size).toBe(6);
    expect(sleep).toHaveBeenCalledTimes(6);
    for (const [ms] of sleep.mock.calls) expect(ms).toBe(REQUEST_GAP_MS);
    expect(REQUEST_GAP_MS).toBe(1000);
    expect(lines.at(-1)).toBe("NOT FEASIBLE");
    expect(code).toBe(1);
  });

  it("does not retry after a thrown error", async () => {
    const site = fakeSite({ search: () => { throw new TypeError("fetch failed"); } });
    const { code, output } = await run(site.fetcher);
    expect(searchCalls(site.calls)).toHaveLength(6);
    expect(output).toContain("fetch failed");
    expect(code).toBe(1);
  });

  it("times each request out after 15 s and moves on without retrying", async () => {
    vi.useFakeTimers();
    const site = fakeSite({
      search: () => new Promise<Response>(() => undefined),
    });
    const pending = run(site.fetcher);
    await vi.advanceTimersByTimeAsync(6 * 15_000 + 1_000);
    const { code, output } = await pending;
    expect(searchCalls(site.calls)).toHaveLength(6);
    expect(output.match(/timed out after 15 s/g)).toHaveLength(6);
    expect(code).toBe(1);
  });

  it("does not time out a request that answers within 15 s", async () => {
    vi.useFakeTimers();
    const site = fakeSite({
      search: (url, headers) => new Promise<Response>((resolve) => setTimeout(() => resolve(defaultSearch(url, headers)), 14_000)),
    });
    const pending = run(site.fetcher);
    await vi.advanceTimersByTimeAsync(6 * 14_000 + 1_000);
    const { code, output } = await pending;
    expect(output).not.toContain("timed out");
    expect(code).toBe(0);
  });
});
