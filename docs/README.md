# Project Context Index

This directory is the durable system of record for product intent, scope, architecture, planning, verification, and long-horizon execution state.

| File | Authority | Update cadence |
|---|---|---|
| `PRODUCT_BRIEF.md` | Why this product exists and for whom | Rare; product-intent changes |
| `MVP_SPEC.md` | Concrete Windows app proposal; pending user review | During design review |
| `DATA_RESEARCH.md` | Sourced API/crawler/repository and hosting findings | After source probes |
| `research/` | Small research evidence artifacts | After probes |
| `MVP_SCOPE.md` | What must and must not ship in the first useful version | When scope is explicitly changed |
| `GAP_ANALYSIS.md` | Evidence-backed delta between current repo and MVP | After discoveries and milestones |
| `ARCHITECTURE.md` | Architecture that exists + accepted constraints | When system boundaries/data flow change |
| `ROADMAP.md` | Ordered outcome-level milestones | After milestone/scope changes |
| `BACKLOG.md` | Deferred, prioritized work | As ideas/gaps are deferred |
| `TEST_PLAN.md` | Required verification and release gates | When behavior or tooling changes |
| `DECISIONS.md` | Append-only material decisions and tradeoffs | When a non-trivial decision is made |
| `PROJECT_STATE.md` | Small live checkpoint for session resume | At least after every milestone |
| `plans/active/` | Current executable plans | During active work |
| `plans/completed/` | Finished plans | When acceptance criteria are met |

## Precedence when documents conflict

1. Explicit current user instruction.
2. `MVP_SCOPE.md` for the active MVP boundary.
3. `PRODUCT_BRIEF.md` for product intent.
4. Accepted entries in `DECISIONS.md` for recorded tradeoffs.
5. `ARCHITECTURE.md` for implemented system shape.
6. Active implementation plan for task sequencing.
7. `PROJECT_STATE.md` for the latest execution checkpoint.
8. `ROADMAP.md` / `BACKLOG.md` for future intent.

Code and tests are evidence of current implementation, not authority to silently redefine product scope. When code/docs disagree, investigate and reconcile explicitly.
