import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractHtmlMetadata, fetchUrl } from "../src/network.js";
import { commandLooksDangerous } from "../src/process.js";
import { handleTool, isReadOnlyShellCommand } from "../src/tools.js";

const port = Number(process.env.OCLI_SMOKE_PORT || 8797);
const fakeApiPort = Number(process.env.OCLI_SMOKE_API_PORT || 8798);
const baseUrl = `http://127.0.0.1:${port}`;
const fakeApiBaseUrl = `http://127.0.0.1:${fakeApiPort}/v1`;
const smokeToken = "smoke-token";
const workspace = await mkdtemp(path.join(tmpdir(), "oases-ocli-smoke-"));
const outsideWorkspace = await mkdtemp(path.join(tmpdir(), "oases-ocli-outside-"));

const htmlMetadata = extractHtmlMetadata(
  "<!doctype html><html><head><title>Oil News Today | OilPrice.com</title></head><body><a href=\"/Latest-Energy-News/World-News/Page-2.html\">Next</a><a href=\"https://example.com/story\">Story</a></body></html>",
  "https://oilprice.com/Latest-Energy-News/World-News/",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(htmlMetadata.title === "Oil News Today | OilPrice.com", "extractHtmlMetadata should extract page title");
assert(htmlMetadata.links.some((link) => link.url === "https://oilprice.com/Latest-Energy-News/World-News/Page-2.html" && link.text === "Next"), "extractHtmlMetadata should resolve relative links");
assert(htmlMetadata.links.some((link) => link.url === "https://example.com/story" && link.text === "Story"), "extractHtmlMetadata should keep absolute links");

assert(commandLooksDangerous("rm -rf ."), "dangerous command detection should block workspace-wide forced removal");
assert(commandLooksDangerous("git reset --hard HEAD"), "dangerous command detection should block destructive git reset");
assert(commandLooksDangerous("git diff -- src; rm -rf ."), "dangerous command detection should inspect chained commands");
assert(!commandLooksDangerous("git status --short"), "dangerous command detection should allow harmless git status");
assert(isReadOnlyShellCommand("git diff -- src"), "read-only shell policy should allow simple git diff");
assert(!isReadOnlyShellCommand("git diff -- src; rm -rf ."), "read-only shell policy should reject chained commands");

let privateFetchBlocked = false;
try {
  await fetchUrl({ url: "http://127.0.0.1:1/", maxChars: 1000 });
} catch {
  privateFetchBlocked = true;
}
assert(privateFetchBlocked, "fetch_url should reject localhost/private network targets before connecting");

await writeFile(path.join(outsideWorkspace, "secret.txt"), "outside workspace", "utf8");
await symlink(outsideWorkspace, path.join(workspace, "outside-link"), "dir");
let symlinkEscapeBlocked = false;
try {
  await handleTool(workspace, "read_file", { path: "outside-link/secret.txt" });
} catch {
  symlinkEscapeBlocked = true;
}
assert(symlinkEscapeBlocked, "workspace path validation should reject symlink escapes outside the workspace");

function runLocal(command, args = [], cwd = workspace) {
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

async function request(pathname, options = {}) {
  const headers = { "X-Oases-Token": smokeToken, ...(options.headers || {}) };
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  const payload = await response.json().catch(() => undefined);
  return { response, payload };
}

async function waitForServer(child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`ocli exited early with code ${child.exitCode}`);
    try {
      const { response } = await request("/health");
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error("Timed out waiting for ocli server.");
}

async function readTextEventually(filePath) {
  const deadline = Date.now() + 3000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  throw lastError;
}

async function readJsonEventually(filePath, accept = () => true) {
  const deadline = Date.now() + 4000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(filePath, "utf8");
      if (text.trim()) {
        const parsed = JSON.parse(text);
        if (accept(parsed)) return parsed;
        lastError = new Error(`JSON in ${filePath} did not match expected state.`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw lastError;
}

async function waitForSessionDone(sessionId) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const current = await request(`/agent/sessions/${encodeURIComponent(sessionId)}`);
    const status = current.payload?.data?.status;
    if (["completed", "failed", "cancelled"].includes(status)) return current.payload;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Timed out waiting for agent session completion.");
}

async function waitForApproval(sessionId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await request(`/agent/sessions/${encodeURIComponent(sessionId)}`);
    const pending = Array.isArray(current.payload?.pendingApprovals)
      ? current.payload.pendingApprovals.find((item) => item?.approvalId && item?.status !== "approved" && item?.status !== "rejected")
      : undefined;
    if (pending?.approvalId) return pending;
    const event = Array.isArray(current.payload?.events)
      ? current.payload.events.find((item) => item?.type === "approval_required")
      : undefined;
    if (event?.approvalId) return event;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Timed out waiting for approval request.");
}

let longMaxTurnSmokeCount = 0;
let autoContinuationSmokeCount = 0;
let modelRetrySmokeCount = 0;
let modelRepairSmokeCount = 0;
let modelEffortRepairSmokeCount = 0;

const fakeApiServer = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const text = messages.map((message) => String(message.content || "")).join("\n");
    if (text.includes("kimi model profile smoke")) {
      if (body.model !== "kimi-k2.6" || body.temperature !== 1 || "effort" in body || "reasoning_effort" in body) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `unexpected Kimi request profile: ${JSON.stringify({ model: body.model, temperature: body.temperature, effort: body.effort, reasoning_effort: body.reasoning_effort })}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"kimi model profile smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("gpt model profile smoke")) {
      if (body.model !== "gpt-5.4" || body.temperature !== 1 || body.effort !== "high" || body.reasoning_effort !== "high") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `unexpected GPT request profile: ${JSON.stringify({ model: body.model, temperature: body.temperature, effort: body.effort, reasoning_effort: body.reasoning_effort })}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"gpt model profile smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("model retry smoke")) {
      modelRetrySmokeCount += 1;
      if (modelRetrySmokeCount === 1) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "transient model retry smoke outage" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"model retry smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("model repair smoke")) {
      modelRepairSmokeCount += 1;
      if (modelRepairSmokeCount === 1) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid temperature: only 1 is allowed for this model" } }));
        return;
      }
      if (body.temperature !== 1) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `temperature repair did not apply: ${String(body.temperature)}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"model repair smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("model effort repair smoke")) {
      modelEffortRepairSmokeCount += 1;
      if (modelEffortRepairSmokeCount === 1) {
        if (body.effort !== "high" || body.reasoning_effort !== "high") {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: `effort fields missing before repair: effort=${body.effort} reasoning_effort=${body.reasoning_effort}` } }));
          return;
        }
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unsupported parameter: reasoning_effort is not supported by this model" } }));
        return;
      }
      if ("effort" in body || "reasoning_effort" in body) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `effort repair did not remove fields: effort=${body.effort} reasoning_effort=${body.reasoning_effort}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"model effort repair smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("native tool call smoke") && !text.includes("工具执行结果")) {
      const writeFileTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "write_file")
        : undefined;
      if (!writeFileTool || body.tool_choice !== "auto" || writeFileTool.function?.parameters?.properties?.path?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "ocli agent request did not include native tool schemas" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_native_write","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"native/tool-call.txt\\",\\"content\\":\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"native streamed tool call ok\\"}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("subagent delegation smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agent_run" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_subagent","type":"function","function":{"name":"agent_run","arguments":"{\\"description\\":\\"delegation-check\\",\\"agentType\\":\\"explore\\",\\"task\\":\\"Read src/delegation-target.txt and report whether it contains the delegation target marker.\\",\\"contextFiles\\":[\\"src/delegation-target.txt\\"],\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("custom agent smoke") && !text.includes("limited custom agent smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_custom_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"reviewer\\",\\"task\\":\\"Review src/custom-agent-target.txt and report whether the custom reviewer marker was injected.\\",\\"contextFiles\\":[\\"src/custom-agent-target.txt\\"],\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto reviewer routing smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "auto-routed custom agent request did not include agent_run" } }));
        return;
      }
      if (!text.includes("<agent_context") || !text.includes("reviewer-check") || !text.includes("custom reviewer marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "auto routing did not inject the matching custom agent context" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_auto_routed_reviewer","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"reviewer\\",\\"description\\":\\"routed-reviewer\\",\\"task\\":\\"Review src/custom-agent-target.txt and report whether the custom reviewer marker was injected.\\",\\"contextFiles\\":[\\"src/custom-agent-target.txt\\"],\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("plugin agent delegation smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "plugin agent delegation request did not include agent_run" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_plugin_agent_direct","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"plugin-explorer\\",\\"description\\":\\"plugin-agent-direct\\",\\"task\\":\\"Run plugin agent direct check.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("limited custom agent smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema for limited agent" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_limited_custom_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"reader\\",\\"task\\":\\"Attempt restricted tool scope check for src/custom-agent-target.txt. First try write_file to restricted/should-not-write.txt, then report whether ocli blocked it.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("custom agent mcp allow smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema for MCP allow agent" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mcp_reader_custom_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"mcpreader\\",\\"task\\":\\"Run allowed MCP custom agent check.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("custom agent mcp deny smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema for MCP deny agent" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mcp_blocked_custom_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"mcpblocked\\",\\"task\\":\\"Run denied MCP custom agent check.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("custom agent skill preload smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema for skill preload agent" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_skilled_custom_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"skilled\\",\\"task\\":\\"Use the preloaded research skill and report the preload marker.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("custom agent command preload smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema for command preload agent" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_commanded_custom_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"commanded\\",\\"description\\":\\"commanded-check\\",\\"task\\":\\"Use the preloaded review-flow command and report the command context marker.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("custom agent initial prompt smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema for initial prompt agent" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_starter_custom_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"starter\\",\\"task\\":\\"Run starter custom agent initial prompt check.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("custom agent yaml frontmatter smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema for YAML frontmatter agent" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_yaml_frontmatter_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"yamlstarter\\",\\"task\\":\\"Run YAML frontmatter custom agent check.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("custom agent effort smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool || agentTool.function?.parameters?.properties?.agentName?.type !== "string") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include agentName schema for effort agent" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_effortful_agent","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"effortful\\",\\"task\\":\\"Run custom agent effort override check.\\",\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("worktree subagent smoke") && !text.includes("子代理任务：") && !text.includes("ocli 子代理已完成")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      const isolationSchema = agentTool?.function?.parameters?.properties?.isolation;
      if (!agentTool || !Array.isArray(isolationSchema?.enum) || !isolationSchema.enum.includes("worktree")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include worktree isolation schema" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_worktree_subagent","type":"function","function":{"name":"agent_run","arguments":"{\\"description\\":\\"worktree-check\\",\\"agentType\\":\\"general\\",\\"task\\":\\"Create isolated/worktree-output.txt with the text worktree isolated output, then report the file path.\\",\\"maxTurns\\":4,\\"isolation\\":\\"worktree\\"}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("background subagent smoke") && !text.includes("子代理任务：") && !text.includes("ocli 后台子代理已启动") && !text.includes("agent_status")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      const statusTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_status")
        : undefined;
      if (!agentTool || !statusTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "top-level ocli agent request did not include background agent tools" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_background_subagent","type":"function","function":{"name":"agent_run","arguments":"{\\"description\\":\\"background-check\\",\\"agentType\\":\\"explore\\",\\"task\\":\\"Read src/background-target.txt and report whether it contains the background marker.\\",\\"contextFiles\\":[\\"src/background-target.txt\\"],\\"maxTurns\\":3,\\"runInBackground\\":true}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Read src/background-target.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"background subagent found marker in src/background-target.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Create isolated/worktree-output.txt") && !text.includes("ocli 已写入 isolated/worktree-output.txt")) {
      const nestedAgentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (nestedAgentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "worktree sub-agent request should not include agent_run" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"isolated/worktree-output.txt\\",\\"content\\":\\"worktree isolated output\\\\n\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Create isolated/worktree-output.txt") && text.includes("ocli 已写入 isolated/worktree-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"worktree subagent wrote isolated/worktree-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 worktree-check") && text.includes("worktree subagent wrote isolated/worktree-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"worktree subagent smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 后台子代理已启动 background-check") && !text.includes("ocli 已查询后台子代理状态")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"agent_status\\",\\"arguments\\":{}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 已查询后台子代理状态") && text.includes("background subagent found marker")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"background subagent smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 已查询后台子代理状态") && text.includes('"status": "running"')) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"agent_status\\",\\"arguments\\":{}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Read src/delegation-target.txt") && !text.includes("ocli 已读取")) {
      const nestedAgentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (nestedAgentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "nested sub-agent request should not include agent_run" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"src/delegation-target.txt\\",\\"numbered\\":true}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Read src/delegation-target.txt") && text.includes("delegation target marker")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"subagent found delegation target marker in src/delegation-target.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Review src/custom-agent-target.txt")) {
      const nestedAgentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (nestedAgentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "custom sub-agent request should not include agent_run" } }));
        return;
      }
      if (!text.includes("custom reviewer marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "custom agent prompt was not injected into sub-agent request" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent used custom reviewer marker on src/custom-agent-target.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Run plugin agent direct check.")) {
      if (!text.includes("plugin direct agent marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "plugin agent prompt was not injected into sub-agent context" } }));
        return;
      }
      if (!text.includes("<skill_context") || !text.includes("plugin skill auto route marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "plugin agent skill preload did not load plugin skill context" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"plugin direct agent saw plugin direct marker and plugin skill context"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Attempt restricted tool scope check") && !text.includes("工具执行结果")) {
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((tool) => tool?.function?.name).filter(Boolean)
        : [];
      if (!toolNames.includes("read_file") || toolNames.includes("write_file") || toolNames.includes("run_command") || toolNames.includes("agent_run")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `limited custom agent tool schema was not scoped correctly: ${toolNames.join(",")}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"restricted/should-not-write.txt\\",\\"content\\":\\"this write should be blocked\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Attempt restricted tool scope check") && text.includes("Tool write_file is not allowed for this sub-agent.")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"limited custom agent blocked write_file as expected"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Attempt restricted tool scope check") && text.includes("ocli 已写入 restricted/should-not-write.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"limited custom agent write_file unexpectedly succeeded"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Run allowed MCP custom agent check.") && !text.includes("工具执行结果")) {
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((tool) => tool?.function?.name).filter(Boolean)
        : [];
      if (!toolNames.includes("mcp_call") || toolNames.includes("read_file") || toolNames.includes("write_file") || toolNames.includes("agent_run")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `MCP allow custom agent tool schema was not scoped correctly: ${toolNames.join(",")}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"mcp_call\\",\\"arguments\\":{\\"server\\":\\"docs\\",\\"tool\\":\\"search_docs\\",\\"arguments\\":{\\"query\\":\\"custom agent mcp allow smoke\\"}}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Run allowed MCP custom agent check.") && text.includes("docs result for")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent MCP allow marker observed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Run denied MCP custom agent check.") && !text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"mcp_call\\",\\"arguments\\":{\\"server\\":\\"docs\\",\\"tool\\":\\"search_docs\\",\\"arguments\\":{\\"query\\":\\"custom agent mcp deny smoke\\"}}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Run denied MCP custom agent check.") && text.includes("MCP tool docs/search_docs is not allowed for this sub-agent.")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent MCP deny marker observed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Use the preloaded research skill")) {
      const nestedSkillReadTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "skill_read")
        : undefined;
      if (nestedSkillReadTool && !text.includes("<skill_context")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "skilled custom agent should receive preloaded skill context before needing skill_read" } }));
        return;
      }
      if (!text.includes("<skill_context") || !text.includes("Research Skill") || !text.includes("skill preload marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "custom agent skill context was not preloaded into sub-agent request" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent skill preload marker observed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Use the preloaded review-flow command")) {
      const nestedCommandReadTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "command_read")
        : undefined;
      if (nestedCommandReadTool && !text.includes("<command_context")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "commanded custom agent should receive preloaded command context before needing command_read" } }));
        return;
      }
      if (!text.includes("<command_context") || !text.includes("Review Flow") || !text.includes("command context marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "custom agent command context was not preloaded into sub-agent request" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent command preload marker observed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Run starter custom agent initial prompt check.")) {
      if (!text.includes("initial prompt marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "custom agent initialPrompt was not prepended to sub-agent first user turn" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent initial prompt marker observed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Run YAML frontmatter custom agent check.")) {
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((tool) => tool?.function?.name).filter(Boolean)
        : [];
      if (!toolNames.includes("read_file") || toolNames.includes("write_file")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `YAML frontmatter tool list was not scoped correctly: ${toolNames.join(",")}` } }));
        return;
      }
      if (!text.includes("<skill_context") || !text.includes("Research Skill")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "YAML frontmatter skills list was not preloaded" } }));
        return;
      }
      if (!text.includes("yaml block prompt marker") || !text.includes("second seeded line")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "YAML block scalar initialPrompt was not prepended" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent YAML frontmatter marker observed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Run custom agent effort override check.")) {
      if (body.effort !== "low" || body.reasoning_effort !== "low") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `custom agent effort was not applied to sub-agent request: effort=${body.effort} reasoning_effort=${body.reasoning_effort}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent effort override observed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto reviewer routing smoke") && text.includes("ocli 子代理已完成 routed-reviewer") && text.includes("custom agent used custom reviewer marker")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"auto agent routing smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("plugin agent delegation smoke") && text.includes("ocli 子代理已完成 plugin-agent-direct") && text.includes("plugin direct agent saw plugin direct marker")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"plugin agent delegation smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 reviewer-check") && text.includes("custom agent used custom reviewer marker")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 skilled-check") && text.includes("custom agent skill preload marker observed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent skill preload smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 commanded-check") && text.includes("custom agent command preload marker observed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent command preload smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 starter-check") && text.includes("custom agent initial prompt marker observed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent initial prompt smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 yamlstarter-check") && text.includes("custom agent YAML frontmatter marker observed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent yaml frontmatter smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 effort-check") && text.includes("custom agent effort override observed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent effort smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 reader-check") && text.includes("limited custom agent blocked write_file")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"limited custom agent smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 mcp-reader-check") && text.includes("custom agent MCP allow marker observed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent mcp allow smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 mcp-blocked-check") && text.includes("custom agent MCP deny marker observed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"custom agent mcp deny smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 delegation-check") && text.includes("subagent found delegation target marker")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"subagent delegation smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("native/tool-call.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"native tool call smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("repeat approval smoke") && !text.includes("repeat approved smoke ok")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"run_python\\",\\"arguments\\":{\\"script\\":\\"open(\\\\\\"repeat-approval-smoke.txt\\\\\\", \\\\\\"w\\\\\\").write(\\\\\\"ok\\\\\\")\\\\nprint(\\\\\\"repeat approved smoke ok\\\\\\")\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("repeat approval second ok") || (text.match(/repeat approved smoke ok/g) || []).length >= 2) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"repeat approval smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("repeat approved smoke ok") && !text.includes("repeat approval second ok")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"run_python\\",\\"arguments\\":{\\"script\\":\\"open(\\\\\\"repeat-approval-smoke.txt\\\\\\", \\\\\\"w\\\\\\").write(\\\\\\"ok\\\\\\")\\\\nprint(\\\\\\"repeat approved smoke ok\\\\\\")\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("approval smoke") && !text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"run_python\\",\\"arguments\\":{\\"script\\":\\"open(\\\\\\"approval-smoke.txt\\\\\\", \\\\\\"w\\\\\\").write(\\\\\\"ok\\\\\\")\\\\nprint(\\\\\\"approved smoke ok\\\\\\")\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("readonly command smoke") && !text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"run_command\\",\\"arguments\\":{\\"command\\":\\"find . -maxdepth 1 -type f\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("readonly command smoke") && text.includes("ocli 已运行 find")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"readonly command smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("approved smoke ok")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"approval smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("empty upstream error smoke")) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("");
      return;
    }
    if (text.includes("vercel protection smoke")) {
      response.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><title>Authentication Required</title><body><h1>Note to agents accessing this page:</h1><p>This page requires Vercel authentication.</p></body></html>");
      return;
    }
    if (text.includes("delayed run check") && !text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"src/adaptive-trigger.txt\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("delayed run check") && text.includes("adaptive-trigger.txt") && !text.includes("auto/adaptive-routing-output.txt")) {
      if (!text.includes("<skill_context") || !text.includes("Research Skill")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "adaptive routing did not inject the research skill context after tool output" } }));
        return;
      }
      if (!text.includes("<memory_context") || !text.includes("late policy memory marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "adaptive routing did not inject the late-policy memory context after tool output" } }));
        return;
      }
      if (!text.includes("<mcp_result_context") || !text.includes("docs result for")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "adaptive routing did not auto-call matching MCP after tool output" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"auto/adaptive-routing-output.txt\\",\\"content\\":\\"adaptive routing loaded late skill memory and mcp\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto/adaptive-routing-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"adaptive capability routing smoke completed\\n\\n生成文件：auto/adaptive-routing-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings capability routing smoke")) {
      if (text.includes("<skill_context") || text.includes("Research Skill")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "settings capability routing policy should have limited skill selection" } }));
        return;
      }
      if (text.includes("<command_context") || text.includes("<mcp_context") || text.includes("<mcp_result_context")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "settings capability routing policy should have disabled command and MCP context" } }));
        return;
      }
      if (!text.includes("<memory_context") || !text.includes("ocli smoke tests")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "settings capability routing policy should still allow one matching memory" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"settings capability routing smoke completed\\n\\npolicy limited skill command and MCP routing while preserving memory RAG"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto capability routing smoke") && !text.includes("auto-routing-output.txt")) {
      if (!text.includes("<skill_context") || !text.includes("Research Skill")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "auto routing did not inject the matching skill context" } }));
        return;
      }
      if (!text.includes("<command_context") || !text.includes("command context marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "auto routing did not inject the matching command context" } }));
        return;
      }
      if (!text.includes("<memory_context") || !text.includes("ocli smoke tests")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "auto routing did not inject the matching memory context" } }));
        return;
      }
      if (!text.includes("<mcp_context") || !text.includes("search_docs")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "auto routing did not inject MCP capability context" } }));
        return;
      }
      if (!text.includes("<mcp_result_context") || !text.includes("docs result for")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "auto routing did not auto-call the matching read-only MCP tool" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"auto/auto-routing-output.txt\\",\\"content\\":\\"auto capability routing smoke used skill command memory mcp context and mcp result\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("plugin capability routing smoke") && !text.includes("plugin-routing-output.txt")) {
      if (!text.includes("<skill_context") || !text.includes("Plugin Route Skill") || !text.includes("source=\"plugin\"")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "plugin auto routing did not inject plugin skill context" } }));
        return;
      }
      if (!text.includes("<command_context") || !text.includes("plugin route command marker") || !text.includes("plugin=\"route-pack\"")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "plugin auto routing did not inject plugin command context" } }));
        return;
      }
      if (!text.includes("<agent_context") || !text.includes("plugin route agent marker") || !text.includes("source=\"plugin\"")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "plugin auto routing did not inject plugin agent context" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"auto/plugin-routing-output.txt\\",\\"content\\":\\"plugin capability routing smoke used plugin skill command agent contexts\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("plugin-routing-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"plugin capability routing smoke completed\\n\\n生成文件：auto/plugin-routing-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto-routing-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"auto capability routing smoke completed\\n\\n生成文件：auto/auto-routing-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("请从这个 ocli 本地工程会话继续处理") && text.includes("failed recovery smoke")) {
      if (
        !text.includes("<original_session_request>")
        || !text.includes("<session_resume_context>")
        || !text.includes('"sourceError"')
        || !text.includes("recoverable model outage for failed recovery smoke")
        || !text.includes("上次错误：")
      ) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "failed recovery resume lost source error or original request context" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"failed recovery resume completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("failed recovery smoke")) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "recoverable model outage for failed recovery smoke" } }));
      return;
    }
    if (text.includes("请从这个 ocli 本地工程会话继续处理") && text.includes("context compaction mcp evidence smoke completed")) {
      const resumeStart = text.indexOf("<session_resume_context>");
      const resumeEnd = text.indexOf("</session_resume_context>");
      const snapshotStart = text.indexOf("<context_state_snapshot>");
      const snapshotEnd = text.indexOf("</context_state_snapshot>");
      const resumeContext = resumeStart >= 0 && resumeEnd > resumeStart
        ? text.slice(resumeStart, resumeEnd)
        : snapshotStart >= 0 && snapshotEnd > snapshotStart ? text.slice(snapshotStart, snapshotEnd) : "";
      if (
        !resumeContext.includes('"autoMemoryResults"')
        || !resumeContext.includes('"name": "testing-policy"')
        || !resumeContext.includes("ocli smoke tests")
        || !resumeContext.includes('"autoMcpResults"')
        || !resumeContext.includes('"server": "docs"')
        || !resumeContext.includes('"tool": "search_docs"')
        || !resumeContext.includes('"routingDiagnostics"')
        || !resumeContext.includes('"categories"')
        || !resumeContext.includes('"contextCompactions"')
        || !resumeContext.includes('"stateSnapshot": true')
      ) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `resume structured context smoke did not preserve prior evidence: ${resumeContext.slice(0, 1800)}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"resume structured context smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("请从这个 ocli 本地工程会话继续处理") && text.includes("ocli persistence smoke completed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"resume endpoint smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("recursive resume snapshot smoke")) {
      const snapshotStart = text.indexOf("<context_state_snapshot>");
      const snapshotEnd = text.indexOf("</context_state_snapshot>");
      const snapshot = snapshotStart >= 0 && snapshotEnd > snapshotStart ? text.slice(snapshotStart, snapshotEnd) : "";
      if (
        !text.includes("<context_compaction")
        || !snapshot.includes('"sessionResumeContext"')
        || !snapshot.includes('"sourceSessionId": "sess_recursive_source"')
        || !snapshot.includes('"autoMemoryResults"')
        || !snapshot.includes('"name": "testing-policy"')
        || !snapshot.includes("ocli smoke tests")
        || !snapshot.includes('"autoMcpResults"')
        || !snapshot.includes('"server": "docs"')
        || !snapshot.includes('"tool": "search_docs"')
        || !snapshot.includes('"routingDiagnostics"')
        || !snapshot.includes('"categories"')
        || !snapshot.includes('"contextCompactions"')
        || !snapshot.includes('"stateSnapshot": true')
      ) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `recursive resume snapshot smoke lost nested resume evidence: ${snapshot.slice(0, 1800)}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"recursive resume context compaction smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("agent framework routing smoke") && !text.includes("framework-routing-output.txt")) {
      if (!text.includes("<agent_framework_context") || !text.includes("framework routing marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "agent framework routing did not inject framework context" } }));
        return;
      }
      if (!text.includes("<skill_context") || !text.includes("Research Skill")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "agent framework routing did not preload framework skill dependencies" } }));
        return;
      }
      if (!text.includes("<memory_context") || !text.includes("ocli smoke tests")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "agent framework routing did not preload framework memory dependencies" } }));
        return;
      }
      if (!text.includes("<agent_context") || !text.includes("custom reviewer marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "agent framework routing did not preload framework agent dependencies" } }));
        return;
      }
      if (!text.includes("<mcp_context") || !text.includes("search_docs") || !text.includes("docs://routing-guide")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "agent framework routing did not preload framework MCP dependencies" } }));
        return;
      }
      if (!text.includes("<framework_execution_blueprint>") || !text.includes("orchestrator -> reviewer") || !text.includes("final response cites generated artifact path")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "agent framework routing did not inject framework execution blueprint" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"auto/framework-routing-output.txt\\",\\"content\\":\\"agent framework routing smoke used framework skill memory agent mcp resource contexts\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("<framework_blueprint_guard>") && text.includes("agent framework routing smoke") && !text.includes("ocli 子代理已完成 framework-reviewer")) {
      const agentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (!agentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "framework blueprint guard request did not include agent_run" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_framework_reviewer","type":"function","function":{"name":"agent_run","arguments":"{\\"agentName\\":\\"reviewer\\",\\"description\\":\\"framework-reviewer\\",\\"task\\":\\"Review auto/framework-routing-output.txt and report whether the generated artifact path satisfies the research-stack framework verification gates.\\",\\"contextFiles\\":[\\"auto/framework-routing-output.txt\\"],\\"maxTurns\\":4}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：按 Framework research-stack 的蓝图检查当前实现")) {
      const nestedAgentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (nestedAgentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "automatic framework reviewer sub-agent request should not include agent_run" } }));
        return;
      }
      if (!text.includes("custom reviewer marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "automatic framework reviewer custom agent prompt was not injected" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"framework reviewer confirmed generated artifact path and verification gates for auto/framework-routing-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("子代理任务：Review auto/framework-routing-output.txt")) {
      const nestedAgentTool = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool?.type === "function" && tool?.function?.name === "agent_run")
        : undefined;
      if (nestedAgentTool) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "framework reviewer sub-agent request should not include agent_run" } }));
        return;
      }
      if (!text.includes("custom reviewer marker")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "framework reviewer custom agent prompt was not injected" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"framework reviewer confirmed generated artifact path and verification gates for auto/framework-routing-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 子代理已完成 framework-reviewer") && text.includes("framework reviewer confirmed generated artifact path")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"agent framework routing smoke completed\\n\\nreviewer handoff satisfied; verification gate cites generated artifact path auto/framework-routing-output.txt\\n\\n生成文件：auto/framework-routing-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("framework-routing-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"agent framework routing smoke completed\\n\\n生成文件：auto/framework-routing-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("skill guided smoke") && !text.includes("ocli 已列出工作区技能")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"skill_list\\",\\"arguments\\":{\\"maxResults\\":10}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("skill guided smoke") && text.includes("ocli 已列出工作区技能") && !text.includes("ocli 已读取技能")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"skill_read\\",\\"arguments\\":{\\"name\\":\\"research\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("skill guided smoke") && text.includes("<skill_context") && !text.includes("skill-guided-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"research/skill-guided-output.txt\\",\\"content\\":\\"skill guided smoke used research skill\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("skill-guided-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"skill guided smoke completed\\n\\n生成文件：research/skill-guided-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("command guided smoke") && !text.includes("ocli 已列出工作区命令")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"command_list\\",\\"arguments\\":{\\"maxResults\\":10}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("command guided smoke") && text.includes("ocli 已列出工作区命令") && !text.includes("ocli 已读取工作区命令")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"command_read\\",\\"arguments\\":{\\"name\\":\\"review-flow\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("command guided smoke") && text.includes("<command_context") && text.includes("command context marker") && !text.includes("command-guided-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"commands/command-guided-output.txt\\",\\"content\\":\\"command guided smoke used command context marker\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("command-guided-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"command guided smoke completed\\n\\n生成文件：commands/command-guided-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("preloaded command smoke") && text.includes("<command_context") && text.includes("preloaded command marker") && !text.includes("preloaded-command-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"commands/preloaded-command-output.txt\\",\\"content\\":\\"preloaded command smoke used command context marker\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("preloaded-command-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"preloaded command smoke completed\\n\\n生成文件：commands/preloaded-command-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto memory suggestion smoke") && !text.includes("auto-memory-suggestion-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"memory/auto-memory-suggestion-output.txt\\",\\"content\\":\\"auto memory suggestion smoke wrote an artifact\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto memory clean request smoke") && !text.includes("auto-memory-clean-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"memory/auto-memory-clean-output.txt\\",\\"content\\":\\"auto memory clean request smoke wrote an artifact\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto memory open todo smoke") && !text.includes("open-memory-follow-up")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"todo_write\\",\\"arguments\\":{\\"todos\\":[{\\"id\\":\\"open-memory-follow-up\\",\\"text\\":\\"open-memory-follow-up\\",\\"status\\":\\"doing\\"}]}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto memory open todo smoke") && text.includes("open-memory-follow-up")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"auto memory open todo smoke still has unfinished work."}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto-memory-clean-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"auto memory clean request smoke completed\\n\\n生成文件：memory/auto-memory-clean-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto-memory-suggestion-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"auto memory suggestion smoke completed\\n\\n生成文件：memory/auto-memory-suggestion-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto memory write smoke") && !text.includes("auto-memory-write-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"memory/auto-memory-write-output.txt\\",\\"content\\":\\"auto memory write smoke wrote an artifact\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto-memory-write-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"auto memory write smoke completed\\n\\n生成文件：memory/auto-memory-write-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("output style guided smoke") && !text.includes("ocli 已列出输出风格")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"output_style_list\\",\\"arguments\\":{\\"maxResults\\":10}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("output style guided smoke") && text.includes("ocli 已列出输出风格") && !text.includes("ocli 已读取输出风格")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"output_style_read\\",\\"arguments\\":{\\"name\\":\\"concise-local\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("output style guided smoke") && text.includes("<output_style_context") && text.includes("Keep output short.") && !text.includes("style-guided-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"styles/style-guided-output.txt\\",\\"content\\":\\"output style guided smoke used concise style\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("style-guided-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"output style guided smoke completed\\n\\n生成文件：styles/style-guided-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings output style smoke") && text.includes("<output_style_context") && text.includes("Keep output short.") && !text.includes("settings-style-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"styles/settings-style-output.txt\\",\\"content\\":\\"settings output style smoke used settings concise style\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings-style-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"settings output style smoke completed\\n\\n生成文件：styles/settings-style-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("memory guided smoke") && !text.includes("ocli 已读取项目记忆")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"memory_read\\",\\"arguments\\":{\\"name\\":\\"testing-policy\\",\\"scope\\":\\"project\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("memory guided smoke") && text.includes("<memory_context") && text.includes("ocli smoke tests") && !text.includes("memory-guided-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"memory/memory-guided-output.txt\\",\\"content\\":\\"memory guided smoke used testing policy memory\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("memory-guided-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"memory guided smoke completed\\n\\n生成文件：memory/memory-guided-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("preloaded memory smoke") && text.includes("<memory_context") && text.includes("preloaded memory marker") && !text.includes("preloaded-memory-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"memory/preloaded-memory-output.txt\\",\\"content\\":\\"preloaded memory smoke used memory context marker\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("preloaded-memory-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"preloaded memory smoke completed\\n\\n生成文件：memory/preloaded-memory-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings permissions deny smoke") && !text.includes("denied-by-settings.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"denied-by-settings.txt\\",\\"content\\":\\"this should not be written\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings permissions deny smoke") && text.includes("denied by .oases/settings.json permissions.deny")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"settings permissions deny smoke completed\\n\\nocli correctly blocked denied-by-settings.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings permissions ask smoke") && !text.includes("ask-by-settings.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"ask-by-settings.txt\\",\\"content\\":\\"approved settings ask write\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings permissions ask smoke") && text.includes("ocli 已写入 ask-by-settings.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"settings permissions ask smoke completed\\n\\nocli approved ask-by-settings.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings permissions allow smoke") && !text.includes("ocli 已运行 find")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"run_command\\",\\"arguments\\":{\\"command\\":\\"find . -maxdepth 1 -type f\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings permissions allow smoke") && text.includes("ocli 已运行 find")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"settings permissions allow smoke completed\\n\\nocli allowed configured read-only command"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings defaultMode plan smoke") && !text.includes("plan-mode-blocked.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"plan-mode-blocked.txt\\",\\"content\\":\\"this should not be written in plan mode\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings defaultMode plan smoke") && text.includes("defaultMode=plan")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"settings defaultMode plan smoke completed\\n\\nocli blocked write_file in plan mode"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings defaultMode dontAsk smoke") && !text.includes("defaultMode=dontAsk")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"run_command\\",\\"arguments\\":{\\"command\\":\\"find . -maxdepth 1 -type f\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("settings defaultMode dontAsk smoke") && text.includes("defaultMode=dontAsk")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"settings defaultMode dontAsk smoke completed\\n\\nocli denied approval-required command without prompting"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("auto continuation smoke")) {
      const completedTurns = autoContinuationSmokeCount;
      if (completedTurns < 10) {
        autoContinuationSmokeCount += 1;
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        response.end([
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_auto_${completedTurns}","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"auto/step-${completedTurns}.txt\\",\\"content\\":\\"auto continuation smoke step ${completedTurns}\\"}"}}]}}]}`,
          "data: [DONE]",
          "",
        ].join("\n\n"));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"auto continuation smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("unfinished continuation smoke") && !text.includes("ocli 自动续跑") && !text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"我会现在创建文件 generated/unfinished-output.txt"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("unfinished continuation smoke") && text.includes("ocli 自动续跑") && !text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"generated/unfinished-output.txt\\",\\"content\\":\\"unfinished continuation smoke ok\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("unfinished-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"unfinished continuation smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("completion guard todo smoke") && !text.includes("ocli 自动续跑") && !text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"任务未完成，剩余 todo：完成验证和收尾。"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("completion guard todo smoke") && text.includes("续跑原因：open_todo") && !text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"guard/todo-output.txt\\",\\"content\\":\\"completion guard todo smoke ok\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("guard/todo-output.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"completion guard todo smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("post tool continuation smoke") && !text.includes("post-tool-output.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"我会写入文件，之后还需要运行验证。\\n<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"guard/post-tool-output.txt\\",\\"content\\":\\"post tool continuation file\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("post-tool-output.txt") && text.includes("工具执行结果") && !text.includes("续跑原因：promised_follow_up")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"post tool continuation smoke stopped too early"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("post-tool-output.txt") && text.includes("续跑原因：promised_follow_up") && !text.includes("post-tool-verified.txt")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"guard/post-tool-verified.txt\\",\\"content\\":\\"post tool continuation verified\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("post-tool-verified.txt") && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"post tool continuation smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("persistent todo restore smoke") && text.includes("persisted follow-up") && text.includes('"status": "done"') && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"persistent todo restore smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("persistent todo restore smoke") && text.includes("续跑原因：open_todo_state")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"todo_write\\",\\"arguments\\":{\\"todos\\":[{\\"text\\":\\"persisted follow-up\\",\\"status\\":\\"done\\"}]}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("persistent todo restore smoke")) {
      if (!text.includes("<todo_state_context>") || !text.includes("persisted follow-up")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "persistent todo restore smoke request did not include restored todo context" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"persistent todo restore smoke completed too early"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("todo state guard smoke") && text.includes("state guard follow-up") && text.includes('"status": "done"') && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"todo state guard smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("todo state guard smoke") && text.includes("续跑原因：open_todo_state")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"todo_write\\",\\"arguments\\":{\\"todos\\":[{\\"text\\":\\"state guard follow-up\\",\\"status\\":\\"done\\"}]}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("todo state guard smoke") && text.includes("ocli 已更新任务计划") && !text.includes("续跑原因：open_todo_state")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"todo state guard smoke completed too early"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("todo state guard smoke")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"todo_write\\",\\"arguments\\":{\\"todos\\":[{\\"text\\":\\"state guard follow-up\\",\\"status\\":\\"doing\\"}]}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("context compaction adaptive tail smoke")) {
      const retainedMatch = text.match(/<context_compaction\b[^>]*requestedRetainedMessages="(\d+)"[^>]*retainedMessages="(\d+)"/);
      const requestedRetained = Number(retainedMatch?.[1]);
      const retained = Number(retainedMatch?.[2]);
      if (!text.includes("<context_compaction") || requestedRetained !== 8 || !(retained > 0 && retained < requestedRetained)) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `adaptive tail compaction smoke did not shrink retained tail: ${JSON.stringify({ requestedRetained, retained, excerpt: text.slice(text.indexOf("<context_compaction"), text.indexOf("</context_compaction>") + "</context_compaction>".length).slice(0, 900) })}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"context compaction adaptive tail smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("context compaction todo state smoke") && text.includes("compaction restored todo") && text.includes('"status": "done"') && text.includes("工具执行结果")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"context compaction todo state smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("context compaction todo state smoke") && text.includes("续跑原因：open_todo_state")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"todo_write\\",\\"arguments\\":{\\"todos\\":[{\\"text\\":\\"compaction restored todo\\",\\"status\\":\\"done\\"}]}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("context compaction todo state smoke")) {
      const snapshotStart = text.indexOf("<context_state_snapshot>");
      const snapshotEnd = text.indexOf("</context_state_snapshot>");
      const snapshot = snapshotStart >= 0 && snapshotEnd > snapshotStart ? text.slice(snapshotStart, snapshotEnd) : "";
      if (!text.includes("<context_compaction") || !snapshot.includes('"openTodos"') || !snapshot.includes("compaction restored todo") || !snapshot.includes('"status": "doing"')) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `context compaction todo state smoke did not preserve open todos: ${snapshot.slice(0, 1200)}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"context compaction todo state smoke completed too early"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("请从这个 ocli 本地工程会话继续处理") && text.includes("context compaction mcp evidence smoke completed")) {
      const resumeStart = text.indexOf("<session_resume_context>");
      const resumeEnd = text.indexOf("</session_resume_context>");
      const snapshotStart = text.indexOf("<context_state_snapshot>");
      const snapshotEnd = text.indexOf("</context_state_snapshot>");
      const resumeContext = resumeStart >= 0 && resumeEnd > resumeStart
        ? text.slice(resumeStart, resumeEnd)
        : snapshotStart >= 0 && snapshotEnd > snapshotStart ? text.slice(snapshotStart, snapshotEnd) : "";
      if (
        !resumeContext.includes('"autoMemoryResults"')
        || !resumeContext.includes('"name": "testing-policy"')
        || !resumeContext.includes("ocli smoke tests")
        || !resumeContext.includes('"autoMcpResults"')
        || !resumeContext.includes('"server": "docs"')
        || !resumeContext.includes('"tool": "search_docs"')
        || !resumeContext.includes('"routingDiagnostics"')
        || !resumeContext.includes('"categories"')
        || !resumeContext.includes('"contextCompactions"')
        || !resumeContext.includes('"stateSnapshot": true')
      ) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `resume structured context smoke did not preserve prior evidence: ${resumeContext.slice(0, 1800)}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"resume structured context smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("context compaction smoke")) {
      if (!text.includes("<context_compaction") || !text.includes("compaction-history-marker-0")) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "context compaction smoke request did not include compacted history summary" } }));
        return;
      }
      const expectsMcpSnapshot = text.includes("context compaction smoke with mcp evidence");
      const hasStateSnapshot = text.includes("<context_state_snapshot>");
      const hasCurrentTask = expectsMcpSnapshot
        ? text.includes('"currentTask": "context compaction smoke with mcp evidence: use docs MCP search_docs capability and testing-policy memory."')
        : text.includes('"currentTask": "context compaction smoke"');
      const hasActiveCapabilities = text.includes('"activeCapabilities"');
      if (!hasStateSnapshot || !hasCurrentTask || !hasActiveCapabilities) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `context compaction smoke request did not include resumable state snapshot: ${JSON.stringify({ hasStateSnapshot, hasCurrentTask, hasActiveCapabilities, excerpt: text.slice(text.indexOf("<context_compaction"), text.indexOf("</context_compaction>") + "</context_compaction>".length).slice(0, 900) })}` } }));
        return;
      }
      if (expectsMcpSnapshot && (!text.includes('"autoMcpResults"') || !text.includes('"server": "docs"') || !text.includes('"tool": "search_docs"') || !text.includes("docs result for"))) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `context compaction smoke request did not preserve auto MCP result evidence: ${text.slice(text.indexOf("<context_state_snapshot>"), text.indexOf("</context_state_snapshot>") + "</context_state_snapshot>".length).slice(0, 1200)}` } }));
        return;
      }
      if (expectsMcpSnapshot && (!text.includes('"autoMemoryResults"') || !text.includes('"name": "testing-policy"') || !text.includes("ocli smoke tests"))) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `context compaction smoke request did not preserve auto memory RAG evidence: ${text.slice(text.indexOf("<context_state_snapshot>"), text.indexOf("</context_state_snapshot>") + "</context_state_snapshot>".length).slice(0, 1200)}` } }));
        return;
      }
      if (expectsMcpSnapshot && (!text.includes('"routingDiagnostics"') || !text.includes('"queryTerms"') || !text.includes('"mcpTools"'))) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `context compaction smoke request did not preserve routing diagnostics: ${text.slice(text.indexOf("<context_state_snapshot>"), text.indexOf("</context_state_snapshot>") + "</context_state_snapshot>".length).slice(0, 1200)}` } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        expectsMcpSnapshot
          ? 'data: {"choices":[{"delta":{"content":"context compaction mcp evidence smoke completed"}}]}'
          : 'data: {"choices":[{"delta":{"content":"context compaction smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("crawler artifact smoke") && !text.includes("Fetch source page")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"todo_write\\",\\"arguments\\":{\\"todos\\":[{\\"text\\":\\"Fetch source page\\",\\"status\\":\\"doing\\"},{\\"text\\":\\"Write crawler code\\",\\"status\\":\\"todo\\"},{\\"text\\":\\"Export dataset\\",\\"status\\":\\"todo\\"}]}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("Fetch source page") && !text.includes("ocli 已抓取")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"fetch_url\\",\\"arguments\\":{\\"url\\":\\"https://example.com/\\",\\"maxChars\\":4000}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 已抓取") && !text.includes("crawler/oilprice_crawler.py")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"crawler/oilprice_crawler.py\\",\\"content\\":\\"from pathlib import Path\\\\nimport json\\\\n\\\\nNEWS = [{\\\\\\"title\\\\\\": \\\\\\"Example energy news\\\\\\", \\\\\\"url\\\\\\": \\\\\\"https://example.com/\\\\\\", \\\\\\"published_date\\\\\\": \\\\\\"2026-06-01\\\\\\"}]\\\\nPath(\\\\\\"data\\\\\\").mkdir(exist_ok=True)\\\\nPath(\\\\\\"data/oilprice_news_sample.json\\\\\\").write_text(json.dumps(NEWS, ensure_ascii=False, indent=2), encoding=\\\\\\"utf8\\\\\\")\\\\n\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("crawler/oilprice_crawler.py") && !text.includes("ocli 已写入 data/oilprice_news_sample.json")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"data/oilprice_news_sample.json\\",\\"content\\":\\"[{\\\\\\"title\\\\\\":\\\\\\"Example energy news\\\\\\",\\\\\\"url\\\\\\":\\\\\\"https://example.com/\\\\\\",\\\\\\"published_date\\\\\\":\\\\\\"2026-06-01\\\\\\"}]\\\\n\\"}}</tool>"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("ocli 已写入 data/oilprice_news_sample.json")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"crawler artifact smoke completed\\n\\n生成文件：crawler/oilprice_crawler.py、data/oilprice_news_sample.json"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("long max turn smoke")) {
      const completedTurns = longMaxTurnSmokeCount;
      if (completedTurns < 14) {
        longMaxTurnSmokeCount += 1;
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        response.end([
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_long_${completedTurns}","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"long/step-${completedTurns}.txt\\",\\"content\\":\\"long max turn smoke step ${completedTurns}\\"}"}}]}}]}`,
          "data: [DONE]",
          "",
        ].join("\n\n"));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"long max turn smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (text.includes("请从这个 ocli 本地工程会话继续处理") && text.includes("ocli persistence smoke completed")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end([
        'data: {"choices":[{"delta":{"content":"resume endpoint smoke completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end([
      'data: {"choices":[{"delta":{"content":"ocli persistence smoke completed"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n"));
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => fakeApiServer.listen(fakeApiPort, "127.0.0.1", resolve));

function startOcliServer() {
  return spawn(process.execPath, ["index.js", "serve", "--workspace", workspace, "--port", String(port), "--token", smokeToken], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
}

let child = startOcliServer();

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  await waitForServer(child);

  const unauthenticatedHealth = await fetch(`${baseUrl}/health`).then(async (response) => ({ response, payload: await response.json().catch(() => undefined) }));
  assert(unauthenticatedHealth.response.status === 401, "health without token should require authentication");
  assert(unauthenticatedHealth.payload?.authRequired === true, "unauthenticated health should explain that a token is required");

  const health = await request("/health");
  assert(health.payload?.ok === true, "/health should be ok");
  assert(health.payload?.protocolVersion === 2, "/health should expose protocolVersion 2");
  assert(health.payload?.runtimeSource === "ocli", "/health should be served by the official Oases ocli runtime");
  assert(health.payload?.modelSource === "web", "/health should declare web-owned model source");
  assert(health.payload?.apiSource === "web-proxy", "/health should declare web proxy API source");
  assert(Array.isArray(health.payload?.toolCapabilities), "/health should expose tool capabilities");
  const runtimeInfo = await readJsonEventually(path.join(workspace, ".oases", "ocli", "runtime.json"));
  assert(runtimeInfo.token === smokeToken && runtimeInfo.port === port, "ocli should persist current runtime token and port for ocli open");
  assert(String(runtimeInfo.webUrl || "").includes(`ocliToken=${smokeToken}`), "runtime info should include tokenized web URL");
  const openDryRun = await runLocal(process.execPath, ["index.js", "open", "--workspace", workspace, "--dry-run"], path.resolve(import.meta.dirname, ".."));
  assert(openDryRun.stdout.includes(`ocliToken=${smokeToken}`), "ocli open --dry-run should print the tokenized web URL");

  const tools = await request("/tools");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "write_file" && tool.risk === "write"), "/tools should expose write_file metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "edit_file" && tool.risk === "write"), "/tools should expose edit_file metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "glob_files" && tool.risk === "read"), "/tools should expose glob_files metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "workspace_status" && tool.risk === "read"), "/tools should expose workspace_status metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "worktree_list" && tool.risk === "read"), "/tools should expose worktree_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "worktree_diff" && tool.risk === "read"), "/tools should expose worktree_diff metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "worktree_apply" && tool.risk === "destructive"), "/tools should expose worktree_apply metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "worktree_remove" && tool.risk === "destructive"), "/tools should expose worktree_remove metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "todo_write" && tool.risk === "write"), "/tools should expose todo_write metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "settings_list" && tool.risk === "read"), "/tools should expose settings_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "settings_read" && tool.risk === "read"), "/tools should expose settings_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "memory_list" && tool.risk === "read"), "/tools should expose memory_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "memory_search" && tool.risk === "read"), "/tools should expose memory_search metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "memory_read" && tool.risk === "read"), "/tools should expose memory_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "memory_write" && tool.risk === "write"), "/tools should expose memory_write metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "skill_list" && tool.risk === "read"), "/tools should expose skill_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "skill_read" && tool.risk === "read"), "/tools should expose skill_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "skill_asset_list" && tool.risk === "read"), "/tools should expose skill_asset_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "skill_asset_read" && tool.risk === "read"), "/tools should expose skill_asset_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "skill_install" && tool.risk === "write"), "/tools should expose skill_install metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "command_list" && tool.risk === "read"), "/tools should expose command_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "command_read" && tool.risk === "read"), "/tools should expose command_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "output_style_list" && tool.risk === "read"), "/tools should expose output_style_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "output_style_read" && tool.risk === "read"), "/tools should expose output_style_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_list" && tool.risk === "read"), "/tools should expose plugin_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_read" && tool.risk === "read"), "/tools should expose plugin_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_capability_list" && tool.risk === "read"), "/tools should expose plugin_capability_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_capability_read" && tool.risk === "read"), "/tools should expose plugin_capability_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_command_list" && tool.risk === "read"), "/tools should expose plugin_command_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_command_read" && tool.risk === "read"), "/tools should expose plugin_command_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_command_install" && tool.risk === "write"), "/tools should expose plugin_command_install metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_output_style_list" && tool.risk === "read"), "/tools should expose plugin_output_style_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_output_style_read" && tool.risk === "read"), "/tools should expose plugin_output_style_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_output_style_install" && tool.risk === "write"), "/tools should expose plugin_output_style_install metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_hook_list" && tool.risk === "read"), "/tools should expose plugin_hook_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_hook_read" && tool.risk === "read"), "/tools should expose plugin_hook_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_agent_list" && tool.risk === "read"), "/tools should expose plugin_agent_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_agent_read" && tool.risk === "read"), "/tools should expose plugin_agent_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_agent_install" && tool.risk === "write"), "/tools should expose plugin_agent_install metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_skill_list" && tool.risk === "read"), "/tools should expose plugin_skill_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_skill_read" && tool.risk === "read"), "/tools should expose plugin_skill_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_skill_install" && tool.risk === "write"), "/tools should expose plugin_skill_install metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_asset_list" && tool.risk === "read"), "/tools should expose plugin_asset_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_asset_read" && tool.risk === "read"), "/tools should expose plugin_asset_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_install" && tool.risk === "write"), "/tools should expose plugin_install metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_remove" && tool.risk === "destructive"), "/tools should expose plugin_remove metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_enable" && tool.risk === "write"), "/tools should expose plugin_enable metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "plugin_disable" && tool.risk === "write"), "/tools should expose plugin_disable metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_list" && tool.risk === "read"), "/tools should expose agent_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_read" && tool.risk === "read"), "/tools should expose agent_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_write" && tool.risk === "write"), "/tools should expose agent_write metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_write" && tool.inputSchema?.properties?.isolation?.enum?.includes("worktree")), "/tools should expose agent_write worktree isolation metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_run" && tool.risk === "agent"), "/tools should expose agent_run metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_run" && tool.inputSchema?.properties?.isolation?.enum?.includes("worktree")), "/tools should expose agent_run worktree isolation metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_run" && tool.inputSchema?.properties?.agentName?.type === "string"), "/tools should expose agent_run agentName metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_status" && tool.risk === "agent"), "/tools should expose agent_status metadata");

  const directAgentRun = await request("/tools/agent_run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "direct agent_run should be rejected outside agent sessions" }),
  });
  assert(directAgentRun.response.status >= 400, "direct agent_run endpoint calls should be rejected outside agent sessions");
  const directAgentStatus = await request("/tools/agent_status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(directAgentStatus.response.status >= 400, "direct agent_status endpoint calls should be rejected outside agent sessions");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: ".oases/mcp/docs-server.mjs",
      content: [
        "const responses = {",
        "  initialize: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'docs', version: '1.0.0' } },",
        "  'tools/list': { tools: [{ name: 'search_docs', description: 'Search workspace docs for routing smoke tests.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } }] },",
        "  'resources/list': { resources: [{ uri: 'docs://routing-guide', name: 'Routing Guide', description: 'Auto routing smoke MCP resource', mimeType: 'text/markdown' }] },",
        "};",
        "let buffer = Buffer.alloc(0);",
        "function send(id, result) {",
        "  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8');",
        "  process.stdout.write(`Content-Length: ${body.length}\\r\\n\\r\\n`);",
        "  process.stdout.write(body);",
        "}",
        "process.stdin.on('data', (chunk) => {",
        "  buffer = Buffer.concat([buffer, chunk]);",
        "  while (true) {",
        "    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');",
        "    if (headerEnd === -1) return;",
        "    const header = buffer.slice(0, headerEnd).toString('utf8');",
        "    const match = header.match(/Content-Length:\\s*(\\d+)/i);",
        "    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }",
        "    const length = Number(match[1]);",
        "    const start = headerEnd + 4;",
        "    if (buffer.length < start + length) return;",
        "    const message = JSON.parse(buffer.slice(start, start + length).toString('utf8'));",
        "    buffer = buffer.slice(start + length);",
        "    if (message.id === undefined) continue;",
        "    if (message.method === 'tools/call') send(message.id, { content: [{ type: 'text', text: `docs result for ${message.params?.arguments?.query || ''}` }] });",
        "    else if (message.method === 'resources/read') send(message.id, { contents: [{ uri: message.params?.uri, mimeType: 'text/markdown', text: '# Routing Guide\\n\\nMCP routing resource.' }] });",
        "    else send(message.id, responses[message.method] || {});",
        "  }",
        "});",
      ].join("\n"),
    }),
  });

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.json", content: JSON.stringify({ outputStyle: "concise-local", env: { OASES_API_KEY: "workspace-secret" }, permissions: { allow: ["read_file"], deny: ["Write(denied-by-settings.txt)"], ask: ["Write(ask-by-settings.txt)"] }, mcpServers: { docs: { command: process.execPath, args: [path.join(workspace, ".oases", "mcp", "docs-server.mjs")], env: { DOCS_TOKEN: "mcp-secret" } } } }, null, 2) }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".claude/settings.json", content: JSON.stringify({ model: "claude-compatible", authToken: "claude-secret" }, null, 2) }),
  });
  const settingsList = await request("/tools/settings_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(settingsList.payload?.data?.settingsFiles?.some((file) => file?.path === ".oases/settings.json"), "settings_list should list Oases workspace settings");
  assert(!settingsList.payload?.data?.settingsFiles?.some((file) => String(file?.path || "").startsWith(".claude/")), "settings_list should hide Claude settings by default");
  const settingsRead = await request("/tools/settings_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.json" }),
  });
  assert(settingsRead.payload?.data?.settings?.keys?.includes("outputStyle"), "settings_read should summarize workspace settings keys");
  assert(settingsRead.payload?.data?.settings?.values?.env?.values?.OASES_API_KEY?.redacted === true, "settings_read should redact sensitive nested keys");
  assert(settingsRead.payload?.data?.safeValues?.mcpServers?.servers?.docs?.command === process.execPath, "settings_read should expose safe MCP server command metadata");
  assert(settingsRead.payload?.data?.safeValues?.mcpServers?.servers?.docs?.args?.length === 1, "settings_read should expose safe MCP server args metadata");
  assert(settingsRead.payload?.data?.safeValues?.mcpServers?.servers?.docs?.envKeys?.includes("DOCS_TOKEN"), "settings_read should expose MCP server env key names only");
  assert(!JSON.stringify(settingsRead.payload?.data || {}).includes("workspace-secret"), "settings_read should not expose sensitive workspace setting values");
  assert(!JSON.stringify(settingsRead.payload?.data || {}).includes("mcp-secret"), "settings_read should not expose sensitive MCP env values");
  const claudeSettingsReadBlocked = await request("/tools/settings_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".claude/settings.json" }),
  });
  assert(claudeSettingsReadBlocked.response.status >= 400, "settings_read should require includeClaude for .claude settings");
  const claudeSettingsRead = await request("/tools/settings_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".claude/settings.json", includeClaude: true }),
  });
  assert(claudeSettingsRead.payload?.data?.settings?.values?.authToken?.redacted === true, "settings_read includeClaude should redact sensitive Claude settings");
  assert(!JSON.stringify(claudeSettingsRead.payload?.data || {}).includes("claude-secret"), "settings_read should not expose sensitive Claude setting values");

  const memoryWrite = await request("/tools/memory_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "project",
      name: "testing-policy",
      title: "Testing policy",
      description: "How this workspace validates changes",
      tags: ["testing", "policy"],
      links: ["review-flow"],
      content: "Integration-level changes should run the ocli smoke tests before release.",
    }),
  });
  assert(memoryWrite.payload?.ok === true, "memory_write should create project memory");
  assert(memoryWrite.payload?.data?.path === ".oases/memory/project/testing-policy.md", "memory_write should write under the scoped memory directory");
  assert(memoryWrite.payload?.data?.artifacts?.[0]?.role === "memory_file", "memory_write should return a memory artifact");
  assert(memoryWrite.payload?.data?.memory?.links?.includes("review-flow"), "memory_write should persist wiki-style memory links");
  const linkedMemoryWrite = await request("/tools/memory_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "project",
      name: "release-checklist",
      title: "Release checklist",
      description: "Release checks linked to the testing policy",
      tags: ["release"],
      links: ["project:testing-policy"],
      content: "Release checklist references [[testing-policy]] before shipping production builds.",
    }),
  });
  assert(linkedMemoryWrite.payload?.ok === true, "memory_write should create linked project memory");
  const autoLinkedMemoryWrite = await request("/tools/memory_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "project",
      name: "deployment-rule",
      title: "Deployment rule",
      tags: ["release"],
      content: "Deployment review must follow testing-policy before production updates.",
    }),
  });
  assert(autoLinkedMemoryWrite.payload?.ok === true, "memory_write should create auto-linked project memory");
  assert(autoLinkedMemoryWrite.payload?.data?.autoLinks?.includes("project:testing-policy"), "memory_write should infer wiki links to existing memories mentioned in content");
  assert(autoLinkedMemoryWrite.payload?.data?.memory?.links?.includes("project:testing-policy"), "memory_write should persist inferred wiki links");
  const latePolicyMemoryWrite = await request("/tools/memory_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "project",
      name: "late-policy",
      title: "Late policy",
      description: "Loaded only after tool output asks for it",
      tags: ["adaptive", "routing"],
      links: ["testing-policy"],
      content: "late policy memory marker: adaptive routing should load this only after a tool result mentions late-policy.",
    }),
  });
  assert(latePolicyMemoryWrite.payload?.ok === true, "memory_write should create late adaptive routing memory");
  const memoryList = await request("/tools/memory_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "project" }),
  });
  assert(memoryList.payload?.data?.memories?.some((memory) => memory?.name === "testing-policy" && memory?.scope === "project" && memory?.tags?.includes("testing")), "memory_list should list scoped project memories with metadata");
  const memoryRead = await request("/tools/memory_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "testing-policy", scope: "project" }),
  });
  assert(memoryRead.payload?.data?.body?.includes("ocli smoke tests"), "memory_read should read memory body text");
  assert(memoryRead.payload?.data?.memory?.links?.includes("review-flow"), "memory_read should expose memory links");
  const memorySearch = await request("/tools/memory_search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "integration release smoke tests", scope: "project", maxResults: 5, maxChars: 240 }),
  });
  const searchedTestingPolicy = memorySearch.payload?.data?.memories?.find((memory) => memory?.memory?.name === "testing-policy");
  assert(searchedTestingPolicy?.snippet?.includes("ocli smoke tests"), "memory_search should return RAG snippets from matching memory body");
  assert(searchedTestingPolicy?.links?.includes("review-flow"), "memory_search should return outgoing memory links");
  assert(searchedTestingPolicy?.backlinks?.some((link) => link?.name === "release-checklist"), "memory_search should return backlinks from wiki-style linked memories");
  assert(searchedTestingPolicy?.backlinks?.some((link) => link?.name === "deployment-rule"), "memory_search should return backlinks from auto-linked memories");
  const duplicateMemoryWrite = await request("/tools/memory_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "project", name: "testing-policy", title: "Testing policy", content: "duplicate" }),
  });
  assert(duplicateMemoryWrite.response.status >= 400, "memory_write should refuse to overwrite by default");
  const blockedMemoryRead = await request("/tools/memory_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.json" }),
  });
  assert(blockedMemoryRead.response.status >= 400, "memory_read should reject paths outside .oases/memory");
  const nestedMemoryWrite = await request("/tools/memory_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "project", path: ".oases/memory/project/nested/testing.md", title: "Nested testing", content: "nested memory" }),
  });
  assert(nestedMemoryWrite.response.status >= 400, "memory_write should reject nested memory paths");

  const write = await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/hello.txt", content: "hello ocli" }),
  });
  assert(write.payload?.ok === true, "write_file should succeed");
  assert(write.payload?.data?.artifacts?.[0]?.type === "file", "write_file should return a file artifact");
  assert(write.payload?.data?.artifacts?.[0]?.path === "smoke/hello.txt", "write_file artifact should include the written path");

  const read = await request("/tools/read_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/hello.txt" }),
  });
  assert(read.payload?.data?.content === "hello ocli", "read_file should return written content");

  const absoluteSmokePath = path.join(workspace, "absolute", "inside.txt");
  const absoluteWrite = await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: absoluteSmokePath, content: "absolute path inside workspace" }),
  });
  assert(absoluteWrite.payload?.ok === true, "write_file should accept absolute paths inside the workspace");
  assert(absoluteWrite.payload?.data?.path === "absolute/inside.txt", "write_file should normalize workspace-internal absolute paths to relative paths");
  const absoluteRead = await request("/tools/read_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: absoluteSmokePath }),
  });
  assert(absoluteRead.payload?.data?.path === "absolute/inside.txt", "read_file should normalize workspace-internal absolute paths to relative paths");
  assert(absoluteRead.payload?.data?.content === "absolute path inside workspace", "read_file should read absolute paths inside the workspace");
  const outsideAbsoluteRead = await request("/tools/read_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: path.join(path.dirname(workspace), "outside.txt") }),
  });
  assert(outsideAbsoluteRead.response.status >= 400, "read_file should reject absolute paths outside the workspace");
  assert(String(outsideAbsoluteRead.payload?.error || "").includes("workspace"), "outside absolute path error should mention workspace boundary");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/skills/research/SKILL.md", content: "---\nname: research\ndescription: Research workflow skill\n---\n\n# Research Skill\n\nUse fetch_url and write_file for sourced outputs.\n\nskill preload marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/commands/review-flow.md", content: "---\nname: review-flow\ndescription: Review workflow command\n---\n\n# Review Flow\n\nUse a concise plan, inspect relevant files, and write the result.\n\ncommand context marker\n" }),
  });
  const skillList = await request("/tools/skill_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 10 }),
  });
  assert(skillList.payload?.data?.skills?.some((skill) => skill?.name === "research" && skill?.path === ".oases/skills/research/SKILL.md"), "skill_list should discover workspace-local skills");
  const bundledSkillList = await request("/tools/skill_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 500 }),
  });
  assert(bundledSkillList.payload?.data?.bundledRootAvailable === true, "skill_list should detect bundled OcliSkills");
  assert(bundledSkillList.payload?.data?.skills?.some((skill) => skill?.name === "web-search" && skill?.source === "bundled" && skill?.path === "OcliSkills/web-search/SKILL.md"), "skill_list should discover bundled OcliSkills");
  const skillRead = await request("/tools/skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "research" }),
  });
  assert(skillRead.payload?.data?.content?.includes("Research Skill"), "skill_read should read skill content by name");
  assert(skillRead.payload?.data?.source === "workspace", "skill_read should label workspace-local skills");
  const bundledSkillRead = await request("/tools/skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web-search", maxChars: 4000 }),
  });
  assert(bundledSkillRead.payload?.data?.source === "bundled", "skill_read should label bundled skills");
  assert(bundledSkillRead.payload?.data?.path === "OcliSkills/web-search/SKILL.md", "skill_read should expose bundled skill path");
  assert(bundledSkillRead.payload?.data?.content?.includes("Use browser automation to search the web"), "skill_read should read bundled skill content by name");
  const bundledSkillAssets = await request("/tools/skill_asset_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web-search", maxResults: 20 }),
  });
  assert(bundledSkillAssets.payload?.data?.source === "bundled", "skill_asset_list should label bundled skill assets");
  assert(bundledSkillAssets.payload?.data?.assets?.some((asset) => asset?.path === "scripts/browser_search.py" && asset?.type === "file"), "skill_asset_list should list bundled skill scripts");
  const bundledSkillAssetRead = await request("/tools/skill_asset_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web-search", assetPath: "scripts/browser_search.py", maxChars: 6000 }),
  });
  assert(bundledSkillAssetRead.payload?.data?.source === "bundled", "skill_asset_read should label bundled skill assets");
  assert(bundledSkillAssetRead.payload?.data?.path === "OcliSkills/web-search/scripts/browser_search.py", "skill_asset_read should expose bundled skill asset path");
  assert(bundledSkillAssetRead.payload?.data?.content?.includes("SOURCES"), "skill_asset_read should read bundled skill script content");
  const skillAssetBlocked = await request("/tools/skill_asset_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web-search", assetPath: "../exa-search/SKILL.md" }),
  });
  assert(skillAssetBlocked.response.status >= 400, "skill_asset_read should reject paths outside the selected skill directory");
  const installedSkill = await request("/tools/skill_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web-search", targetName: "web-search-local" }),
  });
  assert(installedSkill.payload?.data?.installed === true, "skill_install should install a bundled skill into the workspace");
  assert(installedSkill.payload?.data?.path === ".oases/skills/web-search-local/SKILL.md", "skill_install should report the installed workspace skill path");
  const installedSkillAsset = await request("/tools/skill_asset_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/skills/web-search-local/scripts/browser_search.py", maxChars: 4000 }),
  });
  assert(installedSkillAsset.payload?.data?.source === "workspace", "skill_asset_read should read installed workspace skill assets");
  assert(installedSkillAsset.payload?.data?.content?.includes("SOURCES"), "skill_install should copy bundled skill scripts");
  const duplicateSkillInstall = await request("/tools/skill_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web-search", targetName: "web-search-local" }),
  });
  assert(duplicateSkillInstall.response.status >= 400, "skill_install should refuse to overwrite existing workspace skills");
  const skillReadBlocked = await request("/tools/skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(skillReadBlocked.response.status >= 400, "skill_read should reject paths outside .oases/skills");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: ".oases/plugins/feature-dev/.claude-plugin/plugin.json",
      content: JSON.stringify({
        name: "feature-dev",
        version: "1.0.0",
        description: "Feature development workflow",
        author: { name: "Oases" },
        mcpServers: { docs: { command: "node", args: ["server.js"], env: { DOCS_TOKEN: "redacted-by-summary" } } },
        lspServers: { typescript: { command: "typescript-language-server", args: ["--stdio"] } },
        settings: { model: "oases-code", env: { SAFE_FLAG: "1", OASES_API_KEY: "should-not-leak" } },
        commandsPaths: ["./commands"],
        agentsPaths: ["./agents"],
        skillsPaths: ["./skills"],
        outputStylesPaths: ["./output-styles"],
        commandsMetadata: { "feature-dev": { description: "Build a feature safely", allowedTools: ["read_file", "write_file"] } },
      }, null, 2),
    }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/README.md", content: "# Feature Dev Plugin\n\nplugin readme marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/commands/feature-dev.md", content: "---\ndescription: Build a feature safely\n---\n\n# Feature command\n\nUse a plan, inspect files, implement, and verify.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/agents/code-explorer.md", content: "---\nname: code-explorer\ndescription: Explore code structure\nagentType: explore\ntools:\n  - read_file\n  - grep_files\nskills: research\neffort: low\ninitialPrompt: |\n  inspect first\n  then summarize\n---\n\n# Explorer agent\n\nplugin agent marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/skills/review-helper/SKILL.md", content: "---\nname: review-helper\ndescription: Review helper skill\n---\n\n# Review Helper Skill\n\nplugin skill marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/skills/review-helper/references/checklist.md", content: "# Review Checklist\n\nplugin asset reference marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/scripts/check.sh", content: "#!/bin/sh\nprintf 'plugin asset script marker\\n'\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/hooks/hooks.json", content: JSON.stringify({ description: "Feature hook config", hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py", timeout: 5 }] }] } }, null, 2) + "\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/hooks/pretooluse.py", content: "print('plugin hook handler marker')\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/hooks-handlers/session-start.sh", content: "#!/bin/sh\nprintf 'plugin hook handler shell marker\\n'\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/output-styles/concise.md", content: "---\ndescription: Concise engineering summaries\n---\n\n# Concise\n\nKeep output short.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/settings.json", content: JSON.stringify({ safeMode: true, apiToken: "should-not-leak", nested: { password: "should-not-leak" } }, null, 2) }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: ".oases/plugins/route-pack/.claude-plugin/plugin.json",
      content: JSON.stringify({
        name: "route-pack",
        version: "1.0.0",
        description: "Plugin-only routing fixture",
        commandsPaths: ["./commands"],
        agentsPaths: ["./agents"],
        skillsPaths: ["./skills"],
      }, null, 2),
    }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/route-pack/commands/plugin-route-flow.md", content: "---\ndescription: Plugin route command fixture\n---\n\n# Plugin Route Flow\n\nplugin route command marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/route-pack/agents/plugin-explorer.md", content: "---\nname: plugin-explorer\ndescription: Plugin route agent fixture\nagentType: explore\ntools:\n  - read_file\nskills:\n  - plugin-route-helper\nmaxTurns: 4\n---\n\n# Plugin Explorer Agent\n\nplugin route agent marker\nplugin direct agent marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/route-pack/skills/plugin-route-helper/SKILL.md", content: "---\nname: plugin-route-helper\ndescription: Plugin route helper skill\n---\n\n# Plugin Route Skill\n\nplugin skill auto route marker\n" }),
  });
  const pluginList = await request("/tools/plugin_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 10 }),
  });
  const listedPlugin = pluginList.payload?.data?.plugins?.find((plugin) => plugin?.name === "feature-dev");
  assert(listedPlugin?.manifestType === "claude-plugin", "plugin_list should discover Claude-style workspace plugin manifests");
  assert(listedPlugin?.commands?.includes(".oases/plugins/feature-dev/commands/feature-dev.md"), "plugin_list should summarize plugin commands");
  assert(listedPlugin?.agents?.includes(".oases/plugins/feature-dev/agents/code-explorer.md"), "plugin_list should summarize plugin agents");
  assert(listedPlugin?.skills?.includes(".oases/plugins/feature-dev/skills/review-helper/SKILL.md"), "plugin_list should summarize plugin skills");
  assert(listedPlugin?.hooks?.includes(".oases/plugins/feature-dev/hooks/hooks.json"), "plugin_list should summarize plugin hooks");
  assert(listedPlugin?.hooks?.includes(".oases/plugins/feature-dev/hooks-handlers/session-start.sh"), "plugin_list should summarize plugin hook handlers");
  assert(listedPlugin?.outputStyles?.includes(".oases/plugins/feature-dev/output-styles/concise.md"), "plugin_list should summarize plugin output styles");
  assert(listedPlugin?.settingsJson === ".oases/plugins/feature-dev/settings.json", "plugin_list should summarize plugin settings.json");
  const pluginRead = await request("/tools/plugin_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "feature-dev", maxChars: 4000 }),
  });
  assert(pluginRead.payload?.data?.plugin?.name === "feature-dev", "plugin_read should read a workspace plugin by name");
  assert(pluginRead.payload?.data?.readme?.includes("plugin readme marker"), "plugin_read should include README preview when present");
  const pluginCapabilityList = await request("/tools/plugin_capability_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", maxResults: 10 }),
  });
  const listedCapability = pluginCapabilityList.payload?.data?.capabilities?.find((capability) => capability?.plugin === "feature-dev");
  assert(listedCapability?.manifest?.mcpServerNames?.includes("docs"), "plugin_capability_list should summarize manifest MCP server names");
  assert(listedCapability?.manifest?.lspServerNames?.includes("typescript"), "plugin_capability_list should summarize manifest LSP server names");
  assert(listedCapability?.manifest?.settingsKeys?.includes("env"), "plugin_capability_list should summarize manifest settings keys");
  assert(listedCapability?.manifest?.commandsMetadataNames?.includes("feature-dev"), "plugin_capability_list should summarize command metadata names");
  assert(listedCapability?.manifest?.paths?.outputStyles?.includes("./output-styles"), "plugin_capability_list should summarize manifest output style paths");
  assert(listedCapability?.files?.outputStyles?.includes(".oases/plugins/feature-dev/output-styles/concise.md"), "plugin_capability_list should summarize output style files");
  const pluginCapabilityRead = await request("/tools/plugin_capability_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev" }),
  });
  assert(pluginCapabilityRead.payload?.data?.manifest?.mcpServers?.servers?.docs?.command === "node", "plugin_capability_read should summarize MCP server declarations");
  assert(pluginCapabilityRead.payload?.data?.manifest?.settings?.values?.env?.values?.OASES_API_KEY?.redacted === true, "plugin_capability_read should redact sensitive manifest settings");
  assert(pluginCapabilityRead.payload?.data?.settingsFile?.settings?.values?.apiToken?.redacted === true, "plugin_capability_read should redact sensitive settings.json keys");
  assert(!JSON.stringify(pluginCapabilityRead.payload?.data || {}).includes("should-not-leak"), "plugin_capability_read should not expose sensitive setting values");
  const pluginOutputStyleList = await request("/tools/plugin_output_style_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", maxResults: 10 }),
  });
  const listedPluginOutputStyle = pluginOutputStyleList.payload?.data?.outputStyles?.find((style) => style?.name === "concise");
  assert(listedPluginOutputStyle?.path === ".oases/plugins/feature-dev/output-styles/concise.md", "plugin_output_style_list should list plugin output style files");
  assert(listedPluginOutputStyle?.title === "Concise", "plugin_output_style_list should parse output style heading");
  assert(listedPluginOutputStyle?.description === "Concise engineering summaries", "plugin_output_style_list should parse output style frontmatter");
  const pluginOutputStyleRead = await request("/tools/plugin_output_style_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "concise", maxChars: 4000 }),
  });
  assert(pluginOutputStyleRead.payload?.data?.body?.includes("Keep output short."), "plugin_output_style_read should read plugin output style bodies");
  assert(pluginOutputStyleRead.payload?.data?.outputStyle?.source === "plugin", "plugin_output_style_read should label plugin output style source");
  const pluginOutputStyleInstall = await request("/tools/plugin_output_style_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "concise", targetName: "concise-local" }),
  });
  assert(pluginOutputStyleInstall.payload?.data?.installed === true, "plugin_output_style_install should install plugin output styles into .oases/output-styles");
  assert(pluginOutputStyleInstall.payload?.data?.path === ".oases/output-styles/concise-local.md", "plugin_output_style_install should report installed workspace output style path");
  const outputStyleList = await request("/tools/output_style_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 20 }),
  });
  assert(outputStyleList.payload?.data?.outputStyles?.some((style) => style?.path === ".oases/output-styles/concise-local.md"), "output_style_list should include installed plugin output styles");
  const outputStyleRead = await request("/tools/output_style_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "concise-local", maxChars: 4000 }),
  });
  assert(outputStyleRead.payload?.data?.body?.includes("Keep output short."), "output_style_read should read installed output style bodies");
  const duplicatePluginOutputStyleInstall = await request("/tools/plugin_output_style_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "concise", targetName: "concise-local" }),
  });
  assert(duplicatePluginOutputStyleInstall.response.status >= 400, "plugin_output_style_install should refuse to overwrite existing workspace output styles");
  const pluginHookList = await request("/tools/plugin_hook_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", maxResults: 10 }),
  });
  const listedHookConfig = pluginHookList.payload?.data?.hooks?.find((hook) => hook?.path === ".oases/plugins/feature-dev/hooks/hooks.json");
  assert(listedHookConfig?.kind === "config", "plugin_hook_list should classify hooks.json as config");
  assert(listedHookConfig?.events?.includes("PreToolUse"), "plugin_hook_list should parse hook event names");
  assert(listedHookConfig?.commands?.some((command) => command.includes("pretooluse.py")), "plugin_hook_list should summarize hook commands");
  const listedHookHandler = pluginHookList.payload?.data?.hooks?.find((hook) => hook?.path === ".oases/plugins/feature-dev/hooks/pretooluse.py");
  assert(listedHookHandler?.kind === "handler", "plugin_hook_list should classify hook scripts as handlers");
  const listedHookHandlerShell = pluginHookList.payload?.data?.hooks?.find((hook) => hook?.path === ".oases/plugins/feature-dev/hooks-handlers/session-start.sh");
  assert(listedHookHandlerShell?.kind === "handler", "plugin_hook_list should include hooks-handlers files");
  const pluginHookRead = await request("/tools/plugin_hook_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "hooks", maxChars: 4000 }),
  });
  assert(pluginHookRead.payload?.data?.hook?.events?.includes("PreToolUse"), "plugin_hook_read should read a hook config by plugin/name");
  assert(pluginHookRead.payload?.data?.events?.[0]?.matchers?.includes("Edit|Write"), "plugin_hook_read should expose hook matcher metadata");
  const pluginHookHandlerRead = await request("/tools/plugin_hook_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/hooks/pretooluse.py", maxChars: 4000 }),
  });
  assert(pluginHookHandlerRead.payload?.data?.content?.includes("plugin hook handler marker"), "plugin_hook_read should read hook handler source without executing it");
  const pluginHookHandlerShellRead = await request("/tools/plugin_hook_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/hooks-handlers/session-start.sh", maxChars: 4000 }),
  });
  assert(pluginHookHandlerShellRead.payload?.data?.content?.includes("plugin hook handler shell marker"), "plugin_hook_read should read hooks-handlers source files");
  const pluginHookReadBlocked = await request("/tools/plugin_hook_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(pluginHookReadBlocked.response.status >= 400, "plugin_hook_read should reject paths outside .oases/plugins");
  const pluginCommandList = await request("/tools/plugin_command_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", maxResults: 10 }),
  });
  const listedCommand = pluginCommandList.payload?.data?.commands?.find((command) => command?.name === "feature-dev");
  assert(listedCommand?.path === ".oases/plugins/feature-dev/commands/feature-dev.md", "plugin_command_list should list plugin command markdown files");
  assert(listedCommand?.title === "Feature command", "plugin_command_list should parse command headings");
  assert(listedCommand?.description === "Build a feature safely", "plugin_command_list should parse command frontmatter");
  const pluginCommandRead = await request("/tools/plugin_command_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "feature-dev", maxChars: 4000 }),
  });
  assert(pluginCommandRead.payload?.data?.command?.title === "Feature command", "plugin_command_read should read a command by plugin/name");
  assert(pluginCommandRead.payload?.data?.body?.includes("Use a plan"), "plugin_command_read should return command body content");
  const pluginCommandReadByPath = await request("/tools/plugin_command_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/commands/feature-dev.md", maxChars: 4000 }),
  });
  assert(pluginCommandReadByPath.payload?.data?.metadata?.description === "Build a feature safely", "plugin_command_read should read a command by relative path");
  const pluginCommandReadBlocked = await request("/tools/plugin_command_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(pluginCommandReadBlocked.response.status >= 400, "plugin_command_read should reject paths outside .oases/plugins");
  const pluginCommandInstall = await request("/tools/plugin_command_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "feature-dev", targetName: "feature-dev-local" }),
  });
  assert(pluginCommandInstall.payload?.data?.installed === true, "plugin_command_install should install a plugin command into .oases/commands");
  assert(pluginCommandInstall.payload?.data?.path === ".oases/commands/feature-dev-local.md", "plugin_command_install should report installed workspace command path");
  const installedCommandList = await request("/tools/command_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 100 }),
  });
  assert(installedCommandList.payload?.data?.commands?.some((command) => command?.path === ".oases/commands/feature-dev-local.md"), "command_list should include installed plugin commands");
  const installedCommandRead = await request("/tools/command_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/commands/feature-dev-local.md", maxChars: 4000 }),
  });
  assert(installedCommandRead.payload?.data?.body?.includes("Use a plan"), "command_read should read installed plugin command body");
  const duplicatePluginCommandInstall = await request("/tools/plugin_command_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "feature-dev", targetName: "feature-dev-local" }),
  });
  assert(duplicatePluginCommandInstall.response.status >= 400, "plugin_command_install should refuse to overwrite existing workspace commands");
  const pluginAgentList = await request("/tools/plugin_agent_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", maxResults: 10 }),
  });
  const listedPluginAgent = pluginAgentList.payload?.data?.agents?.find((agent) => agent?.name === "code-explorer");
  assert(listedPluginAgent?.path === ".oases/plugins/feature-dev/agents/code-explorer.md", "plugin_agent_list should list plugin agent markdown files");
  assert(listedPluginAgent?.plugin === "feature-dev", "plugin_agent_list should label plugin agent source");
  assert(listedPluginAgent?.agentType === "explore", "plugin_agent_list should parse agent frontmatter");
  assert(listedPluginAgent?.tools?.includes("read_file") && listedPluginAgent?.skills?.includes("research"), "plugin_agent_list should parse plugin agent tool and skill metadata");
  assert(String(listedPluginAgent?.initialPrompt || "").includes("then summarize"), "plugin_agent_list should parse plugin agent block initialPrompt");
  const pluginAgentRead = await request("/tools/plugin_agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "code-explorer", maxChars: 4000 }),
  });
  assert(pluginAgentRead.payload?.data?.agent?.source === "plugin", "plugin_agent_read should mark plugin agent source");
  assert(pluginAgentRead.payload?.data?.prompt?.includes("plugin agent marker"), "plugin_agent_read should return agent prompt body");
  const pluginAgentReadByPath = await request("/tools/plugin_agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/agents/code-explorer.md", maxChars: 4000 }),
  });
  assert(pluginAgentReadByPath.payload?.data?.metadata?.description === "Explore code structure", "plugin_agent_read should read a plugin agent by relative path");
  const pluginAgentReadBlocked = await request("/tools/plugin_agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(pluginAgentReadBlocked.response.status >= 400, "plugin_agent_read should reject paths outside .oases/plugins");
  const pluginAgentInstall = await request("/tools/plugin_agent_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "code-explorer", targetName: "code-explorer-local" }),
  });
  assert(pluginAgentInstall.payload?.data?.installed === true, "plugin_agent_install should install a plugin agent into .oases/agents");
  assert(pluginAgentInstall.payload?.data?.path === ".oases/agents/code-explorer-local.md", "plugin_agent_install should report installed workspace agent path");
  const installedPluginAgentList = await request("/tools/agent_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 100 }),
  });
  assert(installedPluginAgentList.payload?.data?.agents?.some((agent) => agent?.name === "code-explorer" && agent?.path === ".oases/agents/code-explorer-local.md"), "agent_list should include installed plugin agents as workspace agents");
  const installedPluginAgentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/code-explorer-local.md", maxChars: 4000 }),
  });
  assert(installedPluginAgentRead.payload?.data?.prompt?.includes("plugin agent marker"), "agent_read should read installed plugin agent prompt");
  const duplicatePluginAgentInstall = await request("/tools/plugin_agent_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "code-explorer", targetName: "code-explorer-local" }),
  });
  assert(duplicatePluginAgentInstall.response.status >= 400, "plugin_agent_install should refuse to overwrite existing workspace agents");
  const pluginSkillList = await request("/tools/plugin_skill_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", maxResults: 10 }),
  });
  const listedPluginSkill = pluginSkillList.payload?.data?.skills?.find((skill) => skill?.name === "review-helper");
  assert(listedPluginSkill?.path === ".oases/plugins/feature-dev/skills/review-helper/SKILL.md", "plugin_skill_list should list plugin SKILL.md files");
  assert(listedPluginSkill?.plugin === "feature-dev", "plugin_skill_list should label plugin skill source");
  assert(listedPluginSkill?.description === "Review helper skill", "plugin_skill_list should parse skill frontmatter");
  const pluginSkillRead = await request("/tools/plugin_skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "review-helper", maxChars: 4000 }),
  });
  assert(pluginSkillRead.payload?.data?.skill?.source === "plugin", "plugin_skill_read should mark plugin skill source");
  assert(pluginSkillRead.payload?.data?.content?.includes("plugin skill marker"), "plugin_skill_read should return skill content");
  const pluginSkillReadByPath = await request("/tools/plugin_skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/skills/review-helper/SKILL.md", maxChars: 4000 }),
  });
  assert(pluginSkillReadByPath.payload?.data?.metadata?.description === "Review helper skill", "plugin_skill_read should read a plugin skill by relative path");
  const pluginSkillReadBlocked = await request("/tools/plugin_skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(pluginSkillReadBlocked.response.status >= 400, "plugin_skill_read should reject paths outside .oases/plugins");
  const pluginSkillInstall = await request("/tools/plugin_skill_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "review-helper", targetName: "review-helper-local" }),
  });
  assert(pluginSkillInstall.payload?.data?.installed === true, "plugin_skill_install should install a plugin skill into .oases/skills");
  assert(pluginSkillInstall.payload?.data?.path === ".oases/skills/review-helper-local/SKILL.md", "plugin_skill_install should report installed workspace skill path");
  const installedPluginSkillRead = await request("/tools/skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/skills/review-helper-local/SKILL.md", maxChars: 4000 }),
  });
  assert(installedPluginSkillRead.payload?.data?.source === "workspace", "skill_read should read installed plugin skill as a workspace skill");
  assert(installedPluginSkillRead.payload?.data?.content?.includes("plugin skill marker"), "plugin_skill_install should copy the plugin SKILL.md content");
  const installedPluginSkillAsset = await request("/tools/skill_asset_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/skills/review-helper-local/references/checklist.md", maxChars: 4000 }),
  });
  assert(installedPluginSkillAsset.payload?.data?.content?.includes("plugin asset reference marker"), "plugin_skill_install should copy plugin skill assets");
  const duplicatePluginSkillInstall = await request("/tools/plugin_skill_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "review-helper", targetName: "review-helper-local" }),
  });
  assert(duplicatePluginSkillInstall.response.status >= 400, "plugin_skill_install should refuse to overwrite existing workspace skills");
  const pluginAssetList = await request("/tools/plugin_asset_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", assetPath: "skills/review-helper", maxResults: 50 }),
  });
  assert(pluginAssetList.payload?.data?.assets?.some((asset) => asset?.path === "skills/review-helper/references/checklist.md"), "plugin_asset_list should list nested plugin skill references");
  const pluginAssetRead = await request("/tools/plugin_asset_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", assetPath: "skills/review-helper/references/checklist.md", maxChars: 4000 }),
  });
  assert(pluginAssetRead.payload?.data?.content?.includes("plugin asset reference marker"), "plugin_asset_read should read plugin reference assets");
  const pluginScriptAssetRead = await request("/tools/plugin_asset_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/feature-dev/scripts/check.sh", maxChars: 4000 }),
  });
  assert(pluginScriptAssetRead.payload?.data?.content?.includes("plugin asset script marker"), "plugin_asset_read should read plugin script assets without executing them");
  const pluginAssetReadBlocked = await request("/tools/plugin_asset_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", assetPath: "../package.json" }),
  });
  assert(pluginAssetReadBlocked.response.status >= 400, "plugin_asset_read should reject paths outside the selected plugin");
  const pluginDisable = await request("/tools/plugin_disable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "feature-dev" }),
  });
  assert(pluginDisable.payload?.data?.enabled === false, "plugin_disable should mark a plugin disabled");
  assert(pluginDisable.payload?.data?.markerPath === ".oases/plugins/feature-dev/.oases-disabled", "plugin_disable should report the marker path");
  const disabledPluginList = await request("/tools/plugin_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 10 }),
  });
  const disabledPlugin = disabledPluginList.payload?.data?.plugins?.find((plugin) => plugin?.name === "feature-dev");
  assert(disabledPlugin?.enabled === false && disabledPlugin?.disabled === true, "plugin_list should report disabled plugin state");
  const disabledDefaultCommands = await request("/tools/plugin_command_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 50 }),
  });
  assert(!disabledDefaultCommands.payload?.data?.commands?.some((command) => command?.plugin === "feature-dev"), "plugin_command_list should hide disabled plugins by default");
  const disabledIncludedCommands = await request("/tools/plugin_command_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeDisabled: true, maxResults: 50 }),
  });
  assert(disabledIncludedCommands.payload?.data?.commands?.some((command) => command?.plugin === "feature-dev"), "plugin_command_list includeDisabled should include disabled plugins");
  const disabledDefaultOutputStyles = await request("/tools/plugin_output_style_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 50 }),
  });
  assert(!disabledDefaultOutputStyles.payload?.data?.outputStyles?.some((style) => style?.plugin === "feature-dev"), "plugin_output_style_list should hide disabled plugins by default");
  const disabledIncludedOutputStyles = await request("/tools/plugin_output_style_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeDisabled: true, maxResults: 50 }),
  });
  assert(disabledIncludedOutputStyles.payload?.data?.outputStyles?.some((style) => style?.plugin === "feature-dev"), "plugin_output_style_list includeDisabled should include disabled plugins");
  const disabledDefaultOutputStyleRead = await request("/tools/plugin_output_style_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "concise" }),
  });
  assert(disabledDefaultOutputStyleRead.response.status >= 400, "plugin_output_style_read should hide disabled plugins by default");
  const disabledIncludedOutputStyleRead = await request("/tools/plugin_output_style_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", name: "concise", includeDisabled: true }),
  });
  assert(disabledIncludedOutputStyleRead.payload?.data?.outputStyle?.plugin === "feature-dev", "plugin_output_style_read includeDisabled should read disabled plugin styles");
  const disabledDefaultHooks = await request("/tools/plugin_hook_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 50 }),
  });
  assert(!disabledDefaultHooks.payload?.data?.hooks?.some((hook) => hook?.plugin === "feature-dev"), "plugin_hook_list should hide disabled plugins by default");
  const disabledIncludedHooks = await request("/tools/plugin_hook_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeDisabled: true, maxResults: 50 }),
  });
  assert(disabledIncludedHooks.payload?.data?.hooks?.some((hook) => hook?.plugin === "feature-dev"), "plugin_hook_list includeDisabled should include disabled plugins");
  const disabledDefaultCapabilities = await request("/tools/plugin_capability_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 50 }),
  });
  assert(!disabledDefaultCapabilities.payload?.data?.capabilities?.some((capability) => capability?.plugin === "feature-dev"), "plugin_capability_list should hide disabled plugins by default");
  const disabledIncludedCapabilities = await request("/tools/plugin_capability_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeDisabled: true, maxResults: 50 }),
  });
  assert(disabledIncludedCapabilities.payload?.data?.capabilities?.some((capability) => capability?.plugin === "feature-dev"), "plugin_capability_list includeDisabled should include disabled plugins");
  const disabledCapabilityRead = await request("/tools/plugin_capability_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev" }),
  });
  assert(disabledCapabilityRead.response.status >= 400, "plugin_capability_read should hide disabled plugins by default");
  const disabledIncludedCapabilityRead = await request("/tools/plugin_capability_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev", includeDisabled: true }),
  });
  assert(disabledIncludedCapabilityRead.payload?.data?.capability?.disabled === true, "plugin_capability_read includeDisabled should read disabled plugins");
  const pluginEnable = await request("/tools/plugin_enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "feature-dev" }),
  });
  assert(pluginEnable.payload?.data?.enabled === true, "plugin_enable should re-enable a disabled plugin");
  const enabledPluginList = await request("/tools/plugin_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 10 }),
  });
  const enabledPlugin = enabledPluginList.payload?.data?.plugins?.find((plugin) => plugin?.name === "feature-dev");
  assert(enabledPlugin?.enabled === true && enabledPlugin?.disabled === false, "plugin_list should report re-enabled plugin state");
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "plugin-sources/import-me/.claude-plugin/plugin.json", content: JSON.stringify({ name: "import-me", version: "0.0.1", description: "Imported plugin" }, null, 2) }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "plugin-sources/import-me/commands/import.md", content: "# Import command\n\nimport command marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "plugin-sources/import-me/scripts/import.sh", content: "#!/bin/sh\nprintf 'imported plugin script marker\\n'\n" }),
  });
  const pluginInstall = await request("/tools/plugin_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "plugin-sources/import-me", targetName: "imported-demo" }),
  });
  assert(pluginInstall.payload?.data?.installed === true, "plugin_install should install a workspace plugin source");
  assert(pluginInstall.payload?.data?.path === ".oases/plugins/imported-demo/.claude-plugin/plugin.json", "plugin_install should report installed manifest path");
  assert(pluginInstall.payload?.data?.plugin?.commands?.includes(".oases/plugins/imported-demo/commands/import.md"), "plugin_install should summarize installed plugin commands");
  const installedPluginRead = await request("/tools/plugin_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "import-me", maxChars: 4000 }),
  });
  assert(installedPluginRead.payload?.data?.plugin?.root === ".oases/plugins/imported-demo", "plugin_read should read installed plugin by manifest name");
  const installedPluginAsset = await request("/tools/plugin_asset_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: "import-me", assetPath: "scripts/import.sh", maxChars: 4000 }),
  });
  assert(installedPluginAsset.payload?.data?.content?.includes("imported plugin script marker"), "plugin_install should copy plugin script assets");
  const duplicatePluginInstall = await request("/tools/plugin_install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "plugin-sources/import-me", targetName: "imported-demo" }),
  });
  assert(duplicatePluginInstall.response.status >= 400, "plugin_install should refuse to overwrite existing workspace plugins");
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/not-a-plugin/README.md", content: "# Not a plugin\n" }),
  });
  const pluginRemoveNonPlugin = await request("/tools/plugin_remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/plugins/not-a-plugin" }),
  });
  assert(pluginRemoveNonPlugin.response.status >= 400, "plugin_remove should reject directories without a plugin manifest");
  const pluginRemoveBlocked = await request("/tools/plugin_remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(pluginRemoveBlocked.response.status >= 400, "plugin_remove should reject paths outside .oases/plugins");
  const pluginRemove = await request("/tools/plugin_remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "import-me" }),
  });
  assert(pluginRemove.payload?.data?.removed === true, "plugin_remove should remove an installed plugin");
  assert(pluginRemove.payload?.data?.path === ".oases/plugins/imported-demo", "plugin_remove should report the removed plugin directory");
  const pluginListAfterRemove = await request("/tools/plugin_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 50 }),
  });
  assert(!pluginListAfterRemove.payload?.data?.plugins?.some((plugin) => plugin.root === ".oases/plugins/imported-demo"), "plugin_remove should remove the plugin from plugin_list");
  const pluginReadBlocked = await request("/tools/plugin_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(pluginReadBlocked.response.status >= 400, "plugin_read should reject paths outside .oases/plugins");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/reviewer.md", content: "---\nname: reviewer\ndescription: reviewer-check\nagentType: verify\nmaxTurns: 4\n---\n\n# Workspace Reviewer\n\ncustom reviewer marker\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/reader.md", content: "---\nname: reader\ndescription: reader-check\nagentType: explore\ntools: read_file, write_file\ndisallowedTools: write_file\n---\n\n# Workspace Reader\n\nOnly read project files. Never write files.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/skilled.md", content: "---\nname: skilled\ndescription: skilled-check\nagentType: verify\nskills: research\n---\n\n# Skilled Agent\n\nUse preloaded skills before answering.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/commanded.md", content: "---\nname: commanded\ndescription: commanded-check\nagentType: verify\ncommands: review-flow\nmemories: project:testing-policy\n---\n\n# Commanded Agent\n\nUse preloaded command templates before answering.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/starter.md", content: "---\nname: starter\ndescription: starter-check\nagentType: general\ninitialPrompt: initial prompt marker\n---\n\n# Starter Agent\n\nUse the initial prompt before handling the assigned task.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/yamlstarter.md", content: "---\nname: yamlstarter\ndescription: yamlstarter-check\nagentType: verify\ntools:\n  - read_file\n  - write_file\ndisallowedTools:\n  - write_file\nskills:\n  - research\ninitialPrompt: |\n  yaml block prompt marker\n  second seeded line\n---\n\n# YAML Starter Agent\n\nUse YAML frontmatter fields before answering.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/effortful.md", content: "---\nname: effortful\ndescription: effort-check\nagentType: verify\neffort: low\n---\n\n# Effortful Agent\n\nUse the configured effort level for this sub-agent.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/mcpreader.md", content: "---\nname: mcpreader\ndescription: mcp-reader-check\nagentType: verify\ntools: mcp_call\nmcpTools: docs/search_docs\n---\n\n# MCP Reader Agent\n\nOnly call the approved docs/search_docs MCP tool.\n" }),
  });
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/agents/mcpblocked.md", content: "---\nname: mcpblocked\ndescription: mcp-blocked-check\nagentType: verify\ntools: mcp_call\ndisallowedMcpTools: docs/search_docs\n---\n\n# MCP Blocked Agent\n\nTry the denied docs/search_docs MCP tool so the runtime proves enforcement.\n" }),
  });
  const agentWrite = await request("/tools/agent_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "maintainer",
      title: "Maintainer Agent",
      description: "maintainer-check",
      agentType: "plan",
      maxTurns: 5,
      background: true,
      isolation: "worktree",
      effort: "medium",
      tools: ["read_file", "grep_files", "workspace_status", "agent_status"],
      disallowedTools: "delete_file",
      mcpTools: ["docs/search_docs"],
      disallowedMcpTools: "payments/send_money",
      skills: ["research"],
      commands: ["review-flow"],
      memories: ["project:testing-policy"],
      initialPrompt: "maintainer initial marker\nsecond maintainer line",
      prompt: "Use project context to plan safe maintenance work.\n\nmaintainer prompt marker",
    }),
  });
  assert(agentWrite.payload?.ok === true, "agent_write should create structured custom agents");
  assert(agentWrite.payload?.data?.path === ".oases/agents/maintainer.md", "agent_write should write under .oases/agents");
  assert(agentWrite.payload?.data?.artifacts?.[0]?.role === "agent_file", "agent_write should return an agent artifact");
  assert(agentWrite.payload?.data?.agent?.agentType === "plan", "agent_write should return parsed agent metadata");
  assert(agentWrite.payload?.data?.agent?.tools?.includes("workspace_status"), "agent_write should persist tool allowlist metadata");
  assert(agentWrite.payload?.data?.agent?.disallowedTools?.includes("delete_file"), "agent_write should persist disallowed tool metadata");
  assert(agentWrite.payload?.data?.agent?.mcpTools?.includes("docs/search_docs"), "agent_write should persist MCP allowlist metadata");
  assert(agentWrite.payload?.data?.agent?.disallowedMcpTools?.includes("payments/send_money"), "agent_write should persist MCP denylist metadata");
  assert(String(agentWrite.payload?.data?.prompt || "").includes("maintainer prompt marker"), "agent_write should return the written prompt body");
  const duplicateAgentWrite = await request("/tools/agent_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "maintainer", prompt: "duplicate" }),
  });
  assert(duplicateAgentWrite.response.status >= 400, "agent_write should refuse to overwrite by default");
  const invalidAgentWrite = await request("/tools/agent_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../maintainer.md", prompt: "invalid" }),
  });
  assert(invalidAgentWrite.response.status >= 400, "agent_write should reject paths outside .oases/agents");
  const unknownToolAgentWrite = await request("/tools/agent_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bad-tools", tools: ["not_a_tool"], prompt: "invalid tools" }),
  });
  assert(unknownToolAgentWrite.response.status >= 400, "agent_write should reject unknown tool names");
  const agentFrameworkWrite = await request("/tools/agent_framework_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "research-stack",
      title: "Research Stack",
      description: "research stack framework marker",
      agents: ["reviewer"],
      skills: ["research"],
      commands: ["review-flow"],
      memories: ["project:testing-policy"],
      mcpTools: ["docs/search_docs"],
      mcpResources: ["docs://routing-guide"],
      agentRoles: ["reviewer: inspect project risks and call agent_run before final verification", "implementer: make scoped file changes only after context is loaded"],
      handoffs: ["orchestrator -> reviewer before final response", "reviewer -> orchestrator with risk findings"],
      verificationGates: ["all framework MCP/resource evidence reviewed", "final response cites generated artifact path"],
      routingTerms: ["agent framework routing smoke", "research stack"],
      prompt: "Use this framework when the task asks for the research-stack workflow.\n\nframework routing marker",
    }),
  });
  assert(agentFrameworkWrite.payload?.ok === true, "agent_framework_write should create structured frameworks");
  assert(agentFrameworkWrite.payload?.data?.path === ".oases/agent-frameworks/research-stack.md", "agent_framework_write should write under .oases/agent-frameworks");
  assert(agentFrameworkWrite.payload?.data?.artifacts?.[0]?.role === "agent_framework_file", "agent_framework_write should return a framework artifact");
  assert(agentFrameworkWrite.payload?.data?.framework?.skills?.includes("research"), "agent_framework_write should persist skill dependencies");
  assert(agentFrameworkWrite.payload?.data?.framework?.memories?.includes("project:testing-policy"), "agent_framework_write should persist memory dependencies");
  assert(agentFrameworkWrite.payload?.data?.framework?.mcpTools?.includes("docs/search_docs"), "agent_framework_write should persist MCP tool dependencies");
  assert(agentFrameworkWrite.payload?.data?.framework?.mcpResources?.includes("docs://routing-guide"), "agent_framework_write should persist MCP resource dependencies");
  assert(agentFrameworkWrite.payload?.data?.framework?.agentRoles?.some((item) => item.includes("reviewer:")), "agent_framework_write should persist agent role blueprint entries");
  assert(agentFrameworkWrite.payload?.data?.framework?.handoffs?.some((item) => item.includes("orchestrator -> reviewer")), "agent_framework_write should persist handoff blueprint entries");
  assert(agentFrameworkWrite.payload?.data?.framework?.verificationGates?.some((item) => item.includes("artifact path")), "agent_framework_write should persist verification gates");
  const agentFrameworkList = await request("/tools/agent_framework_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 12 }),
  });
  assert(agentFrameworkList.payload?.data?.frameworks?.some((framework) => framework?.name === "research-stack" && framework?.agents?.includes("reviewer") && framework?.mcpResources?.includes("docs://routing-guide")), "agent_framework_list should discover workspace-local frameworks");
  assert(agentFrameworkList.payload?.data?.frameworks?.some((framework) => framework?.name === "research-stack" && framework?.agentRoles?.some((item) => item.includes("implementer:"))), "agent_framework_list should expose framework agent roles");
  const agentFrameworkRead = await request("/tools/agent_framework_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "research-stack" }),
  });
  assert(agentFrameworkRead.payload?.data?.content?.includes("framework routing marker"), "agent_framework_read should read framework content by name");
  assert(agentFrameworkRead.payload?.data?.framework?.commands?.includes("review-flow"), "agent_framework_read should expose command dependencies");
  assert(agentFrameworkRead.payload?.data?.framework?.mcpTools?.includes("docs/search_docs"), "agent_framework_read should expose MCP tool dependencies");
  assert(agentFrameworkRead.payload?.data?.framework?.mcpResources?.includes("docs://routing-guide"), "agent_framework_read should expose MCP resource dependencies");
  assert(agentFrameworkRead.payload?.data?.framework?.handoffs?.some((item) => item.includes("reviewer -> orchestrator")), "agent_framework_read should expose handoff blueprint entries");
  const agentList = await request("/tools/agent_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 12 }),
  });
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "reviewer" && agent?.path === ".oases/agents/reviewer.md"), "agent_list should discover workspace-local agents");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "reader" && agent?.tools?.includes("read_file")), "agent_list should expose custom agent tool metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "skilled" && agent?.skills?.includes("research")), "agent_list should expose custom agent skill metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "commanded" && agent?.commands?.includes("review-flow") && agent?.memories?.includes("project:testing-policy")), "agent_list should expose custom agent command and memory metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "starter" && agent?.initialPrompt === "initial prompt marker"), "agent_list should expose custom agent initialPrompt metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "yamlstarter" && agent?.tools?.includes("read_file") && agent?.disallowedTools?.includes("write_file") && agent?.skills?.includes("research") && String(agent?.initialPrompt || "").includes("second seeded line")), "agent_list should expose YAML list and block scalar custom agent metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "effortful" && agent?.effort === "low"), "agent_list should expose custom agent effort metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "mcpreader" && agent?.mcpTools?.includes("docs/search_docs")), "agent_list should expose custom agent MCP allowlist metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "mcpblocked" && agent?.disallowedMcpTools?.includes("docs/search_docs")), "agent_list should expose custom agent MCP denylist metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "maintainer" && agent?.background === true && agent?.isolation === "worktree" && agent?.effort === "medium" && agent?.commands?.includes("review-flow") && agent?.mcpTools?.includes("docs/search_docs")), "agent_list should expose agent_write structured metadata");
  const agentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "reviewer" }),
  });
  assert(agentRead.payload?.data?.content?.includes("custom reviewer marker"), "agent_read should read agent content by name");
  assert(agentRead.payload?.data?.agent?.agentType === "verify", "agent_read should expose custom agent metadata");
  const commandedAgentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "commanded" }),
  });
  assert(commandedAgentRead.payload?.data?.agent?.commands?.includes("review-flow"), "agent_read should expose custom agent command metadata");
  assert(commandedAgentRead.payload?.data?.agent?.memories?.includes("project:testing-policy"), "agent_read should expose custom agent memory metadata");
  const starterAgentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "starter" }),
  });
  assert(starterAgentRead.payload?.data?.agent?.initialPrompt === "initial prompt marker", "agent_read should expose custom agent initialPrompt metadata");
  const yamlStarterAgentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "yamlstarter" }),
  });
  assert(yamlStarterAgentRead.payload?.data?.agent?.tools?.includes("read_file"), "agent_read should parse YAML tool lists");
  assert(yamlStarterAgentRead.payload?.data?.agent?.disallowedTools?.includes("write_file"), "agent_read should parse YAML disallowed tool lists");
  assert(yamlStarterAgentRead.payload?.data?.agent?.skills?.includes("research"), "agent_read should parse YAML skill lists");
  assert(String(yamlStarterAgentRead.payload?.data?.agent?.initialPrompt || "").includes("yaml block prompt marker\nsecond seeded line"), "agent_read should parse YAML block scalar initialPrompt");
  const effortfulAgentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "effortful" }),
  });
  assert(effortfulAgentRead.payload?.data?.agent?.effort === "low", "agent_read should expose custom agent effort metadata");
  const mcpReaderAgentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "mcpreader" }),
  });
  assert(mcpReaderAgentRead.payload?.data?.agent?.mcpTools?.includes("docs/search_docs"), "agent_read should expose custom agent MCP allowlist metadata");
  const maintainerAgentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "maintainer" }),
  });
  assert(String(maintainerAgentRead.payload?.data?.agent?.initialPrompt || "").includes("second maintainer line"), "agent_read should expose agent_write block initialPrompt metadata");
  assert(maintainerAgentRead.payload?.data?.agent?.memories?.includes("project:testing-policy"), "agent_read should expose agent_write memory metadata");
  const agentReadBlocked = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(agentReadBlocked.response.status >= 400, "agent_read should reject paths outside .oases/agents");

  const edit = await request("/tools/edit_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/hello.txt", oldText: "hello", newText: "hello precise" }),
  });
  assert(edit.payload?.ok === true, "edit_file should succeed for a single exact match");
  assert(edit.payload?.data?.replacements === 1, "edit_file should report one replacement");
  assert(String(edit.payload?.data?.diff || "").includes("+hello precise"), "edit_file should return a diff preview");
  assert(edit.payload?.data?.artifacts?.[0]?.path === "smoke/hello.txt", "edit_file should return an artifact for the edited file");

  const editedRead = await request("/tools/read_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/hello.txt" }),
  });
  assert(editedRead.payload?.data?.content === "hello precise ocli", "read_file should return edited content");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/numbered.txt", content: "one\ntwo\nthree\nfour\n" }),
  });
  const rangedRead = await request("/tools/read_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/numbered.txt", offset: 1, limit: 2, numbered: true }),
  });
  assert(rangedRead.payload?.data?.startLine === 2 && rangedRead.payload?.data?.endLine === 3, "read_file should report requested line range");
  assert(String(rangedRead.payload?.data?.content || "").includes("     2\ttwo"), "read_file should return cat -n style numbered lines");
  assert(!String(rangedRead.payload?.data?.content || "").includes("four"), "read_file ranged content should not include lines outside the requested range");

  await runLocal("git", ["init"]);
  await runLocal("git", ["config", "user.email", "ocli-smoke@example.local"]);
  await runLocal("git", ["config", "user.name", "Oases ocli smoke"]);
  await runLocal("git", ["add", "."]);
  await runLocal("git", ["commit", "-m", "baseline"]);

  const auditedEdit = await request("/tools/edit_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/hello.txt", oldText: "hello precise", newText: "hello audited" }),
  });
  assert(auditedEdit.payload?.ok === true, "edit_file should create a git-visible modification");
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/untracked.md", content: "# untracked preview\n" }),
  });
  const workspaceStatus = await request("/tools/workspace_status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeDiff: true, includeUntrackedPreview: true, maxChars: 20000 }),
  });
  assert(workspaceStatus.payload?.data?.isGitRepo === true, "workspace_status should detect git repositories");
  assert(workspaceStatus.payload?.data?.status?.some((item) => item.status.trim() === "M" && item.path === "smoke/hello.txt"), "workspace_status should report modified files");
  assert(workspaceStatus.payload?.data?.status?.some((item) => item.status === "??" && item.path === "smoke/untracked.md"), "workspace_status should report untracked files");
  assert(String(workspaceStatus.payload?.data?.diff || "").includes("hello audited ocli"), "workspace_status should include workspace diff text");
  assert(workspaceStatus.payload?.data?.untrackedPreviews?.some((item) => item.path === "smoke/untracked.md" && String(item.content).includes("untracked preview")), "workspace_status should include requested untracked previews");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/duplicate.txt", content: "same\nsame\n" }),
  });
  const duplicateEdit = await request("/tools/edit_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "smoke/duplicate.txt", oldText: "same", newText: "changed" }),
  });
  assert(duplicateEdit.response.status >= 400, "edit_file should reject ambiguous duplicate matches by default");
  assert(String(duplicateEdit.payload?.error || "").includes("matched 2 times"), "ambiguous edit_file error should explain duplicate matches");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "src/search-target.ts", content: "export const marker = 'search smoke marker';\n" }),
  });

  const glob = await request("/tools/glob_files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ glob: "src/**/*.ts", maxResults: 20 }),
  });
  assert(glob.payload?.data?.matches?.some((item) => item.path === "src/search-target.ts"), "glob_files should find matching workspace paths by glob");

  const fileSearch = await request("/tools/search_files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "search-target", maxResults: 20 }),
  });
  assert(fileSearch.payload?.data?.matches?.some((item) => item.path === "src/search-target.ts"), "search_files should find matching workspace paths");

  const grep = await request("/tools/grep_files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "search smoke marker", pattern: "*.ts", maxResults: 20 }),
  });
  assert(grep.payload?.data?.matches?.some((item) => item.path === "src/search-target.ts" && item.line === 1), "grep_files should find matching file contents");

  const regexGrep = await request("/tools/grep_files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ regex: "marker\\s*=\\s*'search", glob: "src/**/*.ts", outputMode: "files_with_matches", maxResults: 20 }),
  });
  assert(regexGrep.payload?.data?.useRegex === true, "grep_files should support regex mode");
  assert(regexGrep.payload?.data?.matches?.some((item) => item.path === "src/search-target.ts"), "grep_files regex files_with_matches mode should return matching file paths");

  const countGrep = await request("/tools/grep_files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "search", type: "ts", outputMode: "count", maxResults: 20 }),
  });
  assert(countGrep.payload?.data?.matches?.some((item) => item.path === "src/search-target.ts" && item.count >= 1), "grep_files count mode should return per-file match counts");

  const todoWrite = await request("/tools/todo_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      todos: [
        { text: "Fetch source pages", status: "done" },
        { text: "Write crawler code", status: "doing" },
        { text: "Export dataset", status: "todo" },
      ],
    }),
  });
  assert(todoWrite.payload?.ok === true, "todo_write should succeed");
  assert(todoWrite.payload?.data?.count === 3, "todo_write should return todo count");
  assert(todoWrite.payload?.data?.todos?.[1]?.status === "doing", "todo_write should preserve todo status");
  assert(String(todoWrite.payload?.data?.summary || "").includes("Write crawler code"), "todo_write should return a readable summary");
  const todoClear = await request("/tools/todo_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      todos: todoWrite.payload.data.todos.map((todo) => ({ ...todo, status: "done" })),
    }),
  });
  assert(todoClear.payload?.ok === true, "todo_write should clear seeded tool-test todos before agent session smoke");

  const python = await request("/tools/run_python", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: "from pathlib import Path; Path('generated').mkdir(exist_ok=True); Path('generated/data.json').write_text('{\"ok\": true}', encoding='utf8'); print('python smoke ok')" }),
  });
  assert(python.payload?.data?.stdout?.includes("python smoke ok"), "run_python should execute inside workspace");
  assert(python.payload?.data?.artifacts?.some((artifact) => artifact?.path === "generated/data.json"), "run_python should report generated file artifacts");

  const dangerousCommand = await request("/tools/run_command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "git reset --hard HEAD" }),
  });
  assert(dangerousCommand.response.status >= 400, "run_command should block known destructive commands before execution");
  assert(String(dangerousCommand.payload?.error || "").includes("Command blocked by ocli safety rules"), "dangerous run_command error should explain the safety block");

  const missingModel = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiBaseUrl: "https://www.oasesai.xyz/api/oases/v1", messages: [] }),
  });
  assert(missingModel.response.status === 500, "agent session without a web-provided model should fail fast");
  assert(String(missingModel.payload?.error || "").includes("model provided by Oases Web"), "missing model error should name the web-owned model contract");

  const started = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli smoke system prompt",
      messages: [{ role: "user", content: "complete the smoke test" }],
    }),
  });
  assert(started.response.status === 202, "agent session with web-provided model should start");
  const sessionId = started.payload?.data?.id;
  assert(typeof sessionId === "string", "started session should have an id");
  const completed = await waitForSessionDone(sessionId);
  assert(completed?.data?.status === "completed", "agent session should complete against fake API");
  assert(completed?.data?.model === "deepseek-v4-pro", "session summary should retain web-provided model");

  const sessionDir = path.join(workspace, ".oases", "ocli", "sessions", sessionId);
  const metadata = await readJsonEventually(path.join(sessionDir, "metadata.json"), (value) => value?.status === "completed");
  const result = await readJsonEventually(path.join(sessionDir, "result.json"), (value) => value?.status === "completed" || value?.result);
  const events = await readTextEventually(path.join(sessionDir, "events.ndjson"));
  assert(metadata.model === "deepseek-v4-pro", "persisted metadata should retain web-provided model");
  assert(metadata.status === "completed", "persisted metadata should mark completed session");
  assert(result.result?.finalText?.includes("persistence smoke completed"), "persisted result should include final text");
  assert(events.includes('"type":"started"') && events.includes('"type":"done"'), "persisted events should include started and done events");

  const listed = await request("/agent/sessions");
  assert(listed.payload?.data?.sessions?.some((session) => session.id === sessionId), "session list should include persisted/live session summary");

  const healthWithSessions = await request("/health");
  assert(healthWithSessions.payload?.sessionCount >= 1, "/health should expose total local agent session count");
  assert(healthWithSessions.payload?.activeSessionCount === 0, "/health should expose active local agent session count");
  assert(healthWithSessions.payload?.latestSession?.id === sessionId, "/health should expose the latest local agent session summary");
  assert(healthWithSessions.payload?.latestSession?.status === "completed", "/health latest session should include status");

  const kimiModelProfileStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "kimi-k2.6",
      systemPrompt: "ocli Kimi model profile smoke prompt",
      messages: [{ role: "user", content: "kimi model profile smoke" }],
      maxTurns: 1,
    }),
  });
  assert(kimiModelProfileStarted.response.status === 202, "Kimi model profile smoke session should start");
  const kimiModelProfileCompleted = await waitForSessionDone(kimiModelProfileStarted.payload?.data?.id);
  assert(kimiModelProfileCompleted?.data?.status === "completed", "Kimi model profile smoke session should complete");
  assert(kimiModelProfileCompleted?.data?.result?.finalText?.includes("kimi model profile smoke completed"), "Kimi model profile smoke should reach final response");
  assert(kimiModelProfileCompleted?.data?.result?.modelRequestProfile?.temperature === 1, "Kimi model profile should record fixed temperature=1");
  assert(kimiModelProfileCompleted?.data?.result?.modelRequestProfile?.supportsEffort === false, "Kimi model profile should omit effort fields");
  assert(kimiModelProfileCompleted?.events?.some((event) => event?.type === "model_request_profile" && event?.temperaturePolicy === "fixed" && event?.supportsEffort === false), "Kimi model profile event should expose the fixed no-effort policy");

  const gptModelProfileStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "gpt-5.4",
      systemPrompt: "ocli GPT model profile smoke prompt",
      messages: [{ role: "user", content: "gpt model profile smoke" }],
      maxTurns: 1,
    }),
  });
  assert(gptModelProfileStarted.response.status === 202, "GPT model profile smoke session should start");
  const gptModelProfileCompleted = await waitForSessionDone(gptModelProfileStarted.payload?.data?.id);
  assert(gptModelProfileCompleted?.data?.status === "completed", "GPT model profile smoke session should complete");
  assert(gptModelProfileCompleted?.data?.result?.finalText?.includes("gpt model profile smoke completed"), "GPT model profile smoke should reach final response");
  assert(gptModelProfileCompleted?.data?.result?.modelRequestProfile?.temperature === 1, "GPT model profile should record fixed temperature=1");
  assert(gptModelProfileCompleted?.data?.result?.modelRequestProfile?.effort === "high", "GPT model profile should retain the default high effort");

  const modelRetryStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli model retry smoke prompt",
      messages: [{ role: "user", content: "model retry smoke" }],
      maxTurns: 1,
    }),
  });
  assert(modelRetryStarted.response.status === 202, "model retry smoke session should start");
  const modelRetryCompleted = await waitForSessionDone(modelRetryStarted.payload?.data?.id);
  assert(modelRetryCompleted?.data?.status === "completed", "model retry smoke session should complete after retry");
  assert(modelRetryCompleted?.data?.result?.finalText?.includes("model retry smoke completed"), "model retry smoke should reach final response");
  assert(modelRetryCompleted?.data?.result?.modelRequestRetryCount === 1, "model retry smoke should record one model request retry");
  assert(modelRetryCompleted?.events?.some((event) => event?.type === "model_request_retry" && event?.status === 500 && event?.nextAttempt === 2), "model retry smoke should emit retry telemetry");
  assert(modelRetryCompleted?.events?.some((event) => event?.type === "model_request_recovered" && event?.retryCount === 1), "model retry smoke should emit recovery telemetry");

  const modelRepairStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "repair-temp-smoke",
      systemPrompt: "ocli model repair smoke prompt",
      messages: [{ role: "user", content: "model repair smoke" }],
      maxTurns: 1,
    }),
  });
  assert(modelRepairStarted.response.status === 202, "model repair smoke session should start");
  const modelRepairCompleted = await waitForSessionDone(modelRepairStarted.payload?.data?.id);
  assert(modelRepairCompleted?.data?.status === "completed", "model repair smoke session should complete after parameter repair");
  assert(modelRepairCompleted?.data?.result?.finalText?.includes("model repair smoke completed"), "model repair smoke should reach final response");
  assert(modelRepairCompleted?.data?.result?.modelRequestRepairCount === 1, "model repair smoke should record one model request repair");
  assert(!modelRepairCompleted?.data?.result?.modelRequestRetryCount, "model repair smoke should not count parameter repair as transient retry");
  assert(modelRepairCompleted?.data?.result?.modelRequestRepairs?.some((repair) => repair?.key === "temperature_fixed_1" && repair?.changedKeys?.includes("temperature")), "model repair smoke should record temperature repair metadata");
  assert(modelRepairCompleted?.events?.some((event) => event?.type === "model_request_repair" && event?.status === 400 && event?.repair?.key === "temperature_fixed_1" && event?.changedKeys?.includes("temperature")), "model repair smoke should emit repair telemetry");
  assert(modelRepairCompleted?.events?.some((event) => event?.type === "model_request_recovered" && event?.repairCount === 1 && event?.retryCount === 0), "model repair smoke should emit recovery telemetry with repair count");

  const modelEffortRepairStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "gpt-5.4",
      systemPrompt: "ocli model effort repair smoke prompt",
      messages: [{ role: "user", content: "model effort repair smoke" }],
      maxTurns: 1,
    }),
  });
  assert(modelEffortRepairStarted.response.status === 202, "model effort repair smoke session should start");
  const modelEffortRepairCompleted = await waitForSessionDone(modelEffortRepairStarted.payload?.data?.id);
  assert(modelEffortRepairCompleted?.data?.status === "completed", "model effort repair smoke session should complete after effort repair");
  assert(modelEffortRepairCompleted?.data?.result?.finalText?.includes("model effort repair smoke completed"), "model effort repair smoke should reach final response");
  assert(modelEffortRepairCompleted?.data?.result?.modelRequestRepairCount === 1, "model effort repair smoke should record one model request repair");
  assert(modelEffortRepairCompleted?.data?.result?.modelRequestRepairs?.some((repair) => repair?.key === "effort_removed" && repair?.removedKeys?.includes("reasoning_effort")), "model effort repair smoke should record effort removal metadata");
  assert(modelEffortRepairCompleted?.events?.some((event) => event?.type === "model_request_repair" && event?.repair?.key === "effort_removed" && event?.removedKeys?.includes("effort") && event?.removedKeys?.includes("reasoning_effort")), "model effort repair smoke should emit effort removal telemetry");

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  child = startOcliServer();
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  await waitForServer(child);

  const persistedDetail = await request(`/agent/sessions/${encodeURIComponent(sessionId)}`);
  assert(persistedDetail.response.ok, "persisted session detail should be available after ocli restart");
  assert(persistedDetail.payload?.data?.id === sessionId, "persisted session detail should include session id");
  assert(persistedDetail.payload?.data?.status === "completed", "persisted session detail should include status");
  assert(Array.isArray(persistedDetail.payload?.events) && persistedDetail.payload.events.some((event) => event?.type === "done"), "persisted session detail should include persisted events");
  assert(persistedDetail.payload?.eventCounts?.done === 1, "persisted session detail should include event counts");
  assert(Array.isArray(persistedDetail.payload?.toolResults), "persisted session detail should include tool result summaries");

  const resumedSession = await request(`/agent/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(resumedSession.response.status === 202, "resume endpoint should start a new agent session");
  const resumedSessionId = resumedSession.payload?.data?.id;
  assert(typeof resumedSessionId === "string" && resumedSessionId !== sessionId, "resume endpoint should create a distinct session id");
  assert(resumedSession.payload?.data?.resumedFromSessionId === sessionId, "resumed session summary should point to the source session");
  const resumedCompleted = await waitForSessionDone(resumedSessionId);
  assert(resumedCompleted?.data?.status === "completed", "resumed session should complete");
  assert(resumedCompleted?.data?.resumedFromSessionId === sessionId, "resumed session detail should retain source session id");
  assert(resumedCompleted?.data?.result?.finalText?.includes("resume endpoint smoke completed"), `resumed session should run from the generated resume prompt: ${JSON.stringify({ finalText: resumedCompleted?.data?.result?.finalText, events: resumedCompleted?.events }, null, 2)}`);
  assert(resumedCompleted?.events?.some((event) => event?.type === "session_resumed" && event?.resumedFromSessionId === sessionId), "resumed session should persist a session_resumed event");

  const failedRecoveryStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli failed recovery smoke prompt",
      messages: [{ role: "user", content: "failed recovery smoke" }],
      maxTurns: 2,
    }),
  });
  assert(failedRecoveryStarted.response.status === 202, "failed recovery smoke session should start");
  const failedRecoverySessionId = failedRecoveryStarted.payload?.data?.id;
  assert(typeof failedRecoverySessionId === "string", "failed recovery smoke session should have an id");
  const failedRecoveryDetail = await waitForSessionDone(failedRecoverySessionId);
  assert(failedRecoveryDetail?.data?.status === "failed", "failed recovery source session should fail before resume");
  assert(failedRecoveryDetail?.data?.needsContinuation === true, "failed recovery source session should need continuation");
  assert(failedRecoveryDetail?.data?.stoppedReason === "failed", "failed recovery source session should expose failed stoppedReason");
  assert(String(failedRecoveryDetail?.data?.error || "").includes("recoverable model outage for failed recovery smoke"), "failed recovery source session should preserve the model error");
  assert(String(failedRecoveryDetail?.resumePrompt || "").includes("上次错误：") && String(failedRecoveryDetail?.resumePrompt || "").includes("recoverable model outage for failed recovery smoke"), "failed recovery detail should include the source error in resume prompt");
  const failedRecoveryHealth = await request("/health");
  assert(failedRecoveryHealth.payload?.latestSession?.id === failedRecoverySessionId, "health latest session should be the failed recovery source session");
  assert(failedRecoveryHealth.payload?.latestSession?.needsContinuation === true && failedRecoveryHealth.payload?.latestSession?.stoppedReason === "failed", "health should expose failed sessions as needing continuation");
  const failedRecoveryList = await request("/agent/sessions");
  const listedFailedRecovery = failedRecoveryList.payload?.data?.sessions?.find((session) => session?.id === failedRecoverySessionId);
  assert(listedFailedRecovery?.needsContinuation === true && listedFailedRecovery?.stoppedReason === "failed", "session list should expose failed sessions needing continuation");
  const failedRecoveryResumed = await request(`/agent/sessions/${encodeURIComponent(failedRecoverySessionId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(failedRecoveryResumed.response.status === 202, "failed recovery resume endpoint should start a new session");
  const failedRecoveryResumedId = failedRecoveryResumed.payload?.data?.id;
  assert(typeof failedRecoveryResumedId === "string" && failedRecoveryResumedId !== failedRecoverySessionId, "failed recovery resume should create a distinct session");
  assert(failedRecoveryResumed.payload?.data?.resumedFromSessionId === failedRecoverySessionId, "failed recovery resumed session should point to the failed source");
  const failedRecoveryCompleted = await waitForSessionDone(failedRecoveryResumedId);
  assert(failedRecoveryCompleted?.data?.status === "completed", "failed recovery resumed session should complete");
  assert(failedRecoveryCompleted?.data?.result?.finalText?.includes("failed recovery resume completed"), "failed recovery resume should reach the model recovery response");
  assert(failedRecoveryCompleted?.events?.some((event) => event?.type === "session_resumed" && event?.resumedFromSessionId === failedRecoverySessionId), "failed recovery resume should persist session_resumed event");

  const nativeToolStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli native tool call smoke prompt",
      messages: [{ role: "user", content: "native tool call smoke" }],
    }),
  });
  assert(nativeToolStarted.response.status === 202, "native tool call smoke session should start");
  const nativeToolSessionId = nativeToolStarted.payload?.data?.id;
  assert(typeof nativeToolSessionId === "string", "native tool call smoke session should have an id");
  const nativeToolCompleted = await waitForSessionDone(nativeToolSessionId);
  assert(nativeToolCompleted?.data?.status === "completed", "native tool call smoke session should complete");
  assert(nativeToolCompleted?.data?.result?.finalText?.includes("native tool call smoke completed"), "native tool call smoke should complete after tool execution");
  assert(nativeToolCompleted?.data?.result?.toolResults?.some((result) => result?.name === "write_file" && result?.artifacts?.[0]?.path === "native/tool-call.txt"), "agent tool results should preserve file artifacts");
  const nativeToolFile = await readTextEventually(path.join(workspace, "native", "tool-call.txt"));
  assert(nativeToolFile === "native streamed tool call ok", "native streamed tool call should write the requested file");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "src/delegation-target.txt", content: "delegation target marker\n" }),
  });
  const subagentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli subagent delegation smoke prompt",
      messages: [{ role: "user", content: "subagent delegation smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(subagentStarted.response.status === 202, "subagent delegation smoke session should start");
  const subagentCompleted = await waitForSessionDone(subagentStarted.payload?.data?.id);
  assert(subagentCompleted?.data?.status === "completed", "subagent delegation smoke session should complete");
  assert(subagentCompleted?.data?.result?.finalText?.includes("subagent delegation smoke completed"), "subagent delegation smoke should reach final response");
  assert(subagentCompleted?.data?.result?.toolResults?.some((result) => result?.name === "agent_run" && result?.data?.finalText?.includes("subagent found delegation target marker")), "agent_run should return the sub-agent final text to the parent agent");
  assert(subagentCompleted?.events?.some((event) => event?.type === "subagent_start"), "agent_run should emit subagent_start events");
  assert(subagentCompleted?.events?.some((event) => event?.type === "subagent_done"), "agent_run should emit subagent_done events");
  assert(subagentCompleted?.events?.some((event) => event?.type === "subagent_event" && event?.event?.type === "tool_result" && event?.event?.result?.name === "read_file"), "sub-agent tool events should be surfaced to the parent session");
  const subagentMemorySuggestion = subagentCompleted?.data?.result?.memoryMaintenance?.suggestion || {};
  assert(String(subagentMemorySuggestion?.content || "").includes("## Sub-agent Evidence"), "sub-agent memory suggestion should include sub-agent evidence");
  assert(String(subagentMemorySuggestion?.content || "").includes("subagent found delegation target marker"), "sub-agent memory suggestion should preserve the sub-agent final text");
  assert(subagentMemorySuggestion?.evidence?.subAgentCount >= 1, "sub-agent memory suggestion should count sub-agent evidence");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "src/custom-agent-target.txt", content: "custom target\n" }),
  });
  const customAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli custom agent smoke prompt",
      messages: [{ role: "user", content: "custom agent smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(customAgentStarted.response.status === 202, "custom agent smoke session should start");
  const customAgentCompleted = await waitForSessionDone(customAgentStarted.payload?.data?.id);
  assert(customAgentCompleted?.data?.status === "completed", "custom agent smoke session should complete");
  assert(customAgentCompleted?.data?.result?.finalText?.includes("custom agent smoke completed"), "custom agent smoke should reach final response");
  const customAgentResult = customAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "reviewer");
  assert(customAgentResult?.data?.customAgent?.path === ".oases/agents/reviewer.md", "agent_run should return custom agent metadata");
  assert(customAgentResult?.data?.agentType === "verify", "custom agent metadata should override the sub-agent role");
  assert(String(customAgentResult?.data?.finalText || "").includes("custom agent used custom reviewer marker"), "custom agent prompt should be injected into the sub-agent");
  assert(customAgentCompleted?.events?.some((event) => event?.type === "subagent_start" && event?.agentName === "reviewer"), "custom agent_run should emit subagent_start metadata");

  const autoAgentRoutingStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli auto agent routing smoke prompt",
      messages: [{ role: "user", content: "auto reviewer routing smoke: use reviewer custom agent to review src/custom-agent-target.txt." }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(autoAgentRoutingStarted.response.status === 202, "auto agent routing smoke session should start");
  const autoAgentRoutingCompleted = await waitForSessionDone(autoAgentRoutingStarted.payload?.data?.id);
  assert(autoAgentRoutingCompleted?.data?.status === "completed", "auto agent routing smoke session should complete");
  assert(autoAgentRoutingCompleted?.data?.result?.finalText?.includes("auto agent routing smoke completed"), "auto agent routing smoke should reach final response");
  assert(autoAgentRoutingCompleted?.events?.some((event) => event?.type === "agent_loaded" && event?.autoRouted === true && event?.agent?.name === "reviewer"), "auto capability routing should auto-load matching custom agents");
  assert(autoAgentRoutingCompleted?.data?.result?.capabilityRouting?.selected?.agents?.some((agent) => agent?.name === "reviewer" && agent?.path === ".oases/agents/reviewer.md"), "auto capability routing should record selected custom agents");
  assert(autoAgentRoutingCompleted?.data?.result?.activeAgents?.some((agent) => agent?.name === "reviewer"), "auto-routed custom agents should be recorded in the agent result");
  assert(autoAgentRoutingCompleted?.data?.result?.toolResults?.some((result) => result?.name === "agent_run" && result?.data?.agentName === "reviewer"), "auto-routed custom agent context should guide the model to delegate with agent_run");

  const pluginAgentDelegationStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli plugin agent delegation smoke prompt",
      messages: [{ role: "user", content: "plugin agent delegation smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(pluginAgentDelegationStarted.response.status === 202, "plugin agent delegation smoke session should start");
  const pluginAgentDelegationCompleted = await waitForSessionDone(pluginAgentDelegationStarted.payload?.data?.id);
  assert(pluginAgentDelegationCompleted?.data?.status === "completed", "plugin agent delegation smoke session should complete");
  assert(pluginAgentDelegationCompleted?.data?.result?.finalText?.includes("plugin agent delegation smoke completed"), "plugin agent delegation smoke should reach final response");
  const pluginAgentResult = pluginAgentDelegationCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "plugin-explorer");
  assert(pluginAgentResult?.data?.customAgent?.source === "plugin" && pluginAgentResult?.data?.customAgent?.plugin === "route-pack", "agent_run should load plugin agent metadata without installing it");
  assert(String(pluginAgentResult?.data?.finalText || "").includes("plugin direct agent saw plugin direct marker"), "plugin agent prompt should be injected into the delegated sub-agent");
  assert(pluginAgentResult?.data?.invokedSkills?.some((skill) => skill?.name === "plugin-route-helper" && skill?.source === "plugin"), "plugin agent declared plugin skills should preload into the sub-agent");

  const limitedCustomAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli limited custom agent smoke prompt",
      messages: [{ role: "user", content: "limited custom agent smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(limitedCustomAgentStarted.response.status === 202, "limited custom agent smoke session should start");
  const limitedCustomAgentCompleted = await waitForSessionDone(limitedCustomAgentStarted.payload?.data?.id);
  assert(limitedCustomAgentCompleted?.data?.status === "completed", "limited custom agent smoke session should complete");
  assert(limitedCustomAgentCompleted?.data?.result?.finalText?.includes("limited custom agent smoke completed"), "limited custom agent smoke should reach final response");
  const limitedCustomAgentResult = limitedCustomAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "reader");
  assert(limitedCustomAgentResult?.data?.customAgent?.tools?.includes("read_file"), "limited custom agent result should expose allowed tool metadata");
  assert(limitedCustomAgentResult?.data?.customAgent?.disallowedTools?.includes("write_file"), "limited custom agent result should expose disallowed tool metadata");
  assert(limitedCustomAgentResult?.data?.toolResults?.some((result) => result?.name === "write_file" && result?.ok === false && String(result?.message || "").includes("not allowed")), "limited custom agent should block disallowed manual tool calls");
  let restrictedWriteExists = false;
  try {
    await readFile(path.join(workspace, "restricted", "should-not-write.txt"), "utf8");
    restrictedWriteExists = true;
  } catch {
    restrictedWriteExists = false;
  }
  assert(!restrictedWriteExists, "limited custom agent should not write files blocked by its tool scope");

  const mcpAllowAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli custom agent MCP allow smoke prompt",
      messages: [{ role: "user", content: "custom agent mcp allow smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(mcpAllowAgentStarted.response.status === 202, "custom agent MCP allow smoke session should start");
  const mcpAllowAgentCompleted = await waitForSessionDone(mcpAllowAgentStarted.payload?.data?.id);
  assert(mcpAllowAgentCompleted?.data?.status === "completed", "custom agent MCP allow smoke session should complete");
  assert(mcpAllowAgentCompleted?.data?.result?.finalText?.includes("custom agent mcp allow smoke completed"), "custom agent MCP allow smoke should reach final response");
  const mcpAllowAgentResult = mcpAllowAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "mcpreader");
  assert(mcpAllowAgentResult?.data?.customAgent?.mcpTools?.includes("docs/search_docs"), "custom agent MCP allow result should expose declared MCP allowlist metadata");
  assert(mcpAllowAgentResult?.data?.toolResults?.some((result) => result?.name === "mcp_call" && result?.ok === true && result?.data?.server === "docs" && result?.data?.tool === "search_docs"), "custom agent MCP allowlist should permit matching MCP calls");

  const mcpDenyAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli custom agent MCP deny smoke prompt",
      messages: [{ role: "user", content: "custom agent mcp deny smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(mcpDenyAgentStarted.response.status === 202, "custom agent MCP deny smoke session should start");
  const mcpDenyAgentCompleted = await waitForSessionDone(mcpDenyAgentStarted.payload?.data?.id);
  assert(mcpDenyAgentCompleted?.data?.status === "completed", "custom agent MCP deny smoke session should complete");
  assert(
    mcpDenyAgentCompleted?.data?.result?.finalText?.includes("custom agent mcp deny smoke completed"),
    `custom agent MCP deny smoke should reach final response: ${JSON.stringify(mcpDenyAgentCompleted?.data?.result || {}, null, 2)}`,
  );
  const mcpDenyAgentResult = mcpDenyAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "mcpblocked");
  assert(mcpDenyAgentResult?.data?.customAgent?.disallowedMcpTools?.includes("docs/search_docs"), "custom agent MCP deny result should expose declared MCP denylist metadata");
  assert(mcpDenyAgentResult?.data?.toolResults?.some((result) => result?.name === "mcp_call" && result?.ok === false && String(result?.message || "").includes("MCP tool docs/search_docs is not allowed")), "custom agent MCP denylist should block matching MCP calls before execution");

  const skillPreloadAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli custom agent skill preload smoke prompt",
      messages: [{ role: "user", content: "custom agent skill preload smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(skillPreloadAgentStarted.response.status === 202, "custom agent skill preload smoke session should start");
  const skillPreloadAgentCompleted = await waitForSessionDone(skillPreloadAgentStarted.payload?.data?.id);
  assert(skillPreloadAgentCompleted?.data?.status === "completed", "custom agent skill preload smoke session should complete");
  assert(skillPreloadAgentCompleted?.data?.result?.finalText?.includes("custom agent skill preload smoke completed"), "custom agent skill preload smoke should reach final response");
  const skillPreloadAgentResult = skillPreloadAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "skilled");
  assert(skillPreloadAgentResult?.data?.customAgent?.skills?.includes("research"), "custom agent skill preload result should expose declared skill metadata");
  assert(skillPreloadAgentResult?.data?.invokedSkills?.some((skill) => skill?.name === "research" && skill?.path === ".oases/skills/research/SKILL.md"), "custom agent should report preloaded skills as invoked skills");
  assert(skillPreloadAgentCompleted?.events?.some((event) => event?.type === "subagent_event" && event?.event?.type === "skill_loaded" && event?.event?.skill?.name === "research"), "custom agent skill preload should emit nested skill_loaded events");

  const commandPreloadAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli custom agent command preload smoke prompt",
      messages: [{ role: "user", content: "custom agent command preload smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(commandPreloadAgentStarted.response.status === 202, "custom agent command preload smoke session should start");
  const commandPreloadAgentCompleted = await waitForSessionDone(commandPreloadAgentStarted.payload?.data?.id);
  assert(commandPreloadAgentCompleted?.data?.status === "completed", "custom agent command preload smoke session should complete");
  assert(
    commandPreloadAgentCompleted?.data?.result?.finalText?.includes("custom agent command preload smoke completed"),
    `custom agent command preload smoke should reach final response: ${JSON.stringify(commandPreloadAgentCompleted?.data?.result || {}, null, 2)}`,
  );
  const commandPreloadAgentResult = commandPreloadAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "commanded");
  assert(commandPreloadAgentResult?.data?.customAgent?.commands?.includes("review-flow"), "custom agent command preload result should expose declared command metadata");
  assert(commandPreloadAgentResult?.data?.activeCommands?.some((command) => command?.name === "review-flow" && command?.path === ".oases/commands/review-flow.md"), "custom agent should report preloaded commands as active commands");
  assert(commandPreloadAgentCompleted?.events?.some((event) => event?.type === "subagent_event" && event?.event?.type === "command_loaded" && event?.event?.command?.name === "review-flow"), "custom agent command preload should emit nested command_loaded events");

  const initialPromptAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli custom agent initial prompt smoke prompt",
      messages: [{ role: "user", content: "custom agent initial prompt smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(initialPromptAgentStarted.response.status === 202, "custom agent initial prompt smoke session should start");
  const initialPromptAgentCompleted = await waitForSessionDone(initialPromptAgentStarted.payload?.data?.id);
  assert(initialPromptAgentCompleted?.data?.status === "completed", "custom agent initial prompt smoke session should complete");
  assert(initialPromptAgentCompleted?.data?.result?.finalText?.includes("custom agent initial prompt smoke completed"), "custom agent initial prompt smoke should reach final response");
  const initialPromptAgentResult = initialPromptAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "starter");
  assert(initialPromptAgentResult?.data?.customAgent?.initialPrompt === "initial prompt marker", "custom agent initial prompt result should expose declared initialPrompt metadata");
  assert(String(initialPromptAgentResult?.data?.finalText || "").includes("custom agent initial prompt marker observed"), "custom agent initialPrompt should be prepended to the sub-agent first user turn");

  const yamlFrontmatterAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli custom agent yaml frontmatter smoke prompt",
      messages: [{ role: "user", content: "custom agent yaml frontmatter smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(yamlFrontmatterAgentStarted.response.status === 202, "custom agent YAML frontmatter smoke session should start");
  const yamlFrontmatterAgentCompleted = await waitForSessionDone(yamlFrontmatterAgentStarted.payload?.data?.id);
  assert(yamlFrontmatterAgentCompleted?.data?.status === "completed", "custom agent YAML frontmatter smoke session should complete");
  assert(yamlFrontmatterAgentCompleted?.data?.result?.finalText?.includes("custom agent yaml frontmatter smoke completed"), "custom agent YAML frontmatter smoke should reach final response");
  const yamlFrontmatterAgentResult = yamlFrontmatterAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "yamlstarter");
  assert(yamlFrontmatterAgentResult?.data?.customAgent?.tools?.includes("read_file"), "custom agent YAML frontmatter result should expose parsed tools");
  assert(yamlFrontmatterAgentResult?.data?.customAgent?.disallowedTools?.includes("write_file"), "custom agent YAML frontmatter result should expose parsed disallowed tools");
  assert(yamlFrontmatterAgentResult?.data?.customAgent?.skills?.includes("research"), "custom agent YAML frontmatter result should expose parsed skills");
  assert(String(yamlFrontmatterAgentResult?.data?.customAgent?.initialPrompt || "").includes("second seeded line"), "custom agent YAML frontmatter result should expose parsed block scalar initialPrompt");
  assert(String(yamlFrontmatterAgentResult?.data?.finalText || "").includes("custom agent YAML frontmatter marker observed"), "custom agent YAML frontmatter should affect the sub-agent first turn");

  const effortAgentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli custom agent effort smoke prompt",
      messages: [{ role: "user", content: "custom agent effort smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(effortAgentStarted.response.status === 202, "custom agent effort smoke session should start");
  const effortAgentCompleted = await waitForSessionDone(effortAgentStarted.payload?.data?.id);
  assert(effortAgentCompleted?.data?.status === "completed", "custom agent effort smoke session should complete");
  assert(effortAgentCompleted?.data?.result?.finalText?.includes("custom agent effort smoke completed"), "custom agent effort smoke should reach final response");
  const effortAgentResult = effortAgentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.agentName === "effortful");
  assert(effortAgentResult?.data?.effort === "low", "agent_run should report the custom agent effort used by the sub-agent");
  assert(effortAgentResult?.data?.customAgent?.effort === "low", "custom agent effort result should expose declared effort metadata");
  assert(String(effortAgentResult?.data?.finalText || "").includes("custom agent effort override observed"), "custom agent effort should be applied to the sub-agent model request");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "src/background-target.txt", content: "background marker\n" }),
  });
  const backgroundSubagentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli background subagent smoke prompt",
      messages: [{ role: "user", content: "background subagent smoke" }],
      maxTurns: 8,
      maxAutoContinuations: 1,
    }),
  });
  assert(backgroundSubagentStarted.response.status === 202, "background subagent smoke session should start");
  const backgroundSubagentCompleted = await waitForSessionDone(backgroundSubagentStarted.payload?.data?.id);
  assert(backgroundSubagentCompleted?.data?.status === "completed", "background subagent smoke session should complete");
  assert(backgroundSubagentCompleted?.data?.result?.finalText?.includes("background subagent smoke completed"), "background subagent smoke should reach final response after polling agent_status");
  assert(backgroundSubagentCompleted?.data?.result?.toolResults?.some((result) => result?.name === "agent_run" && result?.data?.status === "async_launched" && result?.data?.subagentId), "background agent_run should return an async_launched result");
  assert(backgroundSubagentCompleted?.data?.result?.toolResults?.some((result) => result?.name === "agent_status" && JSON.stringify(result?.data || {}).includes("background subagent found marker")), "agent_status should return the background sub-agent result");
  assert(backgroundSubagentCompleted?.events?.some((event) => event?.type === "subagent_start" && event?.runInBackground === true), "background agent_run should emit a background subagent_start event");
  assert(backgroundSubagentCompleted?.events?.some((event) => event?.type === "subagent_done" && event?.runInBackground === true), "background agent_run should emit a background subagent_done event");

  const worktreeSubagentStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli worktree subagent smoke prompt",
      messages: [{ role: "user", content: "worktree subagent smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(worktreeSubagentStarted.response.status === 202, "worktree subagent smoke session should start");
  const worktreeSubagentCompleted = await waitForSessionDone(worktreeSubagentStarted.payload?.data?.id);
  assert(worktreeSubagentCompleted?.data?.status === "completed", "worktree subagent smoke session should complete");
  assert(worktreeSubagentCompleted?.data?.result?.finalText?.includes("worktree subagent smoke completed"), "worktree subagent smoke should reach final response");
  const worktreeAgentResult = worktreeSubagentCompleted?.data?.result?.toolResults?.find((result) => result?.name === "agent_run" && result?.data?.isolation === "worktree");
  const worktreePath = worktreeAgentResult?.data?.worktree?.worktreePath;
  assert(typeof worktreePath === "string" && worktreePath, "worktree agent_run should return the created worktree path");
  assert(String(worktreeAgentResult?.data?.finalText || "").includes("worktree subagent wrote isolated/worktree-output.txt"), "worktree agent_run should return sub-agent final text");
  assert(worktreeAgentResult?.data?.workspaceStatus?.status?.some((item) => item?.status === "??" && item?.path === "isolated/worktree-output.txt"), "worktree agent_run should return workspace status for isolated changes");
  assert(worktreeSubagentCompleted?.events?.some((event) => event?.type === "subagent_start" && event?.isolation === "worktree" && event?.worktree?.worktreePath === worktreePath), "worktree agent_run should emit subagent_start worktree metadata");
  const isolatedWorktreeFile = await readTextEventually(path.join(worktreePath, "isolated", "worktree-output.txt"));
  assert(isolatedWorktreeFile === "worktree isolated output\n", "worktree sub-agent should write output in the isolated worktree");
  let mainWorkspaceHasIsolatedFile = false;
  try {
    await readFile(path.join(workspace, "isolated", "worktree-output.txt"), "utf8");
    mainWorkspaceHasIsolatedFile = true;
  } catch {
    mainWorkspaceHasIsolatedFile = false;
  }
  assert(!mainWorkspaceHasIsolatedFile, "worktree sub-agent should not write isolated output into the main workspace");
  const worktreeList = await request("/tools/worktree_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeStatus: true }),
  });
  const canonicalWorktreePath = await realpath(worktreePath);
  assert(worktreeList.payload?.data?.worktrees?.some((item) => item?.path === canonicalWorktreePath && item?.isOasesAgentWorktree === true), "worktree_list should include the Oases agent worktree");
  const worktreeDiff = await request("/tools/worktree_diff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worktreePath, includeDiff: true, includeUntrackedPreview: true }),
  });
  assert(worktreeDiff.payload?.data?.workspaceStatus?.status?.some((item) => item?.status === "??" && item?.path === "isolated/worktree-output.txt"), "worktree_diff should expose isolated worktree changes");
  const invalidWorktreeDiff = await request("/tools/worktree_diff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worktreePath: path.join(workspace, "not-a-linked-worktree") }),
  });
  assert(invalidWorktreeDiff.response.status >= 400, "worktree_diff should reject paths that are not linked git worktrees");
  const removeDirtyWithoutForce = await request("/tools/worktree_remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worktreePath }),
  });
  assert(removeDirtyWithoutForce.response.status >= 400, "worktree_remove should refuse dirty worktrees without force");
  const appliedWorktree = await request("/tools/worktree_apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worktreePath, paths: ["isolated/worktree-output.txt"] }),
  });
  assert(appliedWorktree.payload?.ok === true, "worktree_apply should apply selected worktree files");
  assert(appliedWorktree.payload?.data?.applied?.some((item) => item?.path === "isolated/worktree-output.txt" && item?.action === "copied"), "worktree_apply should report copied file paths");
  assert(appliedWorktree.payload?.data?.artifacts?.some((artifact) => artifact?.path === "isolated/worktree-output.txt"), "worktree_apply should return applied file artifacts");
  const appliedMainFile = await readTextEventually(path.join(workspace, "isolated", "worktree-output.txt"));
  assert(appliedMainFile === "worktree isolated output\n", "worktree_apply should copy selected worktree output into the main workspace");
  const removedWorktree = await request("/tools/worktree_remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worktreePath, force: true }),
  });
  assert(removedWorktree.payload?.data?.removed === true, "worktree_remove should remove the linked worktree with force");
  const worktreeListAfterRemove = await request("/tools/worktree_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(!worktreeListAfterRemove.payload?.data?.worktrees?.some((item) => item?.path === canonicalWorktreePath), "worktree_remove should unregister the removed worktree");

  const approvalStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli smoke approval prompt",
      messages: [{ role: "user", content: "approval smoke" }],
    }),
  });
  assert(approvalStarted.response.status === 202, "approval smoke session should start");
  const approvalSessionId = approvalStarted.payload?.data?.id;
  assert(typeof approvalSessionId === "string", "approval smoke session should have an id");
  const approvalEvent = await waitForApproval(approvalSessionId);
  assert(approvalEvent.tool === "run_python", "approval request should be for run_python");
  assert(approvalEvent.category === "file_modifying_python", "approval request should include a file-modifying permission category");
  assert(String(approvalEvent.reason || "").includes("Python"), "approval request should include a human-readable reason");
  assert(approvalEvent.actionable === true && approvalEvent.source === "live", "session detail should expose live actionable pending approvals");
  assert(String(approvalEvent.arguments?.script || "").includes("approval-smoke.txt"), "pending approval detail should preserve tool arguments");
  const approvalHealth = await request("/health");
  assert(approvalHealth.payload?.pendingApprovalCount >= 1, "health summary should expose pending approval count");
  assert(approvalHealth.payload?.latestSession?.waitingForApproval === true, "health summary latest session should show waiting approval");
  const approvalList = await request("/agent/sessions");
  const listedApprovalSession = approvalList.payload?.data?.sessions?.find((session) => session?.id === approvalSessionId);
  assert(listedApprovalSession?.pendingApprovalCount >= 1 && listedApprovalSession?.waitingForApproval === true, "session list should expose waiting approval status");
  const blockedApprovalResume = await request(`/agent/sessions/${encodeURIComponent(approvalSessionId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(blockedApprovalResume.response.status === 409, "resume endpoint should reject sessions with pending approvals");
  assert(String(blockedApprovalResume.payload?.error || "").includes("approval request"), "resume rejection should explain pending approval blockers");
  const approved = await request(`/agent/sessions/${encodeURIComponent(approvalSessionId)}/approvals/${encodeURIComponent(approvalEvent.approvalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert(approved.payload?.data?.approved === true, "approval endpoint should approve the pending tool");
  const approvalCompleted = await waitForSessionDone(approvalSessionId);
  assert(approvalCompleted?.data?.result?.finalText?.includes("approval smoke completed"), "approval session should complete after approved tool execution");
  assert(Array.isArray(approvalCompleted?.pendingApprovals) && approvalCompleted.pendingApprovals.length === 0, "pending approval detail should clear after approval resolution");
  const approvalHealthAfter = await request("/health");
  assert(Number(approvalHealthAfter.payload?.pendingApprovalCount || 0) === 0, "health summary should clear pending approval count after approval resolution");
  const approvalEvents = await readTextEventually(path.join(workspace, ".oases", "ocli", "sessions", approvalSessionId, "events.ndjson"));
  assert(approvalEvents.includes('"type":"approval_required"') && approvalEvents.includes('"type":"approval_resolved"'), "approval events should be persisted");

  const repeatApprovalStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli repeat approval smoke prompt",
      messages: [{ role: "user", content: "repeat approval smoke" }],
    }),
  });
  assert(repeatApprovalStarted.response.status === 202, "repeat approval smoke session should start");
  const repeatApprovalSessionId = repeatApprovalStarted.payload?.data?.id;
  const repeatApprovalEvent = await waitForApproval(repeatApprovalSessionId);
  const repeatApproved = await request(`/agent/sessions/${encodeURIComponent(repeatApprovalSessionId)}/approvals/${encodeURIComponent(repeatApprovalEvent.approvalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert(repeatApproved.payload?.data?.approved === true, "repeat approval endpoint should approve the pending tool");
  const repeatApprovalCompleted = await waitForSessionDone(repeatApprovalSessionId);
  assert(repeatApprovalCompleted?.data?.result?.finalText?.includes("repeat approval smoke completed"), "repeat approval session should complete after reusing session approval");
  const repeatApprovalRequiredEvents = repeatApprovalCompleted.events.filter((event) => event?.type === "approval_required");
  assert(repeatApprovalRequiredEvents.length === 1, "identical approved tool calls should reuse the current session approval");

  const readonlyCommandStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli readonly command smoke prompt",
      messages: [{ role: "user", content: "readonly command smoke" }],
    }),
  });
  assert(readonlyCommandStarted.response.status === 202, "readonly command smoke session should start");
  const readonlyApprovalEvent = await waitForApproval(readonlyCommandStarted.payload?.data?.id);
  assert(readonlyApprovalEvent.tool === "run_command", "read-only command smoke should request approval for run_command");
  assert(readonlyApprovalEvent.category === "read_only_shell", "read-only command approval should preserve the read-only shell category");
  const readonlyApproved = await request(`/agent/sessions/${encodeURIComponent(readonlyCommandStarted.payload?.data?.id)}/approvals/${encodeURIComponent(readonlyApprovalEvent.approvalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert(readonlyApproved.payload?.data?.approved === true, "read-only command approval endpoint should approve the pending tool");
  const readonlyCommandCompleted = await waitForSessionDone(readonlyCommandStarted.payload?.data?.id);
  assert(readonlyCommandCompleted?.data?.status === "completed", "readonly command smoke session should complete after approval");
  assert(readonlyCommandCompleted?.data?.result?.finalText?.includes("readonly command smoke completed"), "readonly command smoke should reach the final model response");
  assert(readonlyCommandCompleted?.events?.some((event) => event?.type === "approval_required" && event?.tool === "run_command"), "agent shell commands should request approval by default");

  const autoContinuationStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli auto continuation smoke prompt",
      messages: [{ role: "user", content: "auto continuation smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 3,
    }),
  });
  assert(autoContinuationStarted.response.status === 202, "auto continuation smoke session should start");
  const autoContinuationCompleted = await waitForSessionDone(autoContinuationStarted.payload?.data?.id);
  assert(autoContinuationCompleted?.data?.status === "completed", "auto continuation smoke session should complete across local slices");
  assert(autoContinuationCompleted?.data?.result?.finalText?.includes("auto continuation smoke completed"), "auto continuation smoke should reach final model response");
  assert(autoContinuationCompleted?.events?.filter((event) => event?.type === "auto_continue").length >= 2, "ocli should emit auto_continue events across slices");
  assert((await readTextEventually(path.join(workspace, "auto", "step-9.txt"))).includes("auto continuation smoke step 9"), "auto continuation should execute all generated tool steps");

  const unfinishedContinuationStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli unfinished continuation smoke prompt",
      messages: [{ role: "user", content: "unfinished continuation smoke" }],
      maxTurns: 2,
      maxAutoContinuations: 2,
    }),
  });
  assert(unfinishedContinuationStarted.response.status === 202, "unfinished continuation smoke session should start");
  const unfinishedContinuationCompleted = await waitForSessionDone(unfinishedContinuationStarted.payload?.data?.id);
  assert(unfinishedContinuationCompleted?.data?.status === "completed", "unfinished continuation smoke session should complete after automatic follow-up");
  assert(unfinishedContinuationCompleted?.data?.result?.finalText?.includes("unfinished continuation smoke completed"), "unfinished continuation smoke should reach the final response");
  assert(unfinishedContinuationCompleted?.events?.some((event) => event?.type === "auto_continue"), "unfinished no-tool model text should trigger auto_continue");
  assert((await readTextEventually(path.join(workspace, "generated", "unfinished-output.txt"))).includes("unfinished continuation smoke ok"), "unfinished continuation should force the model to produce the promised file");

  const completionGuardStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli completion guard todo smoke prompt",
      messages: [{ role: "user", content: "completion guard todo smoke" }],
      maxTurns: 2,
      maxAutoContinuations: 1,
    }),
  });
  assert(completionGuardStarted.response.status === 202, "completion guard todo smoke session should start");
  const completionGuardCompleted = await waitForSessionDone(completionGuardStarted.payload?.data?.id);
  assert(completionGuardCompleted?.data?.status === "completed", "completion guard todo smoke session should complete after automatic follow-up");
  assert(completionGuardCompleted?.data?.result?.finalText?.includes("completion guard todo smoke completed"), "completion guard todo smoke should reach the final response");
  assert(completionGuardCompleted?.events?.some((event) => event?.type === "auto_continue" && event?.reason === "open_todo"), "open todo text should trigger an auto_continue event with reason=open_todo");
  assert((await readTextEventually(path.join(workspace, "guard", "todo-output.txt"))).includes("completion guard todo smoke ok"), "completion guard should force the model to produce the promised artifact");

  const postToolContinuationStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli post tool continuation smoke prompt",
      messages: [{ role: "user", content: "post tool continuation smoke" }],
      maxTurns: 3,
      maxAutoContinuations: 1,
    }),
  });
  assert(postToolContinuationStarted.response.status === 202, "post-tool continuation smoke session should start");
  const postToolContinuationCompleted = await waitForSessionDone(postToolContinuationStarted.payload?.data?.id);
  assert(postToolContinuationCompleted?.data?.status === "completed", "post-tool continuation smoke session should complete");
  assert(postToolContinuationCompleted?.data?.result?.finalText?.includes("post tool continuation smoke completed"), `post-tool continuation smoke should not stop at the first tool result: ${JSON.stringify({ finalText: postToolContinuationCompleted?.data?.result?.finalText, events: postToolContinuationCompleted?.events }, null, 2)}`);
  assert(postToolContinuationCompleted?.events?.some((event) => event?.type === "auto_continue" && event?.reason === "promised_follow_up" && event?.afterToolResults === true), "post-tool promised follow-up should emit auto_continue after tool results");
  assert((await readTextEventually(path.join(workspace, "guard", "post-tool-output.txt"))).includes("post tool continuation file"), "post-tool continuation should preserve the first generated file");
  assert((await readTextEventually(path.join(workspace, "guard", "post-tool-verified.txt"))).includes("post tool continuation verified"), "post-tool continuation should force the promised follow-up verification artifact");

  const persistentTodoWrite = await request("/tools/todo_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      todos: [{ id: "persisted-follow-up", text: "persisted follow-up", status: "doing" }],
    }),
  });
  assert(persistentTodoWrite.payload?.ok === true, "persistent todo restore smoke should seed a persisted todo");
  const persistentTodoRestoreStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli persistent todo restore smoke prompt",
      messages: [{ role: "user", content: "persistent todo restore smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(persistentTodoRestoreStarted.response.status === 202, "persistent todo restore smoke session should start");
  const persistentTodoRestoreCompleted = await waitForSessionDone(persistentTodoRestoreStarted.payload?.data?.id);
  assert(persistentTodoRestoreCompleted?.data?.status === "completed", `persistent todo restore smoke session should complete: ${JSON.stringify({ data: persistentTodoRestoreCompleted?.data || {}, events: persistentTodoRestoreCompleted?.events || [] }, null, 2)}`);
  assert(persistentTodoRestoreCompleted?.data?.result?.finalText === "persistent todo restore smoke completed", "persistent todo restore guard should ignore premature completion while restored todos are open");
  assert(persistentTodoRestoreCompleted?.events?.some((event) => event?.type === "todo_state_loaded" && event?.openTodos?.some((todo) => todo?.text === "persisted follow-up" && todo?.status === "doing")), "persistent todo restore should load open todos at session start");
  assert(persistentTodoRestoreCompleted?.events?.some((event) => event?.type === "auto_continue" && event?.reason === "open_todo_state"), "restored open todos should trigger auto_continue even when model claims completion");
  assert(Array.isArray(persistentTodoRestoreCompleted?.data?.result?.openTodos) && persistentTodoRestoreCompleted.data.result.openTodos.length === 0, "persistent todo restore should finish only after restored todos are marked done");
  assert(persistentTodoRestoreCompleted?.data?.result?.latestTodos?.every((todo) => todo?.status === "done"), "persistent todo restore should expose final done todo state");

  const todoStateGuardStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli todo state guard smoke prompt",
      messages: [{ role: "user", content: "todo state guard smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(todoStateGuardStarted.response.status === 202, "todo state guard smoke session should start");
  const todoStateGuardCompleted = await waitForSessionDone(todoStateGuardStarted.payload?.data?.id);
  assert(todoStateGuardCompleted?.data?.status === "completed", `todo state guard smoke session should complete: ${JSON.stringify({ data: todoStateGuardCompleted?.data || {}, events: todoStateGuardCompleted?.events || [] }, null, 2)}`);
  assert(todoStateGuardCompleted?.data?.result?.finalText === "todo state guard smoke completed", `todo state guard should ignore premature completion while structured todos are open: ${JSON.stringify({ finalText: todoStateGuardCompleted?.data?.result?.finalText, result: todoStateGuardCompleted?.data?.result, events: todoStateGuardCompleted?.events }, null, 2)}`);
  assert(todoStateGuardCompleted?.events?.some((event) => event?.type === "todo_state_updated" && event?.openTodos?.some((todo) => todo?.status === "doing")), "todo state guard should observe open structured todos");
  assert(todoStateGuardCompleted?.events?.some((event) => event?.type === "auto_continue" && event?.reason === "open_todo_state"), "open structured todos should trigger auto_continue even when model claims completion");
  assert(Array.isArray(todoStateGuardCompleted?.data?.result?.openTodos) && todoStateGuardCompleted.data.result.openTodos.length === 0, "todo state guard should finish only after todos are marked done");
  assert(todoStateGuardCompleted?.data?.result?.latestTodos?.every((todo) => todo?.status === "done"), "todo state guard should expose final done todo state");

  const longHistoryMessages = Array.from({ length: 18 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `compaction-history-marker-${index} ${"历史上下文片段 ".repeat(45)}`,
  }));
  longHistoryMessages.push({ role: "user", content: "context compaction smoke" });
  const contextCompactionStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli context compaction smoke prompt",
      messages: longHistoryMessages,
      maxTurns: 2,
      maxAutoContinuations: 0,
      maxContextTokens: 900,
      contextCompactionRatio: 0.9,
      contextRecentMessages: 4,
    }),
  });
  assert(contextCompactionStarted.response.status === 202, "context compaction smoke session should start");
  const contextCompactionCompleted = await waitForSessionDone(contextCompactionStarted.payload?.data?.id);
  assert(contextCompactionCompleted?.data?.status === "completed", `context compaction smoke session should complete: ${JSON.stringify({ data: contextCompactionCompleted?.data || {}, events: contextCompactionCompleted?.events || [] }, null, 2)}`);
  assert(contextCompactionCompleted?.data?.result?.finalText?.includes("context compaction smoke completed"), "context compaction smoke should reach final response");
  assert(contextCompactionCompleted?.events?.some((event) => event?.type === "context_compacted" && event.compactedMessageCount >= 10), "ocli should emit context_compacted when history crosses the configured threshold");
  assert(contextCompactionCompleted?.events?.some((event) => event?.type === "context_compacted" && event.stateSnapshot === true), "ocli should emit context_compacted with a resumable state snapshot marker");
  assert(contextCompactionCompleted?.data?.result?.contextCompactions?.some((item) => item?.beforeTokens > item?.thresholdTokens && item?.afterTokens < item?.beforeTokens && item?.stateSnapshot === true), "ocli result should record context compaction metadata and state snapshot availability");

  const contextCompactionSettingsWrite = await request("/tools/settings_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: {
        contextCompaction: {
          enabled: true,
          maxContextTokens: 900,
          ratio: 0.9,
          recentMessages: 4,
        },
      },
    }),
  });
  assert(contextCompactionSettingsWrite.payload?.ok === true, "settings_write should allow contextCompaction settings");
  const contextCompactionSettingsRead = await request("/tools/settings_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json" }),
  });
  assert(contextCompactionSettingsRead.payload?.data?.safeValues?.contextCompaction?.maxContextTokens === 900, "settings_read should expose safe contextCompaction maxContextTokens");
  assert(contextCompactionSettingsRead.payload?.data?.safeValues?.contextCompaction?.ratio === 0.9, "settings_read should expose safe contextCompaction ratio");
  const mcpSettingsSeedWrite = await request("/tools/settings_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: {
        mcpServers: {
          docs: { command: "node", args: ["server.js"], env: { DOCS_TOKEN: "local-secret" } },
        },
      },
    }),
  });
  assert(mcpSettingsSeedWrite.payload?.ok === true, "settings_write should allow MCP server settings");
  const mcpSettingsPatchWrite = await request("/tools/settings_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: {
        mcpServers: {
          docs: { command: "npx", args: ["-y", "server"] },
        },
      },
    }),
  });
  assert(mcpSettingsPatchWrite.payload?.ok === true, "settings_write should merge MCP server settings");
  const mcpSettingsRead = await request("/tools/settings_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json" }),
  });
  assert(mcpSettingsRead.payload?.data?.safeValues?.mcpServers?.servers?.docs?.command === "npx", "settings_read should expose merged MCP server command");
  assert(mcpSettingsRead.payload?.data?.safeValues?.mcpServers?.servers?.docs?.args?.length === 2, "settings_read should expose merged MCP server args");
  assert(mcpSettingsRead.payload?.data?.safeValues?.mcpServers?.servers?.docs?.envKeys?.includes("DOCS_TOKEN"), "settings_write should preserve existing MCP env keys when patch omits env");
  assert(!JSON.stringify(mcpSettingsRead.payload?.data || {}).includes("local-secret"), "settings_read should not expose local MCP env values");
  const settingsContextCompactionStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli settings context compaction smoke prompt",
      messages: longHistoryMessages,
      maxTurns: 2,
      maxAutoContinuations: 0,
    }),
  });
  assert(settingsContextCompactionStarted.response.status === 202, "settings context compaction smoke session should start");
  const settingsContextCompactionCompleted = await waitForSessionDone(settingsContextCompactionStarted.payload?.data?.id);
  assert(settingsContextCompactionCompleted?.data?.status === "completed", `settings context compaction smoke session should complete: ${JSON.stringify({ data: settingsContextCompactionCompleted?.data || {}, events: settingsContextCompactionCompleted?.events || [] }, null, 2)}`);
  assert(settingsContextCompactionCompleted?.data?.result?.finalText?.includes("context compaction smoke completed"), "settings context compaction smoke should reach final response");
  assert(settingsContextCompactionCompleted?.events?.some((event) => event?.type === "settings_context_compaction_loaded" && event?.policy?.maxContextTokens === 900 && event?.policy?.recentMessages === 4), "settings context compaction smoke should emit loaded policy metadata");
  assert(settingsContextCompactionCompleted?.events?.some((event) => event?.type === "context_compacted" && event?.policy?.maxContextTokens === 900 && event?.policy?.recentMessages === 4), "settings context compaction smoke should use settings policy in compaction events");
  assert(settingsContextCompactionCompleted?.data?.result?.settingsContextCompaction?.thresholdTokens === 810, "settings context compaction policy should be preserved in result metadata");
  assert(settingsContextCompactionCompleted?.data?.result?.contextCompactions?.some((item) => item?.policy?.maxContextTokens === 900 && item?.policy?.recentMessages === 4), "settings context compaction metadata should be preserved with the compaction record");
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json", content: JSON.stringify({ permissions: {} }, null, 2) }),
  });

  const adaptiveTailMessages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `adaptive-tail-history-marker-${index} ${"旧上下文片段 ".repeat(35)}`,
  }));
  for (let index = 0; index < 7; index += 1) {
    adaptiveTailMessages.push({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `oversized-recent-marker-${index} ${"近期上下文很长，需要压缩到摘要而不是保留原文。".repeat(160)}`,
    });
  }
  adaptiveTailMessages.push({ role: "user", content: "context compaction adaptive tail smoke" });
  const adaptiveTailCompactionStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli context compaction adaptive tail smoke prompt",
      messages: adaptiveTailMessages,
      maxTurns: 2,
      maxAutoContinuations: 0,
      maxContextTokens: 4000,
      contextCompactionRatio: 0.9,
      contextRecentMessages: 8,
    }),
  });
  assert(adaptiveTailCompactionStarted.response.status === 202, "adaptive tail compaction smoke session should start");
  const adaptiveTailCompactionCompleted = await waitForSessionDone(adaptiveTailCompactionStarted.payload?.data?.id);
  assert(adaptiveTailCompactionCompleted?.data?.status === "completed", `adaptive tail compaction smoke session should complete: ${JSON.stringify({ data: adaptiveTailCompactionCompleted?.data || {}, events: adaptiveTailCompactionCompleted?.events || [] }, null, 2)}`);
  assert(adaptiveTailCompactionCompleted?.data?.result?.finalText?.includes("context compaction adaptive tail smoke completed"), "adaptive tail compaction smoke should reach final response");
  const adaptiveTailEvent = adaptiveTailCompactionCompleted?.events?.find((event) => event?.type === "context_compacted" && event?.adaptiveRetainedMessageCount === true);
  assert(adaptiveTailEvent?.requestedRetainedMessageCount === 8 && adaptiveTailEvent?.retainedMessageCount > 0 && adaptiveTailEvent.retainedMessageCount < 8, `adaptive compaction should shrink the retained recent tail: ${JSON.stringify(adaptiveTailCompactionCompleted?.events || [], null, 2)}`);
  assert(adaptiveTailCompactionCompleted?.data?.result?.contextCompactions?.some((item) => item?.adaptiveRetainedMessageCount === true && item?.requestedRetainedMessageCount === 8 && item?.retainedMessageCount < 8), "adaptive retained count should be preserved in result metadata");

  const compactionTodoSeed = await request("/tools/todo_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ todos: [{ id: "compaction-restored-todo", text: "compaction restored todo", status: "doing" }] }),
  });
  assert(compactionTodoSeed.payload?.ok === true, "context compaction todo state smoke should seed an open todo");
  const todoCompactionMessages = Array.from({ length: 18 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `todo-compaction-history-marker-${index} ${"任务压缩历史片段 ".repeat(45)}`,
  }));
  todoCompactionMessages.push({ role: "user", content: "context compaction todo state smoke" });
  const todoCompactionStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli context compaction todo state smoke prompt",
      messages: todoCompactionMessages,
      maxTurns: 4,
      maxAutoContinuations: 1,
      maxContextTokens: 900,
      contextCompactionRatio: 0.9,
      contextRecentMessages: 4,
    }),
  });
  assert(todoCompactionStarted.response.status === 202, "context compaction todo state smoke session should start");
  const todoCompactionCompleted = await waitForSessionDone(todoCompactionStarted.payload?.data?.id);
  assert(todoCompactionCompleted?.data?.status === "completed", `context compaction todo state smoke session should complete: ${JSON.stringify({ data: todoCompactionCompleted?.data || {}, events: todoCompactionCompleted?.events || [] }, null, 2)}`);
  assert(todoCompactionCompleted?.data?.result?.finalText === "context compaction todo state smoke completed", "context compaction todo state smoke should finish after restored todo is done");
  assert(todoCompactionCompleted?.events?.some((event) => event?.type === "todo_state_loaded" && event?.openTodos?.some((todo) => todo?.text === "compaction restored todo")), "context compaction todo state smoke should load persisted open todos");
  assert(todoCompactionCompleted?.events?.some((event) => event?.type === "context_compacted" && event?.stateSnapshot === true), "context compaction todo state smoke should emit compaction snapshot");
  assert(todoCompactionCompleted?.events?.some((event) => event?.type === "auto_continue" && event?.reason === "open_todo_state"), "context compaction todo state smoke should continue while restored todo is open");
  assert(Array.isArray(todoCompactionCompleted?.data?.result?.openTodos) && todoCompactionCompleted.data.result.openTodos.length === 0, "context compaction todo state smoke should finish with no open todos");
  assert(todoCompactionCompleted?.data?.result?.latestTodos?.some((todo) => todo?.text === "compaction restored todo" && todo?.status === "done"), "context compaction todo state smoke should preserve final todo metadata");

  const mcpCompactionMessages = Array.from({ length: 18 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `compaction-history-marker-${index} ${"MCP 历史上下文片段 ".repeat(45)}`,
  }));
  mcpCompactionMessages.push({ role: "user", content: "context compaction smoke with mcp evidence: use docs MCP search_docs capability and testing-policy memory." });
  const mcpCompactionStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli context compaction MCP evidence smoke prompt",
      messages: mcpCompactionMessages,
      maxTurns: 2,
      maxAutoContinuations: 0,
      maxContextTokens: 900,
      contextCompactionRatio: 0.9,
      contextRecentMessages: 4,
    }),
  });
  assert(mcpCompactionStarted.response.status === 202, "context compaction MCP evidence smoke session should start");
  const mcpCompactionSessionId = mcpCompactionStarted.payload?.data?.id;
  const mcpCompactionCompleted = await waitForSessionDone(mcpCompactionSessionId);
  assert(mcpCompactionCompleted?.data?.status === "completed", `context compaction MCP evidence smoke session should complete: ${JSON.stringify({ data: mcpCompactionCompleted?.data || {}, events: mcpCompactionCompleted?.events || [] }, null, 2)}`);
  assert(mcpCompactionCompleted?.data?.result?.finalText?.includes("context compaction mcp evidence smoke completed"), "context compaction MCP evidence smoke should reach final response");
  assert(mcpCompactionCompleted?.events?.some((event) => event?.type === "memory_auto_searched" && event?.results?.some((result) => result?.name === "testing-policy")), "context compaction MCP evidence smoke should auto-search matching memory before compaction");
  assert(mcpCompactionCompleted?.events?.some((event) => event?.type === "mcp_auto_called" && event?.server === "docs" && event?.tool === "search_docs"), "context compaction MCP evidence smoke should auto-call matching MCP before compaction");
  assert(mcpCompactionCompleted?.events?.some((event) => event?.type === "context_compacted" && event?.stateSnapshot === true), "context compaction MCP evidence smoke should emit state-snapshot compaction");
  assert(mcpCompactionCompleted?.data?.result?.capabilityRouting?.autoMemoryResults?.some((result) => result?.name === "testing-policy" && String(result?.snippet || "").includes("ocli smoke tests")), "context compaction MCP evidence smoke should retain auto memory RAG results in final metadata");
  assert(mcpCompactionCompleted?.data?.result?.capabilityRouting?.autoMcpResults?.some((result) => result?.server === "docs" && result?.tool === "search_docs" && String(result?.resultText || "").includes("docs result for")), "context compaction MCP evidence smoke should retain auto MCP results in final metadata");
  assert(mcpCompactionCompleted?.data?.result?.capabilityRouting?.diagnostics?.some((diagnostic) => diagnostic?.categories?.mcpTools?.selectedCount >= 1 && diagnostic?.categories?.memories?.candidateCount >= 1), "context compaction MCP evidence smoke should retain routing diagnostics in final metadata");
  const resumeStructuredStarted = await request(`/agent/sessions/${encodeURIComponent(mcpCompactionSessionId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxTurns: 2, maxAutoContinuations: 0 }),
  });
  assert(resumeStructuredStarted.response.status === 202, "structured resume context smoke should start");
  const resumeStructuredCompleted = await waitForSessionDone(resumeStructuredStarted.payload?.data?.id);
  assert(resumeStructuredCompleted?.data?.status === "completed", `structured resume context smoke should complete: ${JSON.stringify({ data: resumeStructuredCompleted?.data || {}, events: resumeStructuredCompleted?.events || [] }, null, 2)}`);
  assert(resumeStructuredCompleted?.data?.resumedFromSessionId === mcpCompactionSessionId, "structured resume context smoke should retain source session id");
  assert(resumeStructuredCompleted?.data?.result?.finalText?.includes("resume structured context smoke completed"), `structured resume context should preserve prior capability/RAG/MCP/compaction evidence for the model: ${JSON.stringify({ data: resumeStructuredCompleted?.data || {}, events: resumeStructuredCompleted?.events || [] }, null, 2)}`);
  assert(resumeStructuredCompleted?.events?.some((event) => event?.type === "session_resumed" && event?.resumedFromSessionId === mcpCompactionSessionId), "structured resume context smoke should persist session_resumed event");

  const recursiveResumeSnapshot = {
    currentTask: "previous compacted resume task",
    sessionResumeContext: {
      sourceSessionId: "sess_recursive_source",
      sourceStatus: "completed",
      stoppedReason: "completed",
      finalText: "context compaction mcp evidence smoke completed",
      activeCapabilities: {
        memories: [{ name: "testing-policy", path: ".oases/memory/project/testing-policy.md" }],
        mcpTools: [{ server: "docs", name: "search_docs" }],
      },
      autoMemoryResults: [{ name: "testing-policy", snippet: "ocli smoke tests before release" }],
      autoMcpResults: [{ server: "docs", tool: "search_docs", resultText: "docs result for recursive resume context" }],
      routingDiagnostics: [{
        phase: "initial",
        queryTerms: ["testing-policy", "docs", "search_docs"],
        categories: {
          memories: { candidateCount: 1, selectedCount: 1, threshold: 8 },
          mcpTools: { candidateCount: 1, selectedCount: 1, threshold: 6 },
        },
      }],
      contextCompactions: [{ turn: 0, stateSnapshot: true }],
      todos: [{ id: "todo_recursive", text: "recursive resume todo", status: "doing" }],
      openTodos: [{ id: "todo_recursive", text: "recursive resume todo", status: "doing" }],
      todoCounts: { doing: 1 },
    },
    activeCapabilities: {},
  };
  const recursiveResumeMessages = [
    {
      role: "user",
      content: [
        '<context_compaction turn="1" compactedMessages="12" stateSnapshot="true">',
        `<context_state_snapshot>${JSON.stringify(recursiveResumeSnapshot, null, 2)}</context_state_snapshot>`,
        "previous compacted resume evidence summary",
        "</context_compaction>",
      ].join("\n"),
    },
    ...Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `recursive-resume-history-marker-${index} ${"recursive resume context filler ".repeat(45)}`,
    })),
    { role: "user", content: "recursive resume snapshot smoke: verify previously compacted session resume evidence survives another compaction." },
  ];
  const recursiveResumeStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli recursive resume snapshot smoke prompt",
      messages: recursiveResumeMessages,
      maxTurns: 1,
      maxAutoContinuations: 0,
      maxContextTokens: 900,
      contextCompactionRatio: 0.9,
      contextRecentMessages: 1,
    }),
  });
  assert(recursiveResumeStarted.response.status === 202, "recursive resume snapshot smoke should start");
  const recursiveResumeCompleted = await waitForSessionDone(recursiveResumeStarted.payload?.data?.id);
  assert(recursiveResumeCompleted?.data?.status === "completed", `recursive resume snapshot smoke should complete: ${JSON.stringify({ data: recursiveResumeCompleted?.data || {}, events: recursiveResumeCompleted?.events || [] }, null, 2)}`);
  assert(recursiveResumeCompleted?.data?.result?.finalText?.includes("recursive resume context compaction smoke completed"), "recursive resume snapshot smoke should preserve nested resume context across another compaction");
  assert(recursiveResumeCompleted?.events?.some((event) => event?.type === "context_compacted" && event?.stateSnapshot === true), "recursive resume snapshot smoke should emit state-snapshot compaction");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "src/adaptive-trigger.txt",
      content: "Use the research skill, load late-policy project memory, and call docs search_docs MCP before writing the adaptive output.\n",
    }),
  });
  const adaptiveCapabilityRoutingStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli delayed run prompt",
      messages: [{ role: "user", content: "delayed run check" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(adaptiveCapabilityRoutingStarted.response.status === 202, "adaptive capability routing smoke session should start");
  const adaptiveCapabilityRoutingCompleted = await waitForSessionDone(adaptiveCapabilityRoutingStarted.payload?.data?.id);
  assert(adaptiveCapabilityRoutingCompleted?.data?.status === "completed", `adaptive capability routing smoke session should complete: ${JSON.stringify({ data: adaptiveCapabilityRoutingCompleted?.data || {}, events: adaptiveCapabilityRoutingCompleted?.events || [] }, null, 2)}`);
  assert(adaptiveCapabilityRoutingCompleted?.data?.result?.finalText?.includes("adaptive capability routing smoke completed"), "adaptive capability routing smoke should reach final response");
  assert(!adaptiveCapabilityRoutingCompleted?.events?.some((event) => event?.type === "skill_loaded" && event?.turn === -1 && event?.skill?.name === "research"), "adaptive routing smoke should not load research during initial routing");
  assert(adaptiveCapabilityRoutingCompleted?.events?.some((event) => event?.type === "capability_routing" && event?.phase === "adaptive" && event?.selected?.skills?.some((skill) => skill?.name === "research")), "adaptive capability routing should emit selected skill metadata after tool output");
  assert(adaptiveCapabilityRoutingCompleted?.events?.some((event) => event?.type === "skill_loaded" && event?.adaptiveRouted === true && event?.skill?.name === "research"), "adaptive capability routing should load matching skills after tool output");
  assert(adaptiveCapabilityRoutingCompleted?.events?.some((event) => event?.type === "memory_loaded" && event?.adaptiveRouted === true && event?.memory?.name === "late-policy"), "adaptive capability routing should load matching memories after tool output");
  assert(adaptiveCapabilityRoutingCompleted?.events?.some((event) => event?.type === "mcp_auto_called" && event?.phase === "adaptive" && event?.server === "docs" && event?.tool === "search_docs"), "adaptive capability routing should auto-call matching MCP after tool output");
  assert(adaptiveCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.selected?.memories?.some((memory) => memory?.name === "late-policy"), "adaptive capability routing should merge selected memories into result metadata");
  assert((await readTextEventually(path.join(workspace, "auto", "adaptive-routing-output.txt"))).includes("adaptive routing loaded late skill memory and mcp"), "adaptive capability routing smoke should write output after late contexts are injected");

  const autoCapabilityRoutingStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli auto capability routing smoke prompt",
      messages: [{ role: "user", content: "auto capability routing smoke: use research skill, review-flow command, testing-policy memory, and docs MCP search_docs capability." }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(autoCapabilityRoutingStarted.response.status === 202, "auto capability routing smoke session should start");
  const autoCapabilityRoutingCompleted = await waitForSessionDone(autoCapabilityRoutingStarted.payload?.data?.id);
  assert(autoCapabilityRoutingCompleted?.data?.status === "completed", "auto capability routing smoke session should complete");
  assert(autoCapabilityRoutingCompleted?.data?.result?.finalText?.includes("auto capability routing smoke completed"), "auto capability routing smoke should reach final response");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "capability_routing" && event?.selected?.skills?.some((skill) => skill?.name === "research")), "auto capability routing should emit selected skill metadata");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "capability_routing" && event?.diagnostics?.categories?.skills?.selectedCount >= 1 && event?.diagnostics?.queryTerms?.includes("research")), "auto capability routing should emit routing diagnostics with query terms and category counts");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "capability_routing" && event?.diagnostics?.snapshot?.comparableWith === "capability_route_preview" && event?.diagnostics?.snapshot?.totalSelected >= 1 && typeof event?.diagnostics?.snapshot?.fingerprint === "string"), "auto capability routing should emit preview-comparable routing snapshot telemetry");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "skill_loaded" && event?.autoRouted === true && event?.skill?.name === "research"), "auto capability routing should auto-load matching skills");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "command_loaded" && event?.autoRouted === true && event?.command?.name === "review-flow"), "auto capability routing should auto-load matching commands");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "memory_loaded" && event?.autoRouted === true && event?.memory?.name === "testing-policy"), "auto capability routing should auto-load matching memories");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "memory_auto_searched" && event?.results?.some((result) => result?.name === "testing-policy" && String(result?.snippet || "").includes("ocli smoke tests"))), "auto capability routing should emit automatic memory RAG evidence");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "mcp_context_loaded" && event?.tools?.some((tool) => tool?.server === "docs" && tool?.name === "search_docs")), "auto capability routing should inject matching MCP tool metadata");
  assert(autoCapabilityRoutingCompleted?.events?.some((event) => event?.type === "mcp_auto_called" && event?.server === "docs" && event?.tool === "search_docs" && String(event?.resultText || "").includes("docs result for")), "auto capability routing should auto-call matching read-only MCP tools");
  assert(autoCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.selected?.mcpTools?.some((tool) => tool?.server === "docs" && tool?.name === "search_docs"), "auto capability routing should be recorded in the result");
  assert(autoCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.diagnostics?.some((diagnostic) => diagnostic?.phase === "initial" && diagnostic?.categories?.skills?.selectedCount >= 1 && diagnostic?.categories?.mcpTools?.candidateCount >= 1), "auto capability routing should record routing diagnostics in the result");
  assert(autoCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.diagnostics?.some((diagnostic) => diagnostic?.snapshot?.comparableWith === "capability_route_preview" && diagnostic?.snapshot?.categories?.skills?.selectedKeys?.some((key) => String(key || "").includes("research"))), "auto capability routing should record preview-comparable routing snapshot in the result");
  assert(autoCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.autoMemoryResults?.some((result) => result?.name === "testing-policy" && String(result?.snippet || "").includes("ocli smoke tests") && result?.links?.includes("review-flow") && result?.backlinks?.some((link) => link?.name === "release-checklist")), "auto capability routing should record automatic memory RAG results in the result");
  assert(autoCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.autoMcpResults?.some((result) => result?.server === "docs" && result?.tool === "search_docs" && String(result?.resultText || "").includes("docs result for")), "auto capability routing should record auto MCP results in the result");
  assert(autoCapabilityRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("## Memory RAG Evidence"), "auto capability routing memory suggestion should preserve memory RAG evidence");
  assert(autoCapabilityRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("testing-policy"), "auto capability routing memory suggestion should preserve the auto memory result name");
  assert(autoCapabilityRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("ocli smoke tests"), "auto capability routing memory suggestion should preserve the auto memory result snippet");
  assert(autoCapabilityRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("docs/search_docs"), "auto capability routing memory suggestion should preserve the auto MCP tool name");
  assert(autoCapabilityRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("docs result for"), "auto capability routing memory suggestion should preserve the auto MCP result text");
  assert(autoCapabilityRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.evidence?.memoryRagResultCount >= 1, "auto capability routing memory suggestion should record memory RAG evidence count");
  assert(autoCapabilityRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.evidence?.mcpResultCount >= 1, "auto capability routing memory suggestion should record MCP evidence count");
  assert((await readTextEventually(path.join(workspace, "auto", "auto-routing-output.txt"))).includes("mcp result"), "auto capability routing smoke should write output after routed contexts and MCP results are injected");

  const capabilityRoutingSettingsWrite = await request("/tools/settings_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: {
        capabilityRouting: {
          includeAgents: false,
          autoMcpCalls: false,
          limits: {
            skills: 0,
            commands: 0,
            memories: 1,
            agents: 0,
            frameworks: 0,
            mcpTools: 0,
            mcpResources: 0,
            autoMcpCalls: 0,
          },
          memorySearch: { maxResults: 2, maxChars: 500 },
          minScores: { memory: 1 },
        },
      },
    }),
  });
  assert(capabilityRoutingSettingsWrite.payload?.ok === true, "settings_write should allow capabilityRouting settings");
  const capabilityRoutingSettingsRead = await request("/tools/settings_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json" }),
  });
  assert(capabilityRoutingSettingsRead.payload?.data?.safeValues?.capabilityRouting?.limits?.skills === 0, "settings_read should expose safe capabilityRouting limits");
  assert(capabilityRoutingSettingsRead.payload?.data?.safeValues?.capabilityRouting?.autoMcpCalls === false, "settings_read should expose safe capabilityRouting autoMcpCalls");
  const settingsCapabilityRoutingStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli settings capability routing smoke prompt",
      messages: [{ role: "user", content: "settings capability routing smoke: use research skill, review-flow command, testing-policy memory, and docs MCP search_docs capability." }],
      maxTurns: 2,
      maxAutoContinuations: 0,
    }),
  });
  assert(settingsCapabilityRoutingStarted.response.status === 202, "settings capability routing smoke session should start");
  const settingsCapabilityRoutingCompleted = await waitForSessionDone(settingsCapabilityRoutingStarted.payload?.data?.id);
  assert(settingsCapabilityRoutingCompleted?.data?.status === "completed", `settings capability routing smoke should complete: ${JSON.stringify({ data: settingsCapabilityRoutingCompleted?.data || {}, events: settingsCapabilityRoutingCompleted?.events || [] }, null, 2)}`);
  assert(settingsCapabilityRoutingCompleted?.data?.result?.finalText?.includes("settings capability routing smoke completed"), "settings capability routing smoke should reach final response");
  assert(settingsCapabilityRoutingCompleted?.events?.some((event) => event?.type === "settings_capability_routing_loaded" && event?.policy?.limits?.skills === 0), "settings capability routing smoke should emit loaded policy metadata");
  assert(settingsCapabilityRoutingCompleted?.events?.some((event) => event?.type === "capability_routing" && event?.diagnostics?.policy?.limits?.skills === 0 && event?.diagnostics?.categories?.skills?.selectedCount === 0), "capability routing diagnostics should use settings policy limits");
  assert(settingsCapabilityRoutingCompleted?.events?.some((event) => event?.type === "memory_loaded" && event?.autoRouted === true && event?.memory?.name === "testing-policy"), "settings capability routing should still load the one allowed memory");
  assert(!settingsCapabilityRoutingCompleted?.events?.some((event) => event?.type === "skill_loaded" && event?.autoRouted === true), "settings capability routing should suppress skill auto-routing when skills limit is zero");
  assert(!settingsCapabilityRoutingCompleted?.events?.some((event) => event?.type === "command_loaded" && event?.autoRouted === true), "settings capability routing should suppress command auto-routing when commands limit is zero");
  assert(!settingsCapabilityRoutingCompleted?.events?.some((event) => event?.type === "mcp_auto_called"), "settings capability routing should suppress automatic MCP calls");
  assert(settingsCapabilityRoutingCompleted?.data?.result?.settingsCapabilityRouting?.limits?.memories === 1, "settings capability routing policy should be preserved in result metadata");
  assert(settingsCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.selected?.memories?.length === 1, "settings capability routing should cap selected memories");
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json", content: JSON.stringify({ permissions: {} }, null, 2) }),
  });

  const agentFrameworkRoutingStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli agent framework routing smoke prompt",
      messages: [{ role: "user", content: "agent framework routing smoke: use the research-stack framework orchestration." }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(agentFrameworkRoutingStarted.response.status === 202, "agent framework routing smoke session should start");
  const agentFrameworkRoutingCompleted = await waitForSessionDone(agentFrameworkRoutingStarted.payload?.data?.id);
  assert(agentFrameworkRoutingCompleted?.data?.status === "completed", "agent framework routing smoke session should complete");
  assert(agentFrameworkRoutingCompleted?.data?.result?.finalText?.includes("agent framework routing smoke completed"), "agent framework routing smoke should reach final response");
  assert(agentFrameworkRoutingCompleted?.events?.some((event) => event?.type === "agent_framework_loaded" && event?.autoRouted === true && event?.framework?.name === "research-stack"), "auto capability routing should auto-load matching agent frameworks");
  assert(agentFrameworkRoutingCompleted?.events?.some((event) => event?.type === "skill_loaded" && event?.autoRouted === true && event?.skill?.name === "research"), "agent framework routing should preload framework skills");
  assert(agentFrameworkRoutingCompleted?.events?.some((event) => event?.type === "memory_loaded" && event?.autoRouted === true && event?.memory?.name === "testing-policy"), "agent framework routing should preload framework memories");
  assert(agentFrameworkRoutingCompleted?.events?.some((event) => event?.type === "agent_loaded" && event?.autoRouted === true && event?.agent?.name === "reviewer"), "agent framework routing should preload framework agents");
  assert(agentFrameworkRoutingCompleted?.events?.some((event) => event?.type === "mcp_context_loaded" && event?.tools?.some((tool) => tool?.server === "docs" && tool?.name === "search_docs")), "agent framework routing should preload framework MCP tools");
  assert(agentFrameworkRoutingCompleted?.events?.some((event) => event?.type === "mcp_context_loaded" && event?.resources?.some((resource) => resource?.server === "docs" && resource?.uri === "docs://routing-guide")), "agent framework routing should preload framework MCP resources");
  assert(agentFrameworkRoutingCompleted?.data?.result?.capabilityRouting?.selected?.frameworks?.some((framework) => framework?.name === "research-stack"), "agent framework selection should be recorded in capabilityRouting");
  assert(agentFrameworkRoutingCompleted?.data?.result?.capabilityRouting?.selected?.mcpTools?.some((tool) => tool?.server === "docs" && tool?.name === "search_docs"), "agent framework MCP tool selection should be recorded in capabilityRouting");
  assert(agentFrameworkRoutingCompleted?.data?.result?.capabilityRouting?.selected?.mcpResources?.some((resource) => resource?.server === "docs" && resource?.uri === "docs://routing-guide"), "agent framework MCP resource selection should be recorded in capabilityRouting");
  assert(agentFrameworkRoutingCompleted?.data?.result?.activeAgentFrameworks?.some((framework) => framework?.name === "research-stack"), "agent framework routing should record active frameworks in the result");
  assert(agentFrameworkRoutingCompleted?.data?.result?.activeAgentFrameworks?.some((framework) => framework?.name === "research-stack" && framework?.mcpResources?.includes("docs://routing-guide")), "agent framework routing should record active framework MCP resources in the result");
  assert(agentFrameworkRoutingCompleted?.data?.result?.activeAgentFrameworks?.some((framework) => framework?.name === "research-stack" && framework?.agentRoles?.some((item) => item.includes("reviewer:")) && framework?.handoffs?.some((item) => item.includes("orchestrator -> reviewer"))), "agent framework routing should record active framework execution blueprint");
  assert(agentFrameworkRoutingCompleted?.events?.some((event) => event?.type === "auto_continue" && event?.reason === "framework_blueprint_guard" && event?.frameworkBlueprintGuard?.missingAgent === "reviewer" && event?.autoDelegated === true), "framework blueprint guard should auto-continue and mark automatic delegation when final response skips required agent_run handoff");
  assert(agentFrameworkRoutingCompleted?.events?.some((event) => event?.type === "tool_start" && event?.tool === "agent_run" && event?.automatic === true && event?.arguments?.agentName === "reviewer"), "framework blueprint guard should start the missing agent_run automatically");
  assert(agentFrameworkRoutingCompleted?.data?.result?.frameworkBlueprintGuards?.some((guard) => guard?.framework?.name === "research-stack" && guard?.missingAgent === "reviewer"), "framework blueprint guard metadata should be recorded in the result");
  assert(agentFrameworkRoutingCompleted?.data?.result?.toolResults?.some((result) => result?.name === "agent_run" && result?.data?.agentName === "reviewer" && String(result?.data?.finalText || "").includes("framework reviewer confirmed")), "framework blueprint guard should force the missing reviewer agent_run before completion");
  assert(agentFrameworkRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("## Routing Evidence"), "agent framework routing memory suggestion should include routing evidence");
  assert(agentFrameworkRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("research-stack"), "agent framework routing memory suggestion should preserve the selected framework");
  assert(agentFrameworkRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("Framework blueprints"), "agent framework routing memory suggestion should preserve framework blueprint section");
  assert(agentFrameworkRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("orchestrator -> reviewer"), "agent framework routing memory suggestion should preserve framework handoff evidence");
  assert(agentFrameworkRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("docs://routing-guide"), "agent framework routing memory suggestion should preserve the selected MCP resource");
  assert(agentFrameworkRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.evidence?.frameworkCount >= 1, "agent framework routing memory suggestion should count selected frameworks");
  assert(agentFrameworkRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.evidence?.frameworkBlueprintCount >= 1, "agent framework routing memory suggestion should count framework blueprint evidence");
  assert(agentFrameworkRoutingCompleted?.data?.result?.memoryMaintenance?.suggestion?.evidence?.mcpResourceCount >= 1, "agent framework routing memory suggestion should count selected MCP resources");
  assert((await readTextEventually(path.join(workspace, "auto", "framework-routing-output.txt"))).includes("framework skill memory agent mcp resource"), "agent framework routing smoke should write output after framework contexts are injected");

  const pluginCapabilityRoutingStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli plugin capability routing smoke prompt",
      messages: [{ role: "user", content: "plugin capability routing smoke: use route-pack plugin-route-helper skill, plugin-route-flow command, and plugin-explorer agent." }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(pluginCapabilityRoutingStarted.response.status === 202, "plugin capability routing smoke session should start");
  const pluginCapabilityRoutingCompleted = await waitForSessionDone(pluginCapabilityRoutingStarted.payload?.data?.id);
  assert(pluginCapabilityRoutingCompleted?.data?.status === "completed", "plugin capability routing smoke session should complete");
  assert(pluginCapabilityRoutingCompleted?.data?.result?.finalText?.includes("plugin capability routing smoke completed"), "plugin capability routing smoke should reach final response");
  assert(pluginCapabilityRoutingCompleted?.events?.some((event) => event?.type === "skill_loaded" && event?.autoRouted === true && event?.skill?.name === "plugin-route-helper" && event?.skill?.source === "plugin"), "auto capability routing should auto-load matching plugin skills");
  assert(pluginCapabilityRoutingCompleted?.events?.some((event) => event?.type === "command_loaded" && event?.autoRouted === true && event?.command?.name === "plugin-route-flow" && event?.command?.source === "plugin"), "auto capability routing should auto-load matching plugin commands");
  assert(pluginCapabilityRoutingCompleted?.events?.some((event) => event?.type === "agent_loaded" && event?.autoRouted === true && event?.agent?.name === "plugin-explorer" && event?.agent?.source === "plugin"), "auto capability routing should auto-load matching plugin agents");
  assert(pluginCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.selected?.skills?.some((skill) => skill?.name === "plugin-route-helper" && skill?.plugin === "route-pack"), "plugin skill selection should be recorded in capabilityRouting");
  assert(pluginCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.selected?.commands?.some((command) => command?.name === "plugin-route-flow" && command?.plugin === "route-pack"), "plugin command selection should be recorded in capabilityRouting");
  assert(pluginCapabilityRoutingCompleted?.data?.result?.capabilityRouting?.selected?.agents?.some((agent) => agent?.name === "plugin-explorer" && agent?.plugin === "route-pack"), "plugin agent selection should be recorded in capabilityRouting");
  assert((await readTextEventually(path.join(workspace, "auto", "plugin-routing-output.txt"))).includes("plugin skill command agent"), "plugin capability routing smoke should write output after plugin routed contexts are injected");

  const skillGuidedStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli skill guided smoke prompt",
      messages: [{ role: "user", content: "skill guided smoke" }],
      maxTurns: 8,
      maxAutoContinuations: 1,
      disableCapabilityRouting: true,
    }),
  });
  assert(skillGuidedStarted.response.status === 202, "skill guided smoke session should start");
  const skillGuidedCompleted = await waitForSessionDone(skillGuidedStarted.payload?.data?.id);
  assert(skillGuidedCompleted?.data?.status === "completed", "skill guided smoke session should complete");
  assert(skillGuidedCompleted?.data?.result?.finalText?.includes("skill guided smoke completed"), "skill guided smoke should reach final response");
  assert(skillGuidedCompleted?.events?.some((event) => event?.type === "skill_loaded" && event?.skill?.name === "research"), "skill guided smoke should emit a skill_loaded event");
  assert(skillGuidedCompleted?.data?.result?.invokedSkills?.some((skill) => skill?.name === "research"), "skill guided smoke should record invoked skills in the result");
  assert(skillGuidedCompleted?.data?.result?.toolResults?.some((result) => result?.name === "skill_list"), "skill guided smoke should list workspace skills");
  assert(skillGuidedCompleted?.data?.result?.toolResults?.some((result) => result?.name === "skill_read"), "skill guided smoke should read the matching skill");
  assert((await readTextEventually(path.join(workspace, "research", "skill-guided-output.txt"))).includes("used research skill"), "skill guided smoke should write output after skill context is loaded");

  const commandGuidedStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli command guided smoke prompt",
      messages: [{ role: "user", content: "command guided smoke" }],
      maxTurns: 8,
      maxAutoContinuations: 1,
      disableCapabilityRouting: true,
    }),
  });
  assert(commandGuidedStarted.response.status === 202, "command guided smoke session should start");
  const commandGuidedCompleted = await waitForSessionDone(commandGuidedStarted.payload?.data?.id);
  assert(commandGuidedCompleted?.data?.status === "completed", "command guided smoke session should complete");
  assert(commandGuidedCompleted?.data?.result?.finalText?.includes("command guided smoke completed"), "command guided smoke should reach final response");
  assert(commandGuidedCompleted?.events?.some((event) => event?.type === "command_loaded" && event?.command?.name === "review-flow"), "command guided smoke should emit a command_loaded event");
  assert(commandGuidedCompleted?.data?.result?.activeCommands?.some((command) => command?.name === "review-flow"), "command guided smoke should record active commands in the result");
  assert(commandGuidedCompleted?.data?.result?.toolResults?.some((result) => result?.name === "command_list"), "command guided smoke should list workspace commands");
  assert(commandGuidedCompleted?.data?.result?.toolResults?.some((result) => result?.name === "command_read"), "command guided smoke should read the matching command");
  assert((await readTextEventually(path.join(workspace, "commands", "command-guided-output.txt"))).includes("used command context marker"), "command guided smoke should write output after command context is loaded");

  const preloadedCommandStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli preloaded command smoke prompt",
      messages: [{ role: "user", content: "preloaded command smoke" }],
      preloadedCommands: [{
        name: "preloaded-review",
        title: "Preloaded Review",
        path: ".oases/commands/preloaded-review.md",
        source: "workspace",
        content: "# Preloaded Review\n\npreloaded command marker\n",
      }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(preloadedCommandStarted.response.status === 202, "preloaded command smoke session should start");
  const preloadedCommandCompleted = await waitForSessionDone(preloadedCommandStarted.payload?.data?.id);
  assert(preloadedCommandCompleted?.data?.status === "completed", "preloaded command smoke session should complete");
  assert(preloadedCommandCompleted?.data?.result?.finalText?.includes("preloaded command smoke completed"), "preloaded command smoke should reach final response");
  assert(preloadedCommandCompleted?.events?.some((event) => event?.type === "command_loaded" && event?.preloaded === true && event?.command?.name === "preloaded-review"), "preloaded command smoke should emit a preloaded command_loaded event");
  assert(preloadedCommandCompleted?.data?.result?.activeCommands?.some((command) => command?.name === "preloaded-review"), "preloaded command smoke should record active commands in the result");
  assert(!preloadedCommandCompleted?.data?.result?.toolResults?.some((result) => result?.name === "command_read"), "preloaded command smoke should not require a command_read tool call");
  assert((await readTextEventually(path.join(workspace, "commands", "preloaded-command-output.txt"))).includes("used command context marker"), "preloaded command smoke should write output after preloaded command context is injected");

  const outputStyleGuidedStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli output style guided smoke prompt",
      messages: [{ role: "user", content: "output style guided smoke" }],
      maxTurns: 8,
      maxAutoContinuations: 1,
      disableCapabilityRouting: true,
    }),
  });
  assert(outputStyleGuidedStarted.response.status === 202, "output style guided smoke session should start");
  const outputStyleGuidedCompleted = await waitForSessionDone(outputStyleGuidedStarted.payload?.data?.id);
  assert(outputStyleGuidedCompleted?.data?.status === "completed", "output style guided smoke session should complete");
  assert(outputStyleGuidedCompleted?.data?.result?.finalText?.includes("output style guided smoke completed"), "output style guided smoke should reach final response");
  assert(outputStyleGuidedCompleted?.events?.some((event) => event?.type === "output_style_loaded" && event?.outputStyle?.name === "concise-local"), "output style guided smoke should emit an output_style_loaded event");
  assert(outputStyleGuidedCompleted?.data?.result?.activeOutputStyles?.some((style) => style?.name === "concise-local"), "output style guided smoke should record active output styles in the result");
  assert(outputStyleGuidedCompleted?.data?.result?.toolResults?.some((result) => result?.name === "output_style_list"), "output style guided smoke should list workspace output styles");
  assert(outputStyleGuidedCompleted?.data?.result?.toolResults?.some((result) => result?.name === "output_style_read"), "output style guided smoke should read the matching output style");
  assert((await readTextEventually(path.join(workspace, "styles", "style-guided-output.txt"))).includes("used concise style"), "output style guided smoke should write output after output style context is loaded");

  const settingsOutputStyleStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli settings output style smoke prompt",
      messages: [{ role: "user", content: "settings output style smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
    }),
  });
  assert(settingsOutputStyleStarted.response.status === 202, "settings output style smoke session should start");
  const settingsOutputStyleCompleted = await waitForSessionDone(settingsOutputStyleStarted.payload?.data?.id);
  assert(settingsOutputStyleCompleted?.data?.status === "completed", "settings output style smoke session should complete");
  assert(settingsOutputStyleCompleted?.data?.result?.finalText?.includes("settings output style smoke completed"), "settings output style smoke should reach final response");
  assert(settingsOutputStyleCompleted?.events?.some((event) => event?.type === "output_style_loaded" && event?.settings === true && event?.outputStyle?.settingPath === ".oases/settings.json"), "settings output style smoke should load outputStyle from workspace settings");
  assert(settingsOutputStyleCompleted?.data?.result?.activeOutputStyles?.some((style) => style?.name === "concise-local" && style?.settingPath === ".oases/settings.json"), "settings output style smoke should record settings-loaded output style metadata");
  assert(!settingsOutputStyleCompleted?.data?.result?.toolResults?.some((result) => result?.name === "output_style_read"), "settings output style smoke should not require the model to call output_style_read");
  assert((await readTextEventually(path.join(workspace, "styles", "settings-style-output.txt"))).includes("used settings concise style"), "settings output style smoke should write output after settings output style context is loaded");

  const memoryGuidedStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli memory guided smoke prompt",
      messages: [{ role: "user", content: "memory guided smoke" }],
      maxTurns: 6,
      maxAutoContinuations: 1,
      disableCapabilityRouting: true,
    }),
  });
  assert(memoryGuidedStarted.response.status === 202, "memory guided smoke session should start");
  const memoryGuidedCompleted = await waitForSessionDone(memoryGuidedStarted.payload?.data?.id);
  assert(memoryGuidedCompleted?.data?.status === "completed", "memory guided smoke session should complete");
  assert(memoryGuidedCompleted?.data?.result?.finalText?.includes("memory guided smoke completed"), "memory guided smoke should reach final response");
  assert(memoryGuidedCompleted?.events?.some((event) => event?.type === "memory_loaded" && event?.memory?.name === "testing-policy"), "memory guided smoke should emit a memory_loaded event");
  assert(memoryGuidedCompleted?.data?.result?.activeMemories?.some((memory) => memory?.name === "testing-policy" && memory?.scope === "project"), "memory guided smoke should record active memories in the result");
  assert(memoryGuidedCompleted?.data?.result?.toolResults?.some((result) => result?.name === "memory_read"), "memory guided smoke should read the matching memory");
  assert((await readTextEventually(path.join(workspace, "memory", "memory-guided-output.txt"))).includes("testing policy memory"), "memory guided smoke should write output after memory context is loaded");

  const preloadedMemoryStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli preloaded memory smoke prompt",
      messages: [{ role: "user", content: "preloaded memory smoke" }],
      preloadedMemories: [{
        name: "preloaded-policy",
        title: "Preloaded Policy",
        scope: "team",
        path: ".oases/memory/team/preloaded-policy.md",
        body: "# Preloaded Policy\n\npreloaded memory marker\n",
        tags: ["preloaded"],
      }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(preloadedMemoryStarted.response.status === 202, "preloaded memory smoke session should start");
  const preloadedMemoryCompleted = await waitForSessionDone(preloadedMemoryStarted.payload?.data?.id);
  assert(preloadedMemoryCompleted?.data?.status === "completed", "preloaded memory smoke session should complete");
  assert(preloadedMemoryCompleted?.data?.result?.finalText?.includes("preloaded memory smoke completed"), "preloaded memory smoke should reach final response");
  assert(preloadedMemoryCompleted?.events?.some((event) => event?.type === "memory_loaded" && event?.preloaded === true && event?.memory?.name === "preloaded-policy"), "preloaded memory smoke should emit a preloaded memory_loaded event");
  assert(preloadedMemoryCompleted?.data?.result?.activeMemories?.some((memory) => memory?.name === "preloaded-policy" && memory?.scope === "team"), "preloaded memory smoke should record active memories in the result");
  assert(!preloadedMemoryCompleted?.data?.result?.toolResults?.some((result) => result?.name === "memory_read"), "preloaded memory smoke should not require a memory_read tool call");
  assert((await readTextEventually(path.join(workspace, "memory", "preloaded-memory-output.txt"))).includes("memory context marker"), "preloaded memory smoke should write output after preloaded memory context is injected");

  const settingsPermissionsStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli settings permissions deny smoke prompt",
      messages: [{ role: "user", content: "settings permissions deny smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(settingsPermissionsStarted.response.status === 202, "settings permissions deny smoke session should start");
  const settingsPermissionsCompleted = await waitForSessionDone(settingsPermissionsStarted.payload?.data?.id);
  assert(settingsPermissionsCompleted?.data?.status === "completed", "settings permissions deny smoke session should complete");
  assert(settingsPermissionsCompleted?.data?.result?.finalText?.includes("settings permissions deny smoke completed"), "settings permissions deny smoke should reach final response after denial");
  assert(settingsPermissionsCompleted?.events?.some((event) => event?.type === "settings_permissions_loaded" && event?.permissions?.denyCount >= 1), "settings permissions deny smoke should emit settings_permissions_loaded");
  const deniedWriteResult = settingsPermissionsCompleted?.data?.result?.toolResults?.find((result) => result?.name === "write_file" && result?.ok === false);
  assert(String(deniedWriteResult?.message || "").includes("permissions.deny"), "settings permissions deny smoke should block matching write_file calls");
  assert(settingsPermissionsCompleted?.data?.result?.settingsPermissions?.deniedTools?.includes("write_file"), "settings permissions deny smoke should record settings permission metadata");
  const deniedFileContent = await readFile(path.join(workspace, "denied-by-settings.txt"), "utf8").catch(() => "");
  assert(deniedFileContent === "", "settings permissions deny smoke should not write denied files");

  const settingsAskStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli settings permissions ask smoke prompt",
      messages: [{ role: "user", content: "settings permissions ask smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(settingsAskStarted.response.status === 202, "settings permissions ask smoke session should start");
  const settingsAskSessionId = settingsAskStarted.payload?.data?.id;
  const settingsAskApprovalEvent = await waitForApproval(settingsAskSessionId);
  assert(settingsAskApprovalEvent.tool === "write_file", "settings permissions ask smoke should request approval for write_file");
  assert(settingsAskApprovalEvent.category === "settings_permission_ask", "settings permissions ask smoke should use the settings approval category");
  assert(String(settingsAskApprovalEvent.reason || "").includes("permissions.ask"), "settings permissions ask approval should explain the settings rule");
  const settingsAskApproved = await request(`/agent/sessions/${encodeURIComponent(settingsAskSessionId)}/approvals/${encodeURIComponent(settingsAskApprovalEvent.approvalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert(settingsAskApproved.payload?.data?.approved === true, "settings permissions ask approval endpoint should approve the pending tool");
  const settingsAskCompleted = await waitForSessionDone(settingsAskSessionId);
  assert(settingsAskCompleted?.data?.status === "completed", "settings permissions ask smoke session should complete after approval");
  assert(settingsAskCompleted?.data?.result?.finalText?.includes("settings permissions ask smoke completed"), "settings permissions ask smoke should reach final response after approval");
  assert(settingsAskCompleted?.events?.some((event) => event?.type === "settings_permissions_loaded" && event?.permissions?.askCount >= 1), "settings permissions ask smoke should emit settings_permissions_loaded with ask metadata");
  assert(settingsAskCompleted?.data?.result?.settingsPermissions?.askedTools?.includes("write_file"), "settings permissions ask smoke should record ask permission metadata");
  assert((await readTextEventually(path.join(workspace, "ask-by-settings.txt"))).includes("approved settings ask write"), "settings permissions ask smoke should write the approved file");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json", content: JSON.stringify({ permissions: { allow: ["Bash(find . -maxdepth 1 -type f)"] } }, null, 2) }),
  });
  const settingsAllowStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli settings permissions allow smoke prompt",
      messages: [{ role: "user", content: "settings permissions allow smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(settingsAllowStarted.response.status === 202, "settings permissions allow smoke session should start");
  const settingsAllowCompleted = await waitForSessionDone(settingsAllowStarted.payload?.data?.id);
  assert(settingsAllowCompleted?.data?.status === "completed", "settings permissions allow smoke session should complete without approval");
  assert(settingsAllowCompleted?.data?.result?.finalText?.includes("settings permissions allow smoke completed"), "settings permissions allow smoke should reach final response");
  assert(!settingsAllowCompleted?.events?.some((event) => event?.type === "approval_required"), "settings permissions allow smoke should not request approval for the allowed command");
  assert(settingsAllowCompleted?.events?.some((event) => event?.type === "settings_permission_allowed" && event?.tool === "run_command"), "settings permissions allow smoke should emit an allow audit event");
  assert(settingsAllowCompleted?.events?.some((event) => event?.type === "settings_permissions_loaded" && event?.permissions?.allowCount >= 1), "settings permissions allow smoke should emit settings_permissions_loaded with allow metadata");
  assert(settingsAllowCompleted?.data?.result?.settingsPermissions?.allowedTools?.includes("run_command"), "settings permissions allow smoke should record allow permission metadata");
  assert(settingsAllowCompleted?.data?.result?.toolResults?.some((result) => result?.name === "run_command" && result?.ok === true), "settings permissions allow smoke should run the allowed command");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json", content: JSON.stringify({ permissions: { defaultMode: "plan" } }, null, 2) }),
  });
  const settingsPlanStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli settings defaultMode plan smoke prompt",
      messages: [{ role: "user", content: "settings defaultMode plan smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(settingsPlanStarted.response.status === 202, "settings defaultMode plan smoke session should start");
  const settingsPlanCompleted = await waitForSessionDone(settingsPlanStarted.payload?.data?.id);
  assert(settingsPlanCompleted?.data?.status === "completed", "settings defaultMode plan smoke session should complete");
  assert(settingsPlanCompleted?.data?.result?.finalText?.includes("settings defaultMode plan smoke completed"), "settings defaultMode plan smoke should reach final response after block");
  assert(!settingsPlanCompleted?.events?.some((event) => event?.type === "approval_required"), "settings defaultMode plan smoke should not request approval");
  const planWriteResult = settingsPlanCompleted?.data?.result?.toolResults?.find((result) => result?.name === "write_file" && result?.ok === false);
  assert(String(planWriteResult?.message || "").includes("defaultMode=plan"), "settings defaultMode plan smoke should block write_file with a plan-mode error");
  assert(settingsPlanCompleted?.data?.result?.settingsPermissions?.defaultMode === "plan", "settings defaultMode plan smoke should record plan mode metadata");
  const planBlockedFileContent = await readFile(path.join(workspace, "plan-mode-blocked.txt"), "utf8").catch(() => "");
  assert(planBlockedFileContent === "", "settings defaultMode plan smoke should not write blocked files");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json", content: JSON.stringify({ permissions: { defaultMode: "dontAsk" } }, null, 2) }),
  });
  const settingsDontAskStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli settings defaultMode dontAsk smoke prompt",
      messages: [{ role: "user", content: "settings defaultMode dontAsk smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(settingsDontAskStarted.response.status === 202, "settings defaultMode dontAsk smoke session should start");
  const settingsDontAskCompleted = await waitForSessionDone(settingsDontAskStarted.payload?.data?.id);
  assert(settingsDontAskCompleted?.data?.status === "completed", "settings defaultMode dontAsk smoke session should complete");
  assert(settingsDontAskCompleted?.data?.result?.finalText?.includes("settings defaultMode dontAsk smoke completed"), "settings defaultMode dontAsk smoke should reach final response after denial");
  assert(!settingsDontAskCompleted?.events?.some((event) => event?.type === "approval_required"), "settings defaultMode dontAsk smoke should not request approval");
  const dontAskCommandResult = settingsDontAskCompleted?.data?.result?.toolResults?.find((result) => result?.name === "run_command" && result?.ok === false);
  assert(String(dontAskCommandResult?.message || "").includes("defaultMode=dontAsk"), "settings defaultMode dontAsk smoke should deny approval-required commands");
  assert(settingsDontAskCompleted?.data?.result?.settingsPermissions?.defaultMode === "dontAsk", "settings defaultMode dontAsk smoke should record dontAsk mode metadata");

  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json", content: JSON.stringify({ permissions: {} }, null, 2) }),
  });

  const autoMemorySuggestionStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli auto memory suggestion smoke prompt",
      messages: [{ role: "user", content: "auto memory suggestion smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(autoMemorySuggestionStarted.response.status === 202, "auto memory suggestion smoke session should start");
  const autoMemorySuggestionCompleted = await waitForSessionDone(autoMemorySuggestionStarted.payload?.data?.id);
  assert(autoMemorySuggestionCompleted?.data?.status === "completed", "auto memory suggestion smoke session should complete");
  assert(autoMemorySuggestionCompleted?.data?.result?.finalText?.includes("auto memory suggestion smoke completed"), "auto memory suggestion smoke should reach final response");
  assert(autoMemorySuggestionCompleted?.events?.some((event) => event?.type === "memory_update_suggested" && event?.autoWrite === false), "ocli should emit a memory_update_suggested event by default");
  assert(autoMemorySuggestionCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("memory/auto-memory-suggestion-output.txt"), "ocli should include generated artifact paths in memory update suggestions");
  assert(autoMemorySuggestionCompleted?.data?.result?.memoryMaintenance?.suggestion?.content?.includes("## Continuation State"), "ocli memory suggestions should include continuation state");
  assert(autoMemorySuggestionCompleted?.data?.result?.memoryMaintenance?.suggestion?.evidence?.stoppedReason === "completed", "ocli memory suggestions should record completed stoppedReason");
  assert(!autoMemorySuggestionCompleted?.events?.some((event) => event?.type === "memory_auto_written"), "ocli should not auto-write memory unless explicitly enabled");

  const autoMemoryOpenTodoStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli auto memory open todo smoke prompt",
      messages: [{ role: "user", content: "auto memory open todo smoke" }],
      maxTurns: 3,
      maxAutoContinuations: 0,
    }),
  });
  assert(autoMemoryOpenTodoStarted.response.status === 202, "auto memory open todo smoke session should start");
  const autoMemoryOpenTodoCompleted = await waitForSessionDone(autoMemoryOpenTodoStarted.payload?.data?.id);
  const openTodoSuggestion = autoMemoryOpenTodoCompleted?.data?.result?.memoryMaintenance?.suggestion || {};
  assert(autoMemoryOpenTodoCompleted?.data?.status === "completed", "auto memory open todo smoke session should complete");
  assert(autoMemoryOpenTodoCompleted?.data?.result?.stoppedReason === "max_turns", "ocli should not mark a session completed when open todos remain at the turn limit");
  assert(openTodoSuggestion?.evidence?.openTodoCount === 1, "ocli memory suggestions should count open todos");
  assert(openTodoSuggestion?.evidence?.stoppedReason === "max_turns", "ocli memory suggestions should record max_turns stoppedReason");
  assert(String(openTodoSuggestion?.content || "").includes("## Open Todo Evidence"), "ocli memory suggestions should include open todo evidence");
  assert(String(openTodoSuggestion?.content || "").includes("open-memory-follow-up"), "ocli memory suggestions should preserve unfinished todo text");
  const continuationHealth = await request("/health");
  assert(Number(continuationHealth.payload?.continuationPendingCount || 0) >= 1, "health summary should expose sessions needing continuation");
  assert(continuationHealth.payload?.latestSession?.needsContinuation === true && continuationHealth.payload?.latestSession?.stoppedReason === "max_turns", "health summary latest session should expose max-turn continuation state");
  const continuationList = await request("/agent/sessions");
  const listedContinuationSession = continuationList.payload?.data?.sessions?.find((session) => session?.id === autoMemoryOpenTodoStarted.payload?.data?.id);
  assert(listedContinuationSession?.needsContinuation === true && listedContinuationSession?.stoppedReason === "max_turns", "session list should expose sessions needing continuation");

  const autoMemoryCleanRequestStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli auto memory clean request smoke prompt",
      messages: [
        { role: "user", content: "auto memory clean request smoke" },
        {
          role: "user",
          content: [
            "已发现以下 MCP 能力。这里只是能力清单，不代表已经调用工具或读取资源；需要使用时必须显式调用 mcp_call。",
            '<mcp_context>{"tools":[{"server":"docs","name":"search_docs"}]}</mcp_context>',
          ].join("\n"),
        },
      ],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(autoMemoryCleanRequestStarted.response.status === 202, "auto memory clean request smoke session should start");
  const autoMemoryCleanRequestCompleted = await waitForSessionDone(autoMemoryCleanRequestStarted.payload?.data?.id);
  assert(autoMemoryCleanRequestCompleted?.data?.status === "completed", "auto memory clean request smoke session should complete");
  assert(autoMemoryCleanRequestCompleted?.data?.result?.finalText?.includes("auto memory clean request smoke completed"), "auto memory clean request smoke should reach final response");
  const cleanSuggestion = autoMemoryCleanRequestCompleted?.data?.result?.memoryMaintenance?.suggestion || {};
  const cleanRequestSection = String(cleanSuggestion.content || "").match(/## User Request\n([\s\S]*?)\n\n## Outcome/)?.[1] || "";
  assert(String(cleanSuggestion.title || "").includes("auto memory clean request smoke"), "memory suggestion title should use the real user request instead of injected context");
  assert(cleanRequestSection.includes("auto memory clean request smoke"), "memory suggestion should preserve the real user request");
  assert(!cleanRequestSection.includes("<mcp_context") && !cleanRequestSection.includes("已发现以下 MCP 能力"), "memory suggestion user request should omit injected MCP context");

  const autoMemorySettingsWrite = await request("/tools/settings_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { memory: { autoWrite: true, scope: "project" }, permissions: {} } }),
  });
  assert(autoMemorySettingsWrite.payload?.ok === true, "settings_write should allow local memory settings");
  const autoMemorySettingsRead = await request("/tools/settings_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json" }),
  });
  assert(autoMemorySettingsRead.payload?.data?.safeValues?.memory?.autoWrite === true, "settings_read should expose safe memory.autoWrite state");
  const autoMemoryWriteStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli auto memory write smoke prompt",
      messages: [{ role: "user", content: "auto memory write smoke" }],
      maxTurns: 4,
      maxAutoContinuations: 1,
    }),
  });
  assert(autoMemoryWriteStarted.response.status === 202, "auto memory write smoke session should start");
  const autoMemoryWriteCompleted = await waitForSessionDone(autoMemoryWriteStarted.payload?.data?.id);
  assert(autoMemoryWriteCompleted?.data?.status === "completed", "auto memory write smoke session should complete");
  assert(autoMemoryWriteCompleted?.data?.result?.finalText?.includes("auto memory write smoke completed"), "auto memory write smoke should reach final response");
  const autoWrittenPath = autoMemoryWriteCompleted?.data?.result?.memoryMaintenance?.written?.path;
  assert(typeof autoWrittenPath === "string" && autoWrittenPath.startsWith(".oases/memory/project/ocli-"), "ocli should auto-write memory when local memory.autoWrite is enabled");
  assert(autoMemoryWriteCompleted?.events?.some((event) => event?.type === "memory_auto_written" && event?.path === autoWrittenPath), "ocli should emit memory_auto_written after local autoWrite");
  assert((await readTextEventually(path.join(workspace, autoWrittenPath))).includes("memory/auto-memory-write-output.txt"), "auto-written memory should include generated artifact paths");
  await request("/tools/write_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: ".oases/settings.local.json", content: JSON.stringify({ permissions: {} }, null, 2) }),
  });

  const crawlerArtifactStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli crawler artifact smoke prompt",
      messages: [{ role: "user", content: "crawler artifact smoke" }],
      maxTurns: 8,
      maxAutoContinuations: 1,
    }),
  });
  assert(crawlerArtifactStarted.response.status === 202, "crawler artifact smoke session should start");
  const crawlerArtifactSessionId = crawlerArtifactStarted.payload?.data?.id;
  const crawlerArtifactCompleted = await waitForSessionDone(crawlerArtifactSessionId);
  assert(crawlerArtifactCompleted?.data?.status === "completed", "crawler artifact smoke session should complete");
  assert(crawlerArtifactCompleted?.data?.result?.finalText?.includes("crawler artifact smoke completed"), `crawler artifact smoke should reach final response: ${JSON.stringify({ data: crawlerArtifactCompleted?.data || {}, events: crawlerArtifactCompleted?.events || [] }, null, 2)}`);
  assert(crawlerArtifactCompleted?.data?.result?.toolResults?.some((result) => result?.name === "todo_write"), "crawler artifact smoke should use todo_write");
  assert(crawlerArtifactCompleted?.data?.result?.toolResults?.some((result) => result?.name === "fetch_url"), "crawler artifact smoke should fetch a source URL");
  assert(crawlerArtifactCompleted?.data?.result?.toolResults?.some((result) => result?.artifacts?.some((artifact) => artifact?.path === "crawler/oilprice_crawler.py")), "crawler artifact smoke should preserve crawler code artifact");
  assert(crawlerArtifactCompleted?.data?.result?.toolResults?.some((result) => result?.artifacts?.some((artifact) => artifact?.path === "data/oilprice_news_sample.json")), "crawler artifact smoke should preserve dataset artifact");
  assert((await readTextEventually(path.join(workspace, "crawler", "oilprice_crawler.py"))).includes("oilprice_news_sample.json"), "crawler artifact smoke should write crawler code");
  assert((await readTextEventually(path.join(workspace, "data", "oilprice_news_sample.json"))).includes("Example energy news"), "crawler artifact smoke should write a dataset");

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  child = startOcliServer();
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  await waitForServer(child);

  const persistedCrawlerDetail = await request(`/agent/sessions/${encodeURIComponent(crawlerArtifactSessionId)}`);
  assert(persistedCrawlerDetail.response.ok, "persisted crawler artifact session detail should be available after ocli restart");
  assert(persistedCrawlerDetail.payload?.artifacts?.some((artifact) => artifact?.path === "crawler/oilprice_crawler.py"), "persisted session detail should expose crawler code artifacts");
  assert(persistedCrawlerDetail.payload?.artifacts?.some((artifact) => artifact?.path === "data/oilprice_news_sample.json"), "persisted session detail should expose dataset artifacts");
  assert(persistedCrawlerDetail.payload?.todos?.some((todo) => todo?.text === "Write crawler code"), "persisted session detail should expose latest todo snapshot");
  assert(typeof persistedCrawlerDetail.payload?.resumePrompt === "string" && persistedCrawlerDetail.payload.resumePrompt.includes("crawler/oilprice_crawler.py"), "persisted session detail should include a resume prompt with artifacts");
  assert(persistedCrawlerDetail.payload?.approvalSummary?.required === 0, "persisted session detail should include approval summary");
  const crawlerTodoClear = await request("/tools/todo_write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      todos: [
        { text: "Fetch source page", status: "done" },
        { text: "Write crawler code", status: "done" },
        { text: "Export dataset", status: "done" },
      ],
    }),
  });
  assert(crawlerTodoClear.payload?.ok === true, "crawler artifact smoke should clear open todos before later independent sessions");

  const upstreamErrorStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli empty upstream error smoke prompt",
      messages: [{ role: "user", content: "empty upstream error smoke" }],
    }),
  });
  assert(upstreamErrorStarted.response.status === 202, "upstream error smoke session should start");
  const upstreamErrorSessionId = upstreamErrorStarted.payload?.data?.id;
  const upstreamErrorCompleted = await waitForSessionDone(upstreamErrorSessionId);
  assert(upstreamErrorCompleted?.data?.status === "failed", "upstream error smoke session should fail");
  assert(String(upstreamErrorCompleted?.data?.error || "").includes("Oases model request failed (502"), "upstream error should include a non-empty HTTP diagnostic");

  const vercelProtectionStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli vercel protection smoke prompt",
      messages: [{ role: "user", content: "vercel protection smoke" }],
    }),
  });
  assert(vercelProtectionStarted.response.status === 202, "vercel protection smoke session should start");
  const vercelProtectionCompleted = await waitForSessionDone(vercelProtectionStarted.payload?.data?.id);
  const vercelProtectionError = String(vercelProtectionCompleted?.data?.error || "");
  assert(vercelProtectionCompleted?.data?.status === "failed", "vercel protection smoke session should fail");
  assert(vercelProtectionError.includes("Vercel deployment protection"), "Vercel protection errors should be explained directly");
  assert(!vercelProtectionError.includes("<!doctype html>"), "Vercel protection errors should not include the full HTML page");

  const longStarted = await request("/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiBaseUrl: fakeApiBaseUrl,
      model: "deepseek-v4-pro",
      systemPrompt: "ocli long max turn smoke prompt",
      messages: [{ role: "user", content: "long max turn smoke" }],
      maxTurns: 16,
    }),
  });
  assert(longStarted.response.status === 202, "long max turn smoke session should start");
  const longCompleted = await waitForSessionDone(longStarted.payload?.data?.id);
  assert(longCompleted?.data?.result?.stoppedReason === "completed", "agent should honor web-provided maxTurns above the old 12-turn cap");
  assert(longCompleted?.data?.result?.finalText?.includes("long max turn smoke completed"), `long max turn smoke should reach the final model response: ${JSON.stringify({ data: longCompleted?.data || {}, events: longCompleted?.events || [] }, null, 2)}`);

  console.log("ocli smoke passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => fakeApiServer.close(resolve));
  await rm(workspace, { recursive: true, force: true });
  await rm(outsideWorkspace, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 143 && stderr.trim()) console.error(stderr.trim());
}
