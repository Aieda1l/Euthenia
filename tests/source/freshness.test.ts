import { describe, expect, it } from "vitest";
import {
  freshness,
  isLocalTime,
  verifiedLocalDateWindow,
} from "../../src/shared/freshness.js";

const NOW = new Date("2026-09-24T19:00:00.000Z");
const HOUR = 3_600_000;

function row(overrides: { observedAt?: string; startsAt?: string | null; expiresAt?: string | null } = {}) {
  return {
    observedAt: "2026-09-24T12:00:00.000Z",
    startsAt: "2026-09-23T07:00:00.000Z",
    expiresAt: "2026-09-30T07:00:00.000Z",
    ...overrides,
  };
}

describe("freshness (R8)", () => {
  it("is fresh at exactly 24 hours since observation", () => {
    const observedAt = new Date(NOW.getTime() - 24 * HOUR).toISOString();
    expect(freshness(row({ observedAt }), NOW)).toBe("fresh");
  });

  it("is stale at 24 hours plus 1 ms", () => {
    const observedAt = new Date(NOW.getTime() - 24 * HOUR - 1).toISOString();
    expect(freshness(row({ observedAt }), NOW)).toBe("stale");
  });

  it("is upcoming when the start is in the future", () => {
    expect(freshness(row({ startsAt: "2026-09-24T19:00:00.001Z" }), NOW)).toBe("upcoming");
    expect(freshness(row({ startsAt: "2026-09-24T19:00:00.000Z" }), NOW)).toBe("fresh");
  });

  it("is expired when expiresAt equals now (exclusive end)", () => {
    expect(freshness(row({ expiresAt: NOW.toISOString() }), NOW)).toBe("expired");
    expect(freshness(row({ expiresAt: "2026-09-24T19:00:00.001Z" }), NOW)).toBe("fresh");
  });

  it("uses precedence expired > upcoming > stale > fresh", () => {
    const old = "2026-09-20T00:00:00.000Z";
    expect(freshness(row({ observedAt: old, startsAt: "2026-09-25T00:00:00.000Z", expiresAt: "2026-09-24T00:00:00.000Z" }), NOW)).toBe("expired");
    expect(freshness(row({ observedAt: old, startsAt: "2026-09-25T00:00:00.000Z" }), NOW)).toBe("upcoming");
    expect(freshness(row({ observedAt: old }), NOW)).toBe("stale");
  });

  it("missing dates never make an offer expired or upcoming", () => {
    expect(freshness(row({ startsAt: null, expiresAt: null }), NOW)).toBe("fresh");
    expect(freshness(row({ startsAt: null, expiresAt: null, observedAt: "2026-09-20T00:00:00.000Z" }), NOW)).toBe("stale");
  });

  it("treats unparseable timestamps conservatively", () => {
    expect(freshness(row({ observedAt: "not a date" }), NOW)).toBe("stale");
    expect(freshness(row({ expiresAt: "not a date" }), NOW)).toBe("expired");
    expect(freshness(row({ startsAt: "not a date" }), NOW)).toBe("upcoming");
  });
});

describe("isLocalTime (amended R8/R9)", () => {
  it.each(["00:00", "07:00", "23:59", "12:30"])("accepts %j", (value) => {
    expect(isLocalTime(value)).toBe(true);
  });

  it.each(["24:00", "7:00", "07:60", "07:00:00", " 07:00", "07:00 ", "0700", "", "7 a.m.", null, 700])(
    "rejects %j",
    (value) => {
      expect(isLocalTime(value)).toBe(false);
    },
  );
});

describe("verified-local-date conversion (amended R8)", () => {
  it("starts at local midnight for 00:00 and ends at the next local midnight after valid_to", () => {
    expect(verifiedLocalDateWindow("2026-09-23T00:00:00-04:00", "2026-09-29T23:59:59-04:00", "00:00")).toEqual({
      startsAt: "2026-09-23T07:00:00.000Z",
      expiresAt: "2026-09-30T07:00:00.000Z",
    });
  });

  it("uses the attested printed start time in America/Los_Angeles", () => {
    expect(verifiedLocalDateWindow("2026-09-23T00:00:00-04:00", "2026-09-29T23:59:59-04:00", "07:00")).toEqual({
      startsAt: "2026-09-23T14:00:00.000Z",
      expiresAt: "2026-09-30T07:00:00.000Z",
    });
  });

  it("crosses the November DST boundary correctly", () => {
    expect(verifiedLocalDateWindow("2026-10-28T00:00:00-04:00", "2026-11-01T23:59:59-05:00", "00:00")).toEqual({
      startsAt: "2026-10-28T07:00:00.000Z",
      expiresAt: "2026-11-02T08:00:00.000Z",
    });
  });

  it("crosses the March DST boundary correctly", () => {
    expect(verifiedLocalDateWindow("2027-03-10T00:00:00-05:00", "2027-03-16T23:59:59-04:00", "00:00")).toEqual({
      startsAt: "2027-03-10T08:00:00.000Z",
      expiresAt: "2027-03-17T07:00:00.000Z",
    });
  });

  it("rejects a start time that does not exist on a spring-forward day", () => {
    expect(verifiedLocalDateWindow("2027-03-14T00:00:00-05:00", "2027-03-20T23:59:59-04:00", "02:30")).toMatchObject({
      issue: expect.stringMatching(/does not exist|ambiguous/),
    });
  });

  it("reports contradictory validity", () => {
    expect(verifiedLocalDateWindow("2026-09-23T00:00:00-04:00", "2026-09-22T23:59:59-04:00", "00:00")).toMatchObject({
      issue: expect.stringMatching(/contradictory/),
    });
  });

  it("reports missing or malformed dates and start times", () => {
    expect(verifiedLocalDateWindow(null, "2026-09-29T23:59:59-04:00", "00:00")).toMatchObject({ issue: expect.any(String) });
    expect(verifiedLocalDateWindow("2026-09-23T00:00:00-04:00", "", "00:00")).toMatchObject({ issue: expect.any(String) });
    expect(verifiedLocalDateWindow("2026-02-30T00:00:00-04:00", "2026-03-02T00:00:00-04:00", "00:00")).toMatchObject({ issue: expect.any(String) });
    expect(verifiedLocalDateWindow("2026-09-23T00:00:00-04:00", "2026-09-29T23:59:59-04:00", "7:00")).toMatchObject({ issue: expect.stringMatching(/startLocalTime/) });
    expect(verifiedLocalDateWindow("2026-09-23T00:00:00-04:00", "2026-09-29T23:59:59-04:00", undefined)).toMatchObject({ issue: expect.stringMatching(/startLocalTime/) });
  });

  it("an attested 07:00 start is upcoming until 14:00Z and fresh from then", () => {
    const window = verifiedLocalDateWindow("2026-09-23T00:00:00-04:00", "2026-09-29T23:59:59-04:00", "07:00");
    if (!("startsAt" in window)) throw new Error(window.issue);
    const offer = { observedAt: "2026-09-23T12:00:00.000Z", ...window };
    expect(freshness(offer, new Date("2026-09-23T13:59:59.999Z"))).toBe("upcoming");
    expect(freshness(offer, new Date("2026-09-23T14:00:00.000Z"))).toBe("fresh");
  });
});
