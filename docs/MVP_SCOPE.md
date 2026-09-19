# MVP Scope

Status: **Approved by the user on 2026-09-19**, derived from the 2026-09-18 request. No application is implemented.

## Outcome

A Windows user near UW Seattle can see source-backed produce/meat deals, compare genuinely comparable nearby prices, build a shopping list limited to their selected stores, and receive a weekly digest with optional immediate email/SMS alerts.

## In scope

- Single user, USD, Seattle-area initial coverage; campus preset and editable location.
- Radius, store inclusion/exclusion, maximum shopping stops, and independent aggression setting.
- Produce/meat first, normalized units, clear conditions and competitor evidence.
- Explainable rating or explicit insufficient-data state.
- Saved list with quantities and store grouping.
- Weekly digest and separate strong-deal / expiring-deal alert switches.
- Independent email/SMS controls for each cadence, quiet hours and duplicate suppression.
- A packaged Windows application; recommended hosted collector for alerts while PC is off.
- Initial source target: two independent retailer chains with verified applicable offers. Probe the accessible QFC and Safeway Flipp feeds first, with PCC HTML as an independent fallback/reference. Shared Flipp infrastructure is a correlated outage risk; item counts are not validated price coverage. A chain's presence near UW is not a promise of data coverage.

## Acceptance criteria

- [ ] A Windows installer launches a keyboard-usable interface on Windows.
- [ ] Location/radius changes update eligible physical stores and persist after restart.
- [ ] All shopping suggestions respect the selected store subset and maximum stops.
- [ ] At least two independent chains each supply ten validated current observations containing both produce and meat; at least five cross-chain pairs are manually checked, including at least one produce pair and one meat pair. Otherwise multi-store MVP remains incomplete.
- [ ] Every price displays its source, applicable store/region, channel, unit, conditions, observation time and known expiration.
- [ ] Unit conversions, meat attributes, organic status, unknown values, package minimums and coupons behave according to MVP_SPEC.md.
- [ ] Rating explanation exposes the comparison basis and coverage; missing evidence never becomes invented savings.
- [ ] Saving quantities yields a transparent list subtotal or an explicit incomplete/estimated total.
- [ ] Weekly scheduling honors America/Los_Angeles including DST and suppresses duplicate sends after restart.
- [ ] The digest includes only current offers in the configured store/radius/category scope, with rating coverage, conditions and source/expiry context; missing coverage and no-deal states are explicit.
- [ ] Both immediate-alert switches and each email/SMS toggle independently gate delivery.
- [ ] Each external channel passes one authorized live delivery check to the user's configured destination; dry-run evidence alone does not complete delivery.
- [ ] Hosted-mode alert checks continue with the Windows app closed/PC off. If local-only is chosen instead, scope is explicitly revised and the limitation shown.
- [ ] Source failures/staleness are visible and do not generate new price alerts.
- [ ] Spec review, quality review, relevant tests, type/lint/build and critical-path smoke checks pass.

## First implementation milestone boundary

M1 proves acquisition and comparison using two sources and a minimal Windows deal-list/detail slice. It excludes the installer, persisted preferences/list behavior, real notifications, cloud deployment and elaborate shopping optimization. M2 adds the installer plus preferences/list behavior; later MVP milestones add verified scheduling/delivery. M1 is not the complete MVP.

## Explicit deferrals

Nationwide store discovery, full route optimization, automatic checkout, advanced coupons/rewards, arbitrary recipe generation, historic price ratings before enough real observations, and simultaneous local/cloud synchronization. See [BACKLOG.md](BACKLOG.md).
