# Decisions

> Append-only lightweight ADR log. Do not rewrite old decisions to make history look cleaner; add a superseding entry.

## Template

### DEC-YYYYMMDD-001 — <decision title>

**Status:** Accepted | Superseded | Rejected  
**Context:** What decision was required and what constraints mattered?  
**Decision:** What was chosen?  
**Why:** Evidence and tradeoff, including the simpler alternative considered.  
**Consequences:** What becomes easier/harder?  
**Revisit when:** Concrete condition that would justify reconsideration.  
**Supersedes / superseded by:** Optional decision ID.

---

## Accepted decisions

_No project-specific decisions recorded yet._

### DEC-20260918-001 - Preserve observed price context

**Status:** Accepted as a requirement interpretation.  
**Context:** User permits Instacart scraping only when accurate and requests competitor comparisons.  
**Decision:** Preserve source, physical store/region, purchase channel, unit, conditions and observation time; do not assume Instacart/shelf parity or infer missing units.  
**Why:** Live Flipp samples omit units and use different validity/availability dates; Instacart documents retailer-specific pricing.  
**Consequences:** Some offers must remain unrated or unavailable for alerts.  
**Revisit when:** A provider supplies reliable missing metadata.

### DEC-20260918-002 - Hosted scheduling recommendation

**Status:** Proposed; user review pending.  
**Context:** User asked to research both local and hosted operation and recommend a setup.  
**Decision:** Recommend a Windows client and one hosted collector/scheduler with SQLite; validate locally before deployment.  
**Why:** Off-PC alerts need an independent running service. Local Task Scheduler avoids a hosting bill but cannot check while powered off.  
**Consequences:** Estimate $6-12/month hosting before SMS/domain/other costs; no spending or account creation authorized by this proposal.  
**Revisit when:** Actual collector measurements fit a cheaper hosted runtime or the user chooses local-only operation.

### DEC-20260918-003 - Start with observed competitor ratings

**Status:** Proposed; user review pending.  
**Context:** Requiring two competitor families beyond the candidate prevents any Strong rating at a two-chain launch.  
**Decision:** Allow ratings against one verified comparable competitor, always naming the comparator and labeling limited coverage; use a per-family median when more are available. No claim of market-wide cheapest.  
**Why:** Delivers the requested comparison on a small source set without inventing market coverage. Accuracy and breadth are distinct.  
**Consequences:** Immediate messages must carry the same coverage qualifier and satisfy strict freshness/matching/eligibility checks.  
**Revisit when:** Historical observations and broader store coverage support a richer baseline.

### DEC-20260919-001 - User approves written MVP specification

**Status:** Accepted.  
**Context:** The user responded "I approve. Please continue." to the presented research and written-spec review request.  
**Decision:** MVP_SPEC.md and MVP_SCOPE.md are approved for implementation planning. Preserve the subagent-driven execution method in AGENTS.md.  
**Why:** This completes the architectural written-spec review gate.  
**Consequences:** A fresh Sol High planner prepares M1. The implementation plan must still be reviewed before execution under writing-plans. No paid deployment or real message sending is implied.  
**Supersedes:** Proposed status of DEC-20260918-002 and DEC-20260918-003 for the design direction; costs remain estimates and provisioning remains separate.

### DEC-20260919-002 - User approves M1 implementation plan

**Status:** Accepted.  
**Context:** User confirmed "I approve. Please continue." after reviewing the M1 plan and clarifying planned supermarket coverage.  
**Decision:** Execute the four-task plan using the required Sol High implementer/reviewer/verifier roles. Initialize the empty project's Git baseline and use an isolated worktree.  
**Consequences:** No further planning approval is required for M1; source-proof failure remains an explicit stop for dependent work. Real notification delivery and paid deployment remain outside M1.
