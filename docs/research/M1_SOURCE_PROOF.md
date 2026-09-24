# M1 source proof - status: BLOCKED

**Gate result (2026-09-24 19:38Z, code ea20708): BLOCKED, exit 1.** The live run on current ads found 0 qualifying offers per chain and 0 counted pairs. The gate needs 10 per chain and 5 cross-chain pairs. No snapshot was written. Under the plan's stop condition, Task 1 and M1 stay open and dependent UI work (Tasks 3-4) does not start.

Full generated report for this run: [M1_SOURCE_PROOF_RUN_2026-09-24T19-38Z.md](M1_SOURCE_PROOF_RUN_2026-09-24T19-38Z.md). Validation input: [M1_SOURCE_VALIDATIONS_2026-09-24.json](M1_SOURCE_VALIDATIONS_2026-09-24.json). Source evidence: [M1_SOURCE_EVIDENCE_2026-09-24.md](M1_SOURCE_EVIDENCE_2026-09-24.md).

## What ran

- Command: `npm run source:collect -- --postal-code 98105 --validations docs/research/M1_SOURCE_VALIDATIONS_2026-09-24.json`.
- Collector commit: ea20708. 562/562 unit tests pass, and typecheck and lint are clean.
- Requests: 43 live HTTPS requests to `backflipp.wishabi.com`, all accepted. The run used concurrency 2 and allowlisted hosts only.
- Flyers were selected from the live 98105 listing, not hardcoded:

| Family | Flyer | Raw validity | Rows | Detail candidates |
|---|---|---|---|---|
| QFC | 8132234 | Sep 23-29 | 136 | 18 |
| Safeway | 8139228 | Sep 23-29 | 160 | 22 |

- 39 produce/meat offers were normalized. All other rows were excluded with reasons (non-grocery, prepared, seafood, cured/processed, beverages and so on).

## Verified evidence in this run

- **Safeway applicability (store level).** Safeway's own weekly-ad configuration for store 2980 (U District) resolves to flyer 8139228. Attested, so every Safeway offer is `applicability: verified`.
- **Safeway calendar.** The printed terms read "available 7 a.m. Wednesday, September 23, thru Tuesday, September 29, 2026, Midnight". Offers therefore run from 2026-09-23T14:00Z to 2026-09-30T07:00Z (exclusive).
- **One human validation, bound to the exact response hash.** Safeway Gala Apples (`flipp:item:1040925327:049a585f2404`) was checked against printed page 4: $1.49/lb member price, whole Gala apples, no organic claim. The collector accepted the validation. Its only remaining exclusion is `organic` unknown, which the approved rules require.
- **QFC: unattested.** qfc.com times out or resets from this cloud host, so QFC branch participation and printed dates could not be verified. The QFC ad's dates and its "QFC 705" (division) marker are suggestive only.

## Why the gate fails, quantified

The table recomputes the counts from this run's normalized offers, using the repository's own `comparisonKey`. The counts assume every offer were attested and validated, so they are an upper bound. "Qualifying" means a known comparison key, a unit price and no normalization issue.

| Identity rule set | QFC qualifying | Safeway qualifying | Cross-chain pairs |
|---|---|---|---|
| Approved rules (current) | 0 | 0 | 0 |
| + produce without an organic claim = conventional | 1 | 3 | 0 |
| + meat without a frozen marking = fresh | 0 | 2 | 0 |
| Both relaxations | 1 (Envy apples) | 5 (Gala, Cosmic Crisp, Bartlett pears, chicken breasts, cube steak) | **0** |

The main constraint is not the identity strictness. Weekly ads list only a few dozen produce/meat items, and many lack an explicit unit basis: "With Card" alone, bags, multi-buys, BOGO. QFC's 93% ground beef, for example, states two package prices ($23.97 for 3 lb, $8.99 for 1 lb) that do not share one per-lb price, so it stays unpriced. The two chains' sale items rarely overlap. This week QFC advertises Envy apples, 93% ground beef and whole chicken; Safeway advertises Gala and Cosmic Crisp apples, chicken breasts and beef steaks. Even with both relaxations and full attestation, no week-one pair exists. The 10-per-chain floor is also out of reach.

PCC, the plan's fallback, has about 8 produce and 5 meat specials over a three-week period, many without units. It cannot meet the 10-per-family floor either.

## What would unblock M1 (user decision needed)

The approved MVP spec anticipated this. It lists official Kroger data as "a later enrichment option" and a Safeway product endpoint as a probe "if ads lack necessary coverage". The realistic paths are:

1. **Add regular (catalog) prices per chain, alongside the weekly ads.** Recommended.
   - QFC: the official Kroger Public API (product search with `filter.locationId`). It needs **your** Kroger developer registration and OAuth2 client credentials. This is free to register, but no account can be created on your behalf.
   - Safeway: a store-scoped product search endpoint. It is undocumented, has bot protection and needs a feasibility probe.
   - Either would give per-lb and each prices for most produce/meat at a known store. Deal ratings would then compare a sale price with the competitor's current price, which is closer to the spec's intent than ad-versus-ad.
   - These are pickup/delivery channel prices, so the approved channel rules separate them from in-store ad prices. The source-proof gate wording and the channel rules would need your review for this design.
2. **Relax identity defaults** (organic, fresh). Useful later, but insufficient alone: 0 pairs this week.
3. **Change the gate** so evidence accumulates across weeks. That weakens "current observations" and requires a scope revision.
4. **Attest QFC from a residential connection** (your Windows PC). This is necessary for any QFC-ad path, but it does not fix the pair gap.

No paid services, accounts, credentials or messages were created. The source-proof gate was not waived or weakened.
