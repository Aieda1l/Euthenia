import type { Rational } from "./contracts.js";

// Money is parsed digit-wise and exact arithmetic uses BigInt rationals.
// Rationals persist as reduced integer strings with a positive denominator;
// a native BigInt is never stored or serialized. Number conversion is only for
// rounded display, which is outside this module.

const CENTS_TEXT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const DECIMAL_TEXT = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const INTEGER_TEXT = /^-?(0|[1-9]\d*)$/;

/**
 * Parses a nonnegative USD amount with at most two decimals into integer cents.
 * Anything else (empty, negative, symbols, separators, exponents, surrounding
 * whitespace, over-precision or unsafe magnitudes) is unknown: null, never 0.
 */
export function usdCents(text: string | null): number | null {
  if (text === null) return null;
  const match = CENTS_TEXT.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100n + fraction;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

// 1 lb = 0.45359237 kg exactly, so 1 kg = 100000000/45359237 lb; 16 oz = 1 lb.
const POUNDS_PER_UNIT: Record<"lb" | "oz" | "kg", [bigint, bigint]> = {
  lb: [1n, 1n],
  oz: [1n, 16n],
  kg: [100_000_000n, 45_359_237n],
};

/** Converts a nonnegative decimal amount of lb/oz/kg into exact pounds. */
export function pounds(amount: string, unit: "lb" | "oz" | "kg"): Rational {
  const match = DECIMAL_TEXT.exec(amount);
  if (!match) throw new Error(`pounds: invalid amount ${JSON.stringify(amount)}`);
  const fraction = match[2] ?? "";
  const numerator = BigInt((match[1] ?? "0") + fraction);
  const denominator = 10n ** BigInt(fraction.length);
  const [perN, perD] = POUNDS_PER_UNIT[unit];
  return makeRational(numerator * perN, denominator * perD);
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`rational: ${value} is not a safe integer`);
    return BigInt(value);
  }
  // BigInt() alone would accept whitespace, hex and binary literals.
  if (!INTEGER_TEXT.test(value)) throw new Error(`rational: ${JSON.stringify(value)} is not an integer string`);
  return BigInt(value);
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function fromParts(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new Error("rational: zero denominator");
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d) || 1n;
  return { n: String((sign * n) / divisor), d: String((sign * d) / divisor) };
}

function parts(r: Rational): [bigint, bigint] {
  return [toBigInt(r.n), toBigInt(r.d)];
}

/** Builds a reduced rational with a positive denominator. */
export function makeRational(n: bigint | number | string, d: bigint | number | string = 1n): Rational {
  return fromParts(toBigInt(n), toBigInt(d));
}

/** Validates integer strings and returns the reduced, positive-denominator form. */
export function reduceRational(r: Rational): Rational {
  const [n, d] = parts(r);
  return fromParts(n, d);
}

/** True for a persisted rational: integer strings with a positive denominator. */
export function isRational(value: unknown): value is Rational {
  if (typeof value !== "object" || value === null) return false;
  const { n, d } = value as { n?: unknown; d?: unknown };
  return typeof n === "string" && typeof d === "string" &&
    INTEGER_TEXT.test(n) && INTEGER_TEXT.test(d) && BigInt(d) > 0n;
}

export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const [an, ad] = parts(reduceRational(a));
  const [bn, bd] = parts(reduceRational(b));
  const left = an * bd;
  const right = bn * ad;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  const [an, ad] = parts(a);
  const [bn, bd] = parts(b);
  return fromParts(an * bn, ad * bd);
}

export function divideRational(a: Rational, b: Rational): Rational {
  const [an, ad] = parts(a);
  const [bn, bd] = parts(b);
  if (bn === 0n) throw new Error("rational: division by zero");
  return fromParts(an * bd, ad * bn);
}

/** Exact integer-string form: "n" when whole, otherwise "n/d". */
export function rationalToString(r: Rational): string {
  const reduced = reduceRational(r);
  return reduced.d === "1" ? reduced.n : `${reduced.n}/${reduced.d}`;
}
