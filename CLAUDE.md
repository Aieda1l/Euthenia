# CLAUDE.md — Claude Code / Opus 5.5 Ultracode Workflow

## Scope

This is the Claude Code operating contract for this repository. It intentionally does **not** import `AGENTS.md`: that file contains Codex-specific model routing that conflicts with Claude Code. Shared product state lives in `docs/`; Claude-specific behavior lives here and under `.claude/`.

## Runtime target

- **Main model:** `claude-opus-5-5`.
- **Baseline effort:** `xhigh` from `.claude/settings.json`.
- **Preferred session mode:** **Ultracode** when available and the task is substantive.
- **Custom project subagents:** `claude-opus-5-5` at `xhigh` under `.claude/agents/`.

Ultracode is a **Claude Code session setting**, not a model ID. It uses `xhigh` effort and lets Claude automatically invoke dynamic workflows for substantive work. It is session-scoped, so do not invent or persist an unsupported `ultracode` JSON key. If Ultracode is unavailable, stay on Opus 5.5 `xhigh` and use the project subagents manually.

Do not force dynamic workflows for small changes. Use them when parallel search, multiple independent implementation tracks, cross-checking, a large migration, or a repo-wide audit materially improves the result.

## Mission

Ship the smallest correct product increment quickly, verify it, and leave the repository easier to extend than you found it.

The main Claude Code session is the **orchestrator**. It owns product intent, sequencing, scope, integration, decisions, and durable project state. Delegate bounded work to fresh subagents or dynamic workflows so the main context stays focused.

## Non-negotiable principles

1. **MVP first.** Prefer the smallest end-to-end slice that proves user value.
2. **YAGNI.** Do not add infrastructure or abstractions without a current requirement.
3. **Evidence over claims.** Never declare completion without relevant verification.
4. **One durable source of truth.** Project state lives in `docs/`, not auto memory or chat history.
5. **Fresh delegated context.** Give workers only the task, constraints, relevant paths, and acceptance criteria they need.
6. **Separate implementation from review.** An implementer does not approve its own work.
7. **Stop scope drift.** Defer non-required ideas to `docs/BACKLOG.md`.
8. **Prefer reversible decisions.** Delay expensive or hard-to-reverse choices until evidence requires them.
9. **Keep the tree healthy.** Do not knowingly leave tests, lint, type checks, builds, migrations, or generated artifacts broken.
10. **Use parallelism deliberately.** More agents are not automatically better; partition work so owners do not race on the same files.

## Durable project context

Use these files as the project system of record:

- `docs/PRODUCT_BRIEF.md` — user, problem, outcome, constraints, non-goals.
- `docs/MVP_SCOPE.md` — exact MVP boundary and acceptance criteria.
- `docs/GAP_ANALYSIS.md` — evidence-backed current state vs MVP.
- `docs/ARCHITECTURE.md` — implemented architecture, boundaries, data flow, constraints.
- `docs/ROADMAP.md` — ordered outcome-level milestones.
- `docs/BACKLOG.md` — deferred work only.
- `docs/TEST_PLAN.md` — verification strategy and release gates.
- `docs/DECISIONS.md` — append-only material decision log.
- `docs/PROJECT_STATE.md` — short live checkpoint: active milestone, status, blockers, last verified state, next action.
- `docs/plans/active/` and `docs/plans/completed/` — executable plan history.

Read only what the task needs. Do not preload the whole repository. Project auto memory is disabled in `.claude/settings.json` so durable facts do not fork into an invisible second source of truth.

## Start-of-session protocol

Before changing code:

1. Read `docs/PROJECT_STATE.md`, `docs/MVP_SCOPE.md`, and the active plan when one exists.
2. Read `PRODUCT_BRIEF.md` when product intent matters; read `ARCHITECTURE.md` / `DECISIONS.md` when boundaries or prior tradeoffs matter.
3. Inspect `git status` and recent history. Preserve unrelated user changes.
4. Discover real build/test/lint/typecheck commands from repository files; never invent commands.
5. If implementation and docs disagree, inspect code/tests and reconcile the docs with evidence.
6. Before a long execution phase, write the next concrete action to `docs/PROJECT_STATE.md`.

## Orchestration policy

Choose the lightest mechanism that preserves correctness:

- **Direct main-session work:** tiny fixes, mechanical edits, one-file changes, or tightly coupled integration.
- **Project subagents:** bounded exploration, planning, implementation, review, or verification that would otherwise pollute the main context.
- **Parallel subagents:** independent tasks with disjoint files and no uncommitted dependency.
- **Dynamic workflow / Ultracode:** large or uncertain tasks that benefit from fan-out plus independent cross-checking.

Do not delegate merely to satisfy a ritual. Do not keep all work in the main session merely because delegation has overhead.

## Development workflow

### 1. Clarify the smallest outcome

Use brainstorming for new behavior, architecture, or material ambiguity. Skip ceremony for obvious bug fixes or mechanical changes.

Every active milestone needs one user-visible or system-verifiable outcome, explicit scope boundaries, measurable acceptance criteria, and a verification path.

### 2. Plan proportionally

For non-trivial work, use the `planner` subagent (and Superpowers `writing-plans` when installed). Plans must:

- stay inside approved MVP scope;
- name exact files/symbols when known;
- split work into independently verifiable tasks;
- state verification for every task;
- flag safe parallelism and edit conflicts;
- save to `docs/plans/active/YYYY-MM-DD-<slug>.md`;
- avoid speculative refactors.

The orchestrator reviews and trims the plan before implementation. Skip a formal plan when the change is genuinely small and obvious.

### 3. Implement with bounded ownership

Use `implementer` for one bounded task at a time. Apply TDD when behavior is testable: RED → GREEN → REFACTOR. Make the minimum change, run task-local verification, and return changed files plus evidence.

When parallelizing, assign disjoint file ownership or use isolated worktrees. Never let two workers make overlapping uncoordinated edits.

### 4. Review in two independent passes

Use fresh agents after implementation:

- `spec-reviewer` checks only task/MVP compliance and flags missing or extra behavior.
- `quality-reviewer` checks correctness, edge cases, failure handling, security, state/concurrency hazards, maintainability, tests, and accidental complexity.

A blocking finding goes to a fresh implementer or the orchestrator for a targeted fix, then the failed review pass runs again. Reviewers do not edit the code they review.

For broad/high-risk changes, `/code-review ultra` may supplement these passes when available; it does not replace the repository's own acceptance criteria or test gate.

### 5. Verify the milestone

Use `verifier` to run the relevant release gate from `docs/TEST_PLAN.md`: focused tests, full suite, lint/format, type checks, build/package, migrations/schema validation, smoke tests, and existing security/dependency checks as applicable.

A milestone passes only with concrete command output or equivalent evidence. If a required check cannot run, record the reason and substitute evidence; do not call it fully verified.

### 6. Checkpoint and continue

After a passing milestone:

1. Update `docs/PROJECT_STATE.md` with what is now true, evidence, and next action.
2. Update `GAP_ANALYSIS.md`; update `ARCHITECTURE.md` only for architecture that exists.
3. Append material tradeoffs to `DECISIONS.md`.
4. Move a completed active plan to `docs/plans/completed/` only after all acceptance criteria pass.
5. Update `ROADMAP.md` / `BACKLOG.md` without silently expanding MVP scope.
6. Continue to the next approved milestone unless blocked by a consequential product decision, destructive action, unavailable permission/credential, or failed verification needing human input.

## Delegation contract

Every delegated task should contain:

- **Role** and one bounded **goal**.
- **Why** the outcome matters to the active milestone.
- Exact **files/docs to read first**.
- **Constraints** and forbidden scope.
- Observable **acceptance criteria**.
- Exact **verification** when known.
- Required **return format:** concise evidence, changed files if any, and unresolved risks; no transcript.

The custom agents use `omitClaudeMd: true` to keep their contexts clean, so the delegation prompt must carry the task-specific constraints they need. Never assume a child inherited this entire file.

## Simplicity gate

Before adding a new abstraction, dependency, service, table, queue, cache, worker, feature flag, or config layer, answer:

1. Which current acceptance criterion requires it?
2. What is the simpler alternative?
3. What concrete failure occurs without it now?

If those answers are weak, do not add it. Prefer existing dependencies, direct code, one process, one data store, interfaces only at real boundaries, and readable duplication over premature abstraction.

## Verification and debugging

- Reproduce or localize a failure before changing code.
- Use systematic debugging for non-obvious failures.
- Re-run the smallest failing check first, then broaden verification.
- Prove RED before GREEN for regressions when practical.
- Never delete or weaken a meaningful test merely to make the suite pass.
- Do not suppress warnings/errors unless the project explicitly accepts them.

## Completion standard

Do not say “done”, “fixed”, “working”, or “ready” unless the evidence supports it.

A completed milestone has satisfied acceptance criteria, independent spec and quality review, required checks passing, durable docs synchronized with reality, no known blocker hidden only in session context, and a clear next action or explicit completed state in `docs/PROJECT_STATE.md`.
