# Oases ocli Migration Plan

Last updated: 2026-06-11 19:49 Asia/Shanghai

## Goal

Turn the current `ocli-test` prototype tree into the official Oases desktop `ocli` runtime for project mode.

The end state is:

- Users install once with `npm install -g oases-ocli`, then run `ocli`.
- Oases Web stays deployed on Vercel and owns model selection, API proxying, chat UI, approvals UI, and session visualization.
- Local `ocli` owns workspace access, tools, command execution, Python execution, browser/network fetches, agent sessions, permissions, audit logs, and recoverable task state.
- `ocli` does not require local model provider setup or local API keys.
- Mature capabilities from `ocli/ocli-test/src` are progressively adapted into Oases protocol instead of keeping a small sidecar bridge forever.

## Current Architecture Snapshot

| Area | Current state | Target state |
| --- | --- | --- |
| Runtime entry | `ocli/index.js` starts official `ocli/src` runtime | `ocli/index.js` starts official `ocli` package/runtime |
| Active runtime code | `ocli/src/*.js` | `ocli/src/*.js` official package source |
| Mature prototype source | `ocli/ocli-test/src/**` | Migration source for tools, permissions, sessions, skills, agents, and orchestration |
| Old MVP source | `ocli/legacy-mvp-src/**` | Archived until no longer needed |
| npm package skeleton | `ocli/package.json` | `ocli/package.json` with `oases-ocli` bin |
| Web integration | Works via local HTTP/SSE bridge | Same protocol, richer agent behavior and better continuity |

## Phase Table

| Phase | Status | Objective | Main deliverables | Validation | Deployment |
| --- | --- | --- | --- | --- | --- |
| 0. Bridge MVP stabilization | Done | Prove Web can connect to local runtime and execute tools | `/health`, `/tools`, `/agent/sessions`, SSE, approvals, persistence, native tool calls | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` | Production deployed to `https://www.oasesai.xyz` |
| 1. Official ocli package structure | Done | Move from sidecar `ocli-test/oases-bridge` to official `ocli` runtime/package shape | `ocli/package.json`, `ocli/bin/ocli.js`, official runtime source, updated root entry, updated docs/tests | `pnpm test:ocli-package`, `pnpm test:ocli`, `pnpm build` passed | Production deployed |
| 2. Tool system migration | Done | Adapt mature `ocli-test/src/tools` concepts into Oases tool registry | Tool adapters for artifacts, todo planning, improved fetch metadata, generated-file detection | `pnpm test:ocli-package`, `pnpm test:ocli`, `pnpm build` passed | Production deployed |
| 3. Permission system migration | Done | Replace MVP risk checks with structured permission model | Permission categories, shell safety classification, per-session approval memory, clearer approval events, stronger destructive command detection | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Production deployed |
| 4. Continuous task orchestration | Done | Make project tasks continue until completion without user nudging | Task state, auto-continue slices, completion criteria, stronger max-turn handling | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Production deployed |
| 5. Session recovery and audit UX | Done | Make local sessions first-class recoverable engineering artifacts | Session detail panel, categorized timeline, artifact list, resume/continue from session | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Production deployed |
| 6. Skills, agents, and plugins | In progress | Bring in higher-level `ocli-test` orchestration | Skill loading, agent delegation, task/todo tools, plugin path strategy | Skill/tool integration smoke | Deploy after pass |
| 7. npm/GitHub release readiness | In progress | Publishable CLI and GitHub workflow | License/repository fields, release workflow, npm dry-run, install docs | Package/tarball install smoke passed; repository metadata and Apache-2.0 license done; npm publish pending | Release after approval |
| 8. Terminal UX | Done | Make local ocli feel alive and obvious to operate | Animated Oases terminal mark, auto-open Web, stable CI output | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 9. Search/read tool parity | Done | Move closer to `ocli-test` Glob/Grep/Read usefulness | `glob_files`, regex/type/output grep modes, line-range numbered reads | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 10. Sub-agent v1 | Done | Bring first `ocli-test` AgentTool-style delegation into Oases protocol | `agent_run` tool, bounded nested agent loop, subagent events, smoke coverage | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 11. Background sub-agent v1 | Done | Add first `ocli-test`-style background delegation loop | `agent_run(runInBackground)`, `agent_status`, background subagent events | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 12. Worktree sub-agent isolation v1 | Done | Let delegated agents modify an isolated git worktree without polluting the main workspace | `agent_run(isolation:"worktree")`, detached worktree creation, worktree status return, isolation smoke | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build`, syntax checks passed | Local runtime only |
| 13. Worktree lifecycle tools v1 | Done | Let agents inspect, apply, and remove isolated worktree outputs | `worktree_list`, `worktree_diff`, `worktree_apply`, `worktree_remove`, path validation, apply/remove guards | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build`, syntax checks passed | Local runtime only |
| 14. Web worktree control surface v1 | Done | Surface isolated worktree outputs in Oases Web project mode | Session detail worktree extraction, inspect/apply/remove buttons, local UI verification | `pnpm build`, `pnpm test:ocli`, `pnpm test:ocli-package` passed | Preview deployed |
| 15. Workspace custom agents v1 | Done | Let projects define reusable local sub-agents inspired by `ocli-test` AgentTool definitions | `agent_list`, `agent_read`, `agent_run(agentName)`, custom prompt injection, smoke coverage | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 16. Custom agent tool scoping v1 | Done | Enforce `ocli-test`-style tools/disallowedTools boundaries for workspace custom agents | Scoped OpenAI tool schemas, execution-time tool boundary checks, restricted-agent smoke | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 17. Custom agent skill preloading v1 | Done | Preload workspace skills declared by custom agent frontmatter before the first sub-agent model turn | `skills` frontmatter preload, `<skill_context>` injection, `skill_loaded` events, smoke coverage | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 18. Custom agent initialPrompt v1 | Done | Bring `ocli-test` custom agent first-turn prompt seeding into Oases custom agents | `initialPrompt` frontmatter parsing, first user-turn prepend, result metadata, smoke coverage | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 19. Agent frontmatter YAML compatibility v1 | Done | Accept common `ocli-test`/Claude-style Markdown frontmatter forms for custom agents | YAML `- item` lists for tools/skills, `initialPrompt: \|` block scalars, inline arrays, smoke coverage | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 20. Custom agent effort v1 | Done | Bring `ocli-test` custom agent effort frontmatter into Oases sub-agent requests without local model ownership | `effort` frontmatter parsing, sub-agent reasoning effort override, metadata, smoke coverage | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local runtime only |
| 21. Standalone CLI push folder | Done | Give the user a clean folder that can be pushed as a separate GitHub/npm package source | `oases-ocli/` with package manifest, bin, runtime source, standalone smoke tests, docs, ignore files; README push guidance | `cd oases-ocli && npm test`, root `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` | Local docs/package structure only |
| 22. Zero-argument CLI startup | Done | Make the published terminal experience start with `ocli` instead of `ocli serve --workspace .` | CLI parser defaults to `serve`, help/docs promote `ocli`, package smoke covers zero-arg and leading-flag forms | `cd oases-ocli && npm test`, root `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed | Local CLI UX only |

## Phase 1 Detailed Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 1.1 Record migration plan | Done | `docs/ocli-migration-plan.md` | This file is the live handoff document. |
| 1.2 Create official package manifest | Done | `ocli/package.json` | Package identity moved to official `ocli` package root. |
| 1.3 Create official bin entry | Done | `ocli/bin/ocli.js` | Keeps `ocli` and `oases-ocli` bin behavior. |
| 1.4 Move active runtime source | Done | `ocli/src/*.js` | Old MVP runtime archived under `ocli/legacy-mvp-src`; active runtime copied to `ocli/src`. |
| 1.5 Update root entry | Done | `ocli/index.js` | Root `pnpm ocli` starts official runtime source. |
| 1.6 Update package smoke | Done | `scripts/ocli-package-smoke.mjs` | Tests `ocli/package.json`, `ocli/bin/ocli.js`, and `npm pack --dry-run` from official package root. |
| 1.7 Update ocli smoke startup | Done | `scripts/ocli-smoke.mjs` | Root `ocli/index.js` startup remains covered. Runtime identity is now `ocli`. |
| 1.8 Update docs | Done | `README.md`, `docs/ocli-npm-release.md`, `ocli/README.md` | Documents `ocli` as official package and `ocli-test/src` as migration source. |
| 1.9 Validate | Done | scripts/build | `pnpm test:ocli-package`, `pnpm test:ocli`, `pnpm build` passed. |
| 1.10 Deploy | Done | Vercel | Production deployment `dpl_FGnWbaraaR3pEoJ7BJQufMLD7S3u`, aliased to `https://www.oasesai.xyz`. |

## Phase 2 Detailed Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 2.1 Define Oases tool result contract | Done | `ocli/src/tools.js`, `ocli/src/agent.js`, `src/pages/Home.tsx`, tests | Tool results now preserve top-level `artifacts` and Web normalization keeps them. |
| 2.2 Add crawler-friendly artifacts | Done | `ocli/src/tools.js`, `scripts/ocli-smoke.mjs` | `write_file`, `edit_file`, and `delete_file` expose file artifacts with path/bytes/role metadata; agent results preserve artifacts. |
| 2.3 Add Todo/Task planning tool | Done | `ocli/src/constants.js`, `ocli/src/tools.js`, `ocli/src/agent.js`, `src/pages/Home.tsx`, tests | Added `todo_write` as a structured project checklist tool. Web recognizes it, previews todo status, and crawler prompts instruct models to use it for executable progress tracking. |
| 2.4 Improve WebFetch/fetch_url parity | Done | `ocli/src/network.js`, `scripts/ocli-smoke.mjs` | `fetch_url` now returns `title` and normalized `links` for HTML pages while preserving `finalUrl`, `status`, `contentType`, `text`, and truncation metadata. |
| 2.5 Improve shell/Python tool summaries | Done | `ocli/src/tools.js`, tests | `run_command` and `run_python` now snapshot workspace changes and return generated/modified file artifacts. |
| 2.6 Update prompt guidance for migrated tools | Done | `src/pages/Home.tsx` | Prompt now instructs crawler/page-analysis tasks to use `todo_write`, avoid low-value `list_files`, write files, run scripts when needed, and summarize final outputs from artifacts. |
| 2.7 Validate Phase 2 | Done | scripts/build | `pnpm test:ocli-package`, `pnpm test:ocli`, `pnpm build` passed. |
| 2.8 Deploy Phase 2 | Done | Vercel | Production deployment `dpl_Gx1DFBtJ6w5V5PdnguKmhq4ETLYQ`, aliased to `https://www.oasesai.xyz`. |

## Phase 3 Detailed Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 3.1 Read-only shell command policy | Done | `ocli/src/tools.js`, `ocli/src/agent.js`, `scripts/ocli-smoke.mjs` | Allows clearly read-only commands such as `pwd`, `git status`, `git diff`, `git rev-parse`, and `git log` without approval; arbitrary shell commands, Python, and destructive tools remain gated. |
| 3.2 Approval request categories | Done | `ocli/src/tools.js`, `ocli/src/agent.js`, `ocli/src/sessions.js`, `src/pages/Home.tsx`, tests | Approval events now include category, risk, and human-readable reason; Web approval cards display category/reason. |
| 3.3 Per-session approval memory | Done | `ocli/src/agent.js`, `ocli/src/sessions.js`, `scripts/ocli-smoke.mjs` | Repeated identical high-risk tool calls now reuse the current session approval via a stable approval key; approval reuse is session-local and does not persist across restarts. |
| 3.4 Stronger destructive command detection | Done | `ocli/src/process.js`, `ocli/src/tools.js`, `scripts/ocli-smoke.mjs` | Expanded destructive command detection with explainable block reasons for workspace-wide removal, destructive git operations, system/disk commands, infrastructure deletion, and risky SQL; read-only shell auto-approval now rejects chained/control-operator commands. |
| 3.5 Validate Phase 3 | Done | scripts/build | `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed with the known CSS minify warning. |
| 3.6 Deploy Phase 3 | Done | Vercel | Production deployment `dpl_9yWQmFGKqbsxnKzntLpo3jJe29SN`, aliased to `https://www.oasesai.xyz`. |

## Phase 4 Detailed Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 4.1 Define continuation contract | Done | `ocli/src/agent.js`, `src/pages/Home.tsx`, tests | Local agent now treats `maxTurns` as a bounded slice and has a larger `maxTotalTurns` derived from `maxAutoContinuations`; maxed-out sessions report the safer `max_turns` hard-limit state. |
| 4.2 Auto-continue local agent slices | Done | `ocli/src/agent.js`, `ocli/src/sessions.js` | When tool work reaches a slice boundary, ocli emits `auto_continue`, appends a continuation prompt, and keeps running without requiring the user to send “继续”. |
| 4.3 Completion criteria prompt/tool behavior | Done | `ocli/src/agent.js`, `src/pages/Home.tsx` | If the model replies with unfinished “I will write/create/generate” text but no tool call, ocli automatically follows up and instructs it to call tools or finish with artifact paths; Web displays auto-running state from SSE. |
| 4.4 Long-running task smoke | Done | `scripts/ocli-smoke.mjs` | Added a multi-slice fake model smoke that writes ten files across slice boundaries and completes automatically. |
| 4.5 Real crawler-style smoke | Done | `scripts/ocli-smoke.mjs` | Added crawler-style smoke covering `todo_write`, `fetch_url`, generated crawler code, generated dataset file, artifact preservation, and final artifact summary. |
| 4.6 Validate Phase 4 | Done | scripts/build | `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed with the known CSS minify warning. |
| 4.7 Deploy Phase 4 | Done | Vercel | Production deployment `dpl_ALXijhHX9UTUkCB7GZU4BTxcf65P`, aliased to `https://www.oasesai.xyz`. |

## Phase 5 Detailed Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 5.1 Session audit summary contract | Done | `ocli/src/sessions.js`, `ocli/src/server.js`, tests | Session detail now exposes artifact list, latest todo snapshot, approval counts, and a `resumePrompt` suitable for continuing from persisted context. |
| 5.2 Web session detail panel upgrade | Done | `src/pages/Home.tsx` | Project workspace session detail now shows artifacts, todo status, approval stats, recent events, and final/error text. |
| 5.3 Persisted restart recovery smoke | Done | `scripts/ocli-smoke.mjs` | Smoke restarts ocli after a crawler-style session and verifies persisted detail still exposes artifacts, todos, approval summary, and resume prompt. |
| 5.4 Manual continue/resume affordance | Done | `src/pages/Home.tsx` | Added a safe copy-resume-prompt action; it does not silently re-run old tools. |
| 5.5 Validate Phase 5 | Done | scripts/build | `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed with the known CSS minify warning. |
| 5.6 Deploy Phase 5 | Done | Vercel | Production deployment `dpl_BgPsPDizHReArAF4u1SX8NLkFLgm`, aliased to `https://www.oasesai.xyz`. |

## Phase 6 Detailed Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 6.1 Workspace skill discovery tools | Done | `ocli/src/constants.js`, `ocli/src/tools.js`, `src/pages/Home.tsx`, tests | Added `skill_list` and `skill_read` so ocli can discover/read workspace-local `.oases/skills/**` instructions before full skill invocation exists. |
| 6.2 Prompt guidance for skills | Done | `src/pages/Home.tsx` | Project mode now tells the model to call `skill_list`/`skill_read` when tasks match local skills, without claiming a skill was executed before reading it. |
| 6.3 Skill integration smoke | Done | `scripts/ocli-smoke.mjs` | Smoke creates a workspace skill, lists it, reads its `SKILL.md`, and verifies `skill_read` rejects paths outside `.oases/skills`. |
| 6.4 Skill invocation/sub-agent design | Done | `docs/ocli-migration-plan.md`, `ocli/src/agent.js`, tests | Implemented skill invocation v1: after `skill_read`, ocli injects `<skill_context>` into the current agent session, emits `skill_loaded`, and records `invokedSkills`; all model calls still go through the Web-owned proxy. True forked sub-agent execution remains a later Phase 6 item. |
| 6.5 Validate Phase 6 first slice | Done | scripts/build | `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed with the known CSS minify warning. |
| 6.6 Deploy Phase 6 first slice | Done | Vercel | Production deployment `dpl_9xAowqPdNExrhFQoYmgixGdmQaBY`, aliased to `https://www.oasesai.xyz`; Phase 6 remains open for full skill invocation/sub-agent design. |
| 6.7 Forked sub-agent execution | Pending | `ocli/src/agent.js`, `ocli/src/sessions.js`, tests | Adapt the `ocli-test` forked skill/sub-agent concept to Oases protocol without local model keys; likely requires nested agent sessions or delegated turns through the same Web proxy. |
| 6.8 Deploy Phase 6 skill invocation v1 | Done | Vercel | Production deployment `dpl_EQSzr6N87tvan1MJYxsKWsyJYNMu`, aliased to `https://www.oasesai.xyz`; Phase 6 remains open for forked sub-agent execution. |

## Phase 7 Detailed Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 7.1 Strengthen npm package smoke | Done | `scripts/ocli-package-smoke.mjs` | Smoke now runs `npm pack --dry-run`, creates a real tarball, installs it into a temporary clean npm project, and runs installed `oases-ocli --help`. |
| 7.2 Public publish config | Done | `ocli/package.json` | Added `publishConfig.access = public` for the intended public `oases-ocli` package. |
| 7.3 npm install docs | Done | `docs/ocli-npm-release.md`, `ocli/README.md` | Docs now cover `npx oases-ocli`, clean tarball smoke, no local API key, session recovery fields, and skill tools. |
| 7.4 Repository metadata | Done | `ocli/package.json`, `oases-ocli/package.json`, docs | GitHub repository is `https://github.com/qingtengCHINA/oases-ocli`; package manifests now include `repository`, `bugs`, and `homepage`. |
| 7.5 License decision | Done | `ocli/package.json`, `ocli/LICENSE`, `oases-ocli/package.json`, `oases-ocli/LICENSE`, docs | User chose `Apache-2.0`; package manifests and LICENSE files now reflect that choice. |
| 7.6 GitHub validation workflow | Done | `.github/workflows/ocli-ci.yml`, `oases-ocli/.github/workflows/ci.yml` | Added monorepo CI for Web-integrated validation and standalone CLI CI for `npm test` plus `npm pack --dry-run`. npm publish workflow remains pending until license/npm token policy is confirmed. |
| 7.7 Real npm publish | Pending | npm | Run after npm login/token setup: `npm test`, `npm pack --dry-run`, then `npm publish --access public` from `oases-ocli/`. |

## Phase 8 Terminal UX Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 8.1 Animated interactive status mark | Done | `ocli/src/terminalUi.js`, `ocli/src/server.js` | Added a green dot-matrix Oases metaball animation for interactive `ocli serve` sessions. The two connected blobs continuously exchange size so terminal motion indicates that ocli is still running. |
| 8.2 Stable script/CI output | Done | `ocli/src/terminalUi.js` | Non-TTY output, CI, `TERM=dumb`, `NO_COLOR`, and `OCLI_PLAIN_UI=1` keep the original plain startup logs for smoke tests and automation. |
| 8.3 User-facing terminal guidance | Done | `ocli/src/terminalUi.js`, `ocli/README.md` | Startup UI now tells users: `正在运行ocli，请打开https://www.oasesai.xyz 选择“工程模式”配合使用`. |
| 8.4 Local validation | Done | tests/build | `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. |
| 8.5 Logo silhouette redesign | Done | `ocli/src/terminalUi.js` | Replaced the generic metaball renderer with a PNG-derived Oases silhouette mask, preserving the right-top large lobe, left-side concave waist, lower-left lobe, and narrow connector. Animation now uses subtle edge swelling and color flow over the closer silhouette. |
| 8.6 Visible lobe-flow animation | Done | `ocli/src/terminalUi.js` | Upgraded the terminal animation so the upper-right and lower-left lobes visibly exchange size through frame-by-frame coordinate warping, creating a stronger flowing/surging effect while retaining the Oases silhouette. |
| 8.7 Auto-open Oases Web | Done | `ocli/src/terminalUi.js`, `ocli/README.md` | Interactive `ocli` sessions now open `https://www.oasesai.xyz/` after 6 seconds. `OCLI_NO_AUTO_OPEN=1`, non-TTY output, CI, and script runs do not open a browser. |

## Phase 9 Search/Read Tool Parity Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 9.1 Capability gap audit | Done | `docs/ocli-migration-plan.md`, `ocli/ocli-test/src/tools/**` | Current `ocli/src` is usable for Oases project mode but does not yet match full `ocli-test` strength. Major remaining gaps include forked sub-agents, plugin/MCP runtime, IDE/LSP integration, background tasks/worktrees, richer settings, and terminal REPL UI. |
| 9.2 Glob-style file discovery | Done | `ocli/src/constants.js`, `ocli/src/tools.js`, tests | Added `glob_files` with `**/*.ext` style matching, basename matching for patterns like `*.ts`, type filters, modification-time sorting, and tool schema exposure. |
| 9.3 Grep-style content search | Done | `ocli/src/tools.js`, tests | Enhanced `grep_files` with regex support, glob/type filters, `content`, `files_with_matches`, and `count` output modes while preserving existing literal-query behavior. |
| 9.4 Targeted file reads | Done | `ocli/src/tools.js`, tests | `read_file` now supports `offset`, `limit`, `numbered`, and `maxChars` for cat-n style line-range reads; default full-content reads remain backward compatible. |
| 9.5 Local validation | Done | scripts/build | `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. |

## Phase 10 Sub-Agent v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 10.1 AgentTool gap slice | Done | `ocli/ocli-test/src/tools/AgentTool/**`, `ocli/src/agent.js`, `ocli/src/tools.js` | Full `ocli-test` AgentTool includes fork/background/worktree/remote/teammate modes. This slice intentionally migrates the core synchronous delegation behavior first while preserving the Oases Web-owned model/API contract. |
| 10.2 `agent_run` tool schema | Done | `ocli/src/constants.js`, `ocli/src/tools.js` | Added `agent_run` as a first-class OpenAI tool schema with `task`, `description`, `agentType`, `contextFiles`, and `maxTurns`. Direct `/tools/agent_run` calls are rejected because execution requires parent agent context. |
| 10.3 Bounded nested agent execution | Done | `ocli/src/agent.js` | Parent agents can delegate to a fresh sub-agent using the same `apiBaseUrl`/`model` from Oases Web. Nested sub-agents do not receive `agent_run`, preventing unbounded recursion. Sub-agent tool calls use the same workspace and approval callback. |
| 10.4 Sub-agent session events | Done | `ocli/src/agent.js`, tests | Parent session emits `subagent_start`, `subagent_event`, and `subagent_done`; `agent_run` returns the sub-agent final text, stopped reason, tool results, invoked skills, and file artifacts to the parent model as a normal tool result. |
| 10.5 Local validation | Done | `scripts/ocli-smoke.mjs`, package/build | Smoke starts real ocli, verifies top-level `agent_run` exposure, rejects direct HTTP execution, confirms nested agents cannot recursively see `agent_run`, and validates sub-agent read-file work through persisted session events. `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. |

## Phase 11 Background Sub-Agent v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 11.1 Background AgentTool slice | Done | `ocli/ocli-test/src/tools/AgentTool/**`, `ocli/src/agent.js` | Migrated the first background delegation behavior from the `ocli-test` AgentTool direction. This is scoped to the current parent agent run rather than a cross-session daemon; future work can persist detached background tasks. |
| 11.2 `runInBackground` launch | Done | `ocli/src/tools.js`, `ocli/src/agent.js` | `agent_run` now accepts `runInBackground: true`, starts the sub-agent without blocking the parent model turn, and returns `async_launched` with a `subagentId`. |
| 11.3 `agent_status` polling | Done | `ocli/src/constants.js`, `ocli/src/tools.js`, `ocli/src/agent.js` | Added `agent_status` for checking one background sub-agent or listing all current background sub-agents. Direct `/tools/agent_status` calls are rejected outside an agent session. |
| 11.4 Background events/results | Done | `ocli/src/agent.js` | Parent session emits background `subagent_start`, forwarded `subagent_event`, `subagent_done`, and `subagent_error`. `agent_status` returns completed sub-agent final text, tool results, artifacts, and metadata. |
| 11.5 Local validation | Done | `scripts/ocli-smoke.mjs`, package/build | Smoke starts real ocli, verifies `agent_status` exposure/rejection, launches a background sub-agent, polls with `agent_status`, and verifies completion/result/events through the real session API. `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. |

## Phase 12 Worktree Sub-Agent Isolation v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 12.1 `ocli-test` worktree gap slice | Done | `ocli/ocli-test/src/utils/worktree.ts`, `ocli/ocli-test/src/bridge/bridgeMain.ts`, `docs/ocli-migration-plan.md` | Full `ocli-test` supports reusable named worktrees, hooks, cleanup flows, tmux, and bridge spawn modes. This Oases slice intentionally implements only detached git worktree isolation for `agent_run`. |
| 12.2 `agent_run` isolation schema | Done | `ocli/src/tools.js` | Added `isolation: "workspace" | "worktree"` to the tool schema. Default remains `workspace` for backward compatibility. |
| 12.3 Detached worktree execution root | Done | `ocli/src/agent.js` | Top-level `agent_run(isolation:"worktree")` now requires a git repo with a HEAD commit, creates a detached temp worktree from `HEAD`, and runs the sub-agent with that worktree as its filesystem root. Nested sub-agents still cannot call `agent_run`. |
| 12.4 Worktree result metadata | Done | `ocli/src/agent.js` | Sub-agent events and results include `isolation`, `worktreePath`, `gitRoot`, `baseRef`, and `headCommit`. Completed worktree sub-agents also return `workspaceStatus` so the parent can inspect isolated changes. |
| 12.5 Isolation smoke coverage | Done | `scripts/ocli-smoke.mjs` | Smoke starts a real ocli server, has the fake model call `agent_run(isolation:"worktree")`, writes a file in the sub-agent, verifies the file exists only in the returned worktree path, checks status metadata, and removes the temporary test worktree. |
| 12.6 Local validation | Done | scripts/build | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build`, and `node --check` for changed JS/MJS files passed. Build still has the known CSS minify warning. |
| 12.7 Future hardening | Pending | `ocli/src/agent.js`, Web UI | Add user-facing worktree cleanup/keep controls, optional branch naming, background persisted worktree tasks, and explicit merge/apply flows before treating this as full `ocli-test` parity. |

## Phase 13 Worktree Lifecycle Tools v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 13.1 Lifecycle gap slice | Done | `ocli/ocli-test/src/utils/worktree.ts`, `ocli/ocli-test/src/components/WorktreeExitDialog.tsx`, `docs/ocli-migration-plan.md` | `ocli-test` exposes keep/remove decisions and cleanup flows around worktrees. This slice gives Oases agents a tool-level lifecycle surface before a Web UI is added. |
| 13.2 Worktree discovery and validation | Done | `ocli/src/constants.js`, `ocli/src/tools.js` | Added `worktree_list` and shared validation that resolves `/var` vs `/private/var` with `realpath` and only accepts paths returned by `git worktree list --porcelain`. The main workspace is explicitly rejected for management operations. |
| 13.3 Worktree diff inspection | Done | `ocli/src/tools.js` | Added `worktree_diff`, backed by existing `workspace_status`, so agents can inspect isolated changes and untracked previews by worktree path. |
| 13.4 Selective apply | Done | `ocli/src/tools.js` | Added `worktree_apply` to copy selected changed files from a linked worktree into the main git root. It rejects rename/copy entries in v1 and refuses to overwrite dirty same-path main workspace changes unless `force: true`. |
| 13.5 Guarded removal | Done | `ocli/src/tools.js` | Added `worktree_remove`, which refuses to remove dirty worktrees unless `force: true`, then unregisters the linked worktree with `git worktree remove`. Oases temp parent folders are cleaned best-effort after removal. |
| 13.6 Agent messaging and permissions | Done | `ocli/src/agent.js`, `ocli/src/tools.js` | Agent-visible tool result messages now distinguish worktree lifecycle calls. `worktree_apply` and `worktree_remove` require approval during agent runs because they can modify or discard local files. |
| 13.7 Smoke coverage | Done | `scripts/ocli-smoke.mjs` | Smoke creates a real isolated worktree through `agent_run(isolation:"worktree")`, verifies list/diff, rejects a non-linked path, refuses dirty removal without force, applies a selected file to the main workspace, removes the worktree with force, and verifies it is unregistered. |
| 13.8 Local validation | Done | scripts/build | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build`, and changed-file `node --check` passed. Build still has the known CSS minify warning. |
| 13.9 Future hardening | Pending | `ocli/src/tools.js`, Web UI | Add Web cards/buttons for inspect/apply/remove, richer conflict previews, rename support, commit/branch workflows, and persisted worktree registry for cross-session cleanup. |

## Phase 14 Web Worktree Control Surface v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 14.1 Web gap slice | Done | `src/pages/Home.tsx`, `docs/ocli-migration-plan.md` | Phase 13 exposed worktree lifecycle tools in ocli, but Web project mode still only showed generic artifacts/tool results. This slice adds a first Web control surface for those isolated outputs. |
| 14.2 Tool/type awareness | Done | `src/pages/Home.tsx` | Extended project tool names and local session detail normalization for `worktree_list`, `worktree_diff`, `worktree_apply`, and `worktree_remove`. Tool result `data` is now preserved in Web session detail normalization so worktree metadata is not lost. |
| 14.3 Worktree summary extraction | Done | `src/pages/Home.tsx` | Added extraction of worktree path, git root, branch/head, changed file counts, summaries, apply counts, and removed state from `agent_run`, `agent_status`, and worktree lifecycle tool results. |
| 14.4 Web controls | Done | `src/pages/Home.tsx` | The project workspace session detail panel now renders a Worktrees section with compact cards and actions to inspect, apply, or remove a linked worktree. Apply/remove use confirmation prompts and call the local ocli tool endpoints. |
| 14.5 Prompt/tool messaging | Done | `src/pages/Home.tsx` | Project-mode tool guidance and tool success messages now include worktree lifecycle tools so model/tool traces read coherently. |
| 14.6 Local UI verification | Done | local dev server, Playwright | Started Vite locally, opened Oases Chat with Playwright, verified the base page and project mode render. The only browser console error was expected `127.0.0.1:8787` connection refused because ocli was not running during this UI check. |
| 14.7 Validation | Done | scripts/build | `pnpm build`, `pnpm test:ocli`, and `pnpm test:ocli-package` passed. Build still has the known CSS minify warning. Local Playwright render check also passed for the base page and project mode; the only browser console error was expected `127.0.0.1:8787` connection refused because ocli was not running during the UI check. |
| 14.8 Deployment | Done preview | Vercel | Preview deployment `dpl_9MW4J7cxVrA6LxhKQmSnsqFoeoae`, URL `https://oases-chat-4k66z5wx0-qingtengs-projects.vercel.app`, inspect `https://vercel.com/qingtengs-projects/oases-chat/9MW4J7cxVrA6LxhKQmSnsqFoeoae`. Production promotion remains pending explicit approval. |

## Phase 15 Workspace Custom Agents v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 15.1 AgentTool definition gap slice | Done | `ocli/ocli-test/src/tools/AgentTool/loadAgentsDir.ts`, `docs/ocli-migration-plan.md` | Full `ocli-test` supports built-in/plugin/user agents with tools, permissions, MCP servers, hooks, memory, background, and isolation. This Oases slice intentionally starts with workspace-local Markdown definitions only. |
| 15.2 Workspace discovery/read tools | Done | `ocli/src/constants.js`, `ocli/src/tools.js` | Added `agent_list` and `agent_read` for `.oases/agents/**/*.md`. Agent frontmatter supports `name`, `description`, `agentType`, `maxTurns`, `background`, `isolation`, plus documented `tools`/`skills` arrays for future enforcement. Path reads are restricted to `.oases/agents`. |
| 15.3 `agent_run(agentName)` defaults | Done | `ocli/src/tools.js`, `ocli/src/agent.js` | `agent_run` now accepts `agentName` or `agent` and loads the matching workspace definition. Custom definitions can provide default `description`, `agentType`, `maxTurns`, `runInBackground`, and `isolation`; explicit call arguments still take precedence. |
| 15.4 Custom prompt injection and metadata | Done | `ocli/src/agent.js` | The custom agent Markdown body is injected into the sub-agent system prompt as dedicated instructions. Sub-agent start/done/error events, status records, and `agent_run` results include `agentName` and `customAgent` metadata for Web/session audit use. |
| 15.5 Smoke coverage | Done | `scripts/ocli-smoke.mjs` | Smoke creates `.oases/agents/reviewer.md`, verifies `agent_list`/`agent_read`, rejects path escape, checks `agent_run` schema includes `agentName`, and proves the custom prompt marker reaches the sub-agent while nested sub-agents still cannot call `agent_run`. |
| 15.6 Local validation | Done | scripts/build | `node --check ocli/src/agent.js`, `node --check ocli/src/tools.js`, `node --check scripts/ocli-smoke.mjs`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. |
| 15.7 Future hardening | Pending | `ocli/src/agent.js`, `ocli/src/tools.js`, Web UI | Support richer YAML parsing, plugin/built-in agent sources, MCP servers, hooks, memory, model/effort overrides, and Web UI for selecting named agents. |

## Phase 16 Custom Agent Tool Scoping v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 16.1 AgentTool scoping gap slice | Done | `ocli/ocli-test/src/tools/AgentTool/agentToolUtils.ts`, `ocli/ocli-test/src/tools/AgentTool/runAgent.ts`, `docs/ocli-migration-plan.md` | `ocli-test` resolves agent `tools` and `disallowedTools` against available tools, then scopes the sub-agent session. This Oases slice implements exact-name workspace custom-agent scoping without MCP or permission-rule patterns yet. |
| 16.2 Metadata parsing | Done | `ocli/src/tools.js` | `agent_list` and `agent_read` now expose `disallowedTools` alongside `tools`, both parsed from comma-separated Markdown frontmatter. |
| 16.3 Tool schema filtering | Done | `ocli/src/tools.js`, `ocli/src/agent.js` | `listOpenAiTools` accepts `allowedToolNames` and `disallowedToolNames`; custom sub-agents only receive the scoped tool schemas. `disallowedTools` wins over `tools`. |
| 16.4 Execution-time enforcement | Done | `ocli/src/agent.js` | Every parsed/native tool call is checked against the current sub-agent scope before approval or execution. If a model manually emits a forbidden `<tool>` block, ocli returns a failed tool result instead of executing it. |
| 16.5 Smoke coverage | Done | `scripts/ocli-smoke.mjs` | Smoke creates `.oases/agents/reader.md` with `tools: read_file, write_file` and `disallowedTools: write_file`, verifies the nested model request lacks forbidden schemas, forces a manual `write_file` block, and proves the file is not created. |
| 16.6 Local validation | Done | scripts/build | `node --check ocli/src/agent.js`, `node --check ocli/src/tools.js`, `node --check scripts/ocli-smoke.mjs`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. |
| 16.7 Future hardening | Pending | `ocli/src/tools.js`, `ocli/src/agent.js` | Add wildcard/pattern permission rules, MCP tool scoping, richer YAML arrays, built-in/plugin agent sources, and Web UI surfacing for restricted-agent policies. |

## Phase 17 Custom Agent Skill Preloading v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 17.1 Agent skill preload gap slice | Done | `ocli/ocli-test/src/tools/AgentTool/runAgent.ts`, `ocli/ocli-test/src/tools/AgentTool/loadAgentsDir.ts`, `docs/ocli-migration-plan.md` | `ocli-test` can preload skills declared in agent frontmatter. This Oases slice preloads workspace-local `.oases/skills` only, through the existing Web-owned model/API path. |
| 17.2 Skill loading helper | Done | `ocli/src/agent.js` | Added shared normalization/loading for `skill_read` results so explicit `skill_read` and custom-agent preloads produce the same skill shape. |
| 17.3 Pre-first-turn injection | Done | `ocli/src/agent.js` | `agent_run(agentName)` now reads `customAgent.skills`, loads matching workspace skills, and injects a `<skill_context>` message before the sub-agent's first model request. |
| 17.4 Audit metadata and events | Done | `ocli/src/agent.js` | Preloaded skills are recorded in `invokedSkills` and emit `skill_loaded` events with `preloaded: true`, which are forwarded through the parent session as `subagent_event`. |
| 17.5 Smoke coverage | Done | `scripts/ocli-smoke.mjs` | Smoke creates `.oases/agents/skilled.md` with `skills: research`, verifies the sub-agent receives `Research Skill` and a preload marker before calling tools, and checks `invokedSkills` plus nested `skill_loaded` events. |
| 17.6 Local validation | Done | scripts/build | `node --check ocli/src/agent.js`, `node --check ocli/src/tools.js`, `node --check scripts/ocli-smoke.mjs`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. |
| 17.7 Future hardening | Pending | `ocli/src/tools.js`, `ocli/src/agent.js` | Add richer YAML array parsing, missing-skill warnings instead of hard failures where appropriate, built-in/plugin skill sources, and Web UI surfacing for preloaded skill metadata. |

## Phase 18 Custom Agent initialPrompt v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 18.1 Agent initialPrompt gap slice | Done | `ocli/ocli-test/src/tools/AgentTool/loadAgentsDir.ts`, `ocli/src/tools.js`, `ocli/src/agent.js` | `ocli-test` supports `initialPrompt` on custom agent definitions and prepends it to the first user turn. This Oases slice implements the same workspace-local frontmatter behavior without migrating hooks, MCP servers, memory, or model overrides yet. |
| 18.2 Metadata parsing and discovery | Done | `ocli/src/tools.js` | `agent_list` and `agent_read` now expose trimmed `initialPrompt` frontmatter for `.oases/agents/**/*.md`. |
| 18.3 First-turn prompt prepend | Done | `ocli/src/agent.js` | `agent_run(agentName)` carries `customAgent.initialPrompt` into the normalized sub-agent request and prepends it before `子代理任务` in the sub-agent's first user message. |
| 18.4 Audit/result metadata | Done | `ocli/src/agent.js` | `agent_run` results, sub-agent records, and sub-agent events preserve `customAgent.initialPrompt` so Web/session audit can explain why the sub-agent had seeded first-turn instructions. |
| 18.5 Smoke coverage | Done | `scripts/ocli-smoke.mjs` | Smoke creates `.oases/agents/starter.md` with `initialPrompt: initial prompt marker`, verifies discovery/read metadata, confirms the first sub-agent request contains the marker, and checks `agent_run` result metadata. |
| 18.6 Local validation | Done | scripts/build | `node --check ocli/src/agent.js`, `node --check ocli/src/tools.js`, `node --check scripts/ocli-smoke.mjs`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. |
| 18.7 Future hardening | Pending | `ocli/src/tools.js`, `ocli/src/agent.js` | Add YAML block scalar/list parsing parity, explicit Web surfacing for initial prompts, and later integrate initialPrompt with built-in/plugin/user agent source precedence once those sources are migrated. |

## Phase 19 Agent Frontmatter YAML Compatibility v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 19.1 Frontmatter compatibility gap slice | Done | `ocli/ocli-test/src/tools/AgentTool/loadAgentsDir.ts`, `ocli/src/tools.js`, `scripts/ocli-smoke.mjs` | `ocli-test` custom agents are parsed as real frontmatter, so users naturally write YAML lists and block scalars. This Oases slice supports the common subset needed by workspace custom agents without adding a full YAML dependency. |
| 19.2 YAML list parsing | Done | `ocli/src/tools.js` | `tools`, `disallowedTools`, and `skills` now accept `- item` YAML lists in addition to comma-separated strings and simple inline arrays. |
| 19.3 Block scalar parsing | Done | `ocli/src/tools.js` | `initialPrompt: \|` and folded `initialPrompt: >` blocks are parsed, deindented, and passed through the existing first-turn prepend path. |
| 19.4 Smoke coverage | Done | `scripts/ocli-smoke.mjs` | Smoke creates `.oases/agents/yamlstarter.md` with YAML list tools/disallowedTools/skills and a multi-line `initialPrompt`, verifies discovery/read metadata, tool scope filtering, skill preloading, and first-turn prompt injection. |
| 19.5 Docs | Done | `README.md`, `ocli/README.md`, `docs/ocli-migration-plan.md` | Documented comma-separated and YAML list syntax plus multi-line `initialPrompt` block syntax. |
| 19.6 Local validation | Done | scripts/build | `node --check ocli/src/agent.js`, `node --check ocli/src/tools.js`, `node --check scripts/ocli-smoke.mjs`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. |
| 19.7 Future hardening | Pending | `ocli/src/tools.js` | Replace the small frontmatter subset with a vetted YAML parser if future agent sources need nested objects for hooks/MCP servers, while preserving current package/runtime constraints. |

## Phase 20 Custom Agent Effort v1 Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 20.1 Agent effort gap slice | Done | `ocli/ocli-test/src/tools/AgentTool/loadAgentsDir.ts`, `ocli/src/tools.js`, `ocli/src/agent.js` | `ocli-test` custom agents can declare `effort`. This Oases slice supports named effort levels only and keeps model/API selection owned by Oases Web. |
| 20.2 Metadata parsing | Done | `ocli/src/tools.js` | `agent_list` and `agent_read` now expose valid `effort: low|medium|high|max` frontmatter values for workspace custom agents. |
| 20.3 Sub-agent request override | Done | `ocli/src/agent.js` | `agent_run(agentName)` now passes the custom agent effort into the nested `runAgent` call, which sets both `effort` and `reasoning_effort` on the Web proxy request. |
| 20.4 Audit/result metadata | Done | `ocli/src/agent.js` | Sub-agent events, records, background launch payloads, and `agent_run` results include the effective custom-agent effort when present. |
| 20.5 Smoke coverage | Done | `scripts/ocli-smoke.mjs` | Smoke creates `.oases/agents/effortful.md` with `effort: low`, verifies discovery/read metadata, checks the nested fake API receives `effort=low` and `reasoning_effort=low`, and confirms result metadata. |
| 20.6 Local validation | Done | scripts/build | `node --check ocli/src/agent.js`, `node --check ocli/src/tools.js`, `node --check scripts/ocli-smoke.mjs`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. |
| 20.7 Future hardening | Pending | `ocli/src/tools.js`, `ocli/src/agent.js` | Decide whether numeric effort should ever be accepted for Oases, add UI surfacing for per-agent effort, and later evaluate model override semantics without breaking Web-owned model selection. |

## Phase 21 Standalone CLI Push Folder Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 21.1 Create clean standalone package folder | Done | `oases-ocli/**` | Added a root-level CLI-only folder for future separate GitHub/npm publishing. It mirrors the active runtime without `ocli-test`, `legacy-mvp-src`, Web frontend files, Vercel files, generated artifacts, tarballs, or local `.oases` state. |
| 21.2 Package manifest and entrypoints | Done | `oases-ocli/package.json`, `oases-ocli/bin/ocli.js`, `oases-ocli/index.js` | Standalone package keeps the `oases-ocli`/`ocli` bin entries and adds local `npm test`, `npm run test:smoke`, and `npm run test:package` scripts. |
| 21.3 Standalone smoke tests | Done | `oases-ocli/scripts/ocli-smoke.mjs`, `oases-ocli/scripts/ocli-package-smoke.mjs` | Test imports and startup paths now resolve inside `oases-ocli/`, so the folder remains testable after being pushed outside the Web monorepo. |
| 21.4 Ignore and publish boundaries | Done | `oases-ocli/.gitignore`, `oases-ocli/.npmignore`, `oases-ocli/package.json` | Git ignores local/generated files; npm package contents remain limited by `files` to `bin`, `src`, and `README.md`. |
| 21.5 Documentation sync | Done | `README.md`, `ocli/README.md`, `oases-ocli/README.md`, `docs/ocli-npm-release.md`, `docs/ocli-migration-plan.md` | README now explains what to push for a standalone CLI repo versus a full OasesChat repo. Release docs now point to `oases-ocli/` as the clean package source. |
| 21.6 Local validation | Done | scripts/build | `cd oases-ocli && npm test`, root `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify and chunk-size warnings. |

## Phase 22 Zero-Argument CLI Startup Checklist

| Item | Status | Files | Notes |
| --- | --- | --- | --- |
| 22.1 Default command behavior | Done | `ocli/src/cli.js`, `oases-ocli/src/cli.js` | `ocli` now defaults to `serve` with `workspace = process.cwd()`. `ocli --workspace <path>` and `ocli -p <port>` also start directly. `ocli --help` still prints help. |
| 22.2 Backward compatibility | Done | `ocli/src/cli.js`, `oases-ocli/src/cli.js` | Existing `ocli serve --workspace <path>` and npm/pnpm `--` delimiter forms still parse as before. |
| 22.3 Smoke coverage | Done | `scripts/ocli-package-smoke.mjs`, `oases-ocli/scripts/ocli-package-smoke.mjs` | Package smoke now asserts zero-argument startup parsing, leading-flag parsing, and help text with the short `ocli` command. |
| 22.4 Documentation sync | Done | `README.md`, `ocli/README.md`, `oases-ocli/README.md`, `docs/ocli-npm-release.md`, `docs/ocli-migration-plan.md` | Docs now present the preferred published flow as `npm install -g oases-ocli` once, then `ocli` from the project directory. `npx oases-ocli` remains documented as one-off usage. |
| 22.5 Local validation | Done | scripts/build | `cd oases-ocli && npm test`, root `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify and chunk-size warnings. |

## Migration Rules

- Preserve the working Web protocol while migrating internals.
- Do not require local API keys; model/API must continue to come from Oases Web.
- Keep local filesystem access scoped to `--workspace`.
- Every phase must add or update smoke coverage before implementation changes where practical.
- After each meaningful ocli chunk, run `pnpm test:ocli-package` and `pnpm test:ocli`.
- After each large step, run `pnpm build` and deploy to Vercel.
- Keep `ocli/ocli-test/src` available as the reference source until its useful modules have been adapted.
- Keep `oases-ocli/` synchronized with active runtime changes before any standalone CLI GitHub push or npm release.

## Operation Log

| Time | Update | Validation | Deployment |
| --- | --- | --- | --- |
| 2026-06-10 15:45 | Created live migration plan. Phase 1 started. | Pending | Pending |
| 2026-06-10 17:47 | Phase 1 package structure completed: active runtime moved to `ocli/src`, package root created at `ocli`, old MVP archived under `ocli/legacy-mvp-src`, root entry and package smoke updated. | `pnpm test:ocli-package`, `pnpm test:ocli`, `pnpm build` passed. | Pending |
| 2026-06-10 21:40 | Phase 1 deployed to production. Phase 2 started. | Vercel build passed. | `https://www.oasesai.xyz`, deployment `dpl_FGnWbaraaR3pEoJ7BJQufMLD7S3u`, inspect `https://vercel.com/qingtengs-projects/oases-chat/FGnWbaraaR3pEoJ7BJQufMLD7S3u` |
| 2026-06-10 21:44 | Phase 2.1 and 2.2 completed: standardized tool result artifact metadata and preserved artifacts through agent results and Web normalization. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Not deployed yet; continue Phase 2 first. |
| 2026-06-10 21:47 | Phase 2.3 completed: added `todo_write` structured project checklist tool and Web preview support. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Not deployed yet; continue Phase 2 first. |
| 2026-06-10 21:49 | Phase 2.4 completed: enhanced `fetch_url` with HTML title and normalized link metadata for crawler/page-analysis workflows. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Not deployed yet; continue Phase 2 first. |
| 2026-06-10 21:53 | Phase 2.5-2.7 completed: command/Python generated-file artifacts, final artifact-aware prompt guidance, and full validation. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Pending |
| 2026-06-10 21:54 | Phase 2 deployed to production. | Vercel build passed. | `https://www.oasesai.xyz`, deployment `dpl_Gx1DFBtJ6w5V5PdnguKmhq4ETLYQ`, inspect `https://vercel.com/qingtengs-projects/oases-chat/Gx1DFBtJ6w5V5PdnguKmhq4ETLYQ` |
| 2026-06-10 21:58 | Phase 3.1 completed: read-only shell command policy added so harmless commands like `pwd` no longer require approval, while Python/arbitrary shell/destructive tools remain gated. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Not deployed yet; continue Phase 3 first. |
| 2026-06-10 22:00 | Phase 3.2 completed: approval requests now carry category and reason, and Web approval cards display them. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Not deployed yet; continue Phase 3 first. |
| 2026-06-10 22:05 | Phase 3.3 completed: agent approval requests now include stable approval keys; sessions cache approved keys and reuse identical approvals within the same session. Smoke test also covers repeated Python execution with only one `approval_required` event. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Not deployed yet; continue Phase 3.4 first. |
| 2026-06-10 22:08 | Phase 3.4-3.5 completed: stronger destructive command detection added, read-only shell policy no longer auto-approves chained commands, and full local validation passed. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Pending Phase 3 production deploy. |
| 2026-06-10 22:10 | Phase 3 deployed to production. | Vercel build passed. | `https://www.oasesai.xyz`, deployment `dpl_9yWQmFGKqbsxnKzntLpo3jJe29SN`, inspect `https://vercel.com/qingtengs-projects/oases-chat/9yWQmFGKqbsxnKzntLpo3jJe29SN` |
| 2026-06-10 22:11 | Phase 4 started: detailed checklist added for continuation contract, auto-continue slices, completion criteria, long-running task smoke, and crawler-style smoke. | Pending | Pending |
| 2026-06-10 22:17 | Phase 4.1-4.6 completed: local agent now auto-continues across bounded slices, follows up on unfinished no-tool replies, Web shows auto-running state, and crawler-style artifact workflow is covered by smoke. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Pending Phase 4 production deploy. |
| 2026-06-10 22:19 | Phase 4 deployed to production. | Vercel build passed. | `https://www.oasesai.xyz`, deployment `dpl_ALXijhHX9UTUkCB7GZU4BTxcf65P`, inspect `https://vercel.com/qingtengs-projects/oases-chat/ALXijhHX9UTUkCB7GZU4BTxcf65P` |
| 2026-06-10 22:24 | Phase 5 started: detailed checklist added for session audit summaries, upgraded Web session detail panel, persisted restart recovery smoke, and manual resume affordance. | Pending | Pending |
| 2026-06-10 22:28 | Phase 5.1-5.5 completed: session details now expose artifacts/todos/approval summary/resume prompt, Web project workspace renders those audit fields, and restart recovery smoke covers persisted crawler artifacts. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Pending Phase 5 production deploy. |
| 2026-06-10 22:29 | Phase 5 deployed to production. | Vercel build passed. | `https://www.oasesai.xyz`, deployment `dpl_BgPsPDizHReArAF4u1SX8NLkFLgm`, inspect `https://vercel.com/qingtengs-projects/oases-chat/BgPsPDizHReArAF4u1SX8NLkFLgm` |
| 2026-06-10 22:30 | Phase 6 started: first slice scoped to workspace-local skill discovery/read tools before full forked skill invocation. | Pending | Pending |
| 2026-06-10 22:35 | Phase 6.1-6.3 and 6.5 completed: added workspace-local `skill_list`/`skill_read`, prompt guidance, and smoke coverage for skill discovery/read/path boundaries. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Pending Phase 6 first-slice production deploy. |
| 2026-06-10 22:36 | Phase 6 first slice deployed to production. | Vercel build passed. | `https://www.oasesai.xyz`, deployment `dpl_9xAowqPdNExrhFQoYmgixGdmQaBY`, inspect `https://vercel.com/qingtengs-projects/oases-chat/9xAowqPdNExrhFQoYmgixGdmQaBY` |
| 2026-06-10 22:45 | Phase 6.4 skill invocation v1 completed: `skill_read` now loads skills into current-session `<skill_context>`, emits `skill_loaded`, records `invokedSkills`, and smoke verifies skill-guided output generation. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed. | Pending Phase 6 skill invocation v1 deploy. |
| 2026-06-10 22:46 | Phase 6 skill invocation v1 deployed to production. | Vercel build passed. | `https://www.oasesai.xyz`, deployment `dpl_EQSzr6N87tvan1MJYxsKWsyJYNMu`, inspect `https://vercel.com/qingtengs-projects/oases-chat/EQSzr6N87tvan1MJYxsKWsyJYNMu` |
| 2026-06-10 22:49 | Phase 7 started: strengthened npm package smoke with real tarball install, added public publish config, and updated npm install/release docs. Repository metadata, license, workflow, and real publish remain blocked pending user decisions. | Pending validation | Not applicable |
| 2026-06-10 22:50 | Phase 7.1-7.3 validated: package smoke now covers `npm pack --dry-run`, real tarball creation, clean temp-project install, and installed `oases-ocli --help`; ocli smoke and Web build also passed. | `pnpm test:ocli-package`, `pnpm test:ocli`, `pnpm build` passed. | Not deployed; package/docs change does not affect Vercel runtime. |
| 2026-06-10 22:51 | Phase 7.6 validation workflow added: GitHub Actions now runs package smoke, ocli smoke, and Web build on relevant PR/push changes. | Workflow file added; local validation already passed at 22:50. | Not deployed; CI workflow change does not affect Vercel runtime. |
| 2026-06-10 23:10 | Phase 8.1-8.3 completed: added interactive green Oases terminal animation and startup guidance while preserving plain output for CI/scripts. | Pending validation | Not deployed; local ocli terminal UX change only. |
| 2026-06-10 23:16 | Phase 8.4 validated: ocli terminal UX passed local smoke/package/build checks; SIGINT now exits cleanly so `pnpm ocli ...` does not treat a user Ctrl+C stop as a lifecycle failure. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed with known CSS minify warning. | Not deployed; local ocli terminal UX change only. |
| 2026-06-10 23:58 | Phase 8.5 completed: terminal icon redesigned from a sampled Oases PNG silhouette instead of a generic mathematical blob, improving likeness to the provided icon while keeping the flowing green status effect. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed with known CSS minify warning. | Not deployed; local ocli terminal UX change only. |
| 2026-06-11 00:08 | Phase 8.6-8.7 completed: terminal animation now makes the two Oases lobes visibly exchange size, and interactive startup schedules Oases Web to open automatically after 6 seconds. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed with known CSS minify warning. | Not deployed; local ocli terminal UX change only. |
| 2026-06-11 00:35 | Phase 9 completed: added `ocli-test`-style search/read improvements with `glob_files`, regex/type/output-mode `grep_files`, and targeted numbered `read_file` ranges. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed with known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 00:50 | Phase 10 completed: added synchronous `agent_run` sub-agent delegation v1, bounded nested execution, sub-agent event forwarding, and ocli smoke coverage through the real local server/session API. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed with known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 01:06 | Phase 11 completed: added current-session background sub-agents via `agent_run(runInBackground: true)` plus `agent_status` polling, with real ocli smoke coverage. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build` passed with known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 01:36 | Phase 12 completed: added `agent_run(isolation:"worktree")`, detached git worktree execution for sub-agents, worktree metadata/status return, and smoke coverage proving isolated writes do not pollute the main workspace. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build`, and `node --check` passed. Build still has the known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 10:37 | Phase 13 completed: added worktree lifecycle tools (`worktree_list`, `worktree_diff`, `worktree_apply`, `worktree_remove`) with linked-worktree path validation, guarded apply/remove behavior, realpath handling for macOS `/var` vs `/private/var`, and smoke coverage through real ocli HTTP/tool/session paths. | `pnpm test:ocli`, `pnpm test:ocli-package`, `pnpm build`, and `node --check` passed. Build still has the known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 11:01 | Phase 14 completed: Web project workspace session detail now extracts worktree metadata from ocli session results and renders inspect/apply/remove controls for isolated sub-agent worktrees. | `pnpm build`, `pnpm test:ocli`, `pnpm test:ocli-package`, and local Playwright render check passed. Build still has the known CSS minify warning; Playwright saw expected ocli connection refused while ocli was not running. | Preview deployed: `https://oases-chat-4k66z5wx0-qingtengs-projects.vercel.app`, deployment `dpl_9MW4J7cxVrA6LxhKQmSnsqFoeoae`. Production promotion pending approval. |
| 2026-06-11 11:29 | Phase 15 completed: added workspace custom agent discovery/read tools and `agent_run(agentName)` prompt injection with custom agent metadata in sub-agent events/results. | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 11:52 | Phase 16 completed: custom workspace agents now scope nested tool schemas with `tools`/`disallowedTools` and block forbidden manual tool calls before execution. | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 12:11 | Phase 17 completed: custom workspace agents now preload declared workspace skills before the first sub-agent turn and record preloaded skills in audit events/results. | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 13:24 | Phase 18 completed: custom workspace agents now parse `initialPrompt`, prepend it to the sub-agent first user turn, and preserve it in custom-agent result metadata. | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 13:30 | Phase 19 completed: custom agent frontmatter now supports YAML list fields, inline arrays, and multi-line `initialPrompt` block scalars for closer `ocli-test` compatibility. | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 19:18 | Phase 21 completed: created `oases-ocli/` as a clean standalone CLI push folder, added standalone tests and ignore files, and updated README/release docs with push boundaries. | `cd oases-ocli && npm test`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify and chunk-size warnings. | Not deployed; docs/package structure change only. |
| 2026-06-11 16:37 | Phase 20 completed: custom workspace agents now parse `effort`, apply it to sub-agent model requests, and preserve it in events/results while keeping Web-owned model/API unchanged. | `node --check`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify warning. | Not deployed; local ocli runtime/tooling change only. |
| 2026-06-11 19:28 | Phase 22 completed: changed CLI parsing so `ocli` starts the runtime directly, kept `serve` compatibility, and updated package smoke/docs for the short command. | `cd oases-ocli && npm test`, `pnpm test:ocli`, `pnpm test:ocli-package`, and `pnpm build` passed. Build still has the known CSS minify and chunk-size warnings. | Not deployed; local CLI UX/docs change only. |
| 2026-06-11 19:41 | Phase 7.4 completed after standalone GitHub publication: recorded `https://github.com/qingtengCHINA/oases-ocli` in package metadata and docs, added standalone CLI GitHub Actions CI. | `cd oases-ocli && npm test`, standalone `npm run test:package`, and root `pnpm test:ocli-package` passed. | Not deployed; package metadata/docs/CI change only. |
| 2026-06-11 19:49 | Phase 7.5 completed: set oases-ocli license to Apache-2.0, added LICENSE files in both standalone and integrated CLI package folders, and updated package smoke/docs. | `cd oases-ocli && npm test`, standalone `npm run test:package`, and root `pnpm test:ocli-package` passed. | Not deployed; package metadata/docs/license change only. |

## Latest Known Good Validation

```text
pnpm test:ocli          passed
pnpm test:ocli-package  passed
pnpm build              passed with known CSS minify warning
```

Latest production deployment:

```text
https://www.oasesai.xyz
dpl_EQSzr6N87tvan1MJYxsKWsyJYNMu
```

Latest preview deployment:

```text
https://oases-chat-4k66z5wx0-qingtengs-projects.vercel.app
dpl_9MW4J7cxVrA6LxhKQmSnsqFoeoae
```
