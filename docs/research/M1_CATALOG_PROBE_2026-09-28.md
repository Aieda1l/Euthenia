# Catalog price source probe - 2026-09-28

These read-only probes from the Claude Code cloud container followed the user's decision to add catalog prices (DEC-20260928-001). Keys that appear below were found embedded in retailers' public web bundles. They are not recorded here and must not be committed.

## Kroger Public API (QFC)

- `GET https://api.kroger.com/v1/locations?filter.zipCode.near=98105` returned **401** `{"error":"invalid_request","error_description":"The access_token is missing"}`. The official API is reachable from this host; it needs an OAuth2 client-credentials token.
- `developer.kroger.com` returns 403 (Akamai) to this host. Registration and documentation must happen from the user's browser.
- Earlier research (DATA_RESEARCH.md, from the official Postman collection) says product prices need `filter.locationId`. Published limits there are 10,000 product calls/day and 1,600 location calls/day. None of this is verified with credentials yet.
- **Needed from the user:** a Kroger developer application (client ID and client secret) with Product and Location API access. It goes in this environment's settings as `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET`, never in chat or the repository.

## Safeway store product search

- The public weekly-ad page (`https://www.safeway.com/weeklyad`, HTTP 200 from this host) configures a store-scoped product search: `apimProgramSearchPath` `/abs/pub/xapi` plus `apimProgramSearchProductsEndpoint` `/pgmsearch/v1/search/products`. It uses a public client subscription key and parameters including `storeid` and `channel` (the web bundle mentions `instore` and pickup).
- One probe for `q=gala apples`, `storeid=2980`, `channel=instore` **timed out with no response**, over both HTTP/2 and HTTP/1.1. The weekly-ad HTML still loaded, so the API edge silently drops data-center traffic, the same way qfc.com does.
- **Feasibility is unknown from a residential connection.** A tiny probe run on the user's Windows PC is the next evidence step. The endpoint is undocumented, and it is not a supported API or usage agreement.

## Implications

- QFC catalog prices via the official API are feasible from any host once credentials exist.
- The second family's catalog prices (Safeway) can at best be collected from the user's machine. That fits M1's local Windows app, but the MVP's hosted-collector recommendation (M3) would face the same blocking.
- Channel rules apply: catalog prices must be compared only with catalog prices from the same channel, never with weekly-ad prices.
