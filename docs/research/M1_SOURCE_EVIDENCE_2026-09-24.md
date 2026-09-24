# M1 source evidence - 2026-09-24

Read-only research in the Claude Code cloud container, run in parallel with Task 1A. None of these items is a validated observation or a gate pass.

## Current flyers (98105 listing, 2026-09-24 ~16:55Z)

| Family | Flyer | Name | Raw validity | Items |
|---|---|---|---|---|
| kroger (QFC) | 8132234 | Weekly Ad | 2026-09-23T00:00:00-04:00 to 2026-09-29T23:59:59-04:00 | 136 |
| albertsons (Safeway) | 8139228 | Weekly Ad | same | 160 |

The listing also includes Safeway and Albertsons "Big Book of Savings" (Sep 8 - Oct 4), Fred Meyer (Kroger family), Albertsons Weekly Ad, Metropolitan Market, Grocery Outlet and Target. Both weekly ads report `is_store_select: true` and `timezone: -240`.

## Safeway: store-level applicability (strong evidence)

Safeway's public store page for 4732 Brooklyn Ave NE links its weekly ad with `storeId=2980`. Safeway's weekly-ad web bundle (`/weeklyad/dist/weeklyad/main.*.js`) requests `https://api.flipp.com/flyerkit/v4.0/publications/<merchant>` with a public client `access_token`, `postal_code` and `store_code`.

The same request for `store_code=2980` returned exactly one publication: **8139228, "Weekly Ad - Safeway - Seattle"** (flyer type `safewayseattle`). That is the same flyer ID as the ZIP listing. Recorded response, token redacted: [SAFEWAY_STORE_2980_PUBLICATION_2026-09-24.json](SAFEWAY_STORE_2980_PUBLICATION_2026-09-24.json).

This is branch-level evidence that flyer 8139228 applies to Safeway U District. It is not a stock guarantee.

## Safeway: printed calendar semantics

The publication's printed PDF (`pdf_url` in the evidence JSON; 6 image-only pages; SHA-256 `fbfe772adba694cdd01e1c8cc2fa30e2e86bb9cd3bc8932eb711e04878650cf9`) carries this fine print on page 1 ([left](safeway-ad-terms-left-2026-09-24.jpg), [right](safeway-ad-terms-right-2026-09-24.jpg)):

> Items and prices in this ad are available 7 a.m. Wednesday, September 23, thru Tuesday, September 29, 2026, Midnight at your local Safeway and Albertsons stores. (UNLESS OTHERWISE NOTED) ... Safeway or Albertsons for U(TM) offer must be downloaded to your account prior to purchase.

Interpretation for M1:
- Start is 07:00 America/Los_Angeles on the first date. Midnight is wrong for this source, so R8 now takes an attested `startLocalTime`.
- End is inclusive through Tuesday, which is an exclusive end at the next local midnight (2026-09-30T07:00:00Z).
- The Flipp `-04:00` offsets are not Seattle time. The date parts match the printed dates.

"Unless otherwise noted" items are dated separately and correctly in Flipp's per-item fields: the "$5 Friday" items are Sep 25 only, and the "Cheap Chicken Monday" item is Sep 28 only. Human validation must still check each counted item's dates against the printed page.

The printed ad also labels frozen status explicitly: "Frozen" on raw shrimp and "Previously Frozen" on lobster tails.

## QFC: evidence not obtainable from this host

- `https://www.qfc.com/weeklyad` and `https://www.qfc.com/` time out or reset from the container. The proxy reports no relay failures, which suggests QFC rejects data-center traffic.
- Flipp's web viewer is client-rendered and does not expose page images through simple requests.
- Guessed tile URLs return 403.
- The Flipp flyerkit API needs a QFC client token, which only QFC's own blocked site would provide.

QFC applicability and printed calendar semantics remain **unknown**. The ZIP listing, an item named "QFC 705" (division 705 matches University Village's store URL `/705/00807`) and the Wed-Tue raw dates are suggestive only. QFC can be attested from a residential connection (for example, the user's Windows PC) by viewing the QFC University Village weekly ad.

## PCC fallback assessment

The public specials page (`/departments/weekly-specials/all/`) returned 200 and says "Prices effective 09/09/26 through 09/29/26. No Coupons necessary."
- Produce has about 8 items, all labeled Organic. Several have no unit (bunched carrots, sweet onions, zucchini) or use a pint or multi-buy.
- Meat & Seafood has 6 items. Only about 2 are raw, unmarinated cuts with a unit (pork boneless top loin chops $6.99/lb; organic ground turkey 16 oz). Fresh/frozen status and fat percentage are unstated.

PCC cannot supply 10 qualifying observations with both categories under the approved rules. It remains a reference source only.

## Feasibility under the approved identity rules

- Produce `organic` is unknown unless the ad says so (plan: silence is never evidence of conventional). Conventional produce in both supermarket ads therefore has no comparison key and cannot count toward the 10 per family.
- Safeway's current ad has no organic produce. QFC has organic strawberries and blackberries/raspberries.
- Meat `freshFrozen` is known only from explicit "fresh" or "frozen" text. Several meat items say "Fresh"; many don't.

The live collector report (Task 1C) will give exact counts. The expected outcome is a truthful **BLOCKED** gate. That would turn two possible, documented source rules into user product decisions:
1. Supermarket-ad produce without an organic claim is conventional.
2. Meat not marked frozen or previously frozen in the printed ad is fresh.

Neither is adopted without user approval.
