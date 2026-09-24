import { describe, expect, it } from "vitest";
import {
  compareRational,
  divideRational,
  isRational,
  makeRational,
  multiplyRational,
  pounds,
  rationalToString,
  reduceRational,
  usdCents,
} from "../../src/shared/money.js";

describe("usdCents", () => {
  it("matches the plan's assertions", () => {
    expect(usdCents("1.77")).toBe(177);
    expect(usdCents("")).toBeNull();
    expect(usdCents("-1.00")).toBeNull();
    expect(usdCents("1.234")).toBeNull();
    expect(usdCents("0.00")).toBe(0);
  });

  it("parses one-decimal and whole-dollar source strings digit-wise", () => {
    expect(usdCents("5.0")).toBe(500);
    expect(usdCents("7.99")).toBe(799);
    expect(usdCents("14")).toBe(1400);
    expect(usdCents("0.5")).toBe(50);
  });

  it("keeps missing distinct from zero", () => {
    expect(usdCents(null)).toBeNull();
    expect(usdCents("0")).toBe(0);
  });

  it.each(["$1.00", "1.", ".50", "1,000.00", " 1.00", "1.00 ", "NaN", "Infinity", "1e2", "01.00", "+1.00", "0x10"])(
    "rejects non-canonical text %j",
    (text) => {
      expect(usdCents(text)).toBeNull();
    },
  );

  it("rejects amounts beyond the safe integer range", () => {
    expect(usdCents("90071992547409.92")).toBeNull();
    expect(usdCents("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("pounds", () => {
  it("matches the plan's assertions", () => {
    expect(pounds("16", "oz")).toEqual({ n: "1", d: "1" });
    expect(pounds("1", "kg")).toEqual({ n: "100000000", d: "45359237" });
  });

  it("converts decimal amounts exactly", () => {
    expect(pounds("3", "lb")).toEqual({ n: "3", d: "1" });
    expect(pounds("1.5", "lb")).toEqual({ n: "3", d: "2" });
    expect(pounds("8", "oz")).toEqual({ n: "1", d: "2" });
    expect(pounds("0.5", "kg")).toEqual({ n: "50000000", d: "45359237" });
  });

  it.each(["", "-1", "abc", "1.2.3", " 1", "1e3"])("throws for invalid amount %j", (amount) => {
    expect(() => pounds(amount, "lb")).toThrow();
  });
});

describe("rational helpers", () => {
  it("reduces with a positive denominator", () => {
    expect(makeRational(6n, 4n)).toEqual({ n: "3", d: "2" });
    expect(makeRational(3, -6)).toEqual({ n: "-1", d: "2" });
    expect(makeRational("0", "7")).toEqual({ n: "0", d: "1" });
    expect(reduceRational({ n: "10", d: "-4" })).toEqual({ n: "-5", d: "2" });
  });

  it("rejects zero denominators and non-integer strings", () => {
    expect(() => makeRational(1n, 0n)).toThrow();
    expect(() => reduceRational({ n: "1.5", d: "1" })).toThrow();
    expect(() => reduceRational({ n: " 12", d: "1" })).toThrow();
    expect(() => reduceRational({ n: "0x10", d: "1" })).toThrow();
    expect(() => makeRational(1.5)).toThrow();
  });

  it("validates persisted shapes without throwing", () => {
    expect(isRational({ n: "499", d: "1" })).toBe(true);
    expect(isRational({ n: "1", d: "0" })).toBe(false);
    expect(isRational({ n: "1", d: "-2" })).toBe(false);
    expect(isRational({ n: 1, d: "1" })).toBe(false);
    expect(isRational(null)).toBe(false);
  });

  it("compares, multiplies and divides exactly", () => {
    expect(compareRational({ n: "1", d: "3" }, { n: "333333", d: "1000000" })).toBe(1);
    expect(compareRational({ n: "2", d: "4" }, { n: "1", d: "2" })).toBe(0);
    expect(compareRational({ n: "-1", d: "2" }, { n: "0", d: "1" })).toBe(-1);
    expect(multiplyRational({ n: "499", d: "1" }, { n: "3", d: "1" })).toEqual({ n: "1497", d: "1" });
    expect(divideRational({ n: "500", d: "1" }, { n: "2", d: "1" })).toEqual({ n: "250", d: "1" });
    expect(divideRational({ n: "500", d: "1" }, { n: "3", d: "1" })).toEqual({ n: "500", d: "3" });
    expect(() => divideRational({ n: "1", d: "1" }, { n: "0", d: "1" })).toThrow();
  });

  it("handles values beyond Number precision", () => {
    const big = makeRational(2n ** 80n, 3n);
    expect(big).toEqual({ n: "1208925819614629174706176", d: "3" });
    expect(multiplyRational(big, { n: "3", d: "1" })).toEqual({ n: "1208925819614629174706176", d: "1" });
  });

  it("formats as integer strings and serializes without BigInt", () => {
    expect(rationalToString({ n: "499", d: "1" })).toBe("499");
    expect(rationalToString({ n: "500", d: "3" })).toBe("500/3");
    expect(JSON.stringify(makeRational(1n, 2n))).toBe('{"n":"1","d":"2"}');
  });
});
