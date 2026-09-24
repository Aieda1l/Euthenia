# Gap Analysis

Evidence baseline: 2026-09-24. The M1 Task 1 collector and proof code exist at a9e2101: 481/481 tests pass, and typecheck and lint are clean. The live source-proof gate is **BLOCKED**; see [M1_SOURCE_PROOF.md](research/M1_SOURCE_PROOF.md).

| Gap | Evidence | Smallest next step | State |
|---|---|---|---|
| Comparable price coverage (M1 source gate) | Live run: 0 qualifying offers per chain and 0 pairs under the approved rules. With both candidate identity relaxations, still 2 QFC / 5 Safeway and 0 pairs. Weekly sale items rarely overlap across chains. | User decides the source strategy. Recommended: add catalog prices, i.e. the Kroger Public API (needs the user's developer credentials) and a Safeway store product-search probe. | **Blocked on user decision** |
| QFC applicability/calendar evidence | qfc.com rejects this cloud host; the QFC ad is unattested | Attest from a residential connection, or use the Kroger API's store-scoped data | Open |
| Safeway applicability/calendar evidence | Store 2980 resolves to flyer 8139228; printed terms 7 a.m. Wed through Tue midnight (attested) | Repeat per weekly flyer; consider automating the store-publication check | Partially closed (current week) |
| Execution runtime | The Codex route was blocked; Claude Code now executes (DEC-20260924-001) | - | Closed |
| Collector, normalization, proof tooling | Built, reviewed over several rounds, tested offline; live run healthy (43/43 requests) | Keep healthy; extend when the source strategy changes | Closed for current scope |
| Comparison and rating (Task 2) | Rules specified; USDA grade/Angus not yet a discriminator (DEC-20260924-003) | After the source decision, implement eligibility/compare on the frozen contracts | Open |
| Windows application (Tasks 3-4) | No UI or Electron code; stopped by the plan's source-gate stop condition | Resume after the source gate can pass | Open (blocked) |
| Radius, stop cap, aggression, list (M2) | Spec only | Bounded M2 scope | Open |
| Weekly/immediate delivery (M3) | No providers, destinations or scheduler | Previews and deterministic scheduling before live delivery | Open |
| Off-PC operation | Local/hosted options researched; no deployment | Decide hosting after source proof | Open |

## Material risks

- Flipp is an undocumented consumer interface shared by both chains (correlated outage risk). Item-detail bodies were byte-stable across about an hour on 2026-09-24, which keeps hash-bound validations workable.
- Retailer sites (qfc.com) may reject data-center traffic, which matters for hosted collection.
- Weekly ads alone do not provide comparable competitor prices at the M1 floor. Catalog prices bring channel differences (in-store ad vs pickup/delivery) that the approved channel rules keep separate.
- Organic, grade, loyalty, unit and channel mismatches would produce false savings; the implementation keeps them unknown or excluded.
- A two-chain launch gives limited coverage; ratings must name the single competitor and say "1 comparison (limited coverage)".
- No blanket claim that ad or online prices equal shelf prices, or that advertised items are in stock.
