# Architecture

## Implemented system

As of 2026-09-18 there is no application, package manifest, database, installed collector, scheduler, frontend, or deployment in this directory. Existing material is project configuration/instructions and documentation.

The initial 2026-09-18 probes found no Git repository. On 2026-09-19 execution setup initialized Git and committed the approved docs/instructions. Linked execution worktrees now exist, but the required Sol High runtime is blocked before product code creation. No application verification command exists yet.

## Established constraints

- Windows user interface.
- Accurate provenance and comparable grocery prices.
- Configurable geographic/store limits and alert delivery.
- Only chatgpt-web/high subagents may be used in this workflow.
- Single-user MVP and minimal infrastructure.

## Approved near-term design

The user approved [MVP_SPEC.md](MVP_SPEC.md) on 2026-09-19. The near-term direction is a Windows Electron client, TypeScript collection/comparison logic and eventually one hosted scheduler with SQLite. None of these components exists yet. M1 is limited to local acquisition/comparison and a Windows list/detail slice; hosted scheduling and database persistence are later milestones. Update this file with actual components as they land. Source feasibility evidence belongs in [DATA_RESEARCH.md](DATA_RESEARCH.md).
