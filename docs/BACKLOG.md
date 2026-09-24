# Backlog

Deferred ideas only; none is authorized implementation scope for M0/M1.

## P1 - Improve local coverage

- More validated Seattle retailers and everyday low-price baselines for better competitor coverage.
- Historical price ratings after sufficient real observations exist.
- Receipt/shelf verification workflow if online-to-store discrepancies prove frequent.

## P2 - Reduce shopping effort

- Walking/transit routing and explicit travel-cost estimates.
- Dietary exclusions, freezer/storage capacity and serving preferences.
- Deferred cooking/meal templates that use the MVP's ingredient prices, with complete ingredient quantities and clearly scoped meal-cost estimates.
- Retailer-specific coupon workflows after reliable base-price comparison.

## P3 - Revisit with demonstrated need

- Nationwide store discovery, multiple users and mobile applications.
- OCR-only flyer ingestion once a validated extraction/review path exists.
- Bidirectional offline sync or seamless local-to-cloud migration.
- Automatic recipe generation, pantry inventory and nutrition optimization.

Automatic checkout and scraping circumvention infrastructure are outside the current product objective.

## Deferred during M1 Task 1 (2026-09-24)

Recorded so they are not lost. None expands M1 scope without a decision.

- **Identity vocabulary gaps** that cause false exclusions only: mandarin/tangerine kinds, "Center Cut" pork chops, brisket flat, split breasts with interleaved words, celery stalks.
- **Missing meat discriminators:** USDA grade (Choice/Select/Prime) and breed claims (Angus, Wagyu). Required before automated Task 2 ratings.
- **Seafood as a category.** It needs wild/farmed and fresh/previously-frozen discriminators in the contract.
- **Automated Safeway store-publication check** (flyerkit `store_code`) instead of a weekly human attestation. It needs a host-allowlist decision.
- **Stricter lint:** type-aware ESLint rules (`recommendedTypeChecked`, e.g. `no-floating-promises`) across the async collector.
- **Multi-week accumulation** of observations. It only makes sense if the gate's "current observations" wording is revised.
