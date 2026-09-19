# Euthenia Windows MVP specification

**Date:** 2026-09-18  
**Status:** Approved by the user on 2026-09-19; no implementation or deployment.  
**Intent:** Help a UW Seattle student choose inexpensive weekly ingredients, compare prices accurately, limit shopping effort, and receive useful alerts.

## Recommended approach and alternatives

Use a Windows desktop app with one small hosted collector/scheduler. Recommend Electron + React/TypeScript for the app, a TypeScript/Node service, and one SQLite database on a persistent server disk. This permits HTTP/HTML collectors and, only if a validated source needs it, browser automation without a second language or distributed infrastructure. The installed UI communicates over an authenticated HTTPS API. The server is the authority for preferences, offers, lists and delivery state.

Local-only is the cheapest alternative: run the same collector entry point through Windows Task Scheduler. It cannot provide off-PC alerts and wake behavior is hardware/power-policy dependent. Keep this as an alternative deployment decision, not a second synchronized product in the first MVP.

A hosted PWA is another simpler distribution choice, but a packaged Windows app best matches the user's explicit Windows request. Tauri would reduce package size but introduces a Rust/native boundary with no current product benefit. A Cloudflare scheduled Worker may lower hosting costs for HTTP-only sources, but must first demonstrate that the actual parsers fit its runtime/CPU quotas. Do not build both hosting stacks.

Proposed cost envelope is roughly $6/month for an HTTP-only VM or $12/month as an initial browser-automation budget, excluding domain, backups, SMS and any paid data/proxy service. These are estimates, not validated capacity or a spend authorization. Research and source tests precede paid deployment.

## Small first milestone

Prove a trustworthy Windows deal-list and deal-detail slice from two independent retailer chains. Probe Flipp's QFC and Safeway ads first: live research returned 148 and 151 items respectively for ZIP 98105. These counts prove access only; sample rows omit units/conditions, and sale-validity timestamps need printed-ad/local-time validation. Both feeds share Flipp, so retain PCC HTML as an independent fallback/reference candidate. Official Kroger data is a later enrichment option. Gate broader UI/alerts work on ten validated observations per chain and five correctly matched produce/meat pairs across chains. If evidence is insufficient, show that limitation and keep the milestone open. See [DATA_RESEARCH.md](DATA_RESEARCH.md).

## Core screens

1. **This week:** location and radius at top; maximum stops and aggression alongside them. Show Produce / Meat / All filters, search, source freshness, and rated deal rows. Each row has price/unit, store, approximate straight-line distance, expiration, eligibility badges and Add to list.
2. **Deal detail:** comparable offers table; exact versus category-equivalent match label; rating arithmetic; advertised discount separately; source links, timestamps, unit and package terms. Noncomparable substitutes are a separate section.
3. **Shopping list:** quantities grouped by store, subtotal/estimates, uncovered items, and the incremental savings of adding a stop where sufficient price coverage exists.
4. **Alerts/settings:** schedule, timezone, strong and expiring toggles, independent email/text controls, quiet hours, destinations and delivery/setup status. Provide a preview before enabling.

Use clear price typography, restrained color and text labels as well as colors for ratings. The empty state explains missing data or narrow radius and provides a direct source link. No sample price is presented as live. Keyboard focus, contrast and Windows scaling are release checks.

## Location, stores and aggression

- Default location: labeled UW Seattle campus center; user may select a different pin/address. Do not claim dorm-level precision.
- Proposed radius default: 2 miles; editable 0.5-15 miles. It means straight-line distance, not walk/transit distance. Do not infer travel time from it.
- Every candidate store shows whether its data is supported, current, stale or unavailable.
- Maximum shopping stops: 1-5, default 2. This limits the saved-list recommendation, not the number of competitor stores checked.
- Store include/exclude choices constrain recommendations and comparisons. Explain coverage when fewer eligible stores exist.
- Aggression presets: Easy / Balanced / Max savings set an extra-stop tradeoff penalty of $5 / $3 / $1 per added stop, default Balanced. User can override the penalty amount; selecting a preset never silently changes radius or maximum stops. This penalty is a ranking preference, not a minimum-savings guarantee or a charge.
- Calculate purchase totals only for the same requested quantities and equivalent products with complete alternatives. Evaluate store subsets up to the chosen stop cap for a small local catalog. For each candidate subset, adjusted cost = purchase total + penalty * (stops - 1). Select the lowest adjusted cost, break ties by fewer stops then distance, and show the actual purchase total separately from the preference penalty. If coverage is incomplete, group saved deals and mark optimization unavailable.
- Package minimum purchases and coupon quantities affect purchase totals. An estimated meat weight stays an estimate. Future transportation cost/routing is deferred.
- Custom aggression penalties must be finite nonnegative USD amounts with at most two decimal places. Zero is valid and means no preference penalty for additional stops. Reject negative, nonnumeric and infinite values.

## Observation and comparison contract

Each observation records source and source URL; retailer and physical store/explicit region; collection time; published validity dates if supplied; channel (in-store ad, retailer pickup, retailer delivery, Instacart pickup/delivery); product/variant/UPC when present; category attributes; currency; price amount and basis; package quantity/weight; regular price if supplied; coupon/loyalty/minimum-quantity/limits; availability as stated; and parsing/validation status.

Retain a small raw evidence excerpt or source snapshot reference for audit. Preserve the source's date syntax verbatim alongside any parsed validity fields. Unknown is distinct from zero or false. Canonical offers may deduplicate identical store offers for display/ranking, but retain every source-specific provenance observation that contributed to the canonical offer. Source policy determines retention/access limits; an HTML listing or API key is not a guarantee of every allowed reuse.

Compare USD/lb for explicit mass quantities (16 oz = 1 lb), per each for counts, or an explicitly matching volume unit. Never convert each/bunch/pint volume to weight without actual evidence. Package ranges or missing units cannot support precise unit comparisons.

Match produce on type/variety, organic status and form; meat on animal, cut, bone/skin, fresh/frozen and fat percentage where relevant. Match branded packaged goods by variant/UPC/size where possible. If a discriminator required by the category contract is unknown, the observation cannot qualify as either an exact or category-equivalent competitor match for ranking or Strong automation. A plausible cooking substitute is not an exact competitor price. No LLM-only match or OCR result can trigger a Strong alert without validation.

Conditional prices are eligible for automated comparison only when the user has configured the required loyalty status and every required coupon activation and minimum quantity is confirmed for that user/context. Otherwise display the offer as conditional, keep its provenance, and exclude it from automated Strong classification/alerts.

Treat in-store advertisements, online pickup, delivery and Instacart prices as distinct channels. Display cross-channel information for reference but exclude it from a same-channel rating. Instacart prices are labeled Instacart prices and not silently adjusted to estimated shelf prices. Delivery fees/tips/minimums are separate from item comparisons and are not hidden inside claimed grocery savings.

## Rating

A deal label is evidence-backed, not a fabricated precision score. One or more valid competitor retailer families can support a rating. Exclude the candidate retailer family, take each eligible competitor family's best observed valid matching unit price, then compute the median across those family-level prices. Compute savings = (median - candidate price) / median.

- Exceptional: at least 30% below that median.
- Strong: at least 20% below.
- Good: at least 10% below.
- Typical: less than 10% below and no more than 10% above.
- Above comparison: more than 10% above.
- With one competitor family, apply the same thresholds against that one family-level reference but name the competitor and coverage in both UI and immediate-alert text, for example `Strong vs Safeway - 1 comparison (limited coverage)`. Never turn a one-reference rating into a general market-best claim.
- With two or more competitor families, show the median reference plus competitor-family count and reference-price range.
- With none, show Unrated / insufficient comparison data. Store-advertised discount can still display separately.

Coverage and data correctness are separate dimensions. A Strong immediate alert may use one reliable competitor family when the candidate and reference are an exact match or a fully defined category-equivalent match, both prices are fresh in the same comparison context, and the user's required eligibility is known. Prices from different stores in one corporate family do not inflate competitor count. At exactly two retailer families, every rated offer carries `1 comparison (limited coverage)`; unmatched offers are Unrated. The two-chain MVP source floor remains unchanged. Accumulate observations for future history-based ratings, but do not invent history or use store regular prices as history.

## Scheduling and notifications

- Digest content: select up to ten current, non-stale offers from the configured radius, store subset and enabled categories, prioritizing produce and meat when available. Rank by explained observed savings, then unit price only within a comparable product group; include comparator count, price/unit, store, conditions, source link and known expiry. Include coverage/failure status. An empty set produces a clear "no verified matching deals" digest with source status, never a claim that no store has sales. Email contains the selected offers; SMS contains the top three and a link to the full digest. The digest is discovery; its offer-store count may exceed the maximum shopping stops, which applies to the selected list recommendation.
- Weekly digest toggle: proposed Wednesday 08:00 America/Los_Angeles, editable weekday/time. Store the schedule as local wall-clock weekday/time plus an IANA time zone, not as a fixed UTC offset. If the intended local time is skipped by a spring-forward transition, fire at the next valid instant; if it repeats during fall-back, fire once for that intended local period. The choice is a UI default, not a claim about every retailer's ad cycle.
- Immediate Strong deals and Expiring deals are independent switches, initially off.
- Each cadence has separate Email and SMS toggles. A selected channel without valid setup shows Needs setup and cannot pretend to deliver.
- Strong alert requires Strong/Exceptional evidence. Expiring alert requires a known expiry within 24 hours and at least 10% savings against a named eligible competitor; label limited coverage when appropriate. Expiry alone never makes a poor price urgent.
- Proposed polling: weekly ads every six hours; approved volatile-price sources every hour during 07:00-22:00 Seattle time. Respect source limits, Retry-After and backoff. Show last/next check and warn that immediate means after detection, not continuous retailer push.
- Revalidate candidate and reference prices before an immediate send, using the same store/channel/eligibility context. Expiry interpretation is source-specific and must preserve the original date syntax. For a Seattle date-only `through <date>` value, only a source rule confirmed to mean inclusive-through-date may normalize it to an exclusive endpoint at the next local midnight; if the source semantics are unknown, expiry stays unknown and cannot trigger an expiring alert. Catalog prices older than 24 hours and ads not successfully rechecked within 24 hours are stale; expired offers are removed from active results. A missing or semantically unknown ad expiry prevents an expiring claim.
- Quiet hours default 22:00-08:00 and apply to both cadences. A scheduled digest inside quiet hours is deferred to the first allowed instant after quiet hours, preserving its intended local schedule period for deduplication. Deferred immediate candidates are evaluated at that same boundary, revalidated and discarded if expired or no longer eligible. Limit immediate delivery to three grouped messages per channel/local day; excess deals stay visible and may appear in the digest.
- Persist a delivery ledger keyed by user/channel/intended local period for digests. For immediate sends, use user/channel/canonical offer episode (retailer-store, product variant, promotion conditions and validity period) independently of current price or trigger type; Strong and Expiring intentionally share suppression and can be combined in one message. Record last-sent price/time separately. After the first send, a repeat requires BOTH a price decrease of at least 10% from the last-sent price AND at least 24 hours elapsed; changing the price or retailer offer ID cannot bypass this predicate. An already-sent Strong offer does not get a separate Expiring reminder without satisfying the repeat rule. Restart/retry must not replay the same alert, including the repeated wall-clock hour during fall-back.
- Use provider idempotency where supported. After a send timeout with no provider message ID and no idempotency guarantee, record an unknown/ambiguous delivery state, do not automatically resend, and surface visible manual resolution. When provider status can be reconciled, do so before any retry. Distinguish prepared, provider-accepted, delivered, failed and unknown/ambiguous.
- Email recommendation: Resend or the user's existing authenticated sender; verified-domain requirements apply for normal production delivery. SMS recommendation: Twilio with the applicable sender setup and fees. No destination, credential or spend is assumed.
- Actual delivery tests require the configured user's destination; generating previews is the initial verification step.

## Minimal technical boundaries

One hosted process owns collection, matching, schedule evaluation, authenticated API and delivery. Use SQLite transactions for observations/preferences/list/delivery ledger; no Redis, queue broker or microservices. Store service secrets outside the repository and outside the renderer. Pair the single-user Windows client with a revocable high-entropy token over HTTPS; store it through Windows-protected credentials. Validate inputs and source URL allowlists; never let the service fetch arbitrary user URLs.

Package local UI assets in Electron, enable renderer sandbox/context isolation, disable renderer Node integration, narrowly validate IPC and open retailer links in the system browser. Do not render scraped HTML as trusted markup. The desktop caches last-view data as visibly stale/read-only while offline; no offline write synchronization in the first release.

Collector errors preserve last-known observations with their original timestamp. Parse failures, sudden empty feeds and unit/schema changes mark a source degraded and suppress new alerts. Back up the SQLite database and test restore before enabling hosted unattended operation.

## Verification

See [TEST_PLAN.md](TEST_PLAN.md). Deterministic fixtures cover normalization, mismatches, radius, store cap, partial coverage, ratings, timezones, expiration, deduplication and failures. Live comparison checks verify five matched pairs and ten observations per source against the source's same store/channel context. M1 smoke verification covers Windows launch, deal-list display and source-backed deal details; M2 adds installer, persisted preferences and shopping-list smoke coverage. No full-MVP completion claim until both channels and unattended operation are verified.

Each chain's ten-observation sample must contain both produce and meat, and the five matched pairs must contain at least one pair in each category. Missing one category keeps the milestone open.

## Review decisions

The user approved this specification on 2026-09-19, including the Windows app + hosted collector direction and scoped source-first milestone. The cost envelope remains an estimate. This approval permits a concrete implementation plan; it does not purchase services or send messages. The writing-plans handoff still requires review of the resulting plan before execution.
