import {
  REQUIRED_VERIFIED_FIELDS,
  type Evidence,
  type Family,
  type FlyerAttestation,
  type Offer,
  type Proof,
  type SourceSnapshot,
  type Validation,
  type ValidationFile,
} from "../shared/contracts.js";
import { freshness, isLocalTime } from "../shared/freshness.js";
import { comparisonKey, identityGaps } from "../shared/identity.js";
import { compareRational, isRational, makeRational } from "../shared/money.js";

// Source-proof gate (addendum R9, R10). Everything is recomputed from the
// records; no status string is trusted. Every exclusion carries a reason.

const FAMILIES: readonly Family[] = ["kroger", "albertsons", "pcc"];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MIN_SOURCE_ITEMS = 10;
const MIN_PAIRS = 5;
const ZERO = makeRational(0);

type Pair = Proof["pairs"][number];

export interface FamilyCount {
  count: number;
  produce: number;
  meat: number;
  sourceItemIds: string[];
  offerIds: string[];
}

export interface ProofEvaluation {
  ok: boolean;
  /** Gate failures first, then exclusions, skipped pairs and notes. */
  reasons: string[];
  families: Record<Family, FamilyCount>;
  excluded: Array<{ offerId: string; reasons: string[] }>;
  countedPairs: Pair[];
  skippedPairs: Array<{ pair: Pair; reason: string }>;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Evidence IDs embed the first 12 hex digits of the raw-response hash (R7). */
function idMatchesHash(id: string, evidence: Evidence): boolean {
  return SHA256_HEX.test(evidence.rawSha256) && id.endsWith(`:${evidence.rawSha256.slice(0, 12)}`);
}

function evidenceProblems(evidence: Evidence): string[] {
  const problems: string[] = [];
  const label = `evidence ${String(evidence.id)}`;
  if (!nonEmpty(evidence.id)) problems.push("evidence without an id");
  if (evidence.provider !== "flipp" && evidence.provider !== "pcc") problems.push(`${label} has an unknown provider`);
  if (!nonEmpty(evidence.sourceItemId)) problems.push(`${label} has no sourceItemId`);
  if (!nonEmpty(evidence.retrievedUrl)) problems.push(`${label} has no retrievedUrl`);
  if (!nonEmpty(evidence.sourceUrl)) problems.push(`${label} has no sourceUrl`);
  if (!isTimestamp(evidence.observedAt)) problems.push(`${label} has no observation time`);
  if (typeof evidence.rawValidity !== "object" || evidence.rawValidity === null) problems.push(`${label} has no raw validity`);
  if (nonEmpty(evidence.id) && !idMatchesHash(evidence.id, evidence)) problems.push(`${label} does not match its raw hash`);
  return problems;
}

/** Problems that stop a validation from counting (R9). Empty means valid. */
function validationProblems(validation: Validation, offer: Offer): string[] {
  const problems: string[] = [];
  if (!isTimestamp(validation.checkedAt)) problems.push("checkedAt is not a timestamp");
  const evidenceIds = Array.isArray(validation.evidenceIds) ? validation.evidenceIds : [];
  if (evidenceIds.length === 0) problems.push("no evidence IDs");
  for (const id of evidenceIds) {
    const evidence = offer.evidence.find((candidate) => candidate.id === id);
    if (!evidence) problems.push(`evidence ID ${id} is not on the offer`);
    else if (!idMatchesHash(id, evidence)) problems.push(`evidence ID ${id} does not match the raw hash`);
  }
  const verified = new Set(Array.isArray(validation.verifiedFields) ? validation.verifiedFields : []);
  const missing = REQUIRED_VERIFIED_FIELDS.filter((field) => !verified.has(field));
  if (missing.length > 0) problems.push(`verifiedFields missing ${missing.join(", ")}`);
  if (!nonEmpty(validation.applicabilityEvidence)) problems.push("applicabilityEvidence is empty");
  if (!nonEmpty(validation.calendarEvidence)) problems.push("calendarEvidence is empty");
  return problems;
}

function emptyCounts(): Record<Family, FamilyCount> {
  const counts = {} as Record<Family, FamilyCount>;
  for (const family of FAMILIES) counts[family] = { count: 0, produce: 0, meat: 0, sourceItemIds: [], offerIds: [] };
  return counts;
}

interface Qualified {
  offer: Offer;
  key: string;
  sourceItem: string;
}

/** Full gate evaluation for reports; checkProof returns its verdict. */
export function evaluateProof(snapshot: SourceSnapshot, now: Date): ProofEvaluation {
  const failures: string[] = [];
  const notes: string[] = [];
  const offers = Array.isArray(snapshot.offers) ? snapshot.offers : [];
  const proof: Partial<Proof> = snapshot.proof ?? {};
  const validations = Array.isArray(proof.validations) ? proof.validations : [];
  const pairs = Array.isArray(proof.pairs) ? proof.pairs : [];

  if (snapshot.schemaVersion !== 1) failures.push("snapshot schemaVersion must be 1");
  if (snapshot.postalCode !== "98105") failures.push("snapshot postalCode must be 98105");
  const families = proof.families;
  const familiesValid = Array.isArray(families) && families.length === 2 &&
    families.every((family) => FAMILIES.includes(family)) && families[0] !== families[1];
  if (!familiesValid) failures.push("proof families must name two distinct retailer families");
  const proofFamilies: readonly Family[] = familiesValid ? families : [];

  const offersById = new Map<string, number>();
  for (const offer of offers) offersById.set(offer.id, (offersById.get(offer.id) ?? 0) + 1);
  const validationsByOffer = new Map<string, Validation[]>();
  for (const validation of validations) {
    if (!offersById.has(validation.offerId)) {
      notes.push(`validation references unknown offer ${validation.offerId}`);
      continue;
    }
    validationsByOffer.set(validation.offerId, [...(validationsByOffer.get(validation.offerId) ?? []), validation]);
  }

  const excluded: ProofEvaluation["excluded"] = [];
  const qualified: Qualified[] = [];
  for (const offer of offers) {
    const why: string[] = [];
    if ((offersById.get(offer.id) ?? 0) > 1) why.push("duplicate offer id");
    if (!proofFamilies.includes(offer.family)) why.push(`family ${offer.family} is not one of the proof families`);

    const candidates = validationsByOffer.get(offer.id) ?? [];
    const problemSets = candidates.map((validation) => validationProblems(validation, offer));
    if (candidates.length === 0) why.push("no valid validation (none provided)");
    else if (!problemSets.some((problems) => problems.length === 0)) why.push(`no valid validation (${problemSets.flat().join("; ")})`);

    if (offer.applicability !== "verified") why.push("applicability is not verified");
    if (offer.calendarRule === "unknown") why.push("calendar rule is unknown");
    const state = freshness(offer, now);
    if (state !== "fresh") why.push(`freshness is ${state}`);
    // A future observation would otherwise stay "fresh" beyond 24h of real time.
    if (Date.parse(offer.observedAt) > now.getTime()) why.push("observedAt is after the check time");

    if (offer.unitPrice === null) why.push("no unit price");
    else if (!isRational(offer.unitPrice.cents)) why.push("unit price is not a valid rational");
    else if (compareRational(offer.unitPrice.cents, ZERO) <= 0) why.push("unit price is not positive");

    const key = comparisonKey(offer.identity);
    if (key === null) why.push(`no comparisonKey (unknown or unsupported identity fields: ${identityGaps(offer.identity).join(", ")})`);

    const evidence = Array.isArray(offer.evidence) ? offer.evidence : [];
    if (evidence.length === 0) why.push("no evidence");
    for (const item of evidence) why.push(...evidenceProblems(item));
    const sourceItems = new Set(evidence.map((item) => `${item.provider}:${item.sourceItemId}`));
    if (evidence.length > 0 && sourceItems.size !== 1) why.push("evidence must name exactly one source item");

    if (offer.normalizationIssue !== null) why.push(`has a normalization issue: ${offer.normalizationIssue}`);

    if (why.length > 0 || key === null) excluded.push({ offerId: offer.id, reasons: why });
    else qualified.push({ offer, key, sourceItem: [...sourceItems][0] ?? "" });
  }

  // Per family: distinct original source items, so duplicates never add.
  const counts = emptyCounts();
  for (const { offer, sourceItem } of qualified) {
    const family = counts[offer.family];
    if (family.sourceItemIds.includes(sourceItem)) {
      notes.push(`${offer.family}: source item ${sourceItem} already counted; ${offer.id} adds nothing`);
      continue;
    }
    family.sourceItemIds.push(sourceItem);
    family.offerIds.push(offer.id);
    family.count += 1;
    family[offer.identity.category] += 1;
  }
  for (const family of proofFamilies) {
    const { count, produce, meat } = counts[family];
    if (count < MIN_SOURCE_ITEMS) failures.push(`${family}: ${count} qualifying source items (need at least ${MIN_SOURCE_ITEMS})`);
    if (produce === 0) failures.push(`${family}: no qualifying produce`);
    if (meat === 0) failures.push(`${family}: no qualifying meat`);
  }

  // Pairs: counted greedily in listed order; a source item counts once.
  const byId = new Map<string, Qualified>();
  for (const entry of qualified) byId.set(entry.offer.id, entry);
  const usedItems = new Set<string>();
  const countedPairs: Pair[] = [];
  const skippedPairs: ProofEvaluation["skippedPairs"] = [];
  for (const pair of pairs) {
    const left = byId.get(pair.leftId);
    const right = byId.get(pair.rightId);
    let reason: string | null = null;
    if (!left) reason = `${pair.leftId} is not a qualifying offer`;
    else if (!right) reason = `${pair.rightId} is not a qualifying offer`;
    else if (left.offer.family === right.offer.family) reason = "both sides are from the same family";
    else if (left.key !== right.key) reason = "comparisonKey differs";
    else if (left.offer.channel !== right.offer.channel) reason = "channel differs";
    else if (left.offer.unitPrice?.basis !== right.offer.unitPrice?.basis) reason = "unit basis differs";
    else if (pair.category !== left.offer.identity.category || pair.category !== right.offer.identity.category) {
      reason = `declared category ${pair.category} does not match the offers`;
    } else if (usedItems.has(`${left.offer.family}|${left.sourceItem}`) || usedItems.has(`${right.offer.family}|${right.sourceItem}`)) {
      reason = "a source item is already counted in an earlier pair";
    }
    if (reason !== null || !left || !right) {
      skippedPairs.push({ pair, reason: reason ?? "invalid pair" });
      continue;
    }
    usedItems.add(`${left.offer.family}|${left.sourceItem}`);
    usedItems.add(`${right.offer.family}|${right.sourceItem}`);
    countedPairs.push(pair);
  }
  if (countedPairs.length < MIN_PAIRS) failures.push(`${countedPairs.length} counted pairs (need at least ${MIN_PAIRS})`);
  if (!countedPairs.some((pair) => pair.category === "produce")) failures.push("no counted produce pair");
  if (!countedPairs.some((pair) => pair.category === "meat")) failures.push("no counted meat pair");

  const reasons = [
    ...failures,
    ...excluded.map(({ offerId, reasons: why }) => `excluded ${offerId}: ${why.join("; ")}`),
    ...skippedPairs.map(({ pair, reason }) => `pair ${pair.leftId} + ${pair.rightId} skipped: ${reason}`),
    ...notes,
  ];
  return { ok: failures.length === 0, reasons, families: counts, excluded, countedPairs, skippedPairs };
}

/** R10 gate verdict with every failure and exclusion reason. */
export function checkProof(snapshot: SourceSnapshot, now: Date): { ok: boolean; reasons: string[] } {
  const { ok, reasons } = evaluateProof(snapshot, now);
  return { ok, reasons };
}

function attestationProblems(attestation: FlyerAttestation): string[] {
  const problems: string[] = [];
  if (attestation.applicability !== "verified") problems.push("applicability must be verified");
  if (attestation.calendarRule !== "verified-local-date") problems.push("calendarRule must be verified-local-date");
  if (!nonEmpty(attestation.applicabilityEvidence)) problems.push("applicabilityEvidence is empty");
  if (!nonEmpty(attestation.calendarEvidence)) problems.push("calendarEvidence is empty");
  if (!isTimestamp(attestation.checkedAt)) problems.push("checkedAt is not a timestamp");
  if (!isLocalTime(attestation.startLocalTime)) problems.push("startLocalTime must be 24-hour HH:MM (00:00-23:59)");
  return problems;
}

/**
 * Per-flyer attestation (R8/R9): applicability and calendar are verified only
 * for an exactly matching family and flyer ID with complete evidence and a
 * valid printed start time. Everything else stays unknown.
 */
export function attestationFor(file: ValidationFile | null, family: Family, flyerId: number): {
  applicability: "verified" | "unknown";
  calendarRule: "verified-local-date" | "unknown";
  startLocalTime: string | null;
  attestation: FlyerAttestation | null;
  problems: string[];
} {
  const problems: string[] = [];
  const none = () => ({ applicability: "unknown" as const, calendarRule: "unknown" as const, startLocalTime: null, attestation: null, problems });
  const matches = (file?.attestations ?? []).filter((entry) => entry.family === family && entry.flyerId === flyerId);
  const valid: FlyerAttestation[] = [];
  for (const entry of matches) {
    const entryProblems = attestationProblems(entry);
    if (entryProblems.length > 0) problems.push(...entryProblems.map((problem) => `${family} flyer ${flyerId}: ${problem}`));
    else valid.push(entry);
  }
  const first = valid[0];
  if (!first) return none();
  if (valid.some((entry) => entry.startLocalTime !== first.startLocalTime)) {
    problems.push(`${family} flyer ${flyerId}: attestations disagree on startLocalTime`);
    return none();
  }
  return { applicability: "verified", calendarRule: "verified-local-date", startLocalTime: first.startLocalTime, attestation: first, problems };
}

/**
 * Builds a snapshot proof from the human validation file and this run's
 * offers. Entries for offers not collected in this run are dropped with a note;
 * everything else is judged by checkProof.
 */
export function assembleProof(
  file: ValidationFile | null,
  offers: Offer[],
  families: [Family, Family],
  validatedAt: string,
): { proof: Proof; notes: string[] } {
  const notes: string[] = [];
  if (!file) {
    notes.push("no validation file: nothing is verified");
    return { proof: { validatedAt, families: [families[0], families[1]], validations: [], pairs: [] }, notes };
  }
  const ids = new Set(offers.map((offer) => offer.id));
  const validations = file.validations.filter((validation) => {
    if (ids.has(validation.offerId)) return true;
    notes.push(`validation for ${validation.offerId} dropped: offer not collected in this run`);
    return false;
  });
  const pairs = file.pairs.filter((pair) => {
    if (ids.has(pair.leftId) && ids.has(pair.rightId)) return true;
    notes.push(`pair ${pair.leftId} + ${pair.rightId} dropped: offer not collected in this run`);
    return false;
  });
  return {
    proof: {
      validatedAt,
      families: [families[0], families[1]],
      validations: validations.map((validation) => ({ ...validation, evidenceIds: [...validation.evidenceIds], verifiedFields: [...validation.verifiedFields] })),
      pairs: pairs.map((pair) => ({ ...pair })),
    },
    notes,
  };
}

/**
 * Candidate cross-family pairs for the report (R11): same comparisonKey,
 * channel and unit basis with a positive unit price. Suggestions only; a
 * human still chooses and checks pairs.
 */
export function candidatePairs(offers: Offer[]): Array<{
  leftId: string;
  rightId: string;
  category: "produce" | "meat";
  comparisonKey: string;
  channel: Offer["channel"];
  basis: "lb" | "each";
}> {
  const entries = offers.flatMap((offer) => {
    const key = comparisonKey(offer.identity);
    const price = offer.unitPrice;
    if (key === null || price === null || !isRational(price.cents) || compareRational(price.cents, ZERO) <= 0) return [];
    return [{ offer, key, basis: price.basis }];
  });
  const candidates: ReturnType<typeof candidatePairs> = [];
  entries.forEach((left, index) => {
    for (const right of entries.slice(index + 1)) {
      if (left.offer.family === right.offer.family || left.key !== right.key) continue;
      if (left.offer.channel !== right.offer.channel || left.basis !== right.basis) continue;
      candidates.push({
        leftId: left.offer.id,
        rightId: right.offer.id,
        category: left.offer.identity.category,
        comparisonKey: left.key,
        channel: left.offer.channel,
        basis: left.basis,
      });
    }
  });
  return candidates;
}
