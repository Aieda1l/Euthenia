import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { freshness } from "../shared/freshness.js";
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
const DETAIL_WORKERS = 2;

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
    value = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
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

async function loadValidationFile(path: string): Promise<ValidationFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new CollectInputError(`validations file ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseValidationFile(text);
  } catch (error) {
    throw new CollectInputError(`validations file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function isCurrent(flyer: FlippFlyer, now: Date): boolean {
  const from = Date.parse(flyer.valid_from);
  const to = Date.parse(flyer.valid_to);
  return !Number.isNaN(from) && !Number.isNaN(to) && from <= now.getTime() && now.getTime() < to;
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
  detailRequests: number;
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
  name: string;
  stage: "list" | "detail";
  reason: string;
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
  validationsPath: string | null;
  flyers: FlyerLog[];
  excludedRows: ExcludedRow[];
  requests: RequestLog[];
  proofNotes: string[];
}

type ItemResult = { offer: Offer } | { excluded: ExcludedRow };

interface Candidate {
  flyer: FlyerLog;
  row: FlippRow;
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
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

interface Outcome {
  status: CollectStatus;
  message: string;
  nextPermittedAt: string | null;
  error: { name: string; message: string; url: string | null } | null;
  snapshot: SourceSnapshot | null;
  evaluation: ProofEvaluation | null;
  snapshotWritten: boolean;
}

export async function collect(options: CollectOptions): Promise<CollectResult> {
  const clock = options.clock ?? (() => new Date());
  const started = clock();
  const { runId, auditDir } = await createAuditDir(options.dataDir, started);
  const rawDir = join(auditDir, "raw");
  const log: RunLog = {
    runId,
    live: options.fetcher === undefined,
    postalCode: options.postalCode,
    collectedAt: started.toISOString(),
    evaluatedAt: null,
    validationsPath: options.validationsPath ?? null,
    flyers: [],
    excludedRows: [],
    requests: [],
    proofNotes: [],
  };

  async function get(url: URL, file: string): Promise<{ response: FlippResponse; receivedAt: string }> {
    const response = await fetchFlippResponse(url, { fetcher: options.fetcher, now: () => clock().getTime() });
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

  async function collectItem({ flyer, row }: Candidate): Promise<ItemResult> {
    const excluded = (reason: string): ItemResult => ({
      excluded: { family: flyer.family, flyerId: flyer.id, itemId: row.id, name: row.name, stage: "detail", reason },
    });
    const { response, receivedAt } = await get(flippItemUrl(row.id), `item-${row.id}.json`);
    const detail = parseFlippItem(response.json);
    if (detail.id !== row.id) throw new FlippSourceError(`item detail id ${String(detail.id)} does not match requested item ${row.id}`, response.requestUrl);
    if (detail.flyer_id !== undefined && detail.flyer_id !== null && String(detail.flyer_id) !== String(flyer.id)) {
      return excluded(`item detail flyer_id ${String(detail.flyer_id)} is not the selected flyer ${flyer.id}`);
    }
    const category = classifyListRow(detail);
    if (category.category === "excluded") return excluded(category.reason);
    const evidence = flippEvidence({
      // TODO(A9): pass response.bytes once flippEvidence accepts Uint8Array. The
      // bytes passed strict UTF-8 validation, so Buffer decoding (which keeps a
      // BOM) re-encodes to exactly these bytes and the hash is the byte hash.
      rawBody: Buffer.from(response.bytes).toString("utf8"),
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
    const file = options.validationsPath === undefined || options.validationsPath === null
      ? null
      : await loadValidationFile(options.validationsPath);

    const listing = await get(flippListingUrl(POSTAL_CODE), "listing.json");
    const selected = selectFlyers(parseFlippListing(listing.response.json), started);

    const candidates: Candidate[] = [];
    for (const choice of selected) {
      const detail = await get(flippFlyerUrl(choice.id, POSTAL_CODE), `flyer-${choice.id}.json`);
      const rows = parseFlippFlyer(detail.response.json);
      const flyer: FlyerLog = { ...choice, rowCount: rows.length, detailRequests: 0, attestation: attestationFor(file, choice.family, choice.id) };
      log.flyers.push(flyer);
      const seen = new Set<number>();
      for (const row of rows) {
        const listExclusion = (reason: string) =>
          log.excludedRows.push({ family: flyer.family, flyerId: flyer.id, itemId: row.id, name: row.name, stage: "list", reason });
        if (seen.has(row.id)) {
          listExclusion(`duplicate list row for item ${row.id}`);
          continue;
        }
        seen.add(row.id);
        const category = classifyListRow(row);
        if (category.category === "excluded") {
          listExclusion(category.reason);
          continue;
        }
        flyer.detailRequests += 1;
        candidates.push({ flyer, row });
      }
    }

    const results = await runWorkers(DETAIL_WORKERS, candidates.length, (index) => collectItem(candidates[index] as Candidate));
    const offers: Offer[] = [];
    for (const result of results) {
      if ("offer" in result) offers.push(result.offer);
      else log.excludedRows.push(result.excluded);
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
        message: `gate not met: ${gateFailures(evaluation).join("; ")}`,
        nextPermittedAt: null,
        error: null,
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
      snapshot,
      evaluation,
      snapshotWritten: true,
    };
  }

  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (error) {
    const deferred = error instanceof FlippDeferredError;
    const message = error instanceof Error ? error.message : String(error);
    outcome = {
      status: deferred ? "DEFERRED" : "ERROR",
      message,
      nextPermittedAt: deferred ? error.nextPermittedAt : null,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message,
        url: error instanceof FlippSourceError || error instanceof FlippDeferredError ? error.url : null,
      },
      snapshot: null,
      evaluation: null,
      snapshotWritten: false,
    };
  }

  const exitCode = EXIT_CODES[outcome.status];
  const report = renderReport(log, outcome, exitCode);
  const offers = outcome.snapshot?.offers ?? [];
  const diagnostics = {
    runId,
    status: outcome.status,
    exitCode,
    message: outcome.message,
    nextPermittedAt: outcome.nextPermittedAt,
    error: outcome.error,
    live: log.live,
    postalCode: log.postalCode,
    collectedAt: log.collectedAt,
    evaluatedAt: log.evaluatedAt,
    validationsPath: log.validationsPath,
    snapshotWritten: outcome.snapshotWritten,
    flyers: log.flyers,
    attestationProblems: log.flyers.flatMap((flyer) => flyer.attestation.problems),
    excludedRows: log.excludedRows,
    normalizationIssues: offers.filter((offer) => offer.normalizationIssue !== null)
      .map((offer) => ({ offerId: offer.id, issue: offer.normalizationIssue })),
    proofNotes: log.proofNotes,
    evaluation: outcome.evaluation,
    candidatePairs: outcome.snapshot ? candidatePairs(outcome.snapshot.offers) : [],
    requests: log.requests,
    candidateSnapshot: outcome.snapshot,
  };
  await writeFile(join(auditDir, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  await writeFile(join(auditDir, "report.md"), report, "utf8");
  if (options.reportPath) {
    await mkdir(dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, report, "utf8");
  }
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
  };
}

// ---------------------------------------------------------------------------
// Report (markdown for human validation)
// ---------------------------------------------------------------------------

/** Gate failures only; per-offer exclusions and skipped pairs have their own tables. */
function gateFailures(evaluation: ProofEvaluation): string[] {
  return evaluation.reasons.filter((reason) => !reason.startsWith("excluded ") && !reason.startsWith("pair "));
}

function cell(value: unknown): string {
  const text = value === null || value === undefined || value === "" ? "-" : String(value);
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function table(headers: string[], rows: unknown[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
}

function rawPriceText(offer: Offer): string {
  const parts = (["pre_price_text", "current_price", "price_text", "sale_story"] as const)
    .map((field) => [field, offer.rawPrice[field]] as const)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([field, value]) => `${field}=${JSON.stringify(value)}`);
  return parts.length > 0 ? parts.join("; ") : "none";
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

function renderReport(log: RunLog, outcome: Outcome, exitCode: number): string {
  const lines: string[] = [];
  const { status, evaluation, snapshot } = outcome;
  lines.push(`# M1 source-proof report: ${status}`, "");
  lines.push(
    `- Status: ${status} (exit ${exitCode})`,
    `- Run: ${log.runId}`,
    `- Collection time: ${log.collectedAt}`,
    `- Gate evaluated at: ${log.evaluatedAt ?? "not reached"}`,
    `- Postal code: ${log.postalCode}`,
    `- Responses: ${log.live
      ? "live HTTPS responses from backflipp.wishabi.com retrieved by this run"
      : "injected fetcher (test or replay data; not collected from the source by this run)"}`,
    `- Validations file: ${log.validationsPath ?? "none"}`,
    `- Snapshot: ${outcome.snapshotWritten ? "data/snapshots/m1-source.json replaced by this run" : "not written; any prior data/snapshots/m1-source.json is unchanged"}`,
  );
  if (outcome.nextPermittedAt !== null) lines.push(`- Next permitted request: ${outcome.nextPermittedAt}`);
  lines.push("", `Summary: ${outcome.message}`, "");

  if (outcome.error !== null) {
    lines.push("## Error", "", `${outcome.error.name}: ${outcome.error.message}`, "");
  }

  lines.push("## Selected flyers", "");
  if (log.flyers.length === 0) lines.push("None selected.", "");
  else {
    lines.push(...table(
      ["Family", "Retailer", "Flyer", "Name", "Raw valid_from", "Raw valid_to", "Rows", "Detail requests", "Attestation"],
      log.flyers.map((flyer) => [flyer.family, flyer.retailer, flyer.id, flyer.name, flyer.valid_from, flyer.valid_to, flyer.rowCount, flyer.detailRequests, attestationText(flyer)]),
    ), "");
  }

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
    const failures = gateFailures(evaluation);
    lines.push(...(failures.length > 0 ? failures.map((reason) => `- ${reason}`) : ["- none"]), "");
    if (log.proofNotes.length > 0) lines.push("Proof assembly notes:", "", ...log.proofNotes.map((note) => `- ${note}`), "");
    const attestationProblems = log.flyers.flatMap((flyer) => flyer.attestation.problems);
    if (attestationProblems.length > 0) lines.push("Attestation problems:", "", ...attestationProblems.map((problem) => `- ${problem}`), "");

    const counted = new Set(PROOF_FAMILIES.flatMap((family) => evaluation.families[family].offerIds));
    const exclusions = new Map(evaluation.excluded.map((entry) => [entry.offerId, entry.reasons.join("; ")]));
    lines.push(`## In-scope offers (${snapshot.offers.length})`, "");
    lines.push(...table(
      ["Offer", "Source item", "Name", "Category", "Raw price", "Unit price", "comparisonKey or unknown fields", "Conditions",
        "Applicability", "Calendar rule", "Starts / expires", "Freshness", "Evidence", "Source URL", "Gate"],
      snapshot.offers.map((offer) => {
        const evidence = offer.evidence[0];
        const key = comparisonKey(offer.identity);
        const gate = counted.has(offer.id) ? "counted" : `excluded: ${exclusions.get(offer.id) ?? "source item already counted"}`;
        return [
          offer.id, evidence?.sourceItemId, offer.label, offer.identity.category, rawPriceText(offer), unitPriceText(offer),
          key ?? `unknown: ${identityGaps(offer.identity).join(", ")}`, conditionsText(offer), offer.applicability, offer.calendarRule,
          `${offer.startsAt ?? "unknown"} / ${offer.expiresAt ?? "unknown"}`, freshness(offer, evaluatedAt),
          evidence?.id, evidence?.sourceUrl, gate,
        ];
      }),
    ), "");

    const suggestions = candidatePairs(snapshot.offers);
    lines.push(`## Candidate cross-family pairs (${suggestions.length}; suggestions for human validation, not counted)`, "");
    if (suggestions.length === 0) lines.push("None.", "");
    else lines.push(...table(["Left", "Right", "Category", "comparisonKey", "Channel", "Basis"],
      suggestions.map((pair) => [pair.leftId, pair.rightId, pair.category, pair.comparisonKey, pair.channel, pair.basis])), "");

    lines.push(`## Counted pairs (${evaluation.countedPairs.length})`, "");
    if (evaluation.countedPairs.length === 0) lines.push("None.", "");
    else lines.push(...table(["Left", "Right", "Category"], evaluation.countedPairs.map((pair) => [pair.leftId, pair.rightId, pair.category])), "");

    lines.push(`## Skipped pairs (${evaluation.skippedPairs.length})`, "");
    if (evaluation.skippedPairs.length === 0) lines.push("None.", "");
    else lines.push(...table(["Left", "Right", "Category", "Reason"],
      evaluation.skippedPairs.map(({ pair, reason }) => [pair.leftId, pair.rightId, pair.category, reason])), "");
  }

  lines.push(`## Excluded list rows (${log.excludedRows.length})`, "");
  if (log.excludedRows.length === 0) lines.push("None.", "");
  else lines.push(...table(["Family", "Flyer", "Item", "Name", "Stage", "Reason"],
    log.excludedRows.map((row) => [row.family, row.flyerId, row.itemId, row.name, row.stage, row.reason])), "");

  return `${lines.join("\n").trimEnd()}\n`;
}
