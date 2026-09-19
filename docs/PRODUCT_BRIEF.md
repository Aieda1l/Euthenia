# Product Brief

## Product and user

**Euthenia** (working name) is a Windows grocery deal app for a budget-conscious UW Seattle student. It helps the user decide what to cook from the week's cheapest suitable produce and meat, compare nearby competitors, and avoid spending more time or travel money than a deal saves.

## User requirements

- Windows application with a usable graphical interface; web technology inside the app is acceptable.
- Prioritize produce and meat while allowing other grocery categories.
- Deal ratings and competitor price comparisons.
- Adjustable location, store radius, maximum shopping stops, and deal-hunting aggression.
- One optional weekly digest plus separately toggleable immediate alerts for strong or short-lived deals.
- Independently configurable email and text messages.
- Research official APIs, crawlers, third-party projects and GitHub code.
- Instacart scraping is explicitly permitted by the user when accurate.
- Research both local and hosted scheduling and recommend a setup (user clarification, 2026-09-18).

## Success

The user can identify affordable ingredients, understand why an offer is considered a deal, and make a realistic shopping list within their chosen travel and store limits. Alerts arrive at the configured cadence without repeats or misleading prices.

## Constraints

Prefer low operating cost and a small single-user system. Price provenance, unit normalization, store applicability, loyalty requirements, and freshness are part of correctness. A search result or GitHub README is not proof that a collector works. Retailer stock is not guaranteed by an advertisement.

## Non-goals

Automatic purchasing, a delivery marketplace, crowdsourced receipt collection, a complete nutrition planner, or nationwide coverage. Exact dorm address, food budget, dietary restrictions and transportation are not yet specified; the initial design must not require those details.

## Design status

User approved the design in [MVP_SPEC.md](MVP_SPEC.md) on 2026-09-19. Implementation planning is authorized. Source coverage and cost estimates still require the stated validation; no implementation or paid provisioning is claimed.
