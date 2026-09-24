# M1 Windows Deal Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for task execution with fresh Sol High implementers and independent reviewers. Use executing-plans only for tightly coupled integration while preserving required independent review.

**Status:** User approved execution on 2026-09-19. Codex execution was runtime-blocked; on 2026-09-24 execution resumed in Claude Code per the addendum at the end of this plan (DEC-20260924-001). Task 1 in progress.
**Goal:** Show accurate, source-backed produce and meat comparisons from two retailer families in a Windows list/detail app.  
**Architecture:** A bounded Node collector produces a validated local JSON source snapshot. Pure TypeScript compares offers. Electron reads the fixed snapshot through narrow IPC and computes freshness at viewing time; React renders local assets.  
**Tech stack:** Node/TypeScript, Vitest, React/Vite, Electron and Playwright Electron smoke tests. Installed Node 22.23.2 meets the observed candidate engine floors. Pin compatible dependencies and retain a lockfile during execution; registry availability is not a passing installation.  
**Spec:** [MVP_SPEC.md](../../MVP_SPEC.md) and [MVP_SCOPE.md](../../MVP_SCOPE.md).  
**Evidence:** [source research](../../DATA_RESEARCH.md), [planning preflight](../../research/M1_PLANNING_PREFLIGHT_2026-09-19.md), [detail responses](../../research/FLIPP_DETAIL_PROBE_2026-09-19.json).  
**Verification:** [TEST_PLAN.md](../../TEST_PLAN.md).

## Global constraints

- M1 contains collection, normalization, comparable-price ratings and a minimal Windows list/detail view.
- No installer, persisted preferences, shopping list, full radius controls, notification delivery, hosting, database, API server, queue or generalized provider framework. Those remain M2/M3.
- The source gate requires ten distinct original offers per retailer family, both produce and meat in each, and five distinct cross-family comparable pairs including at least one of each category. OR variants cannot inflate offer/pair counts.
- Unknown units, required identity attributes, applicability or condition semantics never become guessed facts. Preserve source context and explain exclusions.
- Compare only the same purchase channel and compatible units. Separate in-store ads, retailer pickup/delivery and Instacart pickup/delivery.
- One observed competitor can support a rating, always naming it and stating limited coverage. No competitor means Unrated.
- Actual-user loyalty/coupon/quantity eligibility starts unknown. Unknown or ineligible candidates remain unrated; unknown or ineligible references do not enter any automated rating tier. A labeled test profile can exercise eligible cases without pretending the user qualifies.
- Exact or fully defined category-equivalent matches follow the approved product attributes. Cooking substitutes are not comparable.
- Every child uses chatgpt-web/high with high reasoning. No silent model substitution.
- Product commands below are **planned**. There is no current package.json, application source, Git repository, installed application or passing product test.
- Use absolute PowerShell paths or Set-Location -ErrorAction Stop; the shell previously started at C:\\ despite a workdir argument.
- Source proof is first. If it cannot pass, retain a healthy tested collector, record the unsatisfied criterion, investigate the already-scoped PCC fallback where useful, and stop dependent UI work. Do not waive criteria or mark M1 complete.

## Current source facts

The 98105 Flipp listing and QFC/Safeway flyer detail endpoints were reachable. Research flyer IDs were QFC 8123483 and Safeway 8129241. Treat them as historical fixture IDs: every live run must discover current flyers from the listing.

Item details use:

```text
GET https://backflipp.wishabi.com/flipp/items/{id}
response: { item: { current_price, pre_price_text, price_text,
                   description, disclaimer_text, valid_from, valid_to,
                   timezone, cutout_image_url } }
```

The actual response is retained in the linked JSON; the displayed field list is explanatory, not a parser schema.

- QFC apples expose /lb and With Card.
- QFC ground chuck exposes a 1 lb package at 7.99 with card.
- Safeway beef exposes 4.99/lb, a 3 lb package totaling 14.97, 80% lean, member pricing and Limit 1.
- A QFC chicken offer has empty current_price and cannot become zero.
- A fruit offer exposes 2 for before price 5; available_to differs from its sale validity.
- Flipp sends -04:00 timestamps for these Seattle queries. Preserve them and establish printed-ad date semantics; never assume the offset means Seattle time.
- Two downloaded cutouts corroborate package/price/condition text. That does not establish a valid beef match, full branch participation or an automatic image parser.

## File map and task boundaries

All implementation paths below are relative to the repository root and are planned files.

| Task | Files owned | Observable outcome |
|---|---|---|
| 1 | package.json/lock, .npmrc, .gitignore, source TypeScript/Vitest/ESLint config; src/shared/contracts.ts, money.ts, identity.ts, freshness.ts; src/source/flipp.ts, normalize.ts, proof.ts; scripts/collect.ts; tests/source/*.test.ts; tests/fixtures/source.ts | Repeated live collection and a truthful source-proof report |
| 2 | src/compare/eligibility.ts, compare.ts; tests/compare/*.test.ts, tests/fixtures/offers.ts | Explained comparisons using frozen source contracts |
| 3 | Required UI dependencies/config additions; tsconfig.core.json, tsconfig.electron.json, vite.config.ts, index.html; electron/main.mjs, preload.cjs, security.mjs; src/renderer/App.tsx, main.tsx, app.css, bridge.d.ts; tests/ui/*.test.tsx, tests/electron/security.test.ts | Secure keyboard-usable Windows list/detail window |
| 4 | playwright.config.ts, tests/electron-smoke.spec.ts, scripts/validate-snapshot.ts, README.md; narrowly necessary runtime wiring | Independently verified Windows critical path |
| Orchestrator | docs/PROJECT_STATE.md, TEST_PLAN.md, GAP_ANALYSIS.md, ARCHITECTURE.md, ROADMAP.md, DECISIONS.md | Durable state agrees with evidence |

Execute 1 -> 2 -> 3 -> 4. Task 1 contains the shared identity/freshness semantics used by its proof gate and later comparison. Task 3 depends on Task 2 runtime exports and adds build configuration, so running those implementers concurrently would add avoidable contention. Independent read-only spec and quality reviews can run in parallel.

## Shared contracts

Task 1 owns these definitions in src/shared/contracts.ts. Later tasks consume them; contract edits are coordinated and verified against every consumer.

```ts
export type Family = "kroger" | "albertsons" | "pcc";
export type Channel =
  | "in-store-ad" | "retailer-pickup" | "retailer-delivery"
  | "instacart-pickup" | "instacart-delivery";
export type Rational = { n: string; d: string };
export type Known<T> =
  | { state: "known"; value: T }
  | { state: "not-applicable" }
  | { state: "unknown" };

export type Identity =
  | { category: "produce"; kind: Known<string>; variety: Known<string>;
      form: Known<string>; organic: Known<boolean> }
  | { category: "meat"; species: Known<string>; cut: Known<string>;
      bone: Known<"in" | "out">; skin: Known<"on" | "off">;
      freshFrozen: Known<"fresh" | "frozen">; fatPercent: Known<number> };

export interface Evidence {
  id: string; provider: "flipp" | "pcc"; sourceItemId: string;
  retrievedUrl: string; sourceUrl: string; observedAt: string;
  rawSha256: string; rawValidity: Record<string, string | null>;
}
export interface Conditions {
  complete: boolean;
  loyaltyRequired: boolean | null;
  couponRequired: boolean | null;
  couponIds: string[];
  minimumUnits: number | null;
  maximumUnits: number | null;
  text: string[];
}
export interface Offer {
  id: string; family: Family; retailer: string; label: string;
  postalCode: string; storeName: string | null; storeAddress: string | null;
  applicability: "verified" | "unknown"; channel: Channel;
  identity: Identity;
  rawPrice: Record<string, string | null>;
  unitPrice: { basis: "lb" | "each"; cents: Rational } | null;
  normalizationIssue: string | null;
  packageMassLb: Rational | null; packageCount: number | null;
  packageTotalCents: number | null;
  conditions: Conditions; evidence: Evidence[];
  observedAt: string;
  startsAt: string | null; expiresAt: string | null;
  calendarRule: "verified-local-date" | "explicit-instant" | "unknown";
}
export interface Validation {
  offerId: string; checkedAt: string; evidenceIds: string[];
  verifiedFields: string[]; applicabilityEvidence: string; calendarEvidence: string;
}
export interface Proof {
  validatedAt: string; families: [Family, Family]; validations: Validation[];
  pairs: Array<{ leftId: string; rightId: string; category: "produce" | "meat" }>;
}
export interface SourceSnapshot {
  schemaVersion: 1; postalCode: "98105"; collectedAt: string;
  offers: Offer[]; proof: Proof;
}
export interface Profile {
  kind: "actual" | "test";
  families: Record<Family, {
    loyalty: "eligible" | "ineligible" | "unknown";
    activatedCouponIds: string[]; quantityConfirmedOfferIds: string[];
  }>;
}
export type Freshness = "fresh" | "stale" | "expired" | "upcoming";
export type Rating = "Exceptional" | "Strong" | "Good" | "Typical" | "Above comparison";
export interface Comparison {
  referenceCents: Rational; savings: Rational; rating: Rating;
  comparatorIds: string[]; comparatorFamilies: Family[];
  coverageText: string; referenceRange: [Rational, Rational];
}
export interface Deal {
  offer: Offer; freshness: Freshness;
  eligibility: "eligible" | "ineligible" | "unknown";
  reason: string | null; comparison: Comparison | null;
}
```

Rationals persist integer strings; arithmetic uses BigInt with a positive denominator and GCD reduction. Never serialize native BigInt. Number conversion is limited to rounded display. Ordinary input cents must be nonnegative safe integers; comparisons require a strictly positive supported price. Zero remains distinguishable from missing, but free-item promotion support is outside M1.

Not-applicable identity values require a documented category rule, such as fat percentage not applying to a whole cut. Missing source text is never evidence for not-applicable or conventional/nonorganic status.

### Export contracts

```ts
// Task 1, src/shared/money.ts
export function usdCents(text: string | null): number | null;
export function pounds(amount: string, unit: "lb" | "oz" | "kg"): Rational;

// Task 1, src/shared/identity.ts
export function comparisonKey(identity: Identity): string | null;

// Task 1, src/shared/freshness.ts; expiresAt is exclusive
export function freshness(offer: Offer, now: Date): Freshness;

// Task 1, src/source/flipp.ts: validated raw response, never unchecked cast
export function fetchFlippJson(url: URL, fetcher?: typeof fetch): Promise<unknown>;
export function parseFlippItem(response: unknown): Record<string, unknown>;

// Task 1, src/source/normalize.ts
export function normalizeFlipp(
  item: Record<string, unknown>,
  context: {
    family: Family; retailer: string; postalCode: "98105";
    observedAt: string; evidence: Evidence;
    applicability: "verified" | "unknown";
    calendarRule: Offer["calendarRule"];
  }
): Offer;

// Task 1, src/source/proof.ts
export function checkProof(
  snapshot: SourceSnapshot, now: Date
): { ok: boolean; reasons: string[] };

// Task 2, src/compare/eligibility.ts
export function eligibility(
  offer: Offer, profile: Profile
): { status: Deal["eligibility"]; reason: string | null };

// Task 2, src/compare/compare.ts
export function rate(savings: Rational): Rating;
export function compare(offers: Offer[], profile: Profile, now: Date): Deal[];
```

These signatures describe module contracts, not stubs to leave in production. Required test helpers are assigned below rather than assumed to exist.

## Review focus

| Failure mode | Owning task and concrete check |
|---|---|
| False live-coverage pass from duplicated rows, OR variants or unsupported facts | Task 1 boundary fixtures for 9/10 observations, 4/5 distinct pairs, missing meat, duplicate original item IDs and missing applicability evidence |
| Wrong each/lb/package or meat/produce match | Task 1 money/identity tests and real source fixtures; Task 2 channel/unit/mismatch exclusion |
| Membership assumptions or misleading savings | Task 2 unknown-eligibility rejection, per-family dedupe, own-family exclusion, threshold and one-reference wording tests |
| Old/future offers labeled live | Task 1 clock boundary tests; Task 3 recomputation on query/focus/minute tick; Task 4 stale-window smoke |
| Retailer text escaping the desktop boundary | Task 3 IPC sender/argument checks, HTML text rendering, URL/path traversal tests; Task 4 actual Electron smoke |

## Task 1 - Prove source viability

**Inputs:** approved spec, six saved item-detail responses, 98105, current public listing.  
**Outputs:** tested collector, frozen contracts, data/snapshots/m1-source.json and docs/research/M1_SOURCE_PROOF.md only with truthful status. Audit payloads stay under ignored data/audit/.

- [ ] Inspect the root and Git state again. If no Git repository exists, create .gitignore then initialize one; stage only reviewed project files. Preserve user changes and never commit .codex, secrets, node_modules, generated outputs or raw audit directories. Do not claim a worktree exists before Git exists.
- [ ] Create minimal source tooling: TypeScript, tsx, Vitest and ESLint with exact compatible pins/lockfile. Candidate package versions and engine observations are in the preflight doc; verify actual installation compatibility. Add save-exact=true in .npmrc.
- [ ] Establish real source-stage scripts in package.json, type: module, strict ES2022 TypeScript checking, and Vitest unit-test inclusion. Ignore Playwright smoke files and generated/audit directories in unit/lint configuration.

```json
{
  "scripts": {
    "test": "vitest run",
    "test:source": "vitest run tests/source",
    "source:collect": "tsx scripts/collect.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  }
}
```

- [ ] Create tests/fixtures/source.ts that reads the committed JSON research fixture and exports item(id: number): Record<string, unknown>. It unwraps the selected item without replacing its data. Unit tests use a fixed clock and explicitly supplied verification context; none of these fixtures count as a live run.
- [ ] Write failing money/normalization tests.

```ts
expect(usdCents("1.77")).toBe(177);
expect(usdCents("")).toBeNull();
expect(usdCents("-1.00")).toBeNull();
expect(usdCents("1.234")).toBeNull();
expect(usdCents("0.00")).toBe(0);
expect(pounds("16", "oz")).toEqual({ n: "1", d: "1" });
expect(pounds("1", "kg")).toEqual({ n: "100000000", d: "45359237" });
```

- [ ] Add source tests asserting: QFC one-pound beef package normalizes 799 cents/lb; Safeway beef is 499 cents/lb with package total 1497 and maximum limit one; missing chicken price stays unknown; /lb is not each; a pint/bunch/size range stays unknown; 2 for 5 retains offer quantity but does not assert a mandatory minimum absent explicit source evidence; no available_to fallback for expiry.
- [ ] Write identity tests rejecting unknown required attributes and cross-cut substitution. The source-proof check and later comparison must both call comparisonKey. Rules derive attributes from current text; no per-item hardcoded attribute map or image-only automatic extraction.
- [ ] Write clock tests for exactly 24 hours, greater than 24 hours, future starts, exclusive expiry, missing dates and contradictory validity. Unknown calendar semantics cannot pass live-current validation. A verified inclusive Seattle through-date becomes the next local midnight; raw source offsets remain in evidence.
- [ ] Write HTTP fixtures for malformed JSON/schema, HTML bot pages, empty responses, 429 and 5xx, timeout and redirect escape. Inject fetcher and fake timers; no live network in these unit tests.
- [ ] Run RED: npm run test:source. Record failures attributable to absent behavior, not merely a broken runner.
- [ ] Implement money parsing digit-wise; BigInt rational conversion and comparison; strict response validation; supported field extraction; shared identity/freshness logic. Return explicit normalization issues for unsupported data.
- [ ] Implement live listing -> current retailer flyer -> item-detail collection. Never hardcode research flyer IDs. Initially allow only HTTPS backflipp.wishabi.com; validate every manual redirect, reject credentials/nondefault ports, cap redirects at three, timeout each request after 15 seconds, concurrency two, maximum two retries for 429/5xx. Honor Retry-After; if it exceeds 15 seconds, end as deferred and record next permitted time instead of retrying early.
- [ ] Preserve all raw pricing/conditions/validity evidence, checksums and observation timestamps. Parse unknown conditions as unknown. Minimum quantity and maximum purchase limit are distinct.
- [ ] Inspect printed ads/local store information to establish branch or explicitly regional participation and calendar interpretation. ZIP discovery alone is insufficient. Human validation checks parser output against evidence; it must not silently enrich recurring runtime facts with manual guesses.
- [ ] Build source-proof validation with the following failure matrix and fixed fixtures.

```text
9 qualifying rows in either family -> fail
10 rows but no meat or no produce in either family -> fail
4 independent comparable pairs -> fail
5 pairs but no pair in one required category -> fail
duplicate source item IDs or repeated OR pair -> does not increase counts
unknown unit, required identity, applicability or current validity -> excluded
missing validation/evidence ID, raw hash or field evidence -> fail
future, expired or stale row -> excluded
10+10 valid rows, both categories, 5 distinct supported pairs -> pass
```

- [ ] The proof report lists counted original IDs, normalized units, required attributes, source/evidence links, conditions, applicability and date evidence, exclusions, pair identities and category counts. Recompute the gate from records; never trust a bare status string.
- [ ] Write to a temporary snapshot; replace m1-source.json only when the complete check passes. A failed refresh preserves prior content and original timestamps. Save incomplete-run diagnostics separately. Tests prove prior-snapshot preservation.
- [ ] Run GREEN: npm run test:source, npm run typecheck, npm run lint.
- [ ] Run the live gate: npm run source:collect -- --postal-code 98105. A nonzero exit and a BLOCKED report are correct on inadequate evidence. Qualifying price pairs may explicitly carry member conditions; this proves observed comparable data, not actual-user eligibility.
- [ ] If needed, investigate PCC within the already-approved source scope. Add only a concrete PCC HTML extractor if it can satisfy the same gate with a primary chain; no generic provider registry. Do not infer missing PCC units. Record the selected two families explicitly in proof.
- [ ] Return files, exact commands/results, source counts/pairs, evidence paths and unresolved issues. Obtain fresh spec and quality reviews. Fix blocking findings via a fresh implementer and repeat the failed pass. Commit only the reviewed bounded task.

**Stop condition:** If the live gate fails, Task 1 and M1 remain incomplete even when unit tests pass. Keep tooling healthy, record the blocker and stop dependent tasks. Do not build a convincing UI around fabricated or unverified prices.

## Task 2 - Compare verified offers

**Inputs:** frozen Offer/Profile/Rational contracts, shared comparisonKey/freshness, source snapshot.  
**Outputs:** eligibility and compare exports with deterministic tests. Own only the Task 2 paths in the file map.

- [ ] Add tests/fixtures/offers.ts with a makeOffer(overrides: Partial<Offer>): Offer helper. Defaults are a complete synthetic whole conventional Gala apple priced at 100 cents/lb, explicit unrestricted conditions, verified fixture applicability and fixed test validity. Evidence URLs use example.invalid and IDs begin fixture:. They are never collected or counted as live evidence. Default profile creates unknown actual eligibility for every family; explicit test profiles are labeled kind: test.
- [ ] Write RED threshold tests using exact rational strings.

```ts
expect(rate({ n: "3", d: "10" })).toBe("Exceptional");
expect(rate({ n: "1", d: "5" })).toBe("Strong");
expect(rate({ n: "1", d: "10" })).toBe("Good");
expect(rate({ n: "-1", d: "10" })).toBe("Typical");
expect(rate({ n: "-1001", d: "10000" })).toBe("Above comparison");
```

- [ ] Build named fixture sets in the test files from makeOffer: valid one-reference pair; duplicate offers in one retailer family; three-family median; unknown organic/fat/cut; same item in different channels; zero/nonpositive reference; unknown membership/coupon/quantity; stale/future/expired. Assert comparison=null for an ineligible/unknown candidate and exclusion of such references at every tier. Assert no-reference UI data remains unrated.
- [ ] Verify equal known category attributes/units/channels produce a match; unknown required fields and cooking substitutions never do. OR variants share original provenance and cannot inflate coverage.
- [ ] Verify one reference names that retailer and states 1 comparison (limited coverage). Test even and odd family medians, range output and own-family exclusion using fixture families. Multiple stores or providers in one family count once.
- [ ] Register test:compare as vitest run tests/compare; run RED.
- [ ] Implement eligibility. Complete parsing is required. Null loyalty/coupon requirements are unknown; required coupons need known IDs and activation; quantities need explicit confirmation. Unrestricted confirmed offers can be eligible with an otherwise unknown profile.
- [ ] Implement compare: retain canonical offers with all provenance; filter active positive unit prices and known eligible context; select lowest valid matching price per other family; compute median and exact savings with BigInt rationals; assign the approved threshold label. Missing comparisons remain null with an explicit reason. Merge provenance for truly identical listings; contradictory current sources stay unresolved rather than silently taking the cheaper number.
- [ ] Run GREEN: npm run test:compare, npm run test:source, npm run typecheck, npm run lint.
- [ ] Obtain fresh spec/quality reviews, resolve findings, and return evidence. Commit the bounded change.

## Task 3 - Windows list/detail interface

**Inputs:** tested compare export, fixed verified source snapshot and shared contracts.  
**Outputs:** an Electron development app with local React UI. No installer or background collection.

- [ ] Consult the installed Superdesign skill for the bounded list/detail UI at execution time. Keep the data/source work independent of any unavailable design service. Do not add a runtime design-service dependency.
- [ ] Add exact compatible React/ReactDOM, Vite/plugin, Electron, renderer test utilities and jsdom dependencies. Update package/lock and configuration in this task. Use no routing framework.
- [ ] Add tsconfig.core.json: emit shared/compare TypeScript as NodeNext ES2022 into dist-core using explicit .js imports. Electron main.mjs imports that output; preload.cjs remains a narrow sandbox-compatible CommonJS bridge. Add tsconfig.electron.json with allowJs/checkJs/noEmit and JSDoc/declarations for Electron JS. Root strict checking covers renderer, source and tests.
- [ ] Add Vite relative asset base and renderer entry, jsdom/jest-dom setup only for UI unit tests, and a restrictive local-content CSP. Extend scripts:

```json
{
  "main": "electron/main.mjs",
  "scripts": {
    "test:ui": "vitest run tests/ui tests/electron",
    "build:core": "tsc -p tsconfig.core.json",
    "build": "npm run build:core && vite build",
    "typecheck:electron": "npm run build:core && tsc -p tsconfig.electron.json --noEmit",
    "start": "npm run build && electron ."
  }
}
```

- [ ] Implement against this bridge contract, declared in src/renderer/bridge.d.ts. Renderer requests IDs only.

```ts
export interface EutheniaBridge {
  listDeals(): Promise<Deal[]>;
  getDeal(id: string): Promise<Deal | null>;
  openSource(input: { offerId: string; evidenceId: string }):
    Promise<{ ok: boolean; reason: string | null }>;
}
```

- [ ] Write RED security tests for sandbox=true, contextIsolation=true, nodeIntegration=false; source-host/port/protocol/credential rejection; sender-frame/argument validation; encoded path traversal and navigation/window denial. Export policy/validation functions from electron/security.mjs so assertions test active production configuration.
- [ ] Write RED UI tests with an explicitly imported synthetic fixtureBridge implementing EutheniaBridge: list/detail data, async load, native keyboard interaction, all source/price/condition/time fields, comparison explanation, Unrated/conditional, unknown expiry, stale, error and empty states. Use user-event with await findBy... rather than a keyDown event alone.
- [ ] Run RED: npm run test:ui.
- [ ] Register an app custom scheme before readiness. Resolve only normalized paths beneath the real dist root; reject traversal including encoded paths. Deny unexpected permissions, navigation and new windows. Render retailer strings as text, never scraped HTML.
- [ ] Main reads only data/snapshots/m1-source.json, validates the schema and proof, and calls compare with a current clock and the actual unknown profile on each query. Recheck on window focus and at least once a minute. Cached results cannot remain fresh after their timestamps expire; upcoming/expired offers never appear as active rated deals.
- [ ] Source opening resolves an offer/evidence ID in the loaded snapshot, then checks a fixed HTTPS hostname allowlist and default port. Initial hosts: backflipp.wishabi.com, flipp.com, www.flipp.com, f.wishabi.net, www.qfc.com, www.safeway.com, local.safeway.com, www.pccmarkets.com. Preserve original HTTP source URLs in evidence; only upgrade a known source URL when HTTPS support was verified. Never accept an arbitrary renderer URL/path.
- [ ] Build one list/detail screen: produce/meat tabs, source status, large unit price, retailer/region, conditions, comparison label/coverage and source action. Detail exposes raw pricing, package/minimum/maximum terms, match basis, reference/range, observation time, expiry or unknown and provenance. Display Unrated - insufficient comparison data when comparison is null. No M2 controls as nonfunctional decoration.
- [ ] Run GREEN: npm run test:ui, npm run typecheck, npm run typecheck:electron, npm run lint, npm run build.
- [ ] Obtain fresh spec/quality reviews, resolve findings and commit the bounded change.

## Task 4 - Integrate and verify on Windows

**Inputs:** reviewed collector, comparison and desktop output.  
**Outputs:** live-source and Windows evidence sufficient for M1 completion, or an explicit remaining blocker.

- [ ] Add scripts/validate-snapshot.ts to parse the fixed source snapshot, recompute checkProof at the current clock and exit nonzero for invalid/stale/current-coverage failure. No automatic live fetch during app launch.
- [ ] Add exact compatible @playwright/test and playwright dev dependencies/config and tests/electron-smoke.spec.ts, excluded from Vitest. Add snapshot:validate as tsx scripts/validate-snapshot.ts and smoke:windows as npm run build && playwright test tests/electron-smoke.spec.ts.
- [ ] Write the failing Windows smoke before final wiring; use a finally block to close the process:

```ts
import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";

test("Windows deal detail preserves source context", async () => {
  const app = await electron.launch({ args: ["."] });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Euthenia");
    const row = page.getByRole("button", { name: /view .* details/i }).first();
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(page.getByText("Source", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
```

- [ ] Add smoke coverage for blocked window.open/navigation, denied arbitrary source request, real bridge data, a clock crossing the freshness boundary and startup with a malformed source snapshot. Tests may inject a clock or loader through module arguments in the test process; do not create a production test-mode preference.
- [ ] Intercept shell.openExternal in Playwright's controlled main process to assert the expected approved source URL without launching external browsers on every test. One manual critical-path check opens the genuine source.
- [ ] Run RED: npm run smoke:windows and record the actual missing integration behavior. Resolve only the bounded wiring problem, not unrelated refactors.
- [ ] Refresh via npm run source:collect -- --postal-code 98105 and run npm run snapshot:validate. Reconfirm distinct counts, both categories, five pairs and known validity/applicability. A historical snapshot or previous successful run does not satisfy today's gate.
- [ ] Run the actual release commands from the manifest:

```text
npm test
npm run typecheck
npm run typecheck:electron
npm run lint
npm run build
npm run snapshot:validate
npm run smoke:windows
```

- [ ] Write README.md instructions for clean npm ci, source collection/proof, app launch, unknown membership behavior and test commands. State that this milestone has no installer or live alerts.
- [ ] Obtain fresh Task 4 spec and quality review. A separate fresh verifier reruns the release gate and performs the Windows critical path: launch, keyboard selection, detail/source fields, one external source action, and error/stale states. Record outputs and screenshot evidence where available. A web-only React preview cannot replace Electron launch.
- [ ] Commit reviewed changes, synchronize PROJECT_STATE/TEST_PLAN/GAP_ANALYSIS/ARCHITECTURE/ROADMAP and append material decisions. Use verification-before-completion and finishing-a-development-branch for final integration. Move this plan to completed only after every M1 criterion passes.

## Acceptance and handoff

The source proof is not an automatic promise of store coverage. If five supported pairs cannot be obtained under the approved rules, M1 stays open and the exact data gap is reported. No fixed manually curated data is passed off as recurring collection.

Before implementation, the user reviews this written plan. AGENTS.md already chooses subagent-driven execution, so no new execution-method or model-choice question is needed. Each task handoff contains role, bounded goal, relevant paths, constraints, acceptance, exact commands and concise evidence return. No production code has been written in this planning phase.

## Orchestrator self-review

- Four independently reviewable tasks; no M2/M3 scope added.
- Source-proof metadata, fixture ownership and shared matching/freshness functions are explicit.
- Runtime freshness and unknown eligibility agree with the approved spec.
- Integer-string rational persistence avoids overflow in normal kg/price arithmetic.
- Source and UI configuration changes are sequenced; no overlapping implementation fan-out.
- All product commands are proposed, not reported passing.
- The user-facing outcome and remaining source risks are explicit.

## Claude Code execution addendum - 2026-09-24

**Why this exists.** On 2026-09-24 the user committed `CLAUDE.md` and `.claude/agents/`, moving orchestration to Claude Code (Opus 5.5 orchestrator plus project `implementer`, `spec-reviewer`, `quality-reviewer` and `verifier` subagents). See DEC-20260924-001. The `chatgpt-web/high` rule in the global constraints above applies to Codex sessions only. Every other constraint in this plan still binds.

**Starting point.** The partial Task 1 in the Windows `C:` checkout (branch `codex/m1-implementation`) was never committed or pushed, and this repository cannot reach it. Task 1 therefore restarts here from this plan. That partial code is neither reused nor claimed. If it is pushed later, reconcile explicitly rather than merging blindly.

**Execution host.** Linux cloud container, Node v22.22.2, npm 10.9.7, Git 2.43. Outbound HTTPS to `backflipp.wishabi.com`, the npm registry and `pccmarkets.com` returned 200 on 2026-09-24. Task 1 is platform-neutral. The Windows launch and smoke evidence for Tasks 3-4 still requires a Windows host. The PowerShell path note above applies only there.

**Live facts on 2026-09-24 (research only; never hardcode).** The 98105 listing shows QFC Weekly Ad 8132234 (136 items) and Safeway Weekly Ad 8139228 (160 items), both Sep 23-29 with `-04:00` offsets. The listing also carries Big Book of Savings flyers, Fred Meyer (Kroger family) and Albertsons (Albertsons family). Item detail records include `image_url`, the full printed ad page image.

### Task 1 split

- **1A - offline core (implementer):** tooling, `src/shared/{contracts,money,identity,freshness}.ts`, `src/source/{normalize,proof}.ts`, `tests/fixtures/source.ts`, `tests/source/{money,identity,freshness,normalize,proof}.test.ts`.
- **1B - acquisition (implementer, after 1A):** `src/source/flipp.ts`, `scripts/collect.ts` (with testable logic in `src/source/collect.ts` if useful), `tests/source/{flipp,collect}.test.ts`.
- **1C - live gate (orchestrator):** live run, human validation against evidence, and a truthful `docs/research/M1_SOURCE_PROOF.md`.

### Binding resolutions for points the plan leaves open

R1. **Fixture.** `docs/research/FLIPP_DETAIL_PROBE_2026-09-19.json` starts with a UTF-8 BOM, and `items[]` holds the *unwrapped* item records. `item(id)` returns a record unchanged. Tests of `parseFlippItem` wrap it as `{ item }`, which is the live endpoint's shape.

R2. **M1 category scope.** Two categories count:
- **produce:** fresh whole or cut fruits and vegetables.
- **meat:** raw beef, pork, chicken, turkey and lamb cuts, plus ground meat.

These are excluded with an explicit reason, not guessed: seafood (the contract lacks a wild/farmed discriminator), cured or processed meat (bacon, ham, sausage, lunch meat, jerky, chorizo, patties or burgers), prepared foods, juice, frozen, canned or dried produce, kits and bowls, and anything the rules cannot classify. Classification uses documented vocabulary and exclusion rules over the current text. There is no per-item map.

R3. **OR and multi-product items.** Each source item yields exactly one `Offer`. A required identity field whose value differs across the named alternatives is `unknown`. Examples:
- "Broccoli or Cauliflower": kind unknown.
- "Cosmic Crisp, Envy or Pink Lady Apples": kind apple, variety unknown.

Counts and pairs use original source item IDs, so these items can never inflate coverage.

R4. **Documented not-applicable and default rules.** Rules live beside `comparisonKey`, are commented, and are unit-tested:
- **Produce `organic`:** `true` only when the text explicitly says organic (including "O Organics" and "Simple Truth Organic"). `false` only when it explicitly says conventional or non-organic. Otherwise `unknown`.
- **Produce `variety`:** required for kinds where variety is commercially material (at least apple, pear, grape, potato, onion, pepper, mushroom). For other kinds it is `not-applicable` (for example strawberry, raspberry, blackberry, blueberry, broccoli, cauliflower, lemon, lime), per a documented kind table.
- **Produce `form`:** `whole` when the text names the kind with no form qualifier. A documented qualifier (sliced, diced, chopped, cut, peeled, shredded, florets, spiralized, baby) sets that form. Conflicting qualifiers make it `unknown`.
- **Meat `bone`:** "boneless" gives `out`, "bone-in" gives `in`, ground meat is `not-applicable`, anything else is `unknown`.
- **Meat `skin`:** applies to poultry cuts only in M1. "skinless" gives `off`, "skin-on" gives `on`, otherwise `unknown`. For beef, pork and lamb, and for ground meat of any species, it is `not-applicable`; for ground meat the lean/fat percentage is the discriminator (amended 2026-09-24 after Task 1A).
- **Meat `freshFrozen`:** `fresh` or `frozen` only from explicit "fresh", "frozen" or "previously frozen" text. Otherwise `unknown`.
- **Meat `fatPercent`:** applies to ground meat only. "93% lean" gives fat 7, "80/20" gives fat 20, and a single 50-99% value in text that also says "lean" is the lean percentage. It is `not-applicable` for whole cuts. Missing on ground meat means `unknown`.
- **`comparisonKey`:** returns `null` whenever any required field is `unknown`.

R5. **Units** (`unitPrice`, `packageMassLb`, `packageCount`, `packageTotalCents`):
- `/lb` or `lb` in the price text gives an `lb` basis.
- A description of exactly "N lb Package" with no other basis gives price / N per lb.
- Explicit `ea` or `each` gives an `each` basis.
- `N for` with price P gives an `each` basis at P/N, keeps the offer quantity in raw price and conditions text, and sets `minimumUnits: null` unless the text states a required purchase.
- Pint, bunch, bag, size ranges, missing basis or empty price give `unitPrice: null` with a specific `normalizationIssue`. Never assume `lb` or `each`.
- A package total ("3 lb ... for $14.97") fills `packageMassLb` and `packageTotalCents` as well.

R6. **Conditions.**
- "With Card", "member price" and similar give `loyaltyRequired: true`. Explicit coupon text gives `couponRequired: true`. Silence gives `null`.
- "Limit N" gives `maximumUnits: N`. It is distinct from `minimumUnits`.
- `complete` is `true` only when every condition-bearing text segment (price text, pre-price text, disclaimer, and any condition words in the description) was recognized. Keep the original strings in `text`.

R7. **Evidence and IDs.**
- `rawSha256`: SHA-256 of the exact item-detail response body.
- `Evidence.id` = `flipp:item:<sourceItemId>:<first 12 hex of rawSha256>`.
- `retrievedUrl` = the request URL.
- `sourceUrl` = the item's `cutout_image_url`, kept as originally given, falling back to `retrievedUrl`.
- `rawValidity` = raw `valid_from`, `valid_to`, `available_to` (when present) and `timezone`.
- `Offer.id` = `flipp:<family>:<sourceItemId>`.

R8. **Calendar and applicability default to unknown.** The collector marks offers `applicability: "verified"` and `calendarRule: "verified-local-date"` only from an explicit human attestation for that exact flyer ID (see R9).
- **`verified-local-date`:** `startsAt` is the attested printed start time (`startLocalTime`, 24-hour `HH:MM`; use `00:00` only when the ad prints dates alone) in America/Los_Angeles on the date part of `valid_from`. `expiresAt` is the next Los Angeles midnight after the date part of `valid_to` (exclusive). Use `Intl`; no timezone dependency. Evidence (2026-09-24): Safeway's printed ad says "available 7 a.m. Wednesday, September 23, thru Tuesday, September 29, 2026, Midnight", so midnight is not a safe universal start.
- **`unknown`:** `startsAt` and `expiresAt` are `null`, raw values stay in evidence, and there is never an `available_to` fallback.
- **Contradictory validity** (start ≥ end): the calendar becomes unknown and the offer gets a `normalizationIssue`.
- **Freshness:**
  - `expired` when `expiresAt <= now`.
  - `upcoming` when `startsAt > now`.
  - `stale` when `now - observedAt > 24h`; exactly 24h is still `fresh`.
  - Otherwise `fresh`. Precedence is expired > upcoming > stale > fresh.

R9. **Human validation input.** `npm run source:collect -- --postal-code 98105 [--validations <file>] [--report <file>]`. The validation file holds:

```ts
{ schemaVersion: 1;
  attestations: Array<{ family: Family; flyerId: number; checkedAt: string;
    applicability: "verified"; applicabilityEvidence: string;
    calendarRule: "verified-local-date"; calendarEvidence: string;
    startLocalTime: string }>;                   // printed start, 24-hour "HH:MM"
  validations: Validation[];                    // bind via evidenceIds (raw-hash IDs)
  pairs: Proof["pairs"] }                       // human-checked cross-family pairs
```

Without the file, or with no matching entries, nothing is verified and the gate reports BLOCKED. A validation counts only when all of the following hold:
- its `offerId` exists;
- every evidence ID exists on that offer with a matching raw hash;
- `verifiedFields` covers every field in a documented `REQUIRED_VERIFIED_FIELDS` list;
- both evidence strings are non-empty.

Validation files a human authors for a real run are committed under `docs/research/` as evidence.

R10. **`checkProof` counting.** It recomputes everything from records and never trusts a status string. A qualifying offer must meet every one of these:
- belongs to one of `proof.families`;
- has a valid validation;
- applicability is verified and the calendar rule is not unknown;
- freshness is `fresh` at `now`;
- has a positive unit price;
- has a non-null `comparisonKey`;
- has complete evidence.

Per family, it counts distinct `sourceItemId`s: at least 10, with at least one produce and one meat.

A pair counts only when:
- both sides qualify;
- they come from different families;
- they share `comparisonKey`, channel and unit basis;
- the declared category matches both sides;
- neither side's source item ID appears in an earlier counted pair (counted greedily in listed order, with skipped pairs reported).

The gate needs at least 5 counted pairs, including at least 1 produce and 1 meat. Every exclusion gets a reason.

R11. **Collector outputs and exit codes.**
- Snapshot: write a temporary file, then atomically replace `data/snapshots/m1-source.json` only on PASS.
- Diagnostics, raw responses and the generated report go to `data/audit/<run-id>/`, which is ignored. `--report` also writes the report to a chosen path.
- The report lists candidate cross-family pairs (same key, channel and basis) to help the human choose `pairs`.
- Exit codes: 0 PASS, 1 BLOCKED (snapshot preserved), 2 source or schema error, 3 deferred by Retry-After (records the next permitted time).
- Before fetching details, filter list rows with the R2 rules, so item-detail requests go only to produce and meat candidates.
- Select flyers only from the live listing: merchant QFC maps to `kroger`, merchant Safeway maps to `albertsons`, the flyer name contains "Weekly Ad", and its raw validity window contains the collection time. Any other count of matching flyers is a source error and is reported.

R12. **Tooling.** Pin exact versions (`save-exact`), commit the lockfile, and use an ESM package with strict ES2022 TypeScript. Verify compatibility before choosing versions. For example, if `typescript-eslint` does not support TypeScript 7 (the native compiler), pin the newest TypeScript it supports. Record the chosen versions and real scripts in `docs/TEST_PLAN.md` (orchestrator).

### Review-driven amendments to R2-R10 (2026-09-24, after the Task 1A spec and quality reviews)

These amendments are binding and are all stricter than before (DEC-20260924-003).

- **A1 - R3, per-segment qualifiers.** For OR and multi-product names, resolve organic, form, bone, skin and fresh/frozen per name segment, the same way as kind and variety. A qualifier stated in one alternative but absent from another (for example "Strawberries or Organic Strawberries") makes that field `unknown`. A qualifier found only in the description applies to all alternatives, except organic: organic from the description alone is `unknown` unless the name agrees. Negated or exclusionary wording ("excludes organic", "except organic", "not including organic") makes organic `unknown`.
- **A2 - R2, head-noun rule for produce.** The produce kind must be the head of the name. After the last kind match, only form qualifiers, filler words or size/unit tokens may follow; anything else excludes the item as unrecognized. Processed forms (powder, minced, grated, crushed, ground as a spice, paste, puree, flakes, seasoning, dip, sauce, water, drink) exclude the item or make form `unknown`. None of them may default to `whole`.
- **A3 - R2, meat production claims.** Meat that states organic, grass-fed or grass-finished, pasture-raised, free-range, wagyu, kobe or USDA Prime is excluded. Reason: the M1 identity contract has no discriminator for these claims (the same rationale as seafood). USDA Choice/Select and Angus remain a documented known limitation. The human pair check guards the proof, and Task 2 must resolve them before automated ratings.
- **A4 - R2/R4, cut vocabulary.** Different products must not share a cut: roast vs steak (including tri-tip and eye of round), and loose vine-ripe tomatoes vs tomatoes on the vine. A preparation qualifier (thin-cut, "for carne asada", St. Louis style and similar) makes the cut `unknown` unless the vocabulary maps it to a distinct cut.
- **A5 - R5, leftover price wording.** After the recognized vocabulary is removed (lb, each, "N for", loyalty and member phrases), any leftover wording or digits in `pre_price_text` or `price_text` ("2/", "Starting at", "save", "up to", "as low as", "BOGO", "buy … get", "off") set `unitPrice: null` and a specific `normalizationIssue`. So does a non-null `dollars_off` or `percent_off`.
- **A6 - R6, conditions.** Condition indicators include purchase, spend, required, additional and any `$amount`. Unrecognized condition text makes `complete: false`.
- **A7 - R7/R10, identity enforcement in the proof.** A qualifying Flipp offer must satisfy all of these:
  - `evidence.id === flipp:item:<sourceItemId>:<rawSha256[0..12]>`;
  - `offer.id === flipp:<family>:<sourceItemId>`;
  - `retrievedUrl === https://backflipp.wishabi.com/flipp/items/<sourceItemId>`.

  Evidence from any other provider is excluded in M1. Counts and used-item tracking are keyed by source item ID alone, and a pair whose two sides share a source item is rejected. Snapshot entries with the wrong shape are excluded with a reason, never thrown.
- **A8 - R8, calendar integrity.**
  - `verified-local-date` requires raw `valid_from` to have a `T00:00:00` time part and raw `valid_to` a `T23:59:59` time part, both with an explicit offset. Otherwise the calendar is `unknown` with an issue.
  - `checkProof` excludes an offer whose calendar rule is not `unknown` but whose `startsAt`/`expiresAt` is missing, unparseable, or not ordered start < end.
  - Timestamps must be ISO 8601 with Z or an explicit offset.
  - `freshness` with an invalid `now` throws.
  - An invalid attestation for a flyer makes that flyer's attestation `unknown`, even when a valid one is also present.
- **A9 - R7 evidence bytes.** `flippEvidence` accepts the exact response bytes (`Uint8Array`) and hashes them. A string input is hashed as UTF-8 and exists only for tests.
- **A10 - REQUIRED_VERIFIED_FIELDS** also includes `packageCount`.
