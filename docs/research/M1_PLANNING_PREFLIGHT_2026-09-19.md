# M1 planning preflight - 2026-09-19

## Baseline

- User approved MVP_SPEC.md and requested continuation.
- Root listing contains AGENTS.md, .codex and docs; no application manifest or source.
- `git -C D:\cyrus\OneDrive\Projects\Euthenia status --short` and `git log -5 --oneline` report no Git repository. A reversible Git baseline is an execution setup step, not something already completed.
- The first planner attempt ended with `stream disconnected before completion: ChatGPT web turn is missing cwd in trusted Codex environment context`. No partial plan file existed. A fresh retry uses the same chatgpt-web/high route; no model substitution.
- A second fresh attempt on the same route failed identically and also produced no plan. A third attempt is scoped to returning plan text from directly supplied requirements without filesystem calls; the orchestrator will save its output if it succeeds.
- The third fresh planner (01a0b915-7d7a-7f60-93c9-da713c302912) succeeded without filesystem calls. The orchestrator reviewed and reduced its draft, corrected unknown-eligibility handling, rational overflow risk, snapshot proof contracts and runtime freshness, and saved the four-task active plan. No production implementation was performed.

## Tooling observed

Read-only commands: `node --version`, `npm --version`, `git --version`.

| Tool | Installed version |
|---|---|
| Node | v22.23.2 |
| npm | 12.0.2 |
| Git | 2.55.0.windows.3 |

Registry metadata retrieved with `npm view <package> version engines --json` (TypeScript/React: version only):

| Package | Observed registry version | Declared Node engines |
|---|---|---|
| Electron | 44.4.3 | >=22.12.0 |
| Vite | 8.3.0 | ^20.19.0 or >=22.12.0 |
| Vitest | 5.0.1 | ^22.12.0 or ^24.0.0 or >=26.0.0 |
| TypeScript | 7.0.2 | Not queried |
| React | 19.3.0 | Not queried |

This is availability/engine evidence, not proof of cross-package compatibility or a passing install/build. No product dependencies were installed. Execution must pin a compatible set and retain the lockfile after actual checks.

## Source feasibility

Six successful item-detail responses are saved in FLIPP_DETAIL_PROBE_2026-09-19.json. They supply fields missing from flyer-list rows. Two downloaded beef cutouts were visually inspected and confirm the displayed package/unit, membership and limit information recorded in DATA_RESEARCH.md. Image inspection does not establish a valid cross-chain match or automatic extraction of missing image-only attributes.

## Technical references inspected

- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer sandbox/context isolation, disabled Node integration, restricted IPC/navigation.
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron): available experimental Electron automation path for the Windows smoke test; actual compatibility remains an execution check.
- [Vite guide](https://vite.dev/guide/): documented Node requirements.

## Remaining evidence

Ten validated current observations per retailer family, both produce and meat, five cross-chain pairs including one of each category, store participation and expiry interpretation. The approved M1 plan must preserve these gates and not count sample payloads as completion.
