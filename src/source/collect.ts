import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type {
  Family,
  FlyerAttestation,
  Offer,
  Proof,
  SourceSnapshot,
  Validation,
  ValidationFile,
} from "../shared/contracts.js";
import { freshness, parseTimestamp } from "../shared/freshness.js";
import { comparisonKey, identityGaps } from "../shared/identity.js";
import { isRational, rationalToString } from "../shared/money.js";
import {
  FlippDeferredError,
  FlippSourceError,
  fetchFlippResponse,
  flippFlyerUrl,
  flippItemUrl,
  flippListingUrl,
  parseFlippFlyer,
  parseFlippItem,
  parseFlippListing,
  type FlippAttempt,
  type FlippFlyer,
  type FlippResponse,
  type FlippRow,
} from "./flipp.js";
import { classifyListRow, flippEvidence, normalizeFlipp } from "./normalize.js";
import { assembleProof, attestationFor, candidatePairs, evaluateProof, type ProofEvaluation } from "./proof.js";

// Live Flipp collection for the M1 source-proof gate (plan Task 1, addendum
// R8-R11): listing -> current QFC/Safeway Weekly Ads -> produce/meat item
// details -> normalized offers -> recomputed gate. The snapshot is replaced
// only on PASS; every run leaves an audit under data/audit/<run-id>/.

export const POSTAL_CODE = "98105";
const PROOF_FAMILIES: [Family, Family] = ["kroger", "albertsons"];
/** Listing merchant -> retailer family (R11). No other merchant is collected. */
const MERCHANTS: ReadonlyArray<{ family: Family; merchant: string; retailer: string }> = [
  { family: "kroger", merchant: "QFC", retailer: "QFC" },
  { family: "albertsons", merchant: "Safeway", retailer: "Safeway" },
];
const WEEKLY_AD = "Weekly Ad";
/** Equal to the Flipp client's concurrency, so no request waits in its queue. */
const DETAIL_WORKERS = 2;
/** Snapshot rename retries for transient Windows antivirus or file-lock errors. */
const RENAME_RETRIES = 5;
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

export type CollectStatus = "PASS" | "BLOCKED" | "ERROR" | "DEFERRED";
const EXIT_CODES = { PASS: 0, BLOCKED: 1, ERROR: 2, DEFERRED: 3 } as const;

/** Usage or input problem (bad postal code, unreadable or malformed validations file). */
export class CollectInputError extends Error {
  override name = "CollectInputError";
}

export interface CollectOptions {
  postalCode: string;
  /** Root for snapshots/ and audit/ (the repository's data/ for the CLI). */
  dataDir: string;
  validationsPath?: string | null;
  reportPath?: string | null;
  /** Injected for tests; omitted means live HTTPS through global fetch. */
  fetcher?: typeof fetch;
  clock?: () => Date;
}

export interface CollectResult {
  status: CollectStatus;
  exitCode: 0 | 1 | 2 | 3;
  runId: string;
  auditDir: string;
  message: string;
  nextPermittedAt: string | null;
  snapshotWritten: boolean;
  /** The assembled snapshot, whether or not it passed and was written. */
  snapshot: SourceSnapshot | null;
  report: string;
  /** True when the report was written to the --report path. */
  reportWritten: boolean;
  /**
   * Audit or report writes that failed after the outcome was decided. They
   * never change the status or exit code; the CLI prints them.
   */
  writeErrors: string[];
}

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const USAGE = "usage: npm run source:collect -- --postal-code 98105 [--validations <file>] [--report <file>]";

export function parseCollectArgs(argv: string[]):
  | { ok: true; postalCode: string; validationsPath: string | null; reportPath: string | null }
  | { ok: false; message: string } {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        "postal-code": { type: "string" },
        validations: { type: "string" },
        report: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const postalCode = values["postal-code"];
    if (postalCode === undefined) return { ok: false, message: `--postal-code is required\n${USAGE}` };
    return { ok: true, postalCode, validationsPath: values.validations ?? null, reportPath: values.report ?? null };
  } catch (error) {
    return { ok: false, message: `${error instanceof Error ? error.message : String(error)}\n${USAGE}` };
  }
}

// ---------------------------------------------------------------------------
// Validation file (R9): strict structural parse; semantics are judged by
// attestationFor and evaluateProof.
// ---------------------------------------------------------------------------

const FAMILY_NAMES: readonly Family[] = ["kroger", "albertsons", "pcc"];

function fail(problem: string): never {
  throw new CollectInputError(problem);
}

function objectWith(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of keys) if (!(key in record)) fail(`${where} is missing ${key}`);
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail(`${where} has unknown key ${key}`);
  return record;
}

function arrayAt(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value;
}

function stringAt(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  return value;
}

function stringsAt(value: unknown, where: string): string[] {
  return arrayAt(value, where).map((entry, index) => stringAt(entry, `${where}[${index}]`));
}

function literalAt<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${where} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  return value as T;
}

const ATTESTATION_KEYS = ["family", "flyerId", "checkedAt", "applicability", "applicabilityEvidence", "calendarRule", "calendarEvidence", "startLocalTime"] as const;
const VALIDATION_KEYS = ["offerId", "checkedAt", "evidenceIds", "verifiedFields", "applicabilityEvidence", "calendarEvidence"] as const;
const PAIR_KEYS = ["leftId", "rightId", "category"] as const;

export function parseValidationFile(text: string): ValidationFile {
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (error) {
    fail(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = objectWith(value, "file", ["schemaVersion", "attestations", "validations", "pairs"]);
  if (root.schemaVersion !== 1) fail("schemaVersion must be 1");
  const attestations = arrayAt(root.attestations, "attestations").map((entry, index): FlyerAttestation => {
    const where = `attestations[${index}]`;
    const record = objectWith(entry, where, ATTESTATION_KEYS);
    const flyerId = record.flyerId;
    if (typeof flyerId !== "number" || !Number.isSafeInteger(flyerId) || flyerId <= 0) fail(`${where}.flyerId must be a positive integer`);
    return {
      family: literalAt(record.family, FAMILY_NAMES, `${where}.family`),
      flyerId,
      checkedAt: stringAt(record.checkedAt, `${where}.checkedAt`),
      applicability: literalAt(record.applicability, ["verified"] as const, `${where}.applicability`),
      applicabilityEvidence: stringAt(record.applicabilityEvidence, `${where}.applicabilityEvidence`),
      calendarRule: literalAt(record.calendarRule, ["verified-local-date"] as const, `${where}.calendarRule`),
      calendarEvidence: stringAt(record.calendarEvidence, `${where}.calendarEvidence`),
      startLocalTime: stringAt(record.startLocalTime, `${where}.startLocalTime`),
    };
  });
  const validations = arrayAt(root.validations, "validations").map((entry, index): Validation => {
    const where = `validations[${index}]`;
    const record = objectWith(entry, where, VALIDATION_KEYS);
    return {
      offerId: stringAt(record.offerId, `${where}.offerId`),
      checkedAt: stringAt(record.checkedAt, `${where}.checkedAt`),
      evidenceIds: stringsAt(record.evidenceIds, `${where}.evidenceIds`),
      verifiedFields: stringsAt(record.verifiedFields, `${where}.verifiedFields`),
      applicabilityEvidence: stringAt(record.applicabilityEvidence, `${where}.applicabilityEvidence`),
      calendarEvidence: stringAt(record.calendarEvidence, `${where}.calendarEvidence`),
    };
  });
  const pairs = arrayAt(root.pairs, "pairs").map((entry, index): Proof["pairs"][number] => {
    const where = `pairs[${index}]`;
    const record = objectWith(entry, where, PAIR_KEYS);
    return {
      leftId: stringAt(record.leftId, `${where}.leftId`),
      rightId: stringAt(record.rightId, `${where}.rightId`),
      category: literalAt(record.category, ["produce", "meat"] as const, `${where}.category`),
    };
  });
  return { schemaVersion: 1, attestations, validations, pairs };
}

/** `shown` is the display path; file-system messages (which embed the absolute path) are reduced to their code. */
async function loadValidationFile(path: string, shown: string): Promise<ValidationFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CollectInputError(`validations file ${shown} could not be read (${typeof code === "string" ? code : "read error"})`);
  }
  try {
    return parseValidationFile(text);
  } catch (error) {
    throw new CollectInputError(`validations file ${shown}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** True when `path` is `parent` or lies inside it. */
function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * A path as shown in diagnostics and the report: relative to the repository
 * root (the data directory's parent) when inside it, otherwise its basename.
 * Never an absolute home path.
 */
function displayPath(path: string, repoRoot: string): string {
  const target = resolve(path);
  return within(repoRoot, target) && target !== repoRoot ? relative(repoRoot, target).split(sep).join("/") : basename(target);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false; // absent (or unreadable): the report write reports any real problem later
  }
}

/**
 * The resolved --report path, checked before any request so the report can
 * never clobber the snapshot, the validations file or a directory. Null
 * without --report.
 */
async function reportTargetFor(options: CollectOptions, repoRoot: string): Promise<string | null> {
  if (options.reportPath === undefined || options.reportPath === null) return null;
  const target = resolve(options.reportPath);
  const validations = options.validationsPath ?? null;
  const problem = within(resolve(options.dataDir, "snapshots"), target) ? "is inside data/snapshots"
    : validations !== null && relative(resolve(validations), target) === "" ? "is the validations file"
    : await isDirectory(target) ? "is an existing directory"
    : null;
  if (problem !== null) {
    throw new CollectInputError(`--report ${displayPath(target, repoRoot)} ${problem}; choose a new file outside data/snapshots`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Flyer selection (R11)
// ---------------------------------------------------------------------------

export interface SelectedFlyer {
  family: Family;
  retailer: string;
  merchant: string;
  id: number;
  name: string;
  valid_from: string;
  valid_to: string;
}

/** The raw window contains `now`; both ends need an explicit offset or Z (A8 timestamps). */
function isCurrent(flyer: FlippFlyer, now: Date): boolean {
  const from = parseTimestamp(flyer.valid_from);
  const to = parseTimestamp(flyer.valid_to);
  return from !== null && to !== null && from <= now.getTime() && now.getTime() < to;
}

function describeFlyer(flyer: FlippFlyer, now: Date): string {
  const notes = [flyer.name.includes(WEEKLY_AD) ? null : `not a ${WEEKLY_AD}`, isCurrent(flyer, now) ? "current" : "not current"];
  return `${flyer.id} "${flyer.name}" ${flyer.valid_from} to ${flyer.valid_to} (${notes.filter(Boolean).join(", ")})`;
}

/**
 * Exactly one current Weekly Ad per family from the live listing; any other
 * count is a source error that lists that merchant's flyers. Never uses fixed IDs.
 */
export function selectFlyers(flyers: FlippFlyer[], now: Date): SelectedFlyer[] {
  const problems: string[] = [];
  const selected: SelectedFlyer[] = [];
  for (const { family, merchant, retailer } of MERCHANTS) {
    const fromMerchant = flyers.filter((flyer) => flyer.merchant.trim() === merchant);
    const matches = fromMerchant.filter((flyer) => flyer.name.includes(WEEKLY_AD) && isCurrent(flyer, now));
    const only = matches[0];
    if (matches.length === 1 && only) {
      selected.push({ family, retailer, merchant, id: only.id, name: only.name, valid_from: only.valid_from, valid_to: only.valid_to });
      continue;
    }
    const candidates = fromMerchant.length > 0 ? fromMerchant.map((flyer) => describeFlyer(flyer, now)).join("; ") : "none";
    problems.push(`${family} (${merchant}): ${matches.length} current "${WEEKLY_AD}" flyers, need exactly 1; ${merchant} flyers: ${candidates}`);
  }
  if (problems.length > 0) throw new FlippSourceError(`flyer selection failed at ${now.toISOString()}: ${problems.join(" | ")}`);
  return selected;
}

// ---------------------------------------------------------------------------
// Run log (diagnostics.json)
// ---------------------------------------------------------------------------

interface FlyerLog extends SelectedFlyer {
  rowCount: number;
  /** List rows selected for an item-detail request (produce/meat candidates). */
  detailCandidates: number;
  attestation: {
    applicability: "verified" | "unknown";
    calendarRule: "verified-local-date" | "unknown";
    startLocalTime: string | null;
    attestation: FlyerAttestation | null;
    problems: string[];
  };
}

interface ExcludedRow {
  family: Family;
  flyerId: number;
  itemId: number;
  /** The list row's name; null when the row has no string name (A11). */
  name: string | null;
  stage: "list" | "detail";
  reason: string;
  /** Item-detail URL and HTTP status of an unavailable item (404/410, A11); otherwise null. */
  url: string | null;
  status: number | null;
}

interface RequestLog {
  requestUrl: string;
  finalUrl: string;
  file: string;
  receivedAt: string;
  sha256: string;
}

interface RunLog {
  runId: string;
  live: boolean;
  postalCode: string;
  collectedAt: string;
  evaluatedAt: string | null;
  /** Display path (relative to the repository root, or a basename). */
  validationsPath: string | null;
  flyers: FlyerLog[];
  /** Malformed listing flyers from other merchants, ignored (A11). */
  listingNotes: string[];
  excludedRows: ExcludedRow[];
  /** Accepted responses saved under raw/. */
  requests: RequestLog[];
  /** Every HTTP exchange, including failed, retried and redirected ones. */
  attempts: FlippAttempt[];
  proofNotes: string[];
}

type ItemResult = { offer: Offer } | { excluded: ExcludedRow };

interface Candidate {
  flyer: FlyerLog;
  row: FlippRow;
  name: string;
}

interface FailureLog {
  name: string;
  message: string;
  url: string | null;
  status: number | null;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function runIdFor(time: Date): string {
  return time.toISOString().replace(/[:.]/g, "-");
}

async function createAuditDir(dataDir: string, time: Date): Promise<{ runId: string; auditDir: string }> {
  const auditRoot = join(dataDir, "audit");
  await mkdir(auditRoot, { recursive: true });
  const base = runIdFor(time);
  for (let attempt = 1; ; attempt += 1) {
    const runId = attempt === 1 ? base : `${base}-${attempt}`;
    const auditDir = join(auditRoot, runId);
    try {
      await mkdir(auditDir);
      await mkdir(join(auditDir, "raw"));
      return { runId, auditDir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Runs tasks with a fixed worker count; after the first failure no new task starts. */
async function runWorkers<T>(count: number, total: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(total);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < total) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(count, total) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}

/**
 * rename, retried up to five times (100-500 ms apart) on EPERM/EACCES/EBUSY,
 * which Windows antivirus scanners and open file handles cause transiently.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (retry >= RENAME_RETRIES || !RENAME_RETRY_CODES.has(code)) throw error;
      await new Promise<void>((done) => setTimeout(done, 100 * (retry + 1)));
    }
  }
}

/** Atomic replace: temp file in the same directory, flushed, then renamed over the snapshot. */
async function writeSnapshot(dataDir: string, snapshot: SourceSnapshot, runId: string): Promise<void> {
  const dir = join(dataDir, "snapshots");
  await mkdir(dir, { recursive: true });
  const target = join(dir, "m1-source.json");
  const temp = join(dir, `.m1-source.${runId}.tmp`);
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

interface Outcome {
  status: CollectStatus;
  message: string;
  nextPermittedAt: string | null;
  /** The first failure, which is authoritative. */
  error: FailureLog | null;
  /** Failures after the first (never the aborts they caused). */
  otherFailures: FailureLog[];
  snapshot: SourceSnapshot | null;
  evaluation: ProofEvaluation | null;
  snapshotWritten: boolean;
}

function failureLog(error: unknown): FailureLog {
  const known = error instanceof FlippSourceError || error instanceof FlippDeferredError;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    url: known ? error.url : null,
    status: known ? error.status : null,
  };
}

/**
 * Outcome of a failed run. The first failure is authoritative: it is the
 * reported error, and later failures are listed after it. The status is
 * DEFERRED whenever any failure was a deferral, even when a source error came
 * first, because the deferral's nextPermittedAt is the earliest time the
 * source allows another request and retrying sooner would ignore it.
 */
function failedOutcome(failures: unknown[]): Outcome {
  const logs = failures.map(failureLog);
  const deferral = failures.find((error): error is FlippDeferredError => error instanceof FlippDeferredError) ?? null;
  const [first = failureLog(new Error("unknown failure")), ...others] = logs;
  return {
    status: deferral === null ? "ERROR" : "DEFERRED",
    message: [first, ...others].map((failure) => failure.message).join("; also: "),
    nextPermittedAt: deferral?.nextPermittedAt ?? null,
    error: first,
    otherFailures: others,
    snapshot: null,
    evaluation: null,
    snapshotWritten: false,
  };
}

export async function collect(options: CollectOptions): Promise<CollectResult> {
  const clock = options.clock ?? (() => new Date());
  const started = clock();
  const repoRoot = dirname(resolve(options.dataDir));
  const { runId, auditDir } = await createAuditDir(options.dataDir, started);
  const rawDir = join(auditDir, "raw");
  const validationsPath = options.validationsPath ?? null;
  const log: RunLog = {
    runId,
    live: options.fetcher === undefined,
    postalCode: options.postalCode,
    collectedAt: started.toISOString(),
    evaluatedAt: null,
    validationsPath: validationsPath === null ? null : displayPath(validationsPath, repoRoot),
    flyers: [],
    listingNotes: [],
    excludedRows: [],
    requests: [],
    attempts: [],
    proofNotes: [],
  };

  // A12: one abort per run. The first failure or deferral aborts every
  // in-flight request, retry wait and redirect hop; requests ended that way
  // reject with `stopped`, which is never recorded as a failure.
  const controller = new AbortController();
  const stopped = new Error("request stopped: the run already failed or was deferred (A12)");
  const failures: unknown[] = [];
  function stopRun(error: unknown): void {
    if (error === stopped || failures.includes(error)) return;
    failures.push(error);
    controller.abort(stopped);
  }

  async function get(url: URL, file: string): Promise<{ response: FlippResponse; receivedAt: string }> {
    const response = await fetchFlippResponse(url, {
      fetcher: options.fetcher,
      now: () => clock().getTime(),
      signal: controller.signal,
      onAttempt: (attempt) => log.attempts.push(attempt),
    });
    const receivedAt = clock().toISOString();
    await writeFile(join(rawDir, file), response.bytes);
    log.requests.push({
      requestUrl: response.requestUrl,
      finalUrl: response.finalUrl,
      file: `raw/${file}`,
      receivedAt,
      sha256: createHash("sha256").update(response.bytes).digest("hex"),
    });
    return { response, receivedAt };
  }

  async function collectItem({ flyer, row, name }: Candidate): Promise<ItemResult> {
    const url = flippItemUrl(row.id);
    const excluded = (reason: string, status: number | null = null): ItemResult => ({
      excluded: {
        family: flyer.family, flyerId: flyer.id, itemId: row.id, name, stage: "detail", reason,
        url: status === null ? null : url.href, status,
      },
    });
    let fetched: { response: FlippResponse; receivedAt: string };
    try {
      // The flyer ID keeps raw names unique when one item appears in both flyers.
      fetched = await get(url, `item-${flyer.id}-${row.id}.json`);
    } catch (error) {
      // A11: an unavailable item (404/410) excludes only that item; everything else stays run-level.
      if (error instanceof FlippSourceError && (error.status === 404 || error.status === 410)) {
        return excluded(`item detail unavailable: HTTP ${error.status}`, error.status);
      }
      throw error;
    }
    const { response, receivedAt } = fetched;
    const detail = parseFlippItem(response.json);
    if (detail.id !== row.id) throw new FlippSourceError(`item detail id ${String(detail.id)} does not match requested item ${row.id}`, response.requestUrl);
    if (detail.flyer_id !== undefined && detail.flyer_id !== null && String(detail.flyer_id) !== String(flyer.id)) {
      return excluded(`item detail flyer_id ${String(detail.flyer_id)} is not the selected flyer ${flyer.id}`);
    }
    const category = classifyListRow(detail);
    if (category.category === "excluded") return excluded(category.reason);
    const evidence = flippEvidence({
      rawBody: response.bytes, // A9: the exact bytes received
      item: detail,
      // Exactly https://backflipp.wishabi.com/flipp/items/<id> (A7), even after a redirect.
      retrievedUrl: response.requestUrl,
      observedAt: receivedAt,
    });
    let offer: Offer;
    try {
      offer = normalizeFlipp(detail, {
        family: flyer.family,
        retailer: flyer.retailer,
        postalCode: POSTAL_CODE,
        observedAt: receivedAt,
        evidence,
        applicability: flyer.attestation.applicability,
        calendarRule: flyer.attestation.calendarRule,
        startLocalTime: flyer.attestation.startLocalTime,
      });
    } catch (error) {
      return excluded(`normalization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (offer.channel !== "in-store-ad") return excluded(`unexpected channel ${offer.channel} for a printed weekly ad`);
    return { offer };
  }

  async function run(): Promise<Outcome> {
    if (options.postalCode !== POSTAL_CODE) {
      throw new CollectInputError(`--postal-code must be ${POSTAL_CODE} (fixed by the M1 contract); got ${JSON.stringify(options.postalCode)}`);
    }
    const file = validationsPath === null ? null : await loadValidationFile(validationsPath, log.validationsPath ?? "");

    const listing = await get(flippListingUrl(POSTAL_CODE), "listing.json");
    const parsed = parseFlippListing(listing.response.json, MERCHANTS.map(({ merchant }) => merchant));
    log.listingNotes = parsed.ignored;
    const selected = selectFlyers(parsed.flyers, started);

    const candidates: Candidate[] = [];
    for (const choice of selected) {
      const detail = await get(flippFlyerUrl(choice.id, POSTAL_CODE), `flyer-${choice.id}.json`);
      const rows = parseFlippFlyer(detail.response.json);
      const flyer: FlyerLog = { ...choice, rowCount: rows.length, detailCandidates: 0, attestation: attestationFor(file, choice.family, choice.id) };
      log.flyers.push(flyer);
      const seen = new Set<number>();
      for (const row of rows) {
        const name = typeof row.name === "string" ? row.name : null;
        const listExclusion = (reason: string) => log.excludedRows.push({
          family: flyer.family, flyerId: flyer.id, itemId: row.id, name, stage: "list", reason, url: null, status: null,
        });
        if (seen.has(row.id)) {
          listExclusion(`duplicate list row for item ${row.id}`);
          continue;
        }
        seen.add(row.id);
        if (name === null) {
          listExclusion("missing or non-string name"); // A11: an excluded row, not a run failure
          continue;
        }
        const category = classifyListRow(row);
        if (category.category === "excluded") {
          listExclusion(category.reason);
          continue;
        }
        flyer.detailCandidates += 1;
        candidates.push({ flyer, row, name });
      }
    }

    const results = await runWorkers(DETAIL_WORKERS, candidates.length, async (index) => {
      try {
        return await collectItem(candidates[index] as Candidate);
      } catch (error) {
        stopRun(error); // A12: the first failure or deferral stops every other request at once
        throw error;
      }
    });
    const offers: Offer[] = [];
    for (const result of results) {
      if ("offer" in result) offers.push(result.offer);
      else log.excludedRows.push(result.excluded);
    }
    // A11: a flyer whose every detail request came back unavailable is a source problem, not a gate result.
    for (const flyer of log.flyers) {
      const unavailable = log.excludedRows.filter((row) => row.flyerId === flyer.id && row.status !== null).length;
      if (flyer.detailCandidates > 0 && unavailable === flyer.detailCandidates) {
        throw new FlippSourceError(`every item-detail request for ${flyer.family} flyer ${flyer.id} failed (${unavailable} of ${flyer.detailCandidates} unavailable: HTTP 404/410)`);
      }
    }

    const evaluatedAt = clock();
    log.evaluatedAt = evaluatedAt.toISOString();
    const { proof, notes } = assembleProof(file, offers, [PROOF_FAMILIES[0], PROOF_FAMILIES[1]], evaluatedAt.toISOString());
    log.proofNotes = notes;
    const snapshot: SourceSnapshot = { schemaVersion: 1, postalCode: POSTAL_CODE, collectedAt: log.collectedAt, offers, proof };
    const evaluation = evaluateProof(snapshot, evaluatedAt);
    if (!evaluation.ok) {
      return {
        status: "BLOCKED",
        message: `gate not met: ${evaluation.failures.join("; ")}`,
        nextPermittedAt: null,
        error: null,
        otherFailures: [],
        snapshot,
        evaluation,
        snapshotWritten: false,
      };
    }
    await writeSnapshot(options.dataDir, snapshot, runId);
    return {
      status: "PASS",
      message: "source-proof gate met; data/snapshots/m1-source.json replaced",
      nextPermittedAt: null,
      error: null,
      otherFailures: [],
      snapshot,
      evaluation,
      snapshotWritten: true,
    };
  }

  let reportTarget: string | null = null;
  let outcome: Outcome;
  try {
    reportTarget = await reportTargetFor(options, repoRoot);
    outcome = await run();
  } catch (error) {
    stopRun(error);
    outcome = failedOutcome(failures);
  }

  // The outcome is decided. From here a failed write is reported in
  // writeErrors but never changes the status or exit code.
  const exitCode = EXIT_CODES[outcome.status];
  const writeErrors: string[] = [];
  async function tryWrite(what: string, write: () => Promise<unknown>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (error) {
      writeErrors.push(`could not write ${what}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // Rejected response bodies (capped at 1 MB by the client) under generated names.
  const attempts = [];
  for (const [index, { body, ...attempt }] of log.attempts.entries()) {
    const file = `raw/failed/attempt-${index + 1}.bin`;
    const kept = body !== null && body.byteLength > 0 && await tryWrite(`failed response body ${file}`, async () => {
      await mkdir(join(auditDir, "raw", "failed"), { recursive: true });
      await writeFile(join(auditDir, file), body);
    });
    attempts.push({ ...attempt, failedBody: kept ? file : null, failedBodyBytes: body?.byteLength ?? 0 });
  }

  const report = renderReport(log, outcome, exitCode);
  const offers = outcome.snapshot?.offers ?? [];
  const diagnostics = {
    runId,
    status: outcome.status,
    exitCode,
    message: outcome.message,
    nextPermittedAt: outcome.nextPermittedAt,
    error: outcome.error,
    otherFailures: outcome.otherFailures,
    live: log.live,
    postalCode: log.postalCode,
    collectedAt: log.collectedAt,
    evaluatedAt: log.evaluatedAt,
    validationsPath: log.validationsPath,
    snapshotWritten: outcome.snapshotWritten,
    flyers: log.flyers,
    listingNotes: log.listingNotes,
    attestationProblems: log.flyers.flatMap((flyer) => flyer.attestation.problems),
    excludedRows: log.excludedRows,
    normalizationIssues: offers.filter((offer) => offer.normalizationIssue !== null)
      .map((offer) => ({ offerId: offer.id, issue: offer.normalizationIssue })),
    proofNotes: log.proofNotes,
    evaluation: outcome.evaluation,
    candidatePairs: outcome.snapshot ? candidatePairs(outcome.snapshot.offers) : [],
    requests: log.requests,
    attempts,
    writeErrors: [...writeErrors],
    candidateSnapshot: outcome.snapshot,
  };
  await tryWrite("diagnostics.json", () => writeFile(join(auditDir, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8"));
  await tryWrite("the audit report.md", () => writeFile(join(auditDir, "report.md"), report, "utf8"));
  const target = reportTarget;
  const reportWritten = target !== null && await tryWrite(`the report ${displayPath(target, repoRoot)}`, async () => {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, report, "utf8");
  });
  return {
    status: outcome.status,
    exitCode,
    runId,
    auditDir,
    message: outcome.message,
    nextPermittedAt: outcome.nextPermittedAt,
    snapshotWritten: outcome.snapshotWritten,
    snapshot: outcome.snapshot,
    report,
    reportWritten,
    writeErrors,
  };
}

// ---------------------------------------------------------------------------
// Report (markdown for human validation)
// ---------------------------------------------------------------------------

/**
 * Markdown-safe text for retailer and source strings anywhere in the report.
 * Every line break (CRLF, a lone CR or LF, U+2028/U+2029) becomes a space, so
 * no source text can start a line of its own, and the characters that could
 * form tables, links, HTML, code spans or headings are backslash-escaped.
 */
function md(value: unknown): string {
  return String(value).replace(/\r\n|[\r\n\u2028\u2029]/g, " ").replace(/[\\`|<>[\]#]/g, "\\$&");
}

function cell(value: unknown): string {
  return value === null || value === undefined || value === "" ? "-" : md(value);
}

function table(headers: string[], rows: unknown[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
}

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${md(item)}`);
}

/** Every raw price field present (verbatim, JSON-quoted), then the raw condition texts. */
function rawText(offer: Offer): string {
  const fields = Object.entries(offer.rawPrice)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([field, value]) => `${field}=${JSON.stringify(value)}`);
  return [...fields, `conditions.text=${JSON.stringify(offer.conditions.text)}`].join("; ");
}

function packageText(offer: Offer): string {
  const mass = offer.packageMassLb;
  const massText = mass === null ? "none" : isRational(mass) ? rationalToString(mass) : `invalid (${JSON.stringify(mass)})`;
  return `packageMassLb=${massText}; packageCount=${offer.packageCount ?? "none"}; packageTotalCents=${offer.packageTotalCents ?? "none"}`;
}

/** Raw valid_from, valid_to, available_to (when present) and timezone, as received. */
function rawValidityText(offer: Offer): string {
  const validity = offer.evidence[0]?.rawValidity ?? {};
  const entries = Object.entries(validity).map(([field, value]) => `${field}=${value ?? "null"}`);
  return entries.length > 0 ? entries.join("; ") : "none";
}

/** Rounded dollars for display only; the exact rational cents follow in parentheses. */
function unitPriceText(offer: Offer): string {
  const price = offer.unitPrice;
  if (price === null) return "unknown";
  if (!isRational(price.cents) || BigInt(price.cents.n) < 0n) return `invalid (${JSON.stringify(price.cents)})`;
  const n = BigInt(price.cents.n);
  const d = BigInt(price.cents.d);
  const cents = (2n * n + d) / (2n * d);
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}/${price.basis} (exact ${rationalToString(price.cents)} cents)`;
}

function requirement(value: boolean | null): string {
  return value === null ? "unknown" : value ? "required" : "not required";
}

function conditionsText(offer: Offer): string {
  const c = offer.conditions;
  return [
    `loyalty ${requirement(c.loyaltyRequired)}`,
    `coupon ${requirement(c.couponRequired)}`,
    `min ${c.minimumUnits ?? "none stated"}`,
    `max ${c.maximumUnits ?? "none stated"}`,
    `complete ${c.complete ? "yes" : "no"}`,
  ].join("; ");
}

function attestationText(flyer: FlyerLog): string {
  const { attestation, problems, startLocalTime } = flyer.attestation;
  const base = attestation
    ? `verified (checked ${attestation.checkedAt}; printed start ${startLocalTime}; applicability: ${attestation.applicabilityEvidence}; calendar: ${attestation.calendarEvidence})`
    : "unknown (no valid attestation for this flyer ID)";
  return problems.length > 0 ? `${base}; problems: ${problems.join("; ")}` : base;
}

function responsesText(log: RunLog): string {
  if (log.attempts.length === 0) return "none; no request was sent";
  if (!log.live) return "injected fetcher (test or replay data; not collected from the source by this run)";
  return `live HTTPS responses from backflipp.wishabi.com retrieved by this run (${log.requests.length} accepted of ${log.attempts.length} request attempts)`;
}

function renderReport(log: RunLog, outcome: Outcome, exitCode: number): string {
  const lines: string[] = [];
  const { status, evaluation, snapshot } = outcome;
  lines.push(`# M1 source-proof report: ${status}`, "");
  lines.push(
    `- Status: ${status} (exit ${exitCode})`,
    `- Run: ${log.runId}`,
    `- Collection time: ${log.collectedAt}`,
    `- Gate evaluated at: ${log.evaluatedAt ?? "not reached"}`,
    `- Postal code: ${md(log.postalCode)}`,
    `- Responses: ${responsesText(log)}`,
    `- Validations file: ${log.validationsPath === null ? "none" : md(log.validationsPath)}`,
    `- Snapshot: ${outcome.snapshotWritten ? "data/snapshots/m1-source.json replaced by this run" : "not written; any prior data/snapshots/m1-source.json is unchanged"}`,
  );
  if (outcome.nextPermittedAt !== null) lines.push(`- Next permitted request: ${outcome.nextPermittedAt}`);
  lines.push("", `Summary: ${md(outcome.message)}`, "");

  if (outcome.error !== null) {
    lines.push("## Error", "", `${md(outcome.error.name)}: ${md(outcome.error.message)}`, "");
    if (outcome.otherFailures.length > 0) {
      lines.push("Later failures:", "", ...bullets(outcome.otherFailures.map((failure) => `${failure.name}: ${failure.message}`)), "");
    }
  }

  lines.push("## Selected flyers", "");
  if (log.flyers.length === 0) lines.push("None selected.", "");
  else {
    lines.push(...table(
      ["Family", "Retailer", "Flyer", "Name", "Raw valid_from", "Raw valid_to", "Rows", "Detail candidates", "Attestation"],
      log.flyers.map((flyer) => [flyer.family, flyer.retailer, flyer.id, flyer.name, flyer.valid_from, flyer.valid_to, flyer.rowCount, flyer.detailCandidates, attestationText(flyer)]),
    ), "");
  }
  if (log.listingNotes.length > 0) lines.push("Ignored listing entries (malformed flyers from other merchants):", "", ...bullets(log.listingNotes), "");

  if (evaluation !== null && snapshot !== null) {
    const evaluatedAt = new Date(log.evaluatedAt ?? log.collectedAt);
    lines.push("## Family counts (qualifying offers)", "");
    lines.push(...table(
      ["Family", "Total", "Produce", "Meat", "Counted source item IDs"],
      PROOF_FAMILIES.map((family) => {
        const count = evaluation.families[family];
        return [family, count.count, count.produce, count.meat, count.sourceItemIds.join(", ") || "none"];
      }),
    ), "");

    lines.push("## Gate reasons", "");
    lines.push(...(evaluation.failures.length > 0 ? bullets(evaluation.failures) : ["- none"]), "");
    if (evaluation.notes.length > 0) lines.push("Gate notes:", "", ...bullets(evaluation.notes), "");
    if (log.proofNotes.length > 0) lines.push("Proof assembly notes:", "", ...bullets(log.proofNotes), "");
    const attestationProblems = log.flyers.flatMap((flyer) => flyer.attestation.problems);
    if (attestationProblems.length > 0) lines.push("Attestation problems:", "", ...bullets(attestationProblems), "");

    const counted = new Set(PROOF_FAMILIES.flatMap((family) => evaluation.families[family].offerIds));
    const exclusions = new Map(evaluation.excluded.map((entry) => [entry.offerId, entry.reasons.join("; ")]));
    lines.push(`## In-scope offers (${snapshot.offers.length})`, "");
    lines.push(...table(
      ["Offer", "Source item", "Name", "Category", "Raw price and condition text", "Unit price", "Package terms",
        "comparisonKey or unknown fields", "Conditions", "Applicability", "Calendar rule", "Raw validity", "Starts / expires",
        "Freshness", "Evidence", "Source URL", "Gate"],
      snapshot.offers.map((offer) => {
        const evidence = offer.evidence[0];
        const key = comparisonKey(offer.identity);
        const gate = counted.has(offer.id) ? "counted" : `excluded: ${exclusions.get(offer.id) ?? "source item already counted"}`;
        return [
          offer.id, evidence?.sourceItemId, offer.label, offer.identity.category, rawText(offer), unitPriceText(offer), packageText(offer),
          key ?? `unknown: ${identityGaps(offer.identity).join(", ")}`, conditionsText(offer), offer.applicability, offer.calendarRule,
          rawValidityText(offer), `${offer.startsAt ?? "unknown"} / ${offer.expiresAt ?? "unknown"}`, freshness(offer, evaluatedAt),
          evidence?.id, evidence?.sourceUrl, gate,
        ];
      }),
    ), "");

    // Validations whose evidence IDs are all on the counted offer.
    const countedRows = snapshot.offers.filter((offer) => counted.has(offer.id)).flatMap((offer) =>
      snapshot.proof.validations
        .filter((validation) => validation.offerId === offer.id &&
          validation.evidenceIds.every((id) => offer.evidence.some((evidence) => evidence.id === id)))
        .map((validation) => [offer.id, offer.evidence[0]?.sourceItemId, validation.checkedAt, validation.applicabilityEvidence,
          validation.calendarEvidence, validation.evidenceIds.join(", ")]));
    lines.push(`## Counted offers and validation evidence (${counted.size})`, "");
    if (countedRows.length === 0) lines.push("None.", "");
    else lines.push(...table(["Offer", "Source item", "Validation checkedAt", "Applicability evidence", "Calendar evidence", "Evidence IDs"], countedRows), "");

    const suggestions = candidatePairs(snapshot.offers);
    lines.push(`## Candidate cross-family pairs (${suggestions.length}; suggestions for human validation, not counted)`, "");
    if (suggestions.length === 0) lines.push("None.", "");
    else lines.push(...table(["Left", "Right", "Category", "comparisonKey", "Channel", "Basis"],
      suggestions.map((pair) => [pair.leftId, pair.rightId, pair.category, pair.comparisonKey, pair.channel, pair.basis])), "");

    // Counted pairs share comparisonKey, channel and unit basis (checked by the gate); shown from the left offer.
    const byId = new Map(snapshot.offers.map((offer) => [offer.id, offer]));
    lines.push(`## Counted pairs (${evaluation.countedPairs.length})`, "");
    if (evaluation.countedPairs.length === 0) lines.push("None.", "");
    else lines.push(...table(["Left", "Right", "Category", "comparisonKey", "Basis"], evaluation.countedPairs.map((pair) => {
      const left = byId.get(pair.leftId);
      return [pair.leftId, pair.rightId, pair.category, left ? comparisonKey(left.identity) : null, left?.unitPrice?.basis];
    })), "");

    lines.push(`## Skipped pairs (${evaluation.skippedPairs.length})`, "");
    if (evaluation.skippedPairs.length === 0) lines.push("None.", "");
    else lines.push(...table(["Left", "Right", "Category", "Reason"],
      evaluation.skippedPairs.map(({ pair, reason }) => [pair.leftId, pair.rightId, pair.category, reason])), "");
  }

  lines.push(`## Excluded rows (list and detail stage) (${log.excludedRows.length})`, "");
  if (log.excludedRows.length === 0) lines.push("None.", "");
  else lines.push(...table(["Family", "Flyer", "Item", "Name", "Stage", "Reason", "URL", "HTTP status"],
    log.excludedRows.map((row) => [row.family, row.flyerId, row.itemId, row.name, row.stage, row.reason, row.url, row.status])), "");

  return `${lines.join("\n").trimEnd()}\n`;
}
