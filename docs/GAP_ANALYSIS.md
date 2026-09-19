# Gap Analysis

Evidence baseline: 2026-09-18. Documentation templates existed; no app/manifests/Git repository were found.

| Gap | Evidence | Smallest next step | State |
|---|---|---|---|
| Sol High execution runtime | User approved spec and plan; three implementation attempts rejected trusted cwd/root context before producing code | Restore the configured route, then resume approved Task 1 | Blocked |
| Reliable local price coverage | Live QFC/Safeway Flipp requests returned 148/151 items; PCC page readable; units, conditions and local applicability not yet verified | Validate two retailer chains and five matching pairs | Open |
| Windows application | No source, manifest or installer | Plan/build source-backed deal-list slice after design approval | Open |
| Comparison and rating accuracy | Rules specified; no executable implementation | Deterministic normalization/matching fixtures | Open |
| Radius, stop cap, aggression and list | Spec only | Implement within bounded M2 scope | Open |
| Weekly/immediate delivery | No providers, destinations or scheduler configured | Preview and deterministic scheduling before live delivery | Open |
| Off-PC operation | Local/hosted alternatives researched, no deployment | Confirm hosting direction/cost and deploy only after source proof | Open |
| Verification/tooling | No canonical application checks | Establish actual scripts during M1 | Open |

## Material risks

- Catalog/API availability, reuse restrictions, source changes and access requirements can limit chain coverage.
- QFC/Safeway Flipp ads share one source service; sampled JSON lacks units/conditions and contains -04:00 timestamps for Seattle. Printed-ad interpretation remains unverified.
- Follow-up on 2026-09-19: item-detail endpoint supplies pre_price_text, price_text, description and disclaimer_text for sampled offers. This closes the missing-metadata discovery gap for those fields, but not price/branch/expiry validation or five-pair acceptance.
- Organic/bone-in/loyalty/units/channel mismatches produce false savings unless explicitly separated.
- Two-source launch gives limited comparison coverage; a rating based on one reliable competitor must name that competitor, show `1 comparison (limited coverage)`, and avoid any general market-best claim.
- Hourly polling cannot guarantee discovery of every brief or in-store clearance deal.
- A Windows-only collector misses checks while off; an always-on service adds cost.
- No blanket claim that Instacart prices equal shelf prices or that advertised items are in stock.
