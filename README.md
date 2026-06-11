# Oases ocli

This directory is the clean standalone Oases CLI package folder. It is intended to be pushed as a separate GitHub repository or used as the source for the future public `oases-ocli` npm package.

GitHub repository: https://github.com/qingtengCHINA/oases-ocli

License: Apache-2.0

Oases Web owns model selection, API proxying, and user-facing conversation state. Local `ocli` owns workspace access, glob/grep/read/edit/write tools, command execution, Python execution, URL fetches, bounded sub-agent delegation, asynchronous agent sessions, SSE progress events, approvals, cancellation, and persisted local audit logs.

This folder deliberately excludes the Web app, Vercel config, the large `ocli-test` reference prototype, the old `legacy-mvp-src` archive, build output, local `.oases` state, tarballs, and environment files.

## Contents

```text
.
├── package.json
├── bin/ocli.js
├── index.js
├── src/
├── scripts/
│   ├── ocli-smoke.mjs
│   └── ocli-package-smoke.mjs
└── docs/
    ├── ocli-npm-release.md
    └── ocli-migration-plan.md
```

## Verify Before Push or Publish

Run these commands from this folder:

```bash
npm test
npm pack --dry-run
```

`npm test` runs both the runtime smoke test and the package/tarball install smoke test. `npm pack --dry-run` shows the exact files that will enter the npm package. The published npm package is intentionally limited by `package.json#files` to:

- `bin`
- `src`
- `README.md`

## Usage

During local development from this folder:

```bash
node index.js
```

Before the package is published to npm, install this folder globally to test the final user command:

```bash
npm install -g .
ocli
```

If zsh still cannot find the command after installation, run `rehash` and try `ocli` again. `oases-ocli` is published to the npm registry:

```bash
npm install -g oases-ocli
ocli
```

In an interactive terminal, `ocli` shows an animated green Oases status mark while the local runtime is running. The two connected lobes continuously exchange size, so the terminal mark visibly flows while `ocli` is alive. Six seconds after startup, `ocli` opens Oases Web automatically:

```text
正在运行ocli，请打开https://www.oasesai.xyz 选择“工程模式”配合使用
```

Set `OCLI_NO_AUTO_OPEN=1` to keep the browser closed. Non-interactive terminals, CI, and piped output keep the plain startup logs so smoke tests and scripts remain stable.

After npm publishing:

```bash
npm install -g oases-ocli
ocli
```

Keep `oases-ocli@latest` installed. Starting with `0.1.1`, filesystem tools accept both relative paths and absolute paths that are inside the current `workspace`. For example, if `ocli` is started from `/Users/qingteng`, then `/Users/qingteng/Downloads` is inside the workspace and can be read through file tools. Absolute paths outside the workspace remain blocked by the filesystem boundary.

Common npm commands:

`ocli update` / `ocli upgrade` is available starting with `oases-ocli@0.1.2`. If the user has an older version, use the npm fallback once. Windows legacy `cmd.exe` users should use `0.1.3` or newer; `ocli` automatically falls back to a static terminal status there to avoid repeated animation clears refreshing the whole window.

| Task | Command |
| --- | --- |
| Install latest | `npm install -g oases-ocli@latest` |
| Upgrade to latest (0.1.2+) | `ocli update` or `ocli upgrade` |
| Upgrade fallback | `npm install -g oases-ocli@latest` |
| Install a specific version | `npm install -g oases-ocli@0.1.3` |
| Check installed version | `ocli --help` |
| Check latest npm version | `npm view oases-ocli version` |
| Locate global install | `npm root -g` and `which ocli` |
| Uninstall | `npm uninstall -g oases-ocli` |
| Run without installing | `npx oases-ocli@latest` |

One-off usage without installing also works:

```bash
npx oases-ocli
```

Then open Oases Chat Web in project mode. The Web app connects to `http://127.0.0.1:8787`, provides the selected model and Oases API proxy URL, and streams local agent progress back into the chat UI. No local model provider or local API key is required.

## Runtime Contract

- Listen only on `127.0.0.1`.
- Expose `GET /health` with `runtimeSource: "ocli"`, `modelSource: "web"`, and `apiSource: "web-proxy"`.
- Accept `apiBaseUrl`, `model`, `systemPrompt`, and compacted messages from Oases Web for every agent run.
- Send OpenAI-compatible tool schemas to the Oases Web model proxy with `tool_choice: "auto"`.
- Execute both Oases `<tool>{...}</tool>` text tool blocks and OpenAI-compatible streamed `delta.tool_calls`.
- Never require users to configure a local model provider or API key.
- Restrict all filesystem tools to the configured workspace. Relative paths and workspace-internal absolute paths are normalized to workspace-relative paths; absolute paths outside the workspace are rejected.
- Support engineering-grade workspace discovery through `glob_files`, regex-capable `grep_files`, and targeted `read_file` line ranges.
- Support bounded sub-agent delegation through `agent_run`, including current-session background launches via `runInBackground: true` and result polling through `agent_status`, using the same Web-provided model/API proxy and the same local workspace permission flow.
- Support `agent_run(isolation: "worktree")` for git-backed workspaces. In this mode, `ocli` creates a detached temporary worktree from `HEAD`, runs the sub-agent inside that isolated root, and returns the worktree path plus `workspace_status` so the main agent can inspect the isolated changes without polluting the main workspace.
- Manage isolated worktree results with `worktree_list`, `worktree_diff`, `worktree_apply`, and `worktree_remove`. Worktree paths are validated against `git worktree list`, `worktree_apply` refuses to overwrite dirty main-workspace paths unless `force: true`, and `worktree_remove` refuses to discard dirty worktrees unless `force: true`.
- Persist session traces under `.oases/ocli/sessions/<session-id>/`.
- Include local agent session counts and the latest session summary in `/health` so Oases Web can surface runtime continuity and recovery state.
- Serve persisted session metadata and events through `GET /agent/sessions/:id` after an `ocli` restart.
- Enrich session detail responses with `eventCounts`, `toolResults`, `artifacts`, `todos`, `approvalSummary`, and `resumePrompt` for Web timeline rendering and recovery.
- Discover workspace-local skills with `skill_list`, read them with `skill_read`, and load them into the current agent session as skill context.
- Discover workspace-local custom agents with `agent_list`, read them with `agent_read`, and run them through `agent_run({ agentName })`. Custom agent Markdown files live under `.oases/agents`, can provide frontmatter defaults such as `agentType`, `maxTurns`, `background`, `isolation`, `effort`, and `initialPrompt`, and inject their body as sub-agent instructions. Their `tools` and `disallowedTools` frontmatter scopes the sub-agent tool schema and is enforced again before tool execution, so text tool blocks cannot bypass the custom agent boundary. Their `skills` frontmatter preloads matching `.oases/skills` files into the sub-agent's first turn and records those skills in session audit metadata. Their `initialPrompt` frontmatter is prepended to the sub-agent's first user turn and preserved in `agent_run` result metadata. Their `effort` frontmatter can set `low`, `medium`, `high`, or `max` for that sub-agent request without changing the Web-owned model/API. Agent frontmatter supports comma-separated lists, YAML `- item` lists, and `initialPrompt: |` block scalars for multi-line first-turn seeding.

## Migration Direction

This runtime starts from the existing Oases MVP protocol so the desktop Web integration stays stable. The next work should progressively replace the simple tool and agent loop with reusable pieces from the Claude Code prototype kept in the main OasesChat repository under `ocli/ocli-test/src`, especially stronger permission handling, richer tool execution, session recovery, skills, agents, and background task orchestration.

The active standalone runtime source is this folder's `src`.
