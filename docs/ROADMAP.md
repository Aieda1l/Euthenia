# Roadmap

Status: the design and the four-task M1 plan were approved on 2026-09-19. Since 2026-09-24, execution runs in Claude Code. The M1 Task 1 collector is built and reviewed. The live source gate is BLOCKED on price coverage, and a user decision on the source strategy is needed.

## M0 - Data feasibility and reviewable specification

Outcome: identify realistic price sources and reuse candidates, compare local/hosted operation, and define measurable MVP behavior.
Evidence: DATA_RESEARCH.md, MVP_SPEC.md, primary source links and independent documentation review.
Current: sourced research and design/planning reviews are complete, and the user approved both.

## M1 - Trustworthy local deals in a Windows window

Outcome: the user can inspect current offers from two validated chains, source details and correct comparable prices.
In scope: collector probes, normalization, minimal Windows deal list/detail, actual test/build scripts.
Out of scope: real sending, hosting purchases, advanced trip planning.
Exit: 10 verified observations/source, five matched pairs, passing focused fixtures, Windows app launch.
Current (2026-09-24): Task 1 code is done. The live gate is BLOCKED because weekly ads give too few comparable offers (see research/M1_SOURCE_PROOF.md). Tasks 2-4 wait on the source-strategy decision.

## M2 - A usable weekly shopping decision

Outcome: location/radius, store selection, maximum stops and aggression produce an honest quantity-aware saved list.
Exit: persisted preferences, complete/partial coverage handling, explained ratings, installer smoke checks.

## M3 - Dependable weekly and immediate alerts

Outcome: chosen email/SMS channels deliver the configured cadence, including off-PC operation in hosted mode.
Exit: scheduler/dedup/failure tests, authorized live email and SMS, unattended hosted check, backup restore and full release gate.

## After MVP

Expand validated store coverage and improve comparison density before adding elaborate meal planning or route optimization. Backlog entries are not permission to expand current scope.
