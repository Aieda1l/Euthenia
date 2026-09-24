# Project State

## Current objective

**2026-09-24: execution resumed in Claude Code** (DEC-20260924-001). The user's `CLAUDE.md` commit replaces the blocked Codex/Sol High route for this repository. The partial Task 1 in the Windows `C:` checkout was never pushed and cannot be reached, so Task 1 restarts here from the approved plan. The binding details are in the plan's [2026-09-24 addendum](plans/active/2026-09-19-m1-windows-deal-comparison.md#claude-code-execution-addendum---2026-09-24).

Build Euthenia: a Windows grocery deal app for a UW Seattle student, prioritizing produce/meat, comparable competitor prices, radius/store/aggression controls, weekly digests and optional immediate email/SMS.

## Active milestone

- **Milestone:** M1 - Trustworthy local deals in a Windows window.
- **Status:** Specification and implementation plan remain approved. Task 1 is restarting in this repository under Claude Code. No task or milestone is complete.
- **Active plan:** [M1 implementation plan](plans/active/2026-09-19-m1-windows-deal-comparison.md).
- **No further design or plan approval is needed.**

## Last verified state

- Git initialized at the original D:/cyrus/OneDrive/Projects/Euthenia repository; approved docs/instructions committed in baseline efe6c1b.
- Active linked checkout: C:/Users/cyrus/.codex-worktrees/Euthenia-m1, branch codex/m1-implementation, clean at 31c72c3 before the resume checkpoint. The nested D: checkout has documentation-only uncommitted changes and remains intact.
- The C: checkout now contains uncommitted source tooling, dependencies, shared/source modules, tests and collector stubs. Last broad source run had 56 passing / 3 failing tests plus an asynchronous error; a later collector suite failed to load and stubs were added without a rerun. No passing current-tree verification, review, live-source proof, UI, installer, deployment or notifications is claimed.
- Read-only Flipp probes returned current QFC/Safeway ads and six detailed sample records. Units, membership/package/limit text are exposed. Two cutouts were visually checked.
- Actual ten-per-chain/five-comparable-pair source gate has not passed. No runtime behavior or live delivery is claimed.

## Codex runtime history (superseded by DEC-20260924-001)

Three fresh chatgpt-web/high implementation attempts returned:
`stream disconnected before completion: ChatGPT web cwd is outside the trusted Codex workspace roots`

Attempts covered the original D: worktree, a new C: worktree under the latest stated trusted root, and a text-only no-tools handoff. No application patch was produced. No child model was substituted.

A fresh chatgpt-web/high high child successfully read the nested D: checkout checkpoint with exit 0 after the latest relocation (agent 01a0bbaa-f33b-71d1-b5cf-f68cb720cb35).

Details and useful source findings: [execution blocker/evidence](research/M1_EXECUTION_BLOCKER_2026-09-19.md).

The requested C: minimal test subsequently passed as well, but implementation child 01a0bd86-db27-7ad2-aade-f4c6a96aceea failed after executing commands on 2026-09-20. Its observed shell cwd was C:/Users/cyrus/.codex-worktrees/Euthenia-m1; inherited harness cwd was D:/cyrus/OneDrive/Projects/Euthenia. Both paths are visible write roots. The new missing-cwd error and detailed evidence are recorded in the active C: checkout's 2026-09-20 blocker report.

## Next action

Task 1 of the M1 plan in this repository (Linux container, Node 22.22.2):
1. **1A:** implementer builds the offline core (tooling, shared contracts/money/identity/freshness, normalize, proof, unit tests).
2. **1B:** implementer builds the Flipp client and collector.
3. **1C:** the orchestrator runs the live gate for 98105 and validates candidates against ad evidence.

Then fresh spec and quality reviews, commit and push. The live source-proof gate remains mandatory before Tasks 2-4. A BLOCKED result is a valid outcome and stops dependent UI work. No paid services, accounts or real messages.
