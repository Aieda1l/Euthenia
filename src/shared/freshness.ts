import type { Freshness, Offer } from "./contracts.js";

// Calendar and freshness semantics (addendum R8, amended 2026-09-24).
//
// verified-local-date: a human attested that this flyer's printed dates are
// Seattle-local. startsAt is the attested printed start time (startLocalTime,
// 24-hour HH:MM) in America/Los_Angeles on the date part of valid_from.
// expiresAt is the next Los Angeles midnight after the date part of valid_to,
// so the through-date is inclusive and expiresAt is exclusive. The raw -04:00
// offsets Flipp sends are never trusted as Seattle time; only their date parts
// are used, and the raw strings stay in Evidence.rawValidity.

export const SEATTLE_TIME_ZONE = "America/Los_Angeles";
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/;
const DAY_MS = 24 * 60 * 60 * 1000;
// A8: timestamps are strict ISO 8601 date-times with Z or an explicit +-hh:mm
// offset. Date.parse alone accepts "1", date-only and offset-less local times.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
// A8: a verified-local-date flyer's raw validity must be a whole printed day
// range: valid_from at T00:00:00 and valid_to at T23:59:59, each with an
// explicit +-hh:mm offset (Flipp sends -04:00 for Seattle queries).
const RAW_DAY_START = /^\d{4}-\d{2}-\d{2}T00:00:00[+-](?:[01]\d|2[0-3]):[0-5]\d$/;
const RAW_DAY_END = /^\d{4}-\d{2}-\d{2}T23:59:59[+-](?:[01]\d|2[0-3]):[0-5]\d$/;

/** Strict 24-hour "HH:MM" (00:00-23:59). */
export function isLocalTime(value: unknown): value is string {
  return typeof value === "string" && LOCAL_TIME.test(value);
}

/** The real calendar date in the leading YYYY-MM-DD of a raw string, or null. */
export function calendarDate(raw: unknown): { y: number; m: number; d: number } | null {
  if (typeof raw !== "string") return null;
  const match = DATE_PART.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Epoch ms of a strict ISO 8601 timestamp with Z or an offset (A8), else null. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || calendarDate(value) === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** True for a strict ISO 8601 timestamp with Z or an explicit offset (A8). */
export function isTimestamp(value: unknown): value is string {
  return parseTimestamp(value) !== null;
}

const seattleParts = new Intl.DateTimeFormat("en-US", {
  timeZone: SEATTLE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Seattle wall-clock time at an instant, expressed as a UTC-epoch "wall" value. */
function seattleWallMs(instantMs: number): number {
  const values: Record<string, number> = {};
  for (const part of seattleParts.formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return Date.UTC(values.year ?? 0, (values.month ?? 1) - 1, values.day ?? 1,
    values.hour ?? 0, values.minute ?? 0, values.second ?? 0);
}

/**
 * Converts a Seattle wall-clock time to an instant. Returns null when the wall
 * time does not exist (spring-forward gap) or is ambiguous (fall-back overlap).
 */
function seattleWallToInstant(wallMs: number): number | null {
  const candidates = new Set<number>();
  for (const probe of [wallMs - DAY_MS, wallMs + DAY_MS]) {
    const offset = seattleWallMs(probe) - probe;
    const instant = wallMs - offset;
    if (seattleWallMs(instant) === wallMs) candidates.add(instant);
  }
  return candidates.size === 1 ? [...candidates][0] ?? null : null;
}

/**
 * startsAt/expiresAt for an attested verified-local-date flyer, or an issue
 * explaining why the calendar must stay unknown.
 */
export function verifiedLocalDateWindow(
  validFrom: unknown,
  validTo: unknown,
  startLocalTime: unknown,
): { startsAt: string; expiresAt: string } | { issue: string } {
  if (!isLocalTime(startLocalTime)) {
    return { issue: "verified-local-date requires an attested startLocalTime in 24-hour HH:MM" };
  }
  if (typeof validFrom !== "string" || !RAW_DAY_START.test(validFrom)) {
    return { issue: `valid_from ${JSON.stringify(validFrom ?? null)} is not a date with a T00:00:00 time part and an explicit +-hh:mm offset` };
  }
  if (typeof validTo !== "string" || !RAW_DAY_END.test(validTo)) {
    return { issue: `valid_to ${JSON.stringify(validTo ?? null)} is not a date with a T23:59:59 time part and an explicit +-hh:mm offset` };
  }
  const from = calendarDate(validFrom);
  const to = calendarDate(validTo);
  if (!from) return { issue: "valid_from has no real calendar date" };
  if (!to) return { issue: "valid_to has no real calendar date" };
  const [hours, minutes] = startLocalTime.split(":").map(Number) as [number, number];
  const start = seattleWallToInstant(Date.UTC(from.y, from.m - 1, from.d, hours, minutes));
  if (start === null) {
    return { issue: `startLocalTime ${startLocalTime} does not exist or is ambiguous in ${SEATTLE_TIME_ZONE} on the valid_from date` };
  }
  const end = seattleWallToInstant(Date.UTC(to.y, to.m - 1, to.d + 1));
  if (end === null) return { issue: `the local midnight after valid_to is not a single instant in ${SEATTLE_TIME_ZONE}` };
  if (start >= end) return { issue: "contradictory validity: start is not before the exclusive end" };
  return { startsAt: new Date(start).toISOString(), expiresAt: new Date(end).toISOString() };
}

/**
 * Freshness at `now` (R8). Precedence: expired > upcoming > stale > fresh.
 * expiresAt is exclusive; exactly 24h since observation is still fresh.
 * Missing dates never make an offer expired or upcoming. Timestamps that are
 * not strict ISO 8601 (A8) are treated conservatively (never fresh). An
 * invalid `now` is a caller error and throws.
 */
export function freshness(offer: Pick<Offer, "observedAt" | "startsAt" | "expiresAt">, now: Date): Freshness {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (Number.isNaN(nowMs)) throw new Error("freshness: now must be a valid Date");
  if (offer.expiresAt !== null) {
    const expires = parseTimestamp(offer.expiresAt);
    if (expires === null || expires <= nowMs) return "expired";
  }
  if (offer.startsAt !== null) {
    const starts = parseTimestamp(offer.startsAt);
    if (starts === null || starts > nowMs) return "upcoming";
  }
  const observed = parseTimestamp(offer.observedAt);
  if (observed === null || nowMs - observed > STALE_AFTER_MS) return "stale";
  return "fresh";
}
