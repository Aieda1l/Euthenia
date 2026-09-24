# Test Plan

## Current executable tooling

As of 2026-09-24. These are the real scripts from `package.json`:

| Command | Purpose |
|---|---|
| `npm ci` | Clean install from the committed lockfile (`save-exact`) |
| `npm test` | `vitest run`: all unit tests |
| `npm run test:source` | `vitest run tests/source`: source/normalization/proof tests |
| `npm run typecheck` | `tsc --noEmit`: strict ES2022, NodeNext |
| `npm run lint` | `eslint .` (flat config, typescript-eslint recommended) |
| `npm run source:collect -- --postal-code 98105 [--validations <file>] [--report <file>]` | Live Flipp collection and source-proof gate. Exit 0 PASS (snapshot replaced), 1 BLOCKED, 2 source/usage error, 3 deferred. Writes `data/audit/<run-id>/`. |

Pinned toolchain: typescript 6.0.3, typescript-eslint 8.70.1, eslint 10.11.0, vitest 5.0.1 (with peer vite 8.3.1), tsx 4.23.15, @types/node 22.20.4.
- TypeScript 7 is not used, because typescript-eslint 8.70.1 accepts only TypeScript `<6.1.0`.
- Verified on Node 22.22.2 (Linux).

`tests/setup.ts` makes global `fetch` throw during unit tests. Every HTTP test injects a fetcher, so the unit suite never touches the network.

Last verified: 2026-09-24 at a9e2101 after `npm ci`, with 481/481 tests passing and typecheck and lint clean. The live gate run is BLOCKED; see [M1_SOURCE_PROOF.md](research/M1_SOURCE_PROOF.md).

Later tasks add UI, Electron and smoke scripts as planned. Do not report them until they exist.

## M0 research/spec verification

- Confirm project baseline with file listing and Git status/history probes.
- Inspect primary source pages for data capabilities, channel caveats and local applicability.
- Inspect third-party README/source/license evidence; distinguish inspected from run.
- Scan authored docs for contradictions, placeholder requirements, unsupported completion claims and broken local links.
- Fresh read-only spec/quality review of the proposal. No runtime success implied.

## M1 acquisition gate

For each of two independent retailer chains, capture 10 current observations including BOTH produce and meat. Manually verify exact price, unit, item, location/region, channel, date and promotion conditions against the source at the same time/context. Require all accepted sample fields correct; reject ambiguous offers instead of guessing. Verify five comparable cross-chain pairs, including at least one produce pair and one meat pair. Missing either category keeps the milestone open. A site listing existing does not satisfy this gate.

Fixture cases: lb/oz/kg conversions; each versus mass; ambiguous bunch/weight/size range; sale price missing; zero versus unknown; multibuy minimum; loyalty/coupon eligibility; differing cuts/fat/organic/frozen attributes; unknown required category discriminator; duplicate listing across sources with all provenance retained; offer expiration; empty/changed source schema. Rating fixtures must cover one reliable competitor family (rated with named `1 comparison (limited coverage)` text and no market-best claim), no competitor family (Unrated), and duplicate observations/stores from one competitor family without inflating competitor count. Verify that an unconfirmed loyalty/coupon/quantity condition remains visibly conditional and cannot produce automated Strong.

Smoke the minimal Windows M1 slice: launch it on Windows, display the deal list, open a deal detail, and confirm the visible source/store-or-region/channel/unit/conditions/observation-time/expiry fields and source link match the backing observation. This smoke evidence is required for M1; it does not imply installer, preferences or shopping-list completion.

## M2 Windows/list gate

Test persisted location/radius/store preferences, boundary-distance inclusion, store exclusions, max-stop limit, same-quantity totals, package minimums, incomplete basket comparisons and aggression penalties. For aggression, assert `adjusted cost = purchase total + penalty * (stops - 1)` for the $5/$3/$1 presets and confirm there is no minimum per-added-store savings guarantee. Smoke-test the installer plus preferences/list flows, keyboard navigation, source links, failure states and display scaling. Evidence must include the produced installer path and actual installed launch result.

## M3 delivery gate

Digest-content fixtures: out-of-radius, excluded-store, expired, stale and disabled-category offers are excluded; selected produce/meat carry price/unit, comparator count, conditions and source/expiry context; unavailable coverage and empty results are explicit; email includes at most ten offers and SMS at most three plus the full-digest link. Digest discovery is distinct from the list's shopping-stop cap.

Quiet-hours fixtures: both digest and immediate delivery defer until the first allowed instant, digest preserves its intended-period identity, and immediate candidates are revalidated then. Immediate-dedup fixtures: a 1% change never bypasses the ledger; a 10% drop before 24 hours is suppressed; a 10% drop after 24 hours may send if still eligible; Strong-to-Expiring transition alone does not resend; restart/retry preserves these rules.
Use a controllable clock for weekly scheduling, Seattle DST, quiet hours, expiration and cold-start data. Verify schedules are persisted as local wall time plus IANA zone; a nonexistent spring-forward wall time fires at the next valid instant; a repeated fall-back wall time fires once; and the ledger keys scheduled delivery to the intended local period across restart/retry. Verify channel/cadence toggles, duplicate suppression across restarts, provider acceptance versus delivered state, retries and ambiguous timeout handling. A send timeout with no provider message ID and no idempotency guarantee must become visible unknown/ambiguous state and must not automatically resend. Ensure stale data and missing credentials suppress sending.

Expiry fixtures must preserve the source date syntax and apply only source-specific semantics. For a Seattle date-only `through <date>` value confirmed by that source to be inclusive, assert an exclusive endpoint at the next local midnight. With unknown `through` semantics, assert unknown expiry and no expiring alert.

Preview locally first. Then verify one real email and one real SMS to the user's configured destination under explicit delivery authorization, plus a hosted run with the desktop closed. Record provider result IDs with sensitive details redacted. Do not claim delivery from a mocked API call.

## Release

Custom-penalty input checks (M2): accept zero and an ordinary positive two-decimal USD amount; reject negative, nonnumeric, infinite or excessive-precision values.

Every MVP acceptance criterion has recorded evidence; independent spec and quality reviews have no blocking issue; actual test/lint/type/build/package scripts pass; installed app critical path and backup restore succeed. Missing credentials, hosting approval, unavailable sources or absent live-message evidence remain documented blockers, not passing checks.
