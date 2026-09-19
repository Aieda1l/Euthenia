# Grocery data and delivery research

**Research date:** 2026-09-18. **Target:** a single-user Windows app for budget groceries around UW Seattle.  
**Status:** Research evidence and recommendations; no production collector, installer, provider account or deployment exists.

## Recommendation

Start with location-scoped weekly ads: Flipp's QFC and Safeway feeds, with PCC's public specials as a simpler independent reference/fallback. Enrich with Kroger's official store-specific API when credentials and permitted use are confirmed. Keep Instacart as an explicitly labeled optional source after a concrete coverage gap is demonstrated.

A live read-only probe returned current QFC and Safeway flyer items for ZIP 98105. That demonstrates endpoint access, not accurate normalized prices yet: several item records omit units and conditions, and their timestamps require validation. The next milestone must solve those issues before calculating savings.

## Evidence levels

- **Live HTTP probe:** direct request executed here; payload shape/count/sample recorded.
- **Primary page inspected:** official/provider/project page readable through web tooling; could be indexed/cached, not an authenticated account test.
- **Project claim:** what a project's author reports, not independently executed.
- **Unverified:** credentials, current runtime behavior, local applicability or license not established.

No third-party repository code was run or installed.

## Live Flipp probe

Public endpoint: [flyer listing for 98105](https://backflipp.wishabi.com/flipp/flyers?postal_code=98105). The web tool could not open it; PowerShell's initial sandbox request could not connect. The approved unsandboxed read succeeded with exit code 0.

| Merchant | Flyer | Displayed validity | Detail result |
|---|---|---|---|
| QFC | 8123483 | Sep 16-22, 2026 | 148 items |
| Safeway | 8129241 | Sep 16-22, 2026 | 151 items |
| Metropolitan Market | 8130302 | Sep 16-22, 2026 | Listing only; detail not probed |

The [QFC detail](https://backflipp.wishabi.com/flipp/flyers/8123483?postal_code=98105) and [Safeway detail](https://backflipp.wishabi.com/flipp/flyers/8129241?postal_code=98105) expose items/pages/has_corrections. Sample item fields include id, name, price, cutout_image_url, valid_from, valid_to, available_to and text_areas.

Critical findings:

- Actual price field is **price**, not current_price. Project examples cannot be assumed to match the current payload.
- Sample prices were strings; sample text_areas arrays were empty. Scalar values alone cannot distinguish per-pound, each, package or multibuy pricing.
- One Safeway fruit offer has valid_to on September 18, while available_to is September 22. **available_to is not a safe sale-expiration field.**
- Raw timestamps contain **-04:00 even for the Seattle ZIP**. Preserve raw values, validate the printed local dates and establish source-specific interpretation before urgency alerts.
- A ZIP-targeted flyer does not prove every physical branch participates. Check the printed ad and local store context.
- Five sample payload rows are retained in [FLIPP_PROBE_2026-09-18.json](research/FLIPP_PROBE_2026-09-18.json). They are research observations, not shopping advice or normalized live offers.
- Both chains depend on the same Flipp infrastructure; an outage affects both. PCC offers an independent source path.
- This is an undocumented consumer-facing interface, not a verified supported developer API or usage agreement.

## Source assessment

### Follow-up item-detail probe - 2026-09-19

Direct requests to `https://backflipp.wishabi.com/flipp/items/{id}` succeeded for six sampled records. Full responses are retained in [FLIPP_DETAIL_PROBE_2026-09-19.json](research/FLIPP_DETAIL_PROBE_2026-09-19.json). This endpoint wraps the record in `item` and adds `current_price`, `pre_price_text`, `price_text`, `description`, and `disclaimer_text`. The earlier finding that flyer-list records lack those fields remains true; the adapter should follow the list with item-detail requests.

- QFC apples: price text explicitly says per pound and With Card.
- QFC ground chuck: $7.99 for a 1 lb package with card. The [downloaded cutout](research/qfc-beef-cutout-2026-09-19.jpg) visually confirms package/unit/condition text.
- Safeway ground beef: $4.99/lb, 80% lean, sold in a 3 lb pack for $14.97 with a limit of one and member eligibility. The [downloaded cutout](research/safeway-beef-cutout-2026-09-19.jpg) visually confirms these fields.
- Safeway broccoli/cauliflower: explicit per-pound member price.
- QFC's combined chicken-cuts offer has an empty numeric price; it must not become zero or an invented per-pound price.
- The expired September 18 fruit offer has `pre_price_text = 2 for`; preserve the multibuy condition instead of treating $5 as the each price.

This improves automatic metadata feasibility. It does not establish all category discriminators, branch participation, Seattle expiration interpretation, user eligibility, or five matched pairs. No production collector or third-party code was installed. Live inspection alone does not satisfy the full M1 acquisition gate.

| Source | What is established | Access/limitations | Recommendation |
|---|---|---|---|
| Flipp circular JSON | Direct listing and two detail requests succeeded for 98105 | Regional ads, incomplete unit/condition text, unsupported interface; no published quota verified | First extraction probe; validate flyer imagery/detail against every accepted field |
| PCC public weekly specials | Public HTML contains sale/regular prices, categories and effective dates | Some items have explicit lb/oz/each; others lack unit basis. Regional application and availability need confirmation | Simple first HTML adapter/reference |
| Kroger Public APIs: QFC/Fred Meyer | Official documentation supports product and location lookup, requiring locationId for price | Register app, OAuth2 credentials; no authenticated request made. Account terms/retention/display permissions not verified | Best official enrichment candidate |
| Safeway browser endpoints | An inspected project's experiment reports store-scoped product search | Undocumented endpoint, browser/session/header requirements and bot blocking; no Seattle endpoint test here | Secondary focused probe if ads lack necessary coverage |
| Instacart Developer Platform | Official docs expose shopping-list/recipe links and nearby-retailer integration | Overview mentions discovery/pricing, but inspected list endpoint returns a URL, not a cross-store price table. Exact catalog entitlement remains unverified | Do not assume ordinary developer keys provide a comparison feed |
| Instacart browser/API extraction | Open-source projects implement session-based GraphQL or hosted scraping | Must validate actual retailer/location/mode, variable weight, loyalty context, query churn and price policy | Optional separate online-price comparison channel |
| H Mart / Metropolitan Market | Regional H Mart weekly-deal site and Metropolitan Market ad/store pages found | Branch-specific ad participation and extractable units still need checking | Expansion candidates, not promised initial coverage |

PCC's inspected page showed an effective period of September 9-29, 2026. Two explicit examples were organic Bartlett pears at $1.99/lb (regular $2.99/lb) and boneless pork top loin chops at $6.99/lb (regular $8.99/lb). Other produce rows omitted a unit. These illustrate both parseable and reject/inspect cases; they do not establish competitive value. [PCC specials](https://www.pccmarkets.com/departments/weekly-specials/all/)

Kroger's official public collection requires developer registration and OAuth2 credentials. Product prices require filter.locationId; published limits are 10,000 product calls/day and 1,600 location calls/day per endpoint. The primary developer site was not text-readable, so the official Kroger Postman collection was used. No promise is made about coupon coverage, expiry fields or shelf-price parity. [Official public API documentation](https://www.postman.com/kroger/the-kroger-co-s-public-workspace/documentation/ki6utqb/kroger-public-apis), [official workspace](https://www.postman.com/kroger/the-kroger-co-s-public-workspace/overview)

Instacart's shopping-list endpoint returns products_link_url. Its FAQ describes limited initial endpoint permissions; the changelog documents a production-key approval process. These observations support treating price-table access as an open question rather than assuming it is available or impossible. [Shopping-list response](https://docs.instacart.com/developer_platform_api/api/products/create_shopping_list_page), [FAQ](https://docs.instacart.com/developer_platform_api/faq), [changelog](https://docs.instacart.com/developer_platform_api/api/changelog)

Instacart documents retailer-specific price policies and variable-weight final charges. Keep its observed prices in an Instacart channel; never silently relabel them as shelf prices or subtract an assumed markup. Verify the configured location in the actual session/request, not just an output ZIP label. [Instacart item pricing](https://www.instacart.com/help/section/866017999/1586544648)

## Useful GitHub projects

License statements concern code reuse, not rights to source grocery data. Pin and inspect a chosen revision before adoption; popularity is not runtime evidence.

| Project | Verified evidence / limitation | Reuse recommendation |
|---|---|---|
| [justinkuzmanich/scoop-alert](https://github.com/justinkuzmanich/scoop-alert) | README describes ZIP -> flyer list -> flyer items; a May 29, 2026 snapshot and 162-commit history were visible. License not verified. Its optional search-snippet pricing can lag. | Best small Flipp protocol reference; write a thin adapter independently if no suitable license. Do not copy snippet-price merging into accuracy-critical alerts. |
| [CupOfOwls/kroger-api](https://github.com/CupOfOwls/kroger-api) | Python client; MIT license inspected. [Changelog](https://github.com/CupOfOwls/kroger-api/blob/main/CHANGELOG.md) lists v0.3.1 on July 8, 2026 and token fixes/tests. | Useful official API implementation/reference; adding a Python runtime solely for this wrapper is unnecessary if the app is TypeScript. |
| [abracadabra50/open-supermarkets](https://github.com/abracadabra50/open-supermarkets) | MIT license inspected. TypeScript provider matrix includes Kroger/QFC/Fred Meyer plus partner and unofficial Instacart paths. Registry exists; no providers run here. | Inspect the relevant adapters before writing equivalents. Avoid importing unrelated international checkout/MCP features into this MVP. |
| [n0nnac/grocery-store-comparison](https://github.com/n0nnac/grocery-store-comparison/blob/main/SAFEWAY_API_RESEARCH.md) | May 7, 2026 experiment for Washington, DC reports /abs/pub/xapi/search/substitute with storeId, price, basePrice, pricePer, promoEndDate. License not verified. | Safeway protocol lead; DC success is not Seattle success. Do not reuse exposed keys/session context blindly. |
| [kleinjm/instacart_api](https://github.com/kleinjm/instacart_api) | Ruby GraphQL wrapper; explorer reported MIT and 36 commits. Requires session cookie, postal/zone context and changing persisted-query hashes. Parent inspected repository; license-file URL retry did not resolve. | Protocol reference; validate license/revision and selected Seattle store before reuse. |
| [piotrv1001/how-to-scrape-instacart-in-nodejs](https://github.com/piotrv1001/how-to-scrape-instacart-in-nodejs) | MIT stated; one-commit example calling a paid/managed Apify actor. README explicitly says postalCode labels output and does not set request location; default market may be San Francisco. | **Reject as a drop-in accurate Seattle feed.** Only reconsider after actual location/retailer verification and cost measurement. |
| [Shreyas2552/house-inventory-app](https://github.com/Shreyas2552/house-inventory-app) | Explorer inspected Kroger + Flipp TypeScript collector layout; five commits and no verified license. Not independently run. | Architecture reference only, not a maintained dependency assumption. |

## UW-area starting store set

Physical locations confirmed on official pages; distance from an eventual dorm pin and participation in each offer remain separate checks.

| Store | Address | Source |
|---|---|---|
| QFC University Village | 2746 NE 45th St, Seattle 98105 | [QFC store page](https://www.qfc.com/stores/grocery/wa/seattle/university-village/705/00807) |
| Safeway U District | 4732 Brooklyn Ave NE, Seattle 98105 | [Safeway store page](https://local.safeway.com/safeway/wa/seattle/4732-brooklyn-ave-ne.html) |
| Metropolitan Market Sand Point | 5250 40th Ave NE, Seattle 98105 | [Official locations](https://www.metropolitan-market.com/locations) |
| PCC Green Lake Village | 450 NE 71st St, Seattle 98115 | [PCC store page](https://www.pccmarkets.com/stores/greenlake-village/) |

Also inspect the [H Mart Pacific Northwest site](https://www.hmartus.com/) and [Metropolitan Market weekly ad](https://shop.metropolitan-market.com/store/metropolitan-market/flyers/weekly). Do not label a regional flyer as valid for the UW H Mart without reading participating-store exclusions.

## Local versus hosted scheduling

| Approach | Off-PC operation | Cost/limits verified | Assessment |
|---|---|---|---|
| Windows Task Scheduler | No when powered off; wake/catch-up settings exist | No hosting bill; electricity and message-provider charges remain | Useful local pilot or strict zero-hosting-budget choice |
| Small Linux VM, single process + SQLite | Yes, while service is healthy | DigitalOcean lists 1 GiB $6/month and 2 GiB $12/month | Recommended deployment shape for simple operations and possible browser collectors; capacity is untested |
| Cloudflare Worker + database | Yes | Free Workers: 100,000 requests/day, 10 ms CPU/invocation; browser service has 10 min/day free | Potential cheaper choice if real collector measurements fit; not interchangeable with unrestricted Node/browser scripts |
| GitHub Actions schedule | Independent of PC | Docs warn of delay/dropped jobs and public-repo schedule disabling after 60 inactive days | Not the reliability basis for short-lived deal alerts |

Sources: [Microsoft scheduler settings](https://learn.microsoft.com/en-us/windows/win32/api/_taskschd/), [VM prices](https://www.digitalocean.com/pricing/droplets), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [browser limits](https://developers.cloudflare.com/browser-run/limits/), [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

**Recommendation:** develop and validate collectors locally, then use the Windows app as a client of one hosted collector/scheduler. Budget $6-12/month as an initial estimate, with real resource measurement before spending. Do not provision both VM and Worker architectures. Hosting does not guarantee a retailer accepts data-center traffic.

## Email, text and Windows packaging

- Resend's current free tier lists 3,000 emails/month and 100/day, enough capacity for a single user's proposed cadence. Normal sending needs sender configuration; resend.dev is a test domain limited to the account's own email. Domain costs and deliverability are separate. [Pricing](https://resend.com/pricing), [test-domain restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)
- Twilio charges for messages plus phone number/carrier costs. US long-code application SMS has sender-registration requirements; do not quote pennies per message as the total cost. Keep SMS optional and show setup/delivery status. [SMS pricing](https://www.twilio.com/en-us/sms/pricing/us?afsrc=1), [A2P setup](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc)
- Electron Forge can create a Windows Setup.exe; its Squirrel target builds on Windows or Linux with additional tooling. Local packaged UI, sandboxed renderer, narrow IPC and HTTPS are the recommended boundaries. [Windows maker](https://www.electronforge.io/config/makers/squirrel.windows), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)

## Next evidence to obtain

1. Confirm the Flipp sample's printed unit, purchase minimum/coupon conditions, local dates and physical-store applicability. Probe available item detail/image metadata before choosing an extraction method.
2. Extract ten valid observations per initial chain and verify five genuinely comparable cross-chain produce/meat pairs. Unknown units/attributes are rejected, not guessed.
3. Validate direct HTTP collection frequency and change detection before adding browser automation.
4. For official Kroger enrichment, obtain the user's developer credentials through secure setup and verify current app-use/retention requirements.
5. Only add Instacart after demonstrating correct retailer, fulfillment mode and location through the full collection path.
6. Benchmark hosted execution, then configure approved destinations/providers and test deliveries. No accounts, credentials, paid services or real notifications were used in this research.
