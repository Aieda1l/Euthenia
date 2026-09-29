import {
  REQUIRED_VERIFIED_FIELDS,
  type Channel,
  type Evidence,
  type Family,
  type FlyerAttestation,
  type Offer,
  type Proof,
  type SourceSnapshot,
  type StoreAttestation,
  type Validation,
  type ValidationFile,
} from "../shared/contracts.js";
import { STALE_AFTER_MS, freshness, isLocalTime, isTimestamp, parseTimestamp } from "../shared/freshness.js";
import { comparisonKey, identityGaps } from "../shared/identity.js";
import { compareRational, isRational, makeRational } from "../shared/money.js";

// Source-proof gate (addendum R9, R10, amended by A7/A8 and by the catalog
// price amendment, section 3). Everything is recomputed from the records; no
// status string is trusted. Every exclusion carries a reason, and malformed
// entries are excluded rather than thrown. The gate evaluates exactly one
// channel, proof.channel; counts never add across channels.

const FAMILIES: readonly Family[] = ["kroger", "albertsons", "pcc"];
const CHANNELS: readonly Channel[] = ["in-store-ad", "retailer-pickup", "retailer-delivery", "instacart-pickup", "instacart-delivery"];
const APPLICABILITY: readonly unknown[] = ["verified", "unknown"];
const CALENDAR_RULES: readonly unknown[] = ["verified-local-date", "explicit-instant", "catalog-observation", "unknown"];
const KNOWN_STATES: readonly unknown[] = ["known", "not-applicable", "unknown"];
const IDENTITY_FIELDS = {
  produce: ["kind", "variety", "form", "organic"],
  meat: ["species", "cut", "bone", "skin", "freshFrozen", "fatPercent"],
} as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE_ITEM_ID = /^[1-9]\d*$/;
const FLIPP_ITEM_URL = "https://backflipp.wishabi.com/flipp/items/";
type CatalogProvider = StoreAttestation["provider"];
/** Rule 2: the one family each catalog provider may serve. */
const CATALOG_PROVIDER_FAMILY: Readonly<Record<CatalogProvider, Family>> = { "kroger-api": "kroger", "safeway-search": "albertsons" };
/** Rule 2: a Kroger productId is exactly 13 digits; leading zeros are significant. */
const KROGER_PRODUCT_ID = /^\d{13}$/;
const KROGER_PRODUCTS_URL = "https://api.kroger.com/v1/products?";
/** Rule 2: a Kroger filter.locationId is 8 digits (division + store). */
const KROGER_LOCATION_ID = /^\d{8}$/;
/** DEC-20260928-002 D1: catalog prices are labeled and validated as retailer-pickup. */
const CATALOG_CHANNEL: Channel = "retailer-pickup";
const MIN_SOURCE_ITEMS = 10;
const MIN_PAIRS = 5;
const ZERO = makeRational(0);

type Pair = Proof["pairs"][number];

export interface FamilyCount {
  count: number;
  produce: number;
  meat: number;
  /** Bare source item IDs of the counted offers, for display; counting is keyed by `<provider>:<sourceItemId>` (rule 5). */
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

function isCatalogProvider(value: unknown): value is CatalogProvider {
  return value === "kroger-api" || value === "safeway-search";
}

/** Rule 2: null when a catalog provider may serve `family`, else the reason. */
function providerFamilyProblem(provider: unknown, family: unknown): string | null {
  if (!isCatalogProvider(provider)) return `provider ${JSON.stringify(provider)} is not a catalog provider`;
  const allowed = CATALOG_PROVIDER_FAMILY[provider];
  return family === allowed ? null : `provider ${provider} is allowed only for family ${allowed}`;
}

/**
 * The exact evidence id for its provider: flipp:item:<sourceItemId>:<hash12>
 * (R7/A7), or <provider>:product:<sourceItemId>:<hash12> for a catalog
 * provider (section 3). Null for any other provider. Needs a valid rawSha256.
 */
function expectedEvidenceId(evidence: Evidence): string | null {
  const hash12 = evidence.rawSha256.slice(0, 12);
  if (evidence.provider === "flipp") return `flipp:item:${evidence.sourceItemId}:${hash12}`;
  if (isCatalogProvider(evidence.provider)) return `${evidence.provider}:product:${evidence.sourceItemId}:${hash12}`;
  return null;
}

/** True when `id` is the exact evidence id of well-formed evidence (A7 and its catalog analogue). */
function idMatchesHash(id: unknown, evidence: Evidence): boolean {
  return typeof evidence.rawSha256 === "string" && SHA256_HEX.test(evidence.rawSha256) && id === expectedEvidenceId(evidence);
}

/**
 * Rule 2: the single 8-digit filter.locationId of a Kroger products request
 * URL (https://api.kroger.com/v1/products?...), or null for any other URL. The
 * fixed prefix also rules out another scheme, host, port, path or userinfo.
 */
function krogerLocationId(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(KROGER_PRODUCTS_URL) || url.includes("#")) return null;
  let ids: string[];
  try {
    ids = new URL(url).searchParams.getAll("filter.locationId");
  } catch {
    return null;
  }
  const [id] = ids;
  return ids.length === 1 && id !== undefined && KROGER_LOCATION_ID.test(id) ? id : null;
}

/** Rule 4: the store scope a catalog evidence URL names, or null. */
function storeScope(evidence: Evidence): string | null {
  if (evidence.provider !== "kroger-api") return null;
  const id = krogerLocationId(evidence.retrievedUrl);
  return id === null ? null : `filter.locationId=${id}`;
}

/** Rule 5: counts and used items are keyed by <provider>:<sourceItemId>. */
function itemKey(evidence: Evidence): string {
  return `${String(evidence.provider)}:${String(evidence.sourceItemId)}`;
}

/** A7: Flipp evidence in the exact R7 shape. Unchanged by the catalog amendment. */
function flippEvidenceProblems(evidence: Evidence, label: string): string[] {
  const problems: string[] = [];
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
  return problems;
}

/** Rule 2: kroger-api evidence for family kroger, a 13-digit productId and a store-scoped products URL. */
function krogerEvidenceProblems(evidence: Evidence, family: Family, label: string): string[] {
  const problems: string[] = [];
  const familyProblem = providerFamilyProblem(evidence.provider, family);
  if (familyProblem !== null) problems.push(`${label}: ${familyProblem}, not ${family}`);
  if (typeof evidence.sourceItemId !== "string" || !KROGER_PRODUCT_ID.test(evidence.sourceItemId)) {
    problems.push(`${label} has no 13-digit Kroger productId sourceItemId`);
  }
  if (typeof evidence.rawSha256 !== "string" || !SHA256_HEX.test(evidence.rawSha256)) problems.push(`${label} has no SHA-256 raw hash`);
  else if (!idMatchesHash(evidence.id, evidence)) {
    problems.push(`${label} does not match its raw hash and source item (catalog id kroger-api:product:<sourceItemId>:<first 12 hex of rawSha256>)`);
  }
  if (krogerLocationId(evidence.retrievedUrl) === null) {
    problems.push(`${label} retrievedUrl is not ${KROGER_PRODUCTS_URL}... with exactly one 8-digit filter.locationId`);
  }
  return problems;
}

/**
 * A7 for Flipp; section 3 rule 2 for catalog providers. Any other provider is
 * excluded. Catalog evidence may carry rawValidity {} (no validity window).
 */
function evidenceProblems(evidence: Evidence, family: Family): string[] {
  const label = `evidence ${String(evidence.id)}`;
  const problems: string[] = [];
  if (evidence.provider === "flipp") problems.push(...flippEvidenceProblems(evidence, label));
  else if (evidence.provider === "kroger-api") problems.push(...krogerEvidenceProblems(evidence, family, label));
  else if (evidence.provider === "safeway-search") {
    // TODO(S1): S1 sets the safeway-search rule-2 pattern (sourceItemId,
    // retrievedUrl and its storeid scope, family albertsons only). Until then
    // no safeway-search evidence can count (fail closed).
    return [`${label}: safeway-search evidence is excluded until S1 defines its pattern`];
  } else {
    problems.push(`${label} has provider ${JSON.stringify(evidence.provider)}; only flipp and kroger-api evidence can count (safeway-search after S1)`);
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

/**
 * Problems that stop a validation from counting (R9). Empty means valid.
 * With `nowMs`, a validation checked after the gate's check time never counts.
 */
function validationProblems(validation: Validation, offer: Offer, nowMs?: number): string[] {
  const problems: string[] = [];
  const checked = parseTimestamp(validation.checkedAt);
  if (checked === null) problems.push("checkedAt is not a strict ISO 8601 timestamp");
  else {
    if (nowMs !== undefined && checked > nowMs) problems.push("checkedAt is after the check time");
    // Section 4 / D5: a catalog price is checked on the retailer site within
    // 24 h after it was observed, so an older or earlier check never binds.
    if (offer.evidence.some((evidence) => isCatalogProvider(evidence.provider))) {
      const observed = parseTimestamp(offer.observedAt);
      if (observed === null || checked < observed || checked - observed > STALE_AFTER_MS) {
        problems.push("catalog validation checkedAt is not within 24 h after observedAt");
      }
    }
  }
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
 * validation problem (the same checks as evaluateProof when given the same
 * check time `now`). Malformed entries are skipped.
 */
export function validValidationsFor(offer: Offer, validations: readonly unknown[], now?: Date): Validation[] {
  const nowMs = now === undefined ? undefined : now.getTime();
  return validations.filter((validation): validation is Validation =>
    isRecord(validation) && validation.offerId === offer.id && validationProblems(validation as unknown as Validation, offer, nowMs).length === 0);
}

function emptyCounts(): Record<Family, FamilyCount> {
  const counts = {} as Record<Family, FamilyCount>;
  for (const family of FAMILIES) counts[family] = { count: 0, produce: 0, meat: 0, sourceItemIds: [], offerIds: [] };
  return counts;
}

interface Qualified {
  offer: Offer;
  key: string;
  /** Bare source item ID, for display. */
  sourceItem: string;
  /** Rule 5: counts and pairs are keyed by <provider>:<sourceItemId>. */
  itemKey: string;
  /** Rule 4: the catalog store scope, or null for a non-catalog offer. */
  storeScope: string | null;
}

/**
 * Rule 3: catalog providers use catalog-observation with both dates null, and
 * no other provider may use it. A8: a dated calendar rule needs strict
 * startsAt < expiresAt.
 */
function calendarProblems(offer: Offer, provider: unknown): string[] {
  if (isCatalogProvider(provider)) {
    const problems: string[] = [];
    if (offer.calendarRule !== "catalog-observation") problems.push(`catalog offer calendar rule ${offer.calendarRule} is not catalog-observation`);
    if (offer.startsAt !== null || offer.expiresAt !== null) problems.push("catalog-observation requires startsAt and expiresAt to be null");
    return problems;
  }
  if (offer.calendarRule === "catalog-observation") return ["calendar rule catalog-observation is only for catalog providers (kroger-api, safeway-search)"];
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
 * Provider-channel binding: Flipp weekly-ad offers are in-store-ad, catalog
 * offers are CATALOG_CHANNEL, so a relabeled offer never counts in the other
 * gate (amendment section 1, D2).
 */
function channelProblems(offer: Offer, provider: unknown): string[] {
  if (provider === "flipp" && offer.channel !== "in-store-ad") {
    return [`provider flipp requires channel in-store-ad, not ${String(offer.channel)}`];
  }
  if (isCatalogProvider(provider) && offer.channel !== CATALOG_CHANNEL) {
    return [`provider ${provider} requires channel ${CATALOG_CHANNEL}, not ${String(offer.channel)}`];
  }
  return [];
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
  // Rule 1: the gate evaluates exactly one channel.
  const proofChannel = CHANNELS.find((channel) => channel === proof.channel) ?? null;
  if (proofChannel === null) failures.push(`proof channel ${JSON.stringify(proof.channel ?? null)} is missing or not a known channel`);

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
    if (offer.channel !== proofChannel) why.push(`channel ${offer.channel} is not the gate channel`);

    const evidence = offer.evidence;
    const itemKeys = new Set(evidence.map(itemKey));
    // The provider and source item when every evidence entry names the same one.
    const single = itemKeys.size === 1 ? evidence[0] : undefined;
    const provider: unknown = single?.provider;

    const candidates = validationsByOffer.get(offer.id) ?? [];
    const problemSets = candidates.map((validation) => validationProblems(validation, offer, nowMs));
    if (candidates.length === 0) why.push("no valid validation (none provided)");
    else if (!problemSets.some((problems) => problems.length === 0)) why.push(`no valid validation (${problemSets.flat().join("; ")})`);

    if (offer.applicability !== "verified") why.push("applicability is not verified");
    why.push(...calendarProblems(offer, provider));
    why.push(...channelProblems(offer, provider));
    const state = freshness(offer, now);
    if (state !== "fresh") why.push(`freshness is ${state}`);
    // A future observation would otherwise stay "fresh" beyond 24h of real time.
    const observed = parseTimestamp(offer.observedAt);
    if (observed === null) why.push("observedAt is not a strict ISO 8601 timestamp");
    else if (observed > nowMs) why.push("observedAt is after the check time");

    if (offer.unitPrice === null) why.push("no unit price");
    else if (compareRational(offer.unitPrice.cents, ZERO) <= 0) why.push("unit price is not positive");

    if (evidence.length === 0) why.push("no evidence");
    for (const item of evidence) why.push(...evidenceProblems(item, offer.family));
    if (evidence.length > 0 && itemKeys.size !== 1) why.push("evidence must name exactly one source item");
    const sourceItem = single === undefined ? "" : String(single.sourceItemId);
    // A7: a Flipp Offer.id is exactly flipp:<family>:<sourceItemId> (R7);
    // section 3: a catalog Offer.id is <provider>:<family>:<sourceItemId>.
    if (provider === "flipp" && offer.id !== `flipp:${offer.family}:${sourceItem}`) {
      why.push(`offer id ${offer.id} is not the R7 id flipp:${offer.family}:${sourceItem}`);
    } else if (isCatalogProvider(provider) && offer.id !== `${provider}:${offer.family}:${sourceItem}`) {
      why.push(`offer id ${offer.id} is not the catalog id ${provider}:${offer.family}:${sourceItem}`);
    }
    const scopes = new Set(evidence.map(storeScope).filter((scope) => scope !== null));
    if (scopes.size > 1) why.push(`evidence names more than one store scope (${[...scopes].sort().join(", ")})`);
    const [scope = null] = scopes;

    if (offer.normalizationIssue !== null) why.push(`has a normalization issue: ${offer.normalizationIssue}`);

    const key = comparisonKey(offer.identity);
    if (key === null) {
      why.push(`no comparisonKey (unknown or unsupported identity fields: ${identityGaps(offer.identity).join(", ")})`);
      excluded.push({ offerId: offer.id, reasons: why });
    } else if (why.length > 0) {
      excluded.push({ offerId: offer.id, reasons: why });
    } else {
      qualified.push({ offer, key, sourceItem, itemKey: single === undefined ? "" : itemKey(single), storeScope: scope });
    }
  }

  // Rule 4: a family's counted catalog offers share one store scope. When they
  // name more than one, none of them counts: the gate cannot tell which store
  // was meant (fail closed).
  const scopesByFamily = new Map<Family, Set<string>>();
  for (const { offer, storeScope: scope } of qualified) {
    if (scope !== null) scopesByFamily.set(offer.family, (scopesByFamily.get(offer.family) ?? new Set<string>()).add(scope));
  }
  const scoped = qualified.filter(({ offer, storeScope: scope }) => {
    const familyScopes = scopesByFamily.get(offer.family);
    if (scope === null || familyScopes === undefined || familyScopes.size <= 1) return true;
    excluded.push({ offerId: offer.id, reasons: [`${offer.family} catalog offers span more than one store scope (${[...familyScopes].sort().join(", ")})`] });
    return false;
  });

  // Per family: distinct original source items. Keyed by <provider>:<sourceItemId>
  // (rule 5; A7 for Flipp), so duplicates never add, even across families.
  const counts = emptyCounts();
  const countedItems = new Map<string, string>();
  for (const { offer, sourceItem, itemKey: counted } of scoped) {
    const countedAs = countedItems.get(counted);
    if (countedAs !== undefined) {
      notes.push(`source item ${counted} already counted as ${countedAs}; ${offer.id} adds nothing`);
      continue;
    }
    countedItems.set(counted, offer.id);
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
  for (const entry of scoped) byId.set(entry.offer.id, entry);
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
    else if (left.itemKey === right.itemKey) reason = "both sides are the same source item";
    else if (countedItems.get(left.itemKey) !== left.offer.id || countedItems.get(right.itemKey) !== right.offer.id) {
      reason = "a side's source item is already counted as another offer";
    } else if (left.key !== right.key) reason = "comparisonKey differs";
    else if (left.offer.channel !== right.offer.channel) reason = "channel differs";
    else if (left.offer.unitPrice?.basis !== right.offer.unitPrice?.basis) reason = "unit basis differs";
    else if (pair.category !== left.offer.identity.category || pair.category !== right.offer.identity.category) {
      reason = `declared category ${String(pair.category)} does not match the offers`;
    } else if (usedItems.has(left.itemKey) || usedItems.has(right.itemKey)) {
      reason = "a source item is already counted in an earlier pair";
    }
    if (reason !== null || !left || !right) {
      skippedPairs.push({ pair, reason: reason ?? "invalid pair" });
      return;
    }
    usedItems.add(left.itemKey);
    usedItems.add(right.itemKey);
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

function storeAttestationProblems(attestation: StoreAttestation): string[] {
  const problems: string[] = [];
  const familyProblem = providerFamilyProblem(attestation.provider, attestation.family);
  if (familyProblem !== null) problems.push(familyProblem);
  if (attestation.provider === "kroger-api") {
    if (typeof attestation.storeId !== "string" || !KROGER_LOCATION_ID.test(attestation.storeId)) {
      problems.push("kroger-api storeId must be an 8-digit locationId");
    }
  } else if (!nonEmpty(attestation.storeId)) problems.push("storeId is empty");
  if (attestation.applicability !== "verified") problems.push("applicability must be verified");
  if (!nonEmpty(attestation.applicabilityEvidence)) problems.push("applicabilityEvidence is empty");
  if (!isTimestamp(attestation.checkedAt)) problems.push("checkedAt is not a strict ISO 8601 timestamp");
  return problems;
}

/**
 * Per-store attestation for catalog prices (section 3, the R8 analogue):
 * applicability is verified only for an exactly matching family, provider and
 * storeId with complete evidence. As in attestationFor (A8), any invalid
 * matching entry leaves the store unknown, even beside a valid one. The
 * collector must also confirm that this run's store lookup returned storeId.
 */
export function storeAttestationFor(
  file: ValidationFile | null,
  family: Family,
  provider: StoreAttestation["provider"],
  storeId: string,
): { applicability: "verified" | "unknown"; attestation: StoreAttestation | null; problems: string[] } {
  const problems: string[] = [];
  const entries: unknown[] = Array.isArray(file?.storeAttestations) ? file.storeAttestations : [];
  const matches = entries.filter((entry): entry is StoreAttestation =>
    isRecord(entry) && entry.family === family && entry.provider === provider && entry.storeId === storeId);
  for (const entry of matches) {
    problems.push(...storeAttestationProblems(entry).map((problem) => `${family} ${provider} store ${storeId}: ${problem}`));
  }
  const first = matches[0];
  if (!first || problems.length > 0) return { applicability: "unknown", attestation: null, problems };
  return { applicability: "verified", attestation: first, problems };
}

/**
 * Builds a snapshot proof for one gate channel from the human validation file
 * and this run's offers. Entries for offers not collected in this run are
 * dropped with a note; everything else is judged by checkProof.
 */
export function assembleProof(
  file: ValidationFile | null,
  offers: Offer[],
  families: [Family, Family],
  validatedAt: string,
  channel: Channel,
): { proof: Proof; notes: string[] } {
  const notes: string[] = [];
  if (!file) {
    notes.push("no validation file: nothing is verified");
    return { proof: { validatedAt, families: [families[0], families[1]], channel, validations: [], pairs: [] }, notes };
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
      channel,
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
