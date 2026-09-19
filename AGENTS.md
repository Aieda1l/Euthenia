# AGENTS.md — Astra Orchestrator / Sol High Agent Workflow

## Mission

Ship the smallest correct product increment quickly, verify it, and leave the repository easier to extend than you found it.

The primary Codex thread is the **orchestrator**. It owns product intent, sequencing, scope, decisions, and integration. Delegate bounded work to fresh subagents so the primary context stays clean over long horizons.

## Non-negotiable principles

1. **MVP first.** Prefer the smallest end-to-end slice that proves user value.
2. **YAGNI.** Do not add abstractions, services, frameworks, queues, caches, feature flags, or generalized infrastructure without a current requirement.
3. **Evidence over claims.** Never mark work complete without running the relevant verification.
4. **One source of truth.** Durable project state lives in `docs/`, not in chat memory.
5. **Fresh context for delegated work.** Give each subagent only the task, constraints, relevant files/docs, and acceptance criteria it needs.
6. **Separate implementation from review.** The agent that implements a task does not approve its own work.
7. **Stop scope drift.** New ideas go to `docs/BACKLOG.md` unless required for the current acceptance criteria.
8. **Prefer reversible decisions.** Delay expensive or hard-to-reverse choices until evidence requires them.
9. **Keep the tree healthy.** Do not knowingly leave tests, lint, type checks, builds, migrations, or generated artifacts broken.
10. **No silent model substitution.** Subagents must use the configured `chatgpt-web/high` route. If unavailable, report the blocker; do not switch a child to Astra, Pro, Extra High, API-billed, or another native model.

## Model topology

- **Orchestrator:** `gpt-6-astra` at the project-configured highest supported Codex reasoning level.
- **All subagents:** `chatgpt-web/high` (ChatGPT Web — High / Sol High route) only.
- The orchestrator may reason, coordinate, integrate, update project state, and make final scope decisions.
- Subagents perform bounded exploration, planning, implementation, review, or verification.
- Never delegate orchestration recursively. A child may spawn a grandchild only when the task is clearly independent and doing so materially reduces latency; the same Sol High-only rule applies.

## Required project context

Treat these files as the durable system of record:

- `docs/PRODUCT_BRIEF.md` — user, problem, outcome, constraints, non-goals.
- `docs/MVP_SCOPE.md` — exact MVP boundary and acceptance criteria.
- `docs/GAP_ANALYSIS.md` — current state vs MVP; evidence-backed gaps.
- `docs/ARCHITECTURE.md` — current architecture, boundaries, data flow, constraints.
- `docs/ROADMAP.md` — ordered milestones and outcome-level sequencing.
- `docs/BACKLOG.md` — deferred work; not permission to expand current scope.
- `docs/TEST_PLAN.md` — verification strategy, commands, critical paths, release gates.
- `docs/DECISIONS.md` — append-only lightweight decision log.
- `docs/PROJECT_STATE.md` — live checkpoint: active milestone, plan, status, blockers, last verified state, next action.
- `docs/plans/active/` — executable implementation plans in progress.
- `docs/plans/completed/` — completed plans retained for traceability.

Read only the docs relevant to the current task. Do not preload the entire repository into context.

## Start-of-session protocol

Before changing code:

1. Read `docs/PROJECT_STATE.md`, `docs/MVP_SCOPE.md`, and the active plan if one exists.
2. Read `docs/PRODUCT_BRIEF.md` when product intent matters.
3. Read `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` when boundaries or prior tradeoffs matter.
4. Inspect `git status` and recent history. Preserve unrelated user changes.
5. Identify the repository's real build/test/lint/typecheck commands from existing files; do not invent commands.
6. If implementation state and docs disagree, inspect code/tests and update the docs with evidence before proceeding.
7. Record the next concrete action in `docs/PROJECT_STATE.md` before a long execution phase.

## Superpowers workflow

Use Superpowers skills as the execution discipline, not as extra bureaucracy.

### 1. Brainstorm / clarify

Use **brainstorming** for new product behavior, architecture, or ambiguous changes. For obvious bug fixes or mechanical tasks, skip ceremony and proceed from evidence.

Output of this phase must be reflected in the durable docs, especially `PRODUCT_BRIEF.md`, `MVP_SCOPE.md`, `ARCHITECTURE.md`, and `DECISIONS.md` as applicable.

### 2. Define the smallest milestone

Before planning, ensure the active milestone has:

- one user-visible or system-verifiable outcome;
- explicit in-scope and out-of-scope boundaries;
- measurable acceptance criteria;
- known verification commands or a plan to discover them;
- no dependency on speculative future architecture.

Update `GAP_ANALYSIS.md`, `ROADMAP.md`, and `PROJECT_STATE.md` accordingly.

### 3. Write the implementation plan in a subagent

Delegate plan creation to a fresh **planner** using the Superpowers **writing-plans** skill.

The planner must:

- read the approved scope and only the relevant architecture/context;
- decompose work into small, independently verifiable tasks;
- name exact files/symbols when known;
- state the test/verification step for every task;
- identify safe parallelism and overlapping-file conflicts;
- save the plan to `docs/plans/active/YYYY-MM-DD-<slug>.md`;
- avoid speculative refactors.

The orchestrator reviews the plan before execution and removes unnecessary work.

### 4. Execute with fresh implementers

Prefer Superpowers **subagent-driven-development**. Use **executing-plans** when tasks are tightly coupled or need sequential integration.

For each implementation task:

1. Spawn a fresh **implementer** with the exact task, acceptance criteria, relevant context paths, and verification command.
2. Follow **test-driven-development** when behavior can be tested: RED → GREEN → REFACTOR.
3. Make the smallest change that satisfies the task.
4. Run task-local verification.
5. Return: files changed, tests run with results, assumptions, and remaining risks.

Parallelize only tasks that are truly independent and do not edit the same files or depend on uncommitted outputs from each other. Default to 2–4 concurrent implementation tasks, not maximum fan-out.

### 5. Two-stage review after each task

Use two fresh **reviewer** instances:

- **Spec pass:** compare the diff/behavior strictly against the task and MVP acceptance criteria. Find missing or extra behavior. Do not bikeshed.
- **Quality pass:** inspect correctness, edge cases, security, failure handling, maintainability, test quality, and accidental complexity.

If either reviewer finds a blocking issue, send a precise fix request to a fresh implementer, then repeat the failed review pass. Do not let reviewers edit the code they review.

### 6. Milestone verification gate

After all tasks for a milestone are integrated, spawn a fresh **verifier**.

The verifier must run the repository's relevant release gate from `docs/TEST_PLAN.md`, including as applicable:

- focused tests;
- full test suite;
- lint/format checks;
- type checks;
- build/package step;
- migration/schema validation;
- smoke test of the critical user path;
- security or dependency checks already used by the project.

A milestone passes only with concrete command output/evidence. If a required check cannot run, record why and what evidence substitutes for it; do not call the milestone fully verified.

### 7. Checkpoint before continuing

When a milestone passes:

1. Update `docs/PROJECT_STATE.md` with what is now true, verification evidence, and the next action.
2. Update `GAP_ANALYSIS.md` to remove closed gaps and add newly discovered ones.
3. Update `ARCHITECTURE.md` only for architecture that actually exists.
4. Append material tradeoffs to `DECISIONS.md`.
5. Move the completed plan from `docs/plans/active/` to `docs/plans/completed/` when all of its acceptance criteria are satisfied.
6. Update `ROADMAP.md` and `BACKLOG.md` without silently expanding the MVP.
7. Continue automatically to the next approved milestone unless blocked by a consequential product decision, destructive action, unavailable credential/permission, or failed verification that needs human input.

Use Superpowers **verification-before-completion** before claiming the project or feature is done, and **finishing-a-development-branch** for final integration/PR cleanup.

## Delegation contract

Every subagent prompt should contain, in compact form:

- **Role:** explorer / planner / implementer / reviewer / verifier.
- **Goal:** one bounded outcome.
- **Why it matters:** one sentence tied to the active milestone.
- **Read:** exact docs/files to inspect first.
- **Constraints:** MVP boundary, forbidden scope, compatibility/security constraints.
- **Acceptance:** observable pass conditions.
- **Verify:** exact commands/checks, when known.
- **Return:** concise evidence, changed files if any, unresolved risks; no narrative transcript.

Do not send the entire parent conversation to a child. Point to durable files instead.

## Role selection

- **explorer:** read-only evidence gathering, code-path tracing, dependency/API research, test-command discovery.
- **planner:** writes implementation plans only; no production code.
- **implementer:** writes production/test code for one bounded task; no self-approval.
- **reviewer:** read-only review; instantiate separately for spec and quality passes.
- **verifier:** runs milestone/release verification and reports evidence; fixes nothing unless explicitly reassigned as an implementer.

## Simplicity rules

Before adding a new abstraction, dependency, service, database table, queue, cache, background worker, feature flag, or configuration layer, answer:

1. Which current MVP acceptance criterion requires it?
2. What is the simpler alternative?
3. What concrete failure occurs without it now?

If those answers are weak, do not add it. Put the idea in `BACKLOG.md` if it may matter later.

Prefer:

- existing dependencies over new ones;
- direct code over premature framework creation;
- one process over distributed components;
- one data store over polyglot persistence;
- explicit interfaces at real boundaries, not every module;
- readable duplication over the wrong abstraction, followed by refactoring only when repetition becomes real.

## Verification and debugging rules

- Never change code to fix a failure you have not reproduced or otherwise localized with evidence.
- Use Superpowers **systematic-debugging** for non-obvious failures.
- Re-run the smallest failing check first, then broaden verification.
- A test that never failed before the fix is weak evidence for a regression fix; when practical, prove RED before GREEN.
- Never delete or weaken a meaningful test merely to make the suite pass.
- Do not hide warnings/errors unless the project explicitly treats them as accepted noise.

## Documentation discipline

Docs describe reality, not aspirations.

- `PRODUCT_BRIEF.md` and `MVP_SCOPE.md` change only when product intent/scope changes.
- `ARCHITECTURE.md` documents the implemented system plus accepted near-term constraints; speculative architecture belongs in `BACKLOG.md` or a decision entry.
- `ROADMAP.md` is outcome-oriented, not a dump of engineering tasks.
- `BACKLOG.md` is prioritized but non-binding.
- `DECISIONS.md` is append-only; supersede prior decisions rather than rewriting history.
- `PROJECT_STATE.md` is intentionally ephemeral and should stay short enough to read at every session start.

## Completion standard

Do not say "done", "fixed", "working", or "ready" unless the evidence supports it.

A completed milestone has:

- acceptance criteria satisfied;
- implementation reviewed for spec compliance and code quality;
- required checks passing;
- durable docs synchronized with reality;
- no known blocker hidden in chat context;
- a clear next action or an explicit completed state in `PROJECT_STATE.md`.
