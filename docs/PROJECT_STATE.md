# Project State

## Current objective

Build Euthenia: a Windows grocery deal app for a UW Seattle student. It prioritizes produce and meat, compares competitor prices on comparable items, has radius, store and aggression controls, sends a weekly digest, and offers optional immediate email/SMS alerts.

Since 2026-09-24, execution runs in Claude Code, per the user's `CLAUDE.md` (DEC-20260924-001). The Codex/Sol High history is summarized at the end.

## Active milestone

- **Milestone:** M1 - Trustworthy local deals in a Windows window.
- **Active plan:** [M1 implementation plan](plans/active/2026-09-19-m1-windows-deal-comparison.md). Its 2026-09-24 addendum R1-R12 and amendments A1-A12 are binding.
- **Status:**
  - Task 1 code is complete and has been through two rounds of independent spec and quality review, each followed by fixes. A final re-review of a9e2101 is in progress.
  - **The live source-proof gate is BLOCKED** ([M1_SOURCE_PROOF.md](research/M1_SOURCE_PROOF.md)).
  - Per the plan's stop condition, Tasks 2-4 wait.
- **Blocking decision for the user:** how to get comparable competitor prices. Weekly ads alone give 0 cross-chain pairs this week, even with relaxed identity defaults. The recommended option is catalog prices: the Kroger Public API (needs the user's developer credentials) plus a Safeway product-search probe. That changes the gate's channel design, so it needs user approval.

## Last verified state (2026-09-24)

- Branch `claude/loving-ptolemy-6dkn4y`. HEAD includes a9e2101 (code) and later docs commits.
- `npm ci`, `npm test` (481/481), `npm run typecheck` and `npm run lint` all pass on Node 22.22.2 (Linux).
- The live `npm run source:collect -- --postal-code 98105 --validations docs/research/M1_SOURCE_VALIDATIONS_2026-09-24.json` exits 1 (BLOCKED):
  - 43/43 live requests accepted;
  - 39 produce/meat offers normalized;
  - 0 qualifying offers per chain, 0 pairs.
- Safeway store 2980 applicability and printed calendar are attested. One hash-bound validation (Gala Apples) is accepted. QFC is unattested because qfc.com rejects this host.
- No UI, installer, database, hosting, notifications, accounts, credentials or paid services exist.

## Next action

1. Finish the final Task 1 re-reviews. Fix any blocking finding and re-verify.
2. Ask the user for the source-strategy decision ([M1_SOURCE_PROOF.md](research/M1_SOURCE_PROOF.md), "What would unblock M1").
3. After the decision, amend the plan for the chosen sources and continue Task 1's gate, then Tasks 2-4.

Do not start Tasks 3-4 before the gate can pass. Do not weaken the gate without the user.

## Codex runtime history (superseded)

- 2026-09-19/20: three Codex `chatgpt-web/high` implementation attempts failed with trusted-cwd errors. A later partial Task 1 in `C:/Users/cyrus/.codex-worktrees/Euthenia-m1` was never committed or pushed and is not used here. Details are in [M1_EXECUTION_BLOCKER_2026-09-19.md](research/M1_EXECUTION_BLOCKER_2026-09-19.md).
- If that partial work is ever pushed, reconcile it explicitly; don't merge it blindly.
