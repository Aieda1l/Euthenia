import {
  REQUIRED_VERIFIED_FIELDS,
  type Channel,
  type Evidence,
  type Family,
  type FlyerAttestation,
  type Offer,
  type Proof,
  type SourceSnapshot,
  type Validation,
  type ValidationFile,
} from "../shared/contracts.js";
import { freshness, isLocalTime, isTimestamp, parseTimestamp } from "../shared/freshness.js";
import { comparisonKey, identityGaps } from "../shared/identity.js";
import { compareRational, isRational, makeRational } from "../shared/money.js";

// Source-proof gate (addendum R9, R10, amended by A7/A8). Everything is
// recomputed from the records; no status string is trusted. Every exclusion
// carries a reason, and malformed entries are excluded rather than thrown.

const FAMILIES: readonly Family[] = ["kroger", "albertsons", "pcc"];
const CHANNELS: readonly Channel[] = ["in-store-ad", "retailer-pickup", "retailer-delivery", "instacart-pickup", "instacart-delivery"];
const APPLICABILITY: readonly unknown[] = ["verified", "unknown"];
const CALENDAR_RULES: readonly unknown[] = ["verified-local-date", "explicit-instant", "unknown"];
const KNOWN_STATES: readonly unknown[] = ["known", "not-applicable", "unknown"];
const IDENTITY_FIELDS = {
  produce: ["kind", "variety", "form", "organic"],
  meat: ["species", "cut", "bone", "skin", "freshFrozen", "fatPercent"],
} as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE_ITEM_ID = /^[1-9]\d*$/;
const FLIPP_ITEM_URL = "https://backflipp.wishabi.com/flipp/items/";
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
  /** Gate failures only (empty exactly when ok). */
  failures: string[];
  /** Non-failing notes, e.g. validations for offers that do not exist. */
  notes: string[];
  families: Record<Family, FamilyCount>;
  excluded: Array<{ offerId: string; reasons: string[] }>;
  countedPairs: Pair[];
  skippedPairs: Array<{ pair: Pair; reason: string }>;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A7: the exact R7 evidence id, flipp:item:<sourceItemId>:<first 12 hex of rawSha256>. */
function r7EvidenceId(evidence: Evidence): string {
  return `flipp:item:${evidence.sourceItemId}:${evidence.rawSha256.slice(0, 12)}`;
}

/** True when `id` is the exact R7 id of well-formed evidence (A7). */
function idMatchesHash(id: unknown, evidence: Evidence): boolean {
  return typeof evidence.rawSha256 === "string" && SHA256_HEX.test(evidence.rawSha256) && id === r7EvidenceId(evidence);
}

/** A7: M1 counts only Flipp evidence in the exact R7 shape. */
function evidenceProblems(evidence: Evidence): string[] {
  const problems: string[] = [];
  const label = `evidence ${String(evidence.id)}`;
  if (evidence.provider !== "flipp") problems.push(`${label} has provider ${JSON.stringify(evidence.provider)}; only flipp evidence counts in M1`);
  if (typeof evidence.sourceItemId !== "string" || !SOURCE_ITEM_ID.test(evidence.sourceItemId)) {
    problems.push(`${label} has no numeric Flipp sourceItemId`);
  }
  if (typeof evidence.rawSha256 !== "string" || !SHA256_HEX.test(evidence.rawSha256)) problems.push(`${label} has no SHA-256 raw hash`);
  else if (!idMatchesHash(evidence.id, evidence)) {
    problems.push(`${label} does not match its raw hash and source item (R7 id flipp:item:<sourceItemId>:<first 12 hex of rawSha256>)`);
  }
  if (evidence.retrievedUrl !== `${FLIPP_ITEM_URL}${String(evidence.sourceItemId)}`) {
    problems.push(`${label} retrievedUrl is not ${FLIPP_ITEM_URL}<sourceItemId>`);
  }
  if (!nonEmpty(evidence.sourceUrl)) problems.push(`${label} has no sourceUrl`);
  if (!isTimestamp(evidence.observedAt)) problems.push(`${label} has no strict ISO 8601 observation time`);
  if (!isRecord(evidence.rawValidity)) problems.push(`${label} has no raw validity`);
  return problems;
}

function isKnownShape(value: unknown): boolean {
  return isRecord(value) && KNOWN_STATES.includes(value.state);
}

/**
 * A7: problems that make a snapshot entry unusable. Checked before anything
 * else reads the entry, so a malformed entry is excluded with a reason and
 * never throws.
 */
function offerShapeProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["entry is not an offer object"];
  const problems: string[] = [];
  if (!nonEmpty(value.id)) problems.push("offer has no id");
  if (!FAMILIES.includes(value.family as Family)) problems.push(`family ${JSON.stringify(value.family)} is not a known family`);
  if (!CHANNELS.includes(value.channel as Channel)) problems.push(`channel ${JSON.stringify(value.channel)} is not a known channel`);
  if (!APPLICABILITY.includes(value.applicability)) problems.push(`applicability ${JSON.stringify(value.applicability)} is out of range`);
  if (!CALENDAR_RULES.includes(value.calendarRule)) problems.push(`calendarRule ${JSON.stringify(value.calendarRule)} is out of range`);
  const identity = value.identity;
  if (!isRecord(identity)) problems.push("identity is missing");
  else if (identity.category !== "produce" && identity.category !== "meat") {
    problems.push(`identity category ${JSON.stringify(identity.category)} is outside produce/meat`);
  } else {
    for (const field of IDENTITY_FIELDS[identity.category]) {
      if (!isKnownShape(identity[field])) problems.push(`identity.${field} is not a Known value`);
    }
  }
  const price = value.unitPrice;
  if (price !== null && !(isRecord(price) && (price.basis === "lb" || price.basis === "each") && isRational(price.cents))) {
    problems.push("unitPrice is malformed");
  }
  if (value.normalizationIssue !== null && typeof value.normalizationIssue !== "string") problems.push("normalizationIssue is malformed");
  if (!Array.isArray(value.evidence)) problems.push("evidence is not an array");
  else if (!value.evidence.every(isRecord)) problems.push("evidence has a non-object entry");
  return problems;
}

/** Problems that stop a validation from counting (R9). Empty means valid. */
function validationProblems(validation: Validation, offer: Offer): string[] {
  const problems: string[] = [];
  if (!isTimestamp(validation.checkedAt)) problems.push("checkedAt is not a strict ISO 8601 timestamp");
  const evidenceIds = Array.isArray(validation.evidenceIds) ? validation.evidenceIds : [];
  if (evidenceIds.length === 0) problems.push("no evidence IDs");
  for (const id of evidenceIds) {
    const evidence = offer.evidence.find((candidate) => candidate.id === id);
    if (!evidence) problems.push(`evidence ID ${String(id)} is not on the offer`);
    else if (!idMatchesHash(id, evidence)) problems.push(`evidence ID ${String(id)} does not match the raw hash`);
  }
  const verified = new Set(Array.isArray(validation.verifiedFields) ? validation.verifiedFields : []);
  const missing = REQUIRED_VERIFIED_FIELDS.filter((field) => !verified.has(field));
  if (missing.length > 0) problems.push(`verifiedFields missing ${missing.join(", ")}`);
  if (!nonEmpty(validation.applicabilityEvidence)) problems.push("applicabilityEvidence is empty");
  if (!nonEmpty(validation.calendarEvidence)) problems.push("calendarEvidence is empty");
  return problems;
}

/**
 * The validations that count for `offer` under R9: those naming it with no
 * validation problem (the same checks as evaluateProof). Malformed entries are skipped.
 */
export function validValidationsFor(offer: Offer, validations: readonly unknown[]): Validation[] {
  return validations.filter((validation): validation is Validation =>
    isRecord(validation) && validation.offerId === offer.id && validationProblems(validation as unknown as Validation, offer).length === 0);
}

function emptyCounts(): Record<Family, FamilyCount> {
  const counts = {} as Record<Family, FamilyCount>;
  for (const family of FAMILIES) counts[family] = { count: 0, produce: 0, meat: 0, sourceItemIds: [], offerIds: [] };
  return counts;
}

interface Qualified {
  offer: Offer;
  key: string;
  /** Bare Flipp source item ID; counts and pairs are keyed by it alone (A7). */
  sourceItem: string;
}

/** A8: a dated calendar rule needs strict startsAt < expiresAt. */
function calendarProblems(offer: Offer): string[] {
  if (offer.calendarRule === "unknown") return ["calendar rule is unknown"];
  const problems: string[] = [];
  const starts = parseTimestamp(offer.startsAt);
  const expires = parseTimestamp(offer.expiresAt);
  if (starts === null) problems.push(`calendar rule ${offer.calendarRule} without a strict ISO 8601 startsAt`);
  if (expires === null) problems.push(`calendar rule ${offer.calendarRule} without a strict ISO 8601 expiresAt`);
  if (starts !== null && expires !== null && starts >= expires) problems.push("startsAt is not before expiresAt");
  return problems;
}

/**
 * Full gate evaluation for reports; checkProof returns its verdict. Throws
 * only for an invalid `now` (a caller error, as in freshness).
 */
export function evaluateProof(snapshot: SourceSnapshot, now: Date): ProofEvaluation {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (Number.isNaN(nowMs)) throw new Error("evaluateProof: now must be a valid Date");
  const failures: string[] = [];
  const notes: string[] = [];
  const root: Partial<SourceSnapshot> = isRecord(snapshot) ? snapshot : {};
  if (!isRecord(snapshot)) failures.push("snapshot is not an object");
  const entries: unknown[] = Array.isArray(root.offers) ? root.offers : [];
  const proof: Partial<Proof> = isRecord(root.proof) ? root.proof : {};
  const validations: unknown[] = Array.isArray(proof.validations) ? proof.validations : [];
  const pairs: unknown[] = Array.isArray(proof.pairs) ? proof.pairs : [];

  if (root.schemaVersion !== 1) failures.push("snapshot schemaVersion must be 1");
  if (root.postalCode !== "98105") failures.push("snapshot postalCode must be 98105");
  const families = proof.families;
  const familiesValid = Array.isArray(families) && families.length === 2 &&
    families.every((family) => FAMILIES.includes(family)) && families[0] !== families[1];
  if (!familiesValid) failures.push("proof families must name two distinct retailer families");
  const proofFamilies: readonly Family[] = familiesValid ? families : [];

  const excluded: ProofEvaluation["excluded"] = [];
  const offers: Offer[] = [];
  entries.forEach((entry, index) => {
    const problems = offerShapeProblems(entry);
    if (problems.length === 0) offers.push(entry as Offer);
    else {
      const id = isRecord(entry) && nonEmpty(entry.id) ? String(entry.id) : `offers[${index}]`;
      excluded.push({ offerId: id, reasons: [`malformed offer: ${problems.join("; ")}`] });
    }
  });

  const offersById = new Map<string, number>();
  for (const offer of offers) offersById.set(offer.id, (offersById.get(offer.id) ?? 0) + 1);
  const validationsByOffer = new Map<string, Validation[]>();
  validations.forEach((validation, index) => {
    if (!isRecord(validation) || typeof validation.offerId !== "string") {
      notes.push(`validations[${index}] is malformed and was ignored`);
      return;
    }
    if (!offersById.has(validation.offerId)) {
      notes.push(`validation references unknown offer ${validation.offerId}`);
      return;
    }
    validationsByOffer.set(validation.offerId, [...(validationsByOffer.get(validation.offerId) ?? []), validation as unknown as Validation]);
  });

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
    why.push(...calendarProblems(offer));
    const state = freshness(offer, now);
    if (state !== "fresh") why.push(`freshness is ${state}`);
    // A future observation would otherwise stay "fresh" beyond 24h of real time.
    const observed = parseTimestamp(offer.observedAt);
    if (observed === null) why.push("observedAt is not a strict ISO 8601 timestamp");
    else if (observed > nowMs) why.push("observedAt is after the check time");

    if (offer.unitPrice === null) why.push("no unit price");
    else if (compareRational(offer.unitPrice.cents, ZERO) <= 0) why.push("unit price is not positive");

    const evidence = offer.evidence;
    if (evidence.length === 0) why.push("no evidence");
    for (const item of evidence) why.push(...evidenceProblems(item));
    const sourceItems = new Set(evidence.map((item) => String(item.sourceItemId)));
    if (evidence.length > 0 && sourceItems.size !== 1) why.push("evidence must name exactly one source item");
    const [sourceItem = ""] = sourceItems;
    // A7: Offer.id is exactly flipp:<family>:<sourceItemId> (R7).
    if (sourceItems.size === 1 && offer.id !== `flipp:${offer.family}:${sourceItem}`) {
      why.push(`offer id ${offer.id} is not the R7 id flipp:${offer.family}:${sourceItem}`);
    }

    if (offer.normalizationIssue !== null) why.push(`has a normalization issue: ${offer.normalizationIssue}`);

    const key = comparisonKey(offer.identity);
    if (key === null) {
      why.push(`no comparisonKey (unknown or unsupported identity fields: ${identityGaps(offer.identity).join(", ")})`);
      excluded.push({ offerId: offer.id, reasons: why });
    } else if (why.length > 0) {
      excluded.push({ offerId: offer.id, reasons: why });
    } else {
      qualified.push({ offer, key, sourceItem });
    }
  }

  // Per family: distinct original source items. Keyed by the source item ID
  // alone (A7), so duplicates never add, even across families.
  const counts = emptyCounts();
  const countedItems = new Map<string, string>();
  for (const { offer, sourceItem } of qualified) {
    const countedAs = countedItems.get(sourceItem);
    if (countedAs !== undefined) {
      notes.push(`source item ${sourceItem} already counted as ${countedAs}; ${offer.id} adds nothing`);
      continue;
    }
    countedItems.set(sourceItem, offer.id);
    const family = counts[offer.family];
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
  pairs.forEach((entry, index) => {
    if (!isRecord(entry)) {
      notes.push(`pairs[${index}] is malformed and was skipped`);
      return;
    }
    const pair = entry as unknown as Pair;
    const left = typeof pair.leftId === "string" ? byId.get(pair.leftId) : undefined;
    const right = typeof pair.rightId === "string" ? byId.get(pair.rightId) : undefined;
    let reason: string | null = null;
    if (!left) reason = `${String(pair.leftId)} is not a qualifying offer`;
    else if (!right) reason = `${String(pair.rightId)} is not a qualifying offer`;
    else if (left.offer.family === right.offer.family) reason = "both sides are from the same family";
    else if (left.sourceItem === right.sourceItem) reason = "both sides are the same source item";
    else if (countedItems.get(left.sourceItem) !== left.offer.id || countedItems.get(right.sourceItem) !== right.offer.id) {
      reason = "a side's source item is already counted as another offer";
    } else if (left.key !== right.key) reason = "comparisonKey differs";
    else if (left.offer.channel !== right.offer.channel) reason = "channel differs";
    else if (left.offer.unitPrice?.basis !== right.offer.unitPrice?.basis) reason = "unit basis differs";
    else if (pair.category !== left.offer.identity.category || pair.category !== right.offer.identity.category) {
      reason = `declared category ${String(pair.category)} does not match the offers`;
    } else if (usedItems.has(left.sourceItem) || usedItems.has(right.sourceItem)) {
      reason = "a source item is already counted in an earlier pair";
    }
    if (reason !== null || !left || !right) {
      skippedPairs.push({ pair, reason: reason ?? "invalid pair" });
      return;
    }
    usedItems.add(left.sourceItem);
    usedItems.add(right.sourceItem);
    countedPairs.push(pair);
  });
  if (countedPairs.length < MIN_PAIRS) failures.push(`${countedPairs.length} counted pairs (need at least ${MIN_PAIRS})`);
  if (!countedPairs.some((pair) => pair.category === "produce")) failures.push("no counted produce pair");
  if (!countedPairs.some((pair) => pair.category === "meat")) failures.push("no counted meat pair");

  const reasons = [
    ...failures,
    ...excluded.map(({ offerId, reasons: why }) => `excluded ${offerId}: ${why.join("; ")}`),
    ...skippedPairs.map(({ pair, reason }) => `pair ${String(pair.leftId)} + ${String(pair.rightId)} skipped: ${reason}`),
    ...notes,
  ];
  return { ok: failures.length === 0, reasons, failures, notes, families: counts, excluded, countedPairs, skippedPairs };
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
  if (!isTimestamp(attestation.checkedAt)) problems.push("checkedAt is not a strict ISO 8601 timestamp");
  if (!isLocalTime(attestation.startLocalTime)) problems.push("startLocalTime must be 24-hour HH:MM (00:00-23:59)");
  return problems;
}

/**
 * Per-flyer attestation (R8/R9): applicability and calendar are verified only
 * for an exactly matching family and flyer ID with complete evidence and a
 * valid printed start time. A8: any invalid attestation for the flyer, or
 * valid ones that disagree, leave it unknown. Everything else stays unknown.
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
  const attestations: unknown[] = Array.isArray(file?.attestations) ? file.attestations : [];
  const matches = attestations.filter((entry): entry is FlyerAttestation =>
    isRecord(entry) && entry.family === family && entry.flyerId === flyerId);
  for (const entry of matches) {
    problems.push(...attestationProblems(entry).map((problem) => `${family} flyer ${flyerId}: ${problem}`));
  }
  const first = matches[0];
  if (!first || problems.length > 0) return none();
  if (matches.some((entry) => entry.startLocalTime !== first.startLocalTime)) {
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
