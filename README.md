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
├── OcliSkills/
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
- `OcliSkills`
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

`ocli update` is available starting with `oases-ocli@0.1.2`. If the user has an older version, use the npm fallback once. Windows legacy `cmd.exe` users should use `0.1.3` or newer; `ocli` automatically falls back to a static terminal status there to avoid repeated animation clears refreshing the whole window. Starting with `0.1.5`, shell/Python execution requested by an agent requires user approval by default; non-execution tools such as file reads, file search, git status summaries, and public URL fetches still run by default, and dangerous commands are hard-blocked before approval. Starting with `0.1.6`, ocli enables local token authentication by default; the terminal prints the token and a Web link containing it, then stores current runtime info under `.oases/ocli/runtime.json`. If the browser is closed or the token needs to be recovered, run `ocli open` from the same workspace to reopen the tokenized Oases Web link. Starting with `0.1.9`, `settings_list` and `settings_read` can safely inspect project `.oases/settings*.json` files, with optional `.claude/settings*.json` compatibility audit through `includeClaude: true`. Starting with `0.1.10`, the agent automatically applies the whitelisted `.oases/settings*.json` `outputStyle` field by loading the matching output style before the first model turn. Starting with `0.1.11`, the agent enforces `.oases/settings*.json` `permissions.deny` as a hard block before tool execution. Starting with `0.1.12`, the agent enforces `.oases/settings*.json` `permissions.ask` as a forced approval checkpoint for matching tool calls, even when that tool would normally run without prompting. Starting with `0.1.13`, `.oases/settings.local.json` `permissions.allow` can skip default approvals for matching calls on the user's own machine; committed `.oases/settings.json` allow rules remain audit-only. Starting with `0.1.14`, `permissions.defaultMode` supports the safe subset `default`, `plan`, and `dontAsk`; permission-widening modes such as `acceptEdits` and `bypassPermissions` are not applied. Starting with `0.1.15`, `command_read` and `plugin_command_read` activate command templates for later agent turns by injecting `<command_context>`, emitting `command_loaded`, and recording `activeCommands`. Starting with `0.1.16`, agent sessions can receive `preloadedCommands`, and custom agent frontmatter can declare `commands` that are loaded before the first sub-agent turn. Starting with `0.1.17`, `memory_list`, `memory_read`, and `memory_write` provide conservative project memory file management under `.oases/memory/{project,team,private}/*.md`. Starting with `0.1.18`, explicit `memory_read`, session `preloadedMemories`, and custom agent frontmatter `memories` inject memory as `<memory_context>` for later model turns, emitting `memory_loaded` and recording `activeMemories`. Starting with `0.1.25`, the agent reads project-level `contextCompaction` settings and uses `enabled`, `maxContextTokens`, `ratio`, and `recentMessages` as the default automatic context-compaction policy while preserving the active policy in events, snapshots, and result metadata. Command templates remain prompt/workflow templates; they are not executed as code, and memory is not automatically bulk-injected or silently saved.

| Task | Command |
| --- | --- |
| Install latest | `npm install -g oases-ocli@latest` |
| Upgrade to latest (0.1.2+) | `ocli update` |
| Upgrade fallback | `npm install -g oases-ocli@latest` |
| Install a specific version | `npm install -g oases-ocli@0.1.18` |
| Reopen current workspace Web link | `ocli open` |
| Print current workspace Web link | `ocli open --dry-run` |
| Check installed version | `ocli --help` |
| Check latest npm version | `npm view oases-ocli version` |
| Locate global install | `npm root -g` and `which ocli` |
| Uninstall | `npm uninstall -g oases-ocli` |
| Run without installing | `npx oases-ocli@latest` |

If `npm publish --access public` fails with `E404 Not Found - PUT https://registry.npmjs.org/oases-ocli`, the package metadata is usually not the problem. It normally means the current terminal npm CLI is not authenticated as an account with publish permission for `oases-ocli`. Check the terminal account first:

```bash
npm whoami --registry=https://registry.npmjs.org/
```

It must print the maintainer account for the package, such as `qingtengpro`. If it prints `E401`, a different account, or nothing useful, log in again from the terminal:

```bash
npm logout --registry=https://registry.npmjs.org/
npm login --registry=https://registry.npmjs.org/ --auth-type=web
npm whoami --registry=https://registry.npmjs.org/
```

Then publish from this standalone package directory:

```bash
npm publish --access public
```

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
- Require approval for destructive local tools (`delete_file`, `worktree_apply`, `worktree_remove`, `plugin_remove`) and for all agent-requested `run_command` / `run_python` execution. Read-only filesystem/search/fetch tools and controlled workspace-bounded `write_file` / `edit_file` can run without prompting unless project settings add a matching `permissions.ask` rule. Dangerous commands are hard-blocked before approval.
- Persist session traces under `.oases/ocli/sessions/<session-id>/`.
- Include local agent session counts and the latest session summary in `/health` so Oases Web can surface runtime continuity and recovery state.
- Serve persisted session metadata and events through `GET /agent/sessions/:id` after an `ocli` restart.
- Enrich session detail responses with `eventCounts`, `toolResults`, `artifacts`, `todos`, `approvalSummary`, and `resumePrompt` for Web timeline rendering and recovery.
- Discover Oases skills with `skill_list`, read them with `skill_read`, and load them into the current agent session as skill context. Skills can come from the current workspace under `.oases/skills/<name>/SKILL.md` or from bundled package skills under `OcliSkills/<name>/SKILL.md`; results are labeled with `source: "workspace"` or `source: "bundled"`.
- Read skill-owned resources with `skill_asset_list` and `skill_asset_read`. These read-only tools stay inside one selected skill directory and support references, scripts, evals, and examples without exposing arbitrary package or workspace paths. Script execution still goes through `run_python` or `run_command` and therefore keeps the existing command safety and approval flow.
- Install bundled skills into the current project with `skill_install`. This copies a bundled skill directory into `.oases/skills/<targetName>` for project-level customization, refuses to overwrite existing workspace skills, and skips symlinks.
- Ship bundled `OcliSkills` in the npm package so every user gets baseline skills such as `web-search`, `exa-search`, image helpers, data helpers, and platform-specific helpers immediately after `npm install -g oases-ocli`.
- Discover project settings with `settings_list` and `settings_read`. By default these tools only inspect `.oases/settings.json` and `.oases/settings.local.json`; with `includeClaude: true`, they can also audit `.claude/settings.json` and `.claude/settings.local.json` for migration compatibility. Settings values are summarized by shape and sensitive keys are redacted. The agent reads the whitelisted `.oases/settings*.json` `outputStyle` field at session startup, with `.oases/settings.local.json` taking priority over `.oases/settings.json`, and automatically loads the matching workspace or plugin output style before the first model turn. It also enforces `.oases/settings*.json` `permissions.deny` rules as hard blocks for matching tool calls, including tool-wide rules and content rules such as `Write(path-fragment)` or `Bash(command-fragment)`. Starting with `0.1.12`, `.oases/settings*.json` `permissions.ask` rules force approval for matching tool calls, emit `settings_permission_ask` approval events, and are recorded in `settingsPermissions.askCount`, `askedTools`, and `toolWideAsk`. Starting with `0.1.13`, `.oases/settings.local.json` `permissions.allow` rules skip default approvals for matching tool calls, emit `settings_permission_allowed` audit events, and are recorded in `settingsPermissions.allowCount`, `allowedTools`, and `toolWideAllow`. Committed `.oases/settings.json` allow rules do not skip approval. Starting with `0.1.14`, `permissions.defaultMode` supports `default`, `plan`, and `dontAsk`: `plan` blocks write/execution/destructive/agent tools while still allowing read/network planning tools and `todo_write`; `dontAsk` denies approval-required calls unless a local allow rule pre-approves them; unsupported modes emit `settings_warning` and are not applied. Starting with `0.1.25`, `contextCompaction` accepts a boolean or `{ enabled, maxContextTokens, ratio, recentMessages }`; it becomes the default compaction policy for agent sessions, can be overridden per request, and is exposed through `settings_context_compaction_loaded`, `context_compacted.policy`, `settingsContextCompaction`, and context-state snapshots.
- Manage and explicitly load conservative project memories with `memory_list`, `memory_read`, and `memory_write`. Memory files are restricted to single-level Markdown files under `.oases/memory/project/*.md`, `.oases/memory/team/*.md`, or `.oases/memory/private/*.md`; nested directories, absolute paths, and `../` escapes are rejected. Listing reads metadata only, reading has a 512KB file cap, and writing refuses to overwrite unless `overwrite: true` is explicitly provided. When an agent explicitly reads a memory, or a session provides `preloadedMemories`, `ocli` injects it as `<memory_context>` for later model turns and records `activeMemories`. Custom agents can declare `memories: project:name, team:name`. Memory is still not automatically bulk-injected or silently saved; `memory_write` remains a normal write-risk tool in the existing audit and permission flow.
- Discover workspace plugins with `plugin_list` and `plugin_read`. Plugin manifests live under `.oases/plugins/<plugin>/.oases-plugin/plugin.json` or Claude-style `.oases/plugins/<plugin>/.claude-plugin/plugin.json`; ocli summarizes README, commands, agents, and hooks so later phases can wire those plugin resources into the agent loop.
- Discover and read workspace command templates with `command_list` and `command_read`. Command Markdown files live under `.oases/commands/*.md`; they are reusable project prompt templates. Listing commands only discovers resources. When an agent session explicitly calls `command_read`, `ocli` injects the template as `<command_context>` into subsequent model turns, emits a `command_loaded` event, and records `activeCommands` in the session result. Web or future command-palette flows can also create a session with `preloadedCommands`, which injects those templates before the first model turn.
- Discover, read, and install workspace plugin command templates with `plugin_command_list`, `plugin_command_read`, and `plugin_command_install`. Plugin command Markdown files live under `.oases/plugins/<plugin>/commands/*.md`; installing one copies it into `.oases/commands/<targetName>.md` so it becomes a normal project command template. Listing or installing plugin commands only discovers or copies resources. When an agent session explicitly calls `plugin_command_read`, `ocli` injects the template as `<command_context>` into subsequent model turns, emits `command_loaded`, and records it in `activeCommands`. Custom agent frontmatter can declare `commands: review-flow, ...`; `ocli` loads matching workspace or plugin commands before the first sub-agent model turn. Commands are not executed as code; any resulting file edits or process execution still go through normal tools and permissions.
- Oases Web project mode now consumes command template and output style tools directly. When `ocli` is connected, Web lists workspace and plugin command templates plus workspace and plugin output styles, lets the user select them in the project composer, reads the selected Markdown/JSON only at send time, and passes them as `preloadedCommands` / `preloadedOutputStyles` to `/agent/sessions` or the legacy `/agent/run` path. The CLI remains responsible for `<command_context>` / `<output_style_context>` injection, `command_loaded` / `output_style_loaded` events, and `activeCommands` / `activeOutputStyles` audit metadata.
- Discover and read workspace plugin hooks with `plugin_hook_list` and `plugin_hook_read`. Hook config and handler files live under `.oases/plugins/<plugin>/hooks` or `hooks-handlers`; ocli parses `hooks.json` event metadata and reads handler source without executing hook code.
- Discover plugin manifest capabilities with `plugin_capability_list` and `plugin_capability_read`. These read-only tools summarize `mcpServers`, `lspServers`, manifest `settings`, custom component paths, `commandsMetadata`, `output-styles`, and `settings.json` structure without starting servers, applying settings, or executing plugin code. Sensitive setting keys such as tokens, secrets, API keys, passwords, and credentials are redacted by shape.
- Discover, read, install, and explicitly load output styles. Workspace styles live under `.oases/output-styles/*.{md,json}` and are exposed through `output_style_list` / `output_style_read`; plugin styles live under `.oases/plugins/<plugin>/output-styles/*.{md,json}` and are exposed through `plugin_output_style_list`, `plugin_output_style_read`, and `plugin_output_style_install`. Installing a plugin style copies it into `.oases/output-styles/<targetName>` so it becomes a normal workspace output style. Listing or installing styles only discovers resources; when an agent session explicitly calls `output_style_read` or `plugin_output_style_read`, `ocli` injects the style as `<output_style_context>` into subsequent model turns, emits an `output_style_loaded` event, and records `activeOutputStyles` in the session result.
- Discover and read workspace plugin agent definitions with `plugin_agent_list` and `plugin_agent_read`. Agent Markdown files live under `.oases/plugins/<plugin>/agents/*.md`; ocli parses the same frontmatter fields used by workspace custom agents while keeping this phase read-only.
- Install plugin-provided agents into the current project with `plugin_agent_install`. This copies a selected plugin agent Markdown file into `.oases/agents/<targetName>.md`, where it becomes a normal workspace custom agent available through `agent_list`, `agent_read`, and `agent_run({ agentName })`.
- Discover and read workspace plugin skill definitions with `plugin_skill_list` and `plugin_skill_read`. Skill Markdown files live under `.oases/plugins/<plugin>/skills/*/SKILL.md`; ocli parses skill frontmatter while keeping plugin skills separate from global `skill_list` until install/injection rules are implemented.
- Install plugin-provided skills into the current project with `plugin_skill_install`. This copies the selected plugin skill directory into `.oases/skills/<targetName>`, including `SKILL.md` and skill-owned resources, so it becomes a normal workspace skill available through `skill_read` and `skill_asset_read`.
- List and read plugin-owned resources with `plugin_asset_list` and `plugin_asset_read`. These tools stay realpath-confined to one selected plugin directory and can read references, scripts, examples, hooks, commands, agents, and skills as text without executing plugin files.
- Install workspace-local plugin directories with `plugin_install`. The source must be inside the current workspace and contain `.oases-plugin/plugin.json` or `.claude-plugin/plugin.json`; ocli copies it into `.oases/plugins/<targetName>`, refuses to overwrite existing plugins, and skips `.git`, `node_modules`, `.DS_Store`, and symlinks.
- Remove installed workspace plugins with `plugin_remove`. The target must stay under `.oases/plugins`, contain `.oases-plugin/plugin.json` or `.claude-plugin/plugin.json`, and is treated as a destructive operation that requires approval inside agent sessions.
- Disable or re-enable installed plugins with `plugin_disable` and `plugin_enable`. Disabled plugins keep their files but receive a `.oases-disabled` marker; `plugin_list` reports `enabled` / `disabled`, while command, agent, and skill discovery hide disabled plugins unless `includeDisabled: true` is provided.
- Discover workspace-local custom agents with `agent_list`, read them with `agent_read`, and run them through `agent_run({ agentName })`. Custom agent Markdown files live under `.oases/agents`, can provide frontmatter defaults such as `agentType`, `maxTurns`, `background`, `isolation`, `effort`, and `initialPrompt`, and inject their body as sub-agent instructions. Their `tools` and `disallowedTools` frontmatter scopes the sub-agent tool schema and is enforced again before tool execution, so text tool blocks cannot bypass the custom agent boundary. Their `skills` frontmatter preloads matching `.oases/skills` or bundled `OcliSkills` into the sub-agent's first turn and records those skills in session audit metadata. Their `commands` frontmatter preloads matching `.oases/commands` or plugin command templates into the sub-agent's first turn and records those commands in session audit metadata. Their `initialPrompt` frontmatter is prepended to the sub-agent's first user turn and preserved in `agent_run` result metadata. Their `effort` frontmatter can set `low`, `medium`, `high`, or `max` for that sub-agent request without changing the Web-owned model/API. Agent frontmatter supports comma-separated lists, YAML `- item` lists, and `initialPrompt: |` block scalars for multi-line first-turn seeding.

## Migration Direction

This runtime starts from the existing Oases MVP protocol so the desktop Web integration stays stable. The next work should progressively replace the simple tool and agent loop with reusable pieces from the Claude Code prototype kept in the main OasesChat repository under `ocli/ocli-test/src`, especially stronger permission handling, richer tool execution, session recovery, skills, agents, and background task orchestration.

The active standalone runtime source is this folder's `src`.
