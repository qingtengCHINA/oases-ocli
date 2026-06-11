# ocli npm Release Guide

This guide turns the Oases desktop bridge into an installable CLI package. The primary target user flow is install once, then start with the shortest command:

```bash
npm install -g oases-ocli
ocli
```

One-off usage without installing also works:

```bash
npx oases-ocli
```

After the command starts, Oases Chat Web project mode connects to `http://127.0.0.1:8787` and sends the selected model, API proxy URL, system prompt, and compacted conversation context to the local runtime. Users do not configure local model providers or API keys.

## Package Layout

The clean standalone package source lives at:

```text
oases-ocli
```

GitHub repository:

```text
https://github.com/qingtengCHINA/oases-ocli
```

Important files:

- `package.json`: npm manifest for `oases-ocli`.
- `bin/ocli.js`: executable entry for both `ocli` and `oases-ocli`.
- `src/server.js`: local HTTP/SSE bridge used by Oases Web.
- `src/agent.js`: local agent loop, including text `<tool>` blocks and native streamed `tool_calls`.
- `src/tools.js`: workspace tool registry.
- `src/sessions.js`: async session, SSE, approval, and cancellation flow.
- `scripts/ocli-smoke.mjs`: standalone runtime smoke test.
- `scripts/ocli-package-smoke.mjs`: standalone npm package/tarball install smoke test.

Inside the full OasesChat Web repository, `ocli/` remains the integrated runtime source used by `pnpm ocli` and root smoke tests. `oases-ocli/` is the clean push/publish folder. Keep these synchronized when active runtime code changes.

`ocli/ocli-test/src` remains the Claude Code prototype reference source for future migration work. It is not included in `oases-ocli/` and is not included in the `oases-ocli` npm package.

## Local Verification

Run these from the repository root after each meaningful ocli change:

```bash
pnpm test:ocli-package
pnpm test:ocli
pnpm build
```

Then verify the standalone CLI folder:

```bash
cd oases-ocli
npm test
npm pack --dry-run
```

What they prove:

- `pnpm test:ocli-package` proves the npm package has a valid manifest, executable bin, and publishable file list.
- It also creates a real tarball, installs it into a temporary clean npm project, and runs the installed `oases-ocli --help` binary. This catches broken `bin` paths before publishing.
- `pnpm test:ocli` proves the desktop bridge can serve health, expose tools, execute workspace edits, run Python, persist sessions, handle approvals, and execute native streamed tool calls.
- `pnpm build` proves the Vercel Web app can compile with the current desktop connection code.

## Try the Packed CLI Locally

From the package directory:

```bash
cd oases-ocli
npm install -g .
ocli --help
ocli
```

If zsh still cannot find `ocli` after installation, run `rehash` and try again.

To test the tarball path:

```bash
npm pack
npx ./oases-ocli-0.1.0.tgz
```

Open Oases Chat Web, switch to project mode, and confirm the project workspace panel shows:

```text
Oases desktop bridge · ocli · v0.1.0
```

## GitHub Preparation

1. Standalone CLI repository is created at `https://github.com/qingtengCHINA/oases-ocli`.
2. For this standalone CLI repository, commit the contents of `oases-ocli/`.
3. License is set to `Apache-2.0` in `package.json`, with a root `LICENSE` file included in the package.
4. Repository metadata is configured in `oases-ocli/package.json`:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/qingtengCHINA/oases-ocli.git"
  },
  "bugs": {
    "url": "https://github.com/qingtengCHINA/oases-ocli/issues"
  },
  "homepage": "https://github.com/qingtengCHINA/oases-ocli#readme"
}
```

5. Add a release checklist to the PR:

```text
- pnpm test:ocli-package
- pnpm test:ocli
- pnpm build
- Vercel preview deployment URL
```

For the first npm release, keep the package version at `0.1.0`. For later releases, bump it before publishing:

```bash
cd oases-ocli
npm version patch
```

## npm Publish

Login once:

```bash
npm login
```

Dry run before publishing:

```bash
cd oases-ocli
npm pack --dry-run
```

The repository-level smoke test is stricter and should also pass before publish:

```bash
pnpm test:ocli-package
```

For the standalone CLI repository, run:

```bash
npm test
npm pack --dry-run
```

Publish the package:

```bash
npm publish --access public
```

Then test the real public install path:

```bash
npm install -g oases-ocli@latest
ocli --help
ocli
```

Also test the one-off `npx` path:

```bash
npx oases-ocli@latest --help
npx oases-ocli@latest
```

## Web Connection Contract

The Web app discovers the local runtime with:

```text
GET http://127.0.0.1:8787/health
```

The bridge must return:

```json
{
  "ok": true,
  "name": "ocli",
  "bridgeName": "Oases desktop bridge",
  "runtimeSource": "ocli",
  "agentSessions": true,
  "approvals": true,
  "nativeToolCalls": true,
  "nativeToolSchemas": true,
  "modelSource": "web",
  "apiSource": "web-proxy",
  "sessionCount": 1,
  "activeSessionCount": 0,
  "latestSession": {
    "id": "sess_example",
    "status": "completed"
  }
}
```

For each project task, Web starts a local agent session with:

```text
POST /agent/sessions
```

The request includes `apiBaseUrl`, `model`, `effort`, `systemPrompt`, and compacted messages. The bridge streams progress back with:

```text
GET /agent/sessions/:id/events
```

After an `ocli` restart, Web can recover recent work with:

```text
GET /agent/sessions
GET /agent/sessions/:id
```

Session detail responses include `events`, `eventCounts`, and `toolResults`, allowing Web to render a categorized timeline without reparsing every persisted event client-side.

The bridge must never require a local API key. If `model` or `apiBaseUrl` is missing, the request should fail fast.
