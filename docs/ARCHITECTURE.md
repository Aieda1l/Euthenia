# Architecture

## Implemented system (as of 2026-09-24)

The source-collection core of M1 Task 1 exists. It is a Node/TypeScript collector with pure normalization and proof logic. It has no UI, database, server, scheduler, installer or deployment. Code is on branch `claude/loving-ptolemy-6dkn4y`.

```text
scripts/collect.ts            thin CLI: npm run source:collect -- --postal-code 98105 [--validations f] [--report f]
src/source/collect.ts         run orchestration, audit output, report rendering, atomic snapshot write
src/source/flipp.ts           allowlisted HTTPS client (backflipp.wishabi.com only) and validated parsers
src/source/normalize.ts       Flipp item -> Offer (units, conditions, evidence, calendar), list-row classifier
src/source/proof.ts           evaluateProof/checkProof (source gate), attestations, proof assembly, candidate pairs
src/shared/contracts.ts       frozen plan contracts (Offer, Evidence, Proof, SourceSnapshot, ...), ValidationFile
src/shared/identity.ts        text-rule identity derivation and comparisonKey (documented vocabulary)
src/shared/money.ts           digit-wise USD parsing, BigInt rationals serialized as integer strings
src/shared/freshness.ts       strict timestamps, America/Los_Angeles local-date windows, freshness
```

## Data flow of one collection run

1. `flipp.ts` fetches the live 98105 listing. `collect.ts` selects exactly one current "Weekly Ad" each for QFC (family `kroger`) and Safeway (`albertsons`).
2. The collector fetches each flyer's rows and classifies them with the R2 rules. Only produce/meat candidates get an item-detail request.
3. Each item-detail response keeps its exact bytes. SHA-256 of those bytes binds the evidence ID `flipp:item:<id>:<hash12>`.
4. `normalizeFlipp` produces an `Offer`:
   - unit price only from explicit text;
   - conditions;
   - identity with unknowns;
   - `applicability` and `calendarRule`, which stay `unknown` unless a human per-flyer attestation from the validations file applies.
5. `assembleProof` combines the offers with the hash-bound human validations and pairs. `evaluateProof` recomputes the gate from the records: at least 10 qualifying offers per family including produce and meat, and at least 5 greedy cross-family pairs including one of each category.
6. Every run writes `data/audit/<run-id>/`: raw bytes, the attempts log, `diagnostics.json` and `report.md`. All of it is ignored by Git. `data/snapshots/m1-source.json` is replaced atomically only on PASS.
7. Exit codes: 0 PASS, 1 BLOCKED, 2 source/schema/usage error, 3 deferred by Retry-After.

## Established constraints

- Windows user interface for the product (Tasks 3-4, not built).
- Accurate provenance and comparable prices. Unknown is never guessed: plan addendum R1-R12 and amendments A1-A12.
- Network: HTTPS to `backflipp.wishabi.com` only, manual redirect validation, 15 s timeouts, concurrency 2, bounded retries. A deferral aborts all traffic.
- No runtime dependencies. Dev tooling is pinned exactly (see TEST_PLAN.md).
- Single user, minimal infrastructure.
- Agent runtime: Claude Code per `CLAUDE.md`. The Codex Sol High rule in AGENTS.md applies to Codex sessions only (DEC-20260924-001).

## Approved but not built

Windows Electron client (Task 3), Windows smoke (Task 4), comparison/eligibility (Task 2), and later a hosted scheduler with SQLite (M3). See [MVP_SPEC.md](MVP_SPEC.md) and the [M1 plan](plans/active/2026-09-19-m1-windows-deal-comparison.md).
