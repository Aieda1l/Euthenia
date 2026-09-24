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

### DEC-20260924-001 - Continue M1 execution in Claude Code

**Status:** Accepted.  
**Context:** Codex `chatgpt-web/high` children repeatedly failed with trusted-cwd errors (2026-09-19 and 2026-09-20). On 2026-09-24 the user committed `CLAUDE.md` and `.claude/agents/`. That commit makes Claude Code (Opus 5.5 at `xhigh`, with project implementer, reviewer and verifier subagents) the operating contract and states that AGENTS.md's Codex model routing does not apply to it.  
**Decision:** Continue the approved M1 plan in Claude Code. The Sol High-only child rule governs Codex sessions only. The partial, uncommitted Task 1 code in the Windows `C:` checkout is unavailable to this repository and is neither reused nor claimed; Task 1 restarts from the approved plan.  
**Why:** The user explicitly changed the runtime, so this is not a silent model substitution. Waiting for the unreachable partial code would block all progress, and that code had failing tests and no review.  
**Consequences:** Spec, scope and plan approvals stand. Implementation and review separation continues through fresh project subagents. Windows-only evidence for Tasks 3-4 still needs a Windows host.  
**Revisit when:** The user asks to reconcile the `C:` partial work or to return to Codex.

### DEC-20260924-002 - Task 1 identity, validation and calendar resolutions

**Status:** Accepted as an orchestrator interpretation of the approved spec. The user may override it.  
**Context:** The approved plan leaves several details open: identity defaults, OR-variant handling, how human validation enters the proof, and when applicability and calendar semantics count as verified.  
**Decision:** Adopt resolutions R1-R12 in the M1 plan's 2026-09-24 addendum. In short:
- Organic status and meat fresh/frozen status are known only from explicit text.
- Produce form defaults to `whole` when no form qualifier appears. Variety, bone, skin and fat use documented not-applicable rules.
- OR items stay one offer, with differing attributes unknown.
- Applicability and calendar are verified only by per-flyer human attestations.
- Validations bind to raw-hash evidence IDs.
- Pairs count greedily, with each original item used at most once.

**Why:** These are the most conservative readings that still allow any match. Reading "whole" as unknown would make every produce offer unmatchable. Organic and fresh/frozen are explicitly forbidden from being defaulted.  
**Consequences:** Most conventional produce and unlabeled meat will stay unrated. The live gate may fail on pair count; the plan treats that as a truthful outcome. Any relaxation is a user product decision.  
**Revisit when:** Live results show the gate cannot pass under these rules, or the user chooses different defaults.

### DEC-20260924-003 - Tighten Task 1 rules after independent review

**Status:** Accepted, as orchestrator resolution of review findings. The user may override.  
**Context:** The independent spec and quality reviews of Task 1A found paths where text rules could guess identity or price. Examples: qualifiers leaking across OR alternatives, processed goods keyed as fresh produce, organic and grass-fed meat sharing a key with conventional meat, leftover price qualifiers becoming exact unit prices, and fixture-shaped evidence passing the proof.  
**Decision:** Adopt amendments A1-A10 in the M1 plan's "Review-driven amendments" section. Every amendment makes the rules stricter.

USDA Choice/Select and Angus claims are not yet a discriminator. That limitation is documented. Human pair validation guards the source proof, and Task 2 must resolve it before automated ratings.  
**Why:** A false match or price is worse than lower coverage, and the MVP accuracy constraints require unknown over guessed.  
**Consequences:** Coverage drops further, which makes the live gate harder to pass. The user decisions flagged in `M1_SOURCE_EVIDENCE_2026-09-24.md` become more consequential.  
**Revisit when:** The contract gains production-claim or grade attributes, or live evidence shows that an exclusion removes only genuinely comparable offers.
