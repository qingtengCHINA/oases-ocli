import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli.js";
import { supportsInteractiveUi } from "../src/terminalUi.js";

const packageRoot = path.resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, cwd = packageRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr || stdout}`));
    });
  });
}

const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
assert(manifest.name === "oases-ocli", "package name should be oases-ocli for npx oases-ocli");
assert(manifest.type === "module", "package should be ESM");
assert(manifest.bin?.ocli === "bin/ocli.js", "package should expose the ocli binary");
assert(manifest.bin?.["oases-ocli"] === "bin/ocli.js", "package should expose the oases-ocli binary");
assert(Array.isArray(manifest.files) && manifest.files.includes("bin") && manifest.files.includes("src") && manifest.files.includes("OcliSkills"), "package should publish the official runtime files and bundled skills");
assert(manifest.publishConfig?.access === "public", "package should be configured for public npm publishing");
assert(manifest.repository?.url === "git+https://github.com/qingtengCHINA/oases-ocli.git", "package should point to the public GitHub repository");
assert(manifest.bugs?.url === "https://github.com/qingtengCHINA/oases-ocli/issues", "package should expose the GitHub issues URL");
assert(manifest.homepage === "https://github.com/qingtengCHINA/oases-ocli#readme", "package should expose the GitHub README homepage");
assert(manifest.license === "Apache-2.0", "package should use Apache-2.0 license");

const ttyStream = { isTTY: true };
assert(!supportsInteractiveUi(ttyStream, {}, "win32"), "Windows cmd should use static terminal UI by default");
assert(supportsInteractiveUi(ttyStream, { WT_SESSION: "1" }, "win32"), "Windows Terminal should keep animated terminal UI");
assert(supportsInteractiveUi(ttyStream, { TERM_PROGRAM: "vscode" }, "win32"), "VS Code terminal on Windows should keep animated terminal UI");
assert(supportsInteractiveUi(ttyStream, { OCLI_ANIMATED_UI: "1" }, "win32"), "users should be able to force animated terminal UI");
assert(!supportsInteractiveUi(ttyStream, { OCLI_PLAIN_UI: "1" }, "darwin"), "plain UI env should disable animation");
assert(!supportsInteractiveUi({ isTTY: false }, { WT_SESSION: "1" }, "win32"), "non-TTY output should never animate");

const help = await run(process.execPath, ["bin/ocli.js", "--help"]);
assert(help.stdout.includes(`ocli ${manifest.version}`), "packaged CLI should print help");
assert(help.stdout.includes("\n  ocli\n"), "packaged CLI help should include zero-argument startup");
assert(help.stdout.includes("ocli --workspace ~/Projects/my-app"), "packaged CLI help should include short workspace example");
assert(help.stdout.includes("ocli open"), "packaged CLI help should include open command");
assert(help.stdout.includes("ocli update"), "packaged CLI help should include self-update command");

const defaultArgs = parseArgs(["node", "bin/ocli.js"]);
assert(defaultArgs.command === "serve", "CLI parser should default to serve when no command is provided");
assert(defaultArgs.workspace === process.cwd(), "CLI parser should default workspace to cwd");

const shortWorkspaceArgs = parseArgs(["node", "bin/ocli.js", "--workspace", "."]);
assert(shortWorkspaceArgs.command === "serve", "CLI parser should treat leading flags as default serve options");
assert(shortWorkspaceArgs.workspace === ".", "CLI parser should preserve workspace in zero-command form");

const pnpmDelimitedArgs = parseArgs(["node", "bin/ocli.js", "--", "serve", "--workspace", "."]);
assert(pnpmDelimitedArgs.command === "serve", "CLI parser should ignore a pnpm/npm -- argument delimiter");
assert(pnpmDelimitedArgs.workspace === ".", "CLI parser should preserve arguments after a pnpm/npm -- delimiter");

const updateArgs = parseArgs(["node", "bin/ocli.js", "update", "--dry-run"]);
assert(updateArgs.command === "update", "CLI parser should support update command");
assert(updateArgs.dryRun === true, "CLI parser should preserve update --dry-run");
const upgradeArgs = parseArgs(["node", "bin/ocli.js", "upgrade"]);
assert(upgradeArgs.command === "upgrade", "CLI parser should support upgrade alias");
const openArgs = parseArgs(["node", "bin/ocli.js", "open", "--workspace", "/tmp/example", "--dry-run"]);
assert(openArgs.command === "open" && openArgs.workspace === "/tmp/example" && openArgs.dryRun === true, "CLI parser should support open --workspace --dry-run");

const updateDryRun = await run(process.execPath, ["bin/ocli.js", "update", "--dry-run"]);
assert(updateDryRun.stdout.includes("npm install -g oases-ocli@latest"), "update --dry-run should print the npm update command");

const packed = await run("npm", ["pack", "--dry-run", "--json"]);
const packInfo = JSON.parse(packed.stdout)[0];
const files = packInfo.files.map((file) => file.path);
assert(files.includes("bin/ocli.js"), "npm package should include bin/ocli.js");
assert(files.includes("src/server.js"), "npm package should include src/server.js");
assert(files.includes("src/agent.js"), "npm package should include src/agent.js");
assert(files.includes("src/open.js"), "npm package should include src/open.js");
assert(files.includes("OcliSkills/web-search/SKILL.md"), "npm package should include bundled OcliSkills");
assert(files.includes("OcliSkills/web-search/scripts/browser_search.py"), "npm package should include bundled skill scripts");
assert(files.includes("LICENSE"), "npm package should include LICENSE");
assert(!files.some((file) => file.startsWith("../") || file.includes("ocli-test") || file.includes("legacy-mvp-src")), "npm package should not include prototype or archived runtime source");

const tempRoot = await mkdtemp(path.join(tmpdir(), "oases-ocli-package-"));
try {
  const packedReal = await run("npm", ["pack", "--json", "--pack-destination", tempRoot]);
  const packedInfo = JSON.parse(packedReal.stdout)[0];
  const tarball = path.join(tempRoot, packedInfo.filename);
  const installRoot = path.join(tempRoot, "install-smoke");
  await mkdir(installRoot, { recursive: true });
  await run("npm", ["init", "-y"], installRoot);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installRoot);
  const installedHelp = await run(process.platform === "win32" ? "node_modules\\.bin\\oases-ocli.cmd" : "node_modules/.bin/oases-ocli", ["--help"], installRoot);
  assert(installedHelp.stdout.includes(`ocli ${manifest.version}`), "installed tarball should expose the oases-ocli binary");
  assert(installedHelp.stdout.includes("\n  ocli\n"), "installed tarball help should include zero-argument startup");
  assert(installedHelp.stdout.includes("ocli open"), "installed tarball help should include open command");
  const installedUpdateDryRun = await run(process.platform === "win32" ? "node_modules\\.bin\\ocli.cmd" : "node_modules/.bin/ocli", ["upgrade", "--dry-run"], installRoot);
  assert(installedUpdateDryRun.stdout.includes("npm install -g oases-ocli@latest"), "installed tarball should expose update/upgrade dry-run");
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    `
import { handleTool } from './node_modules/oases-ocli/src/tools.js';
const written = await handleTool(process.cwd(), 'memory_write', {
  scope: 'team',
  name: 'release-policy',
  title: 'Release policy',
  description: 'How this team validates package releases',
  tags: ['release', 'memory'],
  content: 'Run package smoke before publishing oases-ocli.',
});
if (!written.written || written.path !== '.oases/memory/team/release-policy.md') throw new Error('installed package could not write scoped memory');
if (written.artifacts?.[0]?.role !== 'memory_file') throw new Error('installed package memory_write did not return memory artifact');
const listed = await handleTool(process.cwd(), 'memory_list', { scope: 'team' });
if (!listed.memories?.some((memory) => memory.name === 'release-policy' && memory.scope === 'team' && memory.tags?.includes('release'))) throw new Error('installed package could not list scoped memory metadata');
const read = await handleTool(process.cwd(), 'memory_read', { name: 'release-policy', scope: 'team' });
if (!String(read.body || '').includes('package smoke')) throw new Error('installed package could not read memory body');
let duplicateRejected = false;
try { await handleTool(process.cwd(), 'memory_write', { scope: 'team', name: 'release-policy', title: 'Release policy', content: 'duplicate' }); } catch { duplicateRejected = true; }
if (!duplicateRejected) throw new Error('installed package memory_write should reject overwrite by default');
let outsideRejected = false;
try { await handleTool(process.cwd(), 'memory_read', { path: '.oases/settings.json' }); } catch { outsideRejected = true; }
if (!outsideRejected) throw new Error('installed package memory_read should reject paths outside .oases/memory');
let nestedRejected = false;
try { await handleTool(process.cwd(), 'memory_write', { scope: 'team', path: '.oases/memory/team/nested/release.md', title: 'Nested', content: 'nested' }); } catch { nestedRejected = true; }
if (!nestedRejected) throw new Error('installed package memory_write should reject nested memory paths');
const agentWritten = await handleTool(process.cwd(), 'agent_write', {
  name: 'release-reviewer',
  title: 'Release Reviewer',
  description: 'Verify release readiness',
  agentType: 'verify',
  maxTurns: 4,
  effort: 'low',
  tools: ['read_file', 'grep_files', 'workspace_status'],
  disallowedTools: 'delete_file',
  skills: 'web-search',
  memories: ['team:release-policy'],
  initialPrompt: 'package agent initial marker\\nsecond package line',
  prompt: 'Review release artifacts and report concrete blocking risks.\\n\\npackage agent prompt marker',
});
if (!agentWritten.written || agentWritten.path !== '.oases/agents/release-reviewer.md') throw new Error('installed package could not write structured custom agent');
if (agentWritten.artifacts?.[0]?.role !== 'agent_file') throw new Error('installed package agent_write did not return agent artifact');
if (agentWritten.agent?.agentType !== 'verify' || agentWritten.agent?.effort !== 'low') throw new Error('installed package agent_write did not parse agent metadata');
const agentListed = await handleTool(process.cwd(), 'agent_list', { maxResults: 10 });
if (!agentListed.agents?.some((agent) => agent.name === 'release-reviewer' && agent.tools?.includes('workspace_status') && agent.disallowedTools?.includes('delete_file'))) throw new Error('installed package could not list agent_write metadata');
const agentRead = await handleTool(process.cwd(), 'agent_read', { name: 'release-reviewer' });
if (!String(agentRead.prompt || '').includes('package agent prompt marker')) throw new Error('installed package could not read agent_write prompt');
if (!String(agentRead.agent?.initialPrompt || '').includes('second package line')) throw new Error('installed package agent_read did not parse block initialPrompt');
let duplicateAgentRejected = false;
try { await handleTool(process.cwd(), 'agent_write', { name: 'release-reviewer', prompt: 'duplicate' }); } catch { duplicateAgentRejected = true; }
if (!duplicateAgentRejected) throw new Error('installed package agent_write should reject overwrite by default');
let outsideAgentRejected = false;
try { await handleTool(process.cwd(), 'agent_write', { path: '../bad-agent.md', prompt: 'outside' }); } catch { outsideAgentRejected = true; }
if (!outsideAgentRejected) throw new Error('installed package agent_write should reject paths outside .oases/agents');
let unknownAgentToolRejected = false;
try { await handleTool(process.cwd(), 'agent_write', { name: 'bad-tool-agent', tools: ['not_a_tool'], prompt: 'bad tool' }); } catch { unknownAgentToolRejected = true; }
if (!unknownAgentToolRejected) throw new Error('installed package agent_write should reject unknown tool names');
`,
  ], installRoot);
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    "import { handleTool } from './node_modules/oases-ocli/src/tools.js'; const skill = await handleTool(process.cwd(), 'skill_read', { name: 'web-search', maxChars: 2000 }); if (skill.source !== 'bundled' || !String(skill.content || '').includes('Use browser automation to search the web')) throw new Error('installed package could not read bundled web-search skill'); const asset = await handleTool(process.cwd(), 'skill_asset_read', { name: 'web-search', assetPath: 'scripts/browser_search.py', maxChars: 2000 }); if (asset.source !== 'bundled' || !String(asset.content || '').includes('SOURCES')) throw new Error('installed package could not read bundled web-search skill asset'); const installed = await handleTool(process.cwd(), 'skill_install', { name: 'web-search', targetName: 'web-search-copy' }); if (!installed.installed || installed.path !== '.oases/skills/web-search-copy/SKILL.md') throw new Error('installed package could not install bundled web-search skill'); const installedAsset = await handleTool(process.cwd(), 'skill_asset_read', { path: '.oases/skills/web-search-copy/scripts/browser_search.py', maxChars: 2000 }); if (installedAsset.source !== 'workspace' || !String(installedAsset.content || '').includes('SOURCES')) throw new Error('installed bundled skill asset was not copied into the workspace');",
  ], installRoot);
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    "import { mkdir, writeFile } from 'node:fs/promises'; import { handleTool } from './node_modules/oases-ocli/src/tools.js'; await mkdir('.oases/plugins/demo/.claude-plugin', { recursive: true }); await mkdir('.oases/plugins/demo/commands', { recursive: true }); await mkdir('.oases/plugins/demo/agents', { recursive: true }); await mkdir('.oases/plugins/demo/skills/demo-skill/references', { recursive: true }); await mkdir('.oases/plugins/demo/scripts', { recursive: true }); await mkdir('.oases/plugins/demo/hooks', { recursive: true }); await mkdir('.oases/plugins/demo/hooks-handlers', { recursive: true }); await writeFile('.oases/plugins/demo/.claude-plugin/plugin.json', JSON.stringify({ name: 'demo-plugin', version: '1.0.0', description: 'demo plugin' }, null, 2)); await writeFile('.oases/plugins/demo/README.md', '# Demo\\n\\ninstalled package plugin marker\\n'); await writeFile('.oases/plugins/demo/commands/demo.md', '---\\ndescription: Demo command description\\n---\\n\\n# Demo command\\n\\ncommand body marker\\n'); await writeFile('.oases/plugins/demo/agents/demo-agent.md', '---\\nname: demo-agent\\ndescription: Demo agent description\\nagentType: explore\\ntools:\\n  - read_file\\ninitialPrompt: |\\n  package agent seed\\n---\\n\\n# Demo agent\\n\\nagent body marker\\n'); await writeFile('.oases/plugins/demo/skills/demo-skill/SKILL.md', '---\\nname: demo-skill\\ndescription: Demo skill description\\n---\\n\\n# Demo Skill\\n\\nskill body marker\\n'); await writeFile('.oases/plugins/demo/skills/demo-skill/references/ref.md', '# Ref\\n\\nasset reference marker\\n'); await writeFile('.oases/plugins/demo/scripts/check.sh', '#!/bin/sh\\nprintf \"asset script marker\\\\n\"\\n'); await writeFile('.oases/plugins/demo/hooks/hooks.json', JSON.stringify({ description: 'Demo hook config', hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py', timeout: 5 }] }] } }, null, 2)); await writeFile('.oases/plugins/demo/hooks/pretooluse.py', 'print(\"hook handler marker\")\\n'); await writeFile('.oases/plugins/demo/hooks-handlers/session-start.sh', '#!/bin/sh\\nprintf \"hook handler shell marker\\\\n\"\\n'); const listed = await handleTool(process.cwd(), 'plugin_list', { maxResults: 10 }); if (!listed.plugins?.some((plugin) => plugin.name === 'demo-plugin' && plugin.commands?.includes('.oases/plugins/demo/commands/demo.md') && plugin.agents?.includes('.oases/plugins/demo/agents/demo-agent.md') && plugin.skills?.includes('.oases/plugins/demo/skills/demo-skill/SKILL.md') && plugin.hooks?.includes('.oases/plugins/demo/hooks/hooks.json') && plugin.hooks?.includes('.oases/plugins/demo/hooks-handlers/session-start.sh'))) throw new Error('installed package could not list workspace plugins'); const read = await handleTool(process.cwd(), 'plugin_read', { name: 'demo-plugin' }); if (!String(read.readme || '').includes('installed package plugin marker')) throw new Error('installed package could not read workspace plugin README'); const hooks = await handleTool(process.cwd(), 'plugin_hook_list', { plugin: 'demo-plugin' }); if (!hooks.hooks?.some((hook) => hook.path === '.oases/plugins/demo/hooks/hooks.json' && hook.events?.includes('PreToolUse') && hook.commands?.some((command) => String(command).includes('pretooluse.py')))) throw new Error('installed package could not list plugin hooks'); const hook = await handleTool(process.cwd(), 'plugin_hook_read', { plugin: 'demo-plugin', name: 'hooks' }); if (!hook.hook?.events?.includes('PreToolUse') || !hook.events?.[0]?.matchers?.includes('Edit|Write')) throw new Error('installed package could not read plugin hook config'); const hookHandler = await handleTool(process.cwd(), 'plugin_hook_read', { path: '.oases/plugins/demo/hooks/pretooluse.py' }); if (!String(hookHandler.content || '').includes('hook handler marker')) throw new Error('installed package could not read plugin hook handler source'); const hookShell = await handleTool(process.cwd(), 'plugin_hook_read', { path: '.oases/plugins/demo/hooks-handlers/session-start.sh' }); if (!String(hookShell.content || '').includes('hook handler shell marker')) throw new Error('installed package could not read plugin hooks-handlers source'); const commands = await handleTool(process.cwd(), 'plugin_command_list', { plugin: 'demo-plugin' }); if (!commands.commands?.some((command) => command.name === 'demo' && command.title === 'Demo command' && command.description === 'Demo command description')) throw new Error('installed package could not list plugin commands'); const command = await handleTool(process.cwd(), 'plugin_command_read', { plugin: 'demo-plugin', name: 'demo' }); if (!String(command.body || '').includes('command body marker')) throw new Error('installed package could not read plugin command markdown'); const agents = await handleTool(process.cwd(), 'plugin_agent_list', { plugin: 'demo-plugin' }); if (!agents.agents?.some((agent) => agent.name === 'demo-agent' && agent.agentType === 'explore' && agent.tools?.includes('read_file'))) throw new Error('installed package could not list plugin agents'); const agent = await handleTool(process.cwd(), 'plugin_agent_read', { plugin: 'demo-plugin', name: 'demo-agent' }); if (!String(agent.prompt || '').includes('agent body marker') || agent.agent?.source !== 'plugin') throw new Error('installed package could not read plugin agent markdown'); const skills = await handleTool(process.cwd(), 'plugin_skill_list', { plugin: 'demo-plugin' }); if (!skills.skills?.some((skill) => skill.name === 'demo-skill' && skill.description === 'Demo skill description')) throw new Error('installed package could not list plugin skills'); const skill = await handleTool(process.cwd(), 'plugin_skill_read', { plugin: 'demo-plugin', name: 'demo-skill' }); if (!String(skill.content || '').includes('skill body marker') || skill.skill?.source !== 'plugin') throw new Error('installed package could not read plugin skill markdown'); const assets = await handleTool(process.cwd(), 'plugin_asset_list', { plugin: 'demo-plugin', assetPath: 'skills/demo-skill' }); if (!assets.assets?.some((asset) => asset.path === 'skills/demo-skill/references/ref.md')) throw new Error('installed package could not list plugin assets'); const asset = await handleTool(process.cwd(), 'plugin_asset_read', { plugin: 'demo-plugin', assetPath: 'skills/demo-skill/references/ref.md' }); if (!String(asset.content || '').includes('asset reference marker')) throw new Error('installed package could not read plugin asset reference'); const script = await handleTool(process.cwd(), 'plugin_asset_read', { path: '.oases/plugins/demo/scripts/check.sh' }); if (!String(script.content || '').includes('asset script marker')) throw new Error('installed package could not read plugin script asset');",
  ], installRoot);
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    `
import { mkdir, writeFile } from 'node:fs/promises';
import { handleTool } from './node_modules/oases-ocli/src/tools.js';
await mkdir('.oases/plugins/capability/.claude-plugin', { recursive: true });
await mkdir('.oases/plugins/capability/output-styles', { recursive: true });
await writeFile('.oases/plugins/capability/.claude-plugin/plugin.json', JSON.stringify({
  name: 'capability-plugin',
  version: '1.0.0',
  description: 'capability plugin',
  mcpServers: { docs: { command: 'node', args: ['server.js'], env: { DOCS_TOKEN: 'should-not-leak' } } },
  lspServers: { typescript: { command: 'typescript-language-server', args: ['--stdio'] } },
  settings: { model: 'oases-code', env: { OASES_API_KEY: 'should-not-leak' } },
  commandsPaths: ['./commands'],
  outputStylesPaths: ['./output-styles'],
  commandsMetadata: { capability: { description: 'Capability command', allowedTools: ['read_file'] } },
}, null, 2));
await writeFile('.oases/plugins/capability/output-styles/concise.md', '---\\ndescription: Concise package output\\n---\\n\\n# Concise\\n\\nKeep package output short.\\n');
await writeFile('.oases/plugins/capability/settings.json', JSON.stringify({ safeMode: true, apiToken: 'should-not-leak' }, null, 2));
const listed = await handleTool(process.cwd(), 'plugin_capability_list', { plugin: 'capability-plugin' });
const capability = listed.capabilities?.find((item) => item.plugin === 'capability-plugin');
if (!capability?.manifest?.mcpServerNames?.includes('docs')) throw new Error('installed package could not list plugin MCP capability');
if (!capability?.files?.outputStyles?.includes('.oases/plugins/capability/output-styles/concise.md')) throw new Error('installed package could not list plugin output styles capability');
const read = await handleTool(process.cwd(), 'plugin_capability_read', { plugin: 'capability-plugin' });
if (read.manifest?.mcpServers?.servers?.docs?.command !== 'node') throw new Error('installed package could not read plugin MCP capability');
if (read.manifest?.settings?.values?.env?.values?.OASES_API_KEY?.redacted !== true) throw new Error('installed package did not redact manifest setting key');
if (read.settingsFile?.settings?.values?.apiToken?.redacted !== true) throw new Error('installed package did not redact settings.json key');
if (JSON.stringify(read).includes('should-not-leak')) throw new Error('installed package leaked sensitive plugin settings');
const pluginStyles = await handleTool(process.cwd(), 'plugin_output_style_list', { plugin: 'capability-plugin' });
const pluginStyle = pluginStyles.outputStyles?.find((item) => item.name === 'concise');
if (pluginStyle?.description !== 'Concise package output') throw new Error('installed package could not list plugin output styles');
const pluginStyleRead = await handleTool(process.cwd(), 'plugin_output_style_read', { plugin: 'capability-plugin', name: 'concise' });
if (!String(pluginStyleRead.body || '').includes('Keep package output short.')) throw new Error('installed package could not read plugin output styles');
const installedStyle = await handleTool(process.cwd(), 'plugin_output_style_install', { plugin: 'capability-plugin', name: 'concise', targetName: 'concise-package' });
if (!installedStyle.installed || installedStyle.path !== '.oases/output-styles/concise-package.md') throw new Error('installed package could not install plugin output styles');
const workspaceStyles = await handleTool(process.cwd(), 'output_style_list', { maxResults: 20 });
if (!workspaceStyles.outputStyles?.some((item) => item.path === '.oases/output-styles/concise-package.md')) throw new Error('installed package could not list installed output styles');
const workspaceStyle = await handleTool(process.cwd(), 'output_style_read', { name: 'concise-package' });
if (!String(workspaceStyle.body || '').includes('Keep package output short.')) throw new Error('installed package could not read installed output styles');
await handleTool(process.cwd(), 'plugin_disable', { plugin: 'capability-plugin' });
const hidden = await handleTool(process.cwd(), 'plugin_capability_list', { maxResults: 20 });
if (hidden.capabilities?.some((item) => item.plugin === 'capability-plugin')) throw new Error('plugin_capability_list should hide disabled plugins by default');
const visible = await handleTool(process.cwd(), 'plugin_capability_list', { includeDisabled: true, maxResults: 20 });
if (!visible.capabilities?.some((item) => item.plugin === 'capability-plugin')) throw new Error('plugin_capability_list includeDisabled should include disabled plugins');
const hiddenStyles = await handleTool(process.cwd(), 'plugin_output_style_list', { maxResults: 20 });
if (hiddenStyles.outputStyles?.some((item) => item.plugin === 'capability-plugin')) throw new Error('plugin_output_style_list should hide disabled plugins by default');
const visibleStyles = await handleTool(process.cwd(), 'plugin_output_style_list', { includeDisabled: true, maxResults: 20 });
if (!visibleStyles.outputStyles?.some((item) => item.plugin === 'capability-plugin')) throw new Error('plugin_output_style_list includeDisabled should include disabled plugins');
let blocked = false;
try { await handleTool(process.cwd(), 'plugin_capability_read', { plugin: 'capability-plugin' }); } catch { blocked = true; }
if (!blocked) throw new Error('plugin_capability_read should hide disabled plugins by default');
let styleBlocked = false;
try { await handleTool(process.cwd(), 'plugin_output_style_read', { plugin: 'capability-plugin', name: 'concise' }); } catch { styleBlocked = true; }
if (!styleBlocked) throw new Error('plugin_output_style_read should hide disabled plugins by default');
`,
  ], installRoot);
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    "import { mkdir, writeFile } from 'node:fs/promises'; import { handleTool } from './node_modules/oases-ocli/src/tools.js'; await mkdir('plugin-sources/importable/.claude-plugin', { recursive: true }); await mkdir('plugin-sources/importable/commands', { recursive: true }); await mkdir('plugin-sources/importable/agents', { recursive: true }); await mkdir('plugin-sources/importable/scripts', { recursive: true }); await mkdir('plugin-sources/importable/hooks', { recursive: true }); await mkdir('plugin-sources/importable/skills/import-skill/references', { recursive: true }); await writeFile('plugin-sources/importable/.claude-plugin/plugin.json', JSON.stringify({ name: 'importable-plugin', version: '0.0.1', description: 'importable plugin' }, null, 2)); await writeFile('plugin-sources/importable/commands/import.md', '# Import\\n\\nimportable command marker\\n'); await writeFile('plugin-sources/importable/agents/import-agent.md', '---\\nname: import-agent\\ndescription: Import agent\\nagentType: explore\\ntools:\\n  - read_file\\n---\\n\\n# Import Agent\\n\\nimport agent marker\\n'); await writeFile('plugin-sources/importable/scripts/check.sh', '#!/bin/sh\\nprintf \"importable script marker\\\\n\"\\n'); await writeFile('plugin-sources/importable/hooks/hooks.json', JSON.stringify({ description: 'Import hook config', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 ${CLAUDE_PLUGIN_ROOT}/hooks/prompt.py' }] }] } }, null, 2)); await writeFile('plugin-sources/importable/hooks/prompt.py', 'print(\"import hook marker\")\\n'); await writeFile('plugin-sources/importable/skills/import-skill/SKILL.md', '---\\nname: import-skill\\ndescription: Import skill\\n---\\n\\n# Import Skill\\n\\nimport skill marker\\n'); await writeFile('plugin-sources/importable/skills/import-skill/references/ref.md', '# Ref\\n\\nimport skill asset marker\\n'); const installed = await handleTool(process.cwd(), 'plugin_install', { path: 'plugin-sources/importable', targetName: 'imported-package-plugin' }); if (!installed.installed || installed.path !== '.oases/plugins/imported-package-plugin/.claude-plugin/plugin.json') throw new Error('installed package could not install workspace plugin source'); const read = await handleTool(process.cwd(), 'plugin_read', { name: 'importable-plugin' }); if (read.plugin?.root !== '.oases/plugins/imported-package-plugin') throw new Error('installed package could not read installed plugin'); const asset = await handleTool(process.cwd(), 'plugin_asset_read', { plugin: 'importable-plugin', assetPath: 'scripts/check.sh' }); if (!String(asset.content || '').includes('importable script marker')) throw new Error('installed package could not copy plugin assets'); const installedHook = await handleTool(process.cwd(), 'plugin_hook_read', { plugin: 'importable-plugin', name: 'hooks' }); if (!installedHook.hook?.events?.includes('UserPromptSubmit')) throw new Error('installed package could not read installed plugin hook config'); const installedPluginCommand = await handleTool(process.cwd(), 'plugin_command_install', { plugin: 'importable-plugin', name: 'import', targetName: 'import-command-local' }); if (!installedPluginCommand.installed || installedPluginCommand.path !== '.oases/commands/import-command-local.md') throw new Error('installed package could not install plugin command'); const installedCommand = await handleTool(process.cwd(), 'command_read', { path: '.oases/commands/import-command-local.md', maxChars: 2000 }); if (!String(installedCommand.body || '').includes('importable command marker')) throw new Error('installed package plugin_command_install should create a readable workspace command'); const installedPluginAgent = await handleTool(process.cwd(), 'plugin_agent_install', { plugin: 'importable-plugin', name: 'import-agent', targetName: 'import-agent-local' }); if (!installedPluginAgent.installed || installedPluginAgent.path !== '.oases/agents/import-agent-local.md') throw new Error('installed package could not install plugin agent'); const installedPluginAgentRead = await handleTool(process.cwd(), 'agent_read', { path: '.oases/agents/import-agent-local.md', maxChars: 2000 }); if (!String(installedPluginAgentRead.prompt || '').includes('import agent marker')) throw new Error('installed package plugin_agent_install should create a readable workspace agent'); const installedPluginSkill = await handleTool(process.cwd(), 'plugin_skill_install', { plugin: 'importable-plugin', name: 'import-skill', targetName: 'import-skill-local' }); if (!installedPluginSkill.installed || installedPluginSkill.path !== '.oases/skills/import-skill-local/SKILL.md') throw new Error('installed package could not install plugin skill'); const installedPluginSkillAsset = await handleTool(process.cwd(), 'skill_asset_read', { path: '.oases/skills/import-skill-local/references/ref.md', maxChars: 2000 }); if (!String(installedPluginSkillAsset.content || '').includes('import skill asset marker')) throw new Error('installed package plugin_skill_install should copy skill assets'); const disabled = await handleTool(process.cwd(), 'plugin_disable', { name: 'importable-plugin' }); if (disabled.enabled !== false || disabled.plugin?.disabled !== true) throw new Error('installed package could not disable installed plugin'); const hiddenCommands = await handleTool(process.cwd(), 'plugin_command_list', { maxResults: 20 }); if (hiddenCommands.commands?.some((command) => command.plugin === 'importable-plugin')) throw new Error('installed package plugin_command_list should hide disabled plugins by default'); const visibleCommands = await handleTool(process.cwd(), 'plugin_command_list', { includeDisabled: true, maxResults: 20 }); if (!visibleCommands.commands?.some((command) => command.plugin === 'importable-plugin')) throw new Error('installed package plugin_command_list includeDisabled should include disabled plugins'); const hiddenHooks = await handleTool(process.cwd(), 'plugin_hook_list', { maxResults: 20 }); if (hiddenHooks.hooks?.some((hook) => hook.plugin === 'importable-plugin')) throw new Error('installed package plugin_hook_list should hide disabled plugins by default'); const visibleHooks = await handleTool(process.cwd(), 'plugin_hook_list', { includeDisabled: true, maxResults: 20 }); if (!visibleHooks.hooks?.some((hook) => hook.plugin === 'importable-plugin')) throw new Error('installed package plugin_hook_list includeDisabled should include disabled plugins'); const enabled = await handleTool(process.cwd(), 'plugin_enable', { name: 'importable-plugin' }); if (enabled.enabled !== true || enabled.plugin?.enabled !== true) throw new Error('installed package could not re-enable installed plugin'); let duplicateRejected = false; try { await handleTool(process.cwd(), 'plugin_install', { path: 'plugin-sources/importable', targetName: 'imported-package-plugin' }); } catch { duplicateRejected = true; } if (!duplicateRejected) throw new Error('installed package plugin_install should reject duplicate target'); await mkdir('.oases/plugins/not-a-plugin', { recursive: true }); await writeFile('.oases/plugins/not-a-plugin/README.md', '# Not a plugin\\n'); let nonPluginRejected = false; try { await handleTool(process.cwd(), 'plugin_remove', { path: '.oases/plugins/not-a-plugin' }); } catch { nonPluginRejected = true; } if (!nonPluginRejected) throw new Error('installed package plugin_remove should reject non-plugin directories'); const removed = await handleTool(process.cwd(), 'plugin_remove', { name: 'importable-plugin' }); if (!removed.removed || removed.path !== '.oases/plugins/imported-package-plugin') throw new Error('installed package could not remove installed plugin'); const listed = await handleTool(process.cwd(), 'plugin_list', { maxResults: 20 }); if (listed.plugins?.some((plugin) => plugin.root === '.oases/plugins/imported-package-plugin')) throw new Error('installed package plugin_remove should update plugin_list');",
  ], installRoot);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("ocli package smoke passed");
