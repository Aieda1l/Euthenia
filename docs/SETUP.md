# One-Time Orchestrator Setup

This repository assumes:

- **Primary/orchestrator:** native Codex `gpt-6-astra`.
- **Children:** only `chatgpt-web/high` through `miuuyy/codex-chatgpt-web` Full Harness.
- **Methodology:** Superpowers for brainstorming, planning, TDD, subagent execution, review, debugging, verification, and branch finishing.

## 1. Install Superpowers in Codex

Current Codex versions expose Superpowers in the plugin marketplace:

1. Open `/plugins` in Codex.
2. Search for `Superpowers`.
3. Install the plugin.
4. Start a fresh Codex task/session after installation.

Verify by asking Codex which Superpowers skills are available or by invoking a task that should trigger `brainstorming` / `writing-plans`.

Project: https://github.com/obra/superpowers

## 2. Install and connect codex-chatgpt-web

Project: https://github.com/miuuyy/codex-chatgpt-web

Use the latest release for your OS. In the launcher:

1. Sign into your own ChatGPT account and run the browser smoke test.
2. Install the ChatGPT Web model entries into Codex, then fully restart Codex once.
3. Complete **Full harness (MCP)** setup.
4. Create the ChatGPT Developer Mode Tunnel connector named exactly `Codex Native2`, with Authentication `None` and the permissions required for the harness.
5. Run the launcher's runtime/doctor verification.
6. Confirm `ChatGPT Web — High` is present and working from Codex.

## 3. Use Compatibility V1 for this mixed model topology

This kit intentionally uses a native Astra parent and routed ChatGPT Web children. Select Compatibility V1:

```bash
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents status
```

Then fully restart Codex and start a **new task**. The bridge documents protocol selection as task-pinned.

Do not manually duplicate the bridge-owned multi-agent protocol flags in this repository's `.codex/config.toml`; the launcher journals/manages them.

## 4. Trust the project config

Codex only loads project-local `.codex/config.toml` and project-local agent files for trusted projects. Make sure this repository is trusted in Codex, then start a new task from the repository root.

Expected primary config:

- model: `gpt-6-astra`
- reasoning: `max`
- subagent default: `chatgpt-web/high`
- subagent reasoning: `high`

If your installed Codex build rejects `model_reasoning_effort = "max"`, temporarily use `xhigh` and update Codex; current Astra itself supports `max`.

## 5. Smoke-test model isolation

Before a long run, perform a tiny mixed-model test:

1. Ask the Astra orchestrator to report its selected model/session config.
2. Ask it to spawn an `explorer` that reads a harmless repository file and returns the first heading.
3. Confirm the child is shown as the ChatGPT Web High route, not Astra/Pro/native fallback.
4. Run one `reviewer` read-only task.
5. Run one `implementer` task on a disposable branch/worktree or a trivial documentation edit, then revert it if desired.

If `chatgpt-web/high` is unavailable, fix the bridge/account/runtime setup. Do not weaken the model-isolation rule by allowing fallback children.

## 6. Start a real project

For a new or poorly documented repository, the first orchestrator prompt can simply be:

> Initialize this repository using AGENTS.md. Establish the baseline, fill only the project context you can support with evidence, identify the smallest MVP milestone, and use Superpowers to plan and execute it with verification gates.

The workflow should then keep `docs/PROJECT_STATE.md` current so future sessions can resume without replaying the whole conversation.
