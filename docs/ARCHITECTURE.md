# Architecture

## Implemented system

As of 2026-09-18 there is no application, package manifest, database, installed collector, scheduler, frontend, or deployment in this directory. Existing material is project configuration/instructions and documentation.

Git status/history probes report that this directory is not a Git repository. No version-control baseline or application verification command can be claimed.

## Established constraints

- Windows user interface.
- Accurate provenance and comparable grocery prices.
- Configurable geographic/store limits and alert delivery.
- Only chatgpt-web/high subagents may be used in this workflow.
- Single-user MVP and minimal infrastructure.

## Approved near-term design

The user approved [MVP_SPEC.md](MVP_SPEC.md) on 2026-09-19. The near-term direction is a Windows Electron client, TypeScript collection/comparison logic and eventually one hosted scheduler with SQLite. None of these components exists yet. M1 is limited to local acquisition/comparison and a Windows list/detail slice; hosted scheduling and database persistence are later milestones. Update this file with actual components as they land. Source feasibility evidence belongs in [DATA_RESEARCH.md](DATA_RESEARCH.md).
