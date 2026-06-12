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

async function waitForSessionDone(sessionId) {
  const deadline = Date.now() + 5000;
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

const fakeApiServer = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const text = messages.map((message) => String(message.content || "")).join("\n");
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
    if (text.includes("ocli 已运行 find")) {
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
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "skill_list" && tool.risk === "read"), "/tools should expose skill_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "skill_read" && tool.risk === "read"), "/tools should expose skill_read metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_list" && tool.risk === "read"), "/tools should expose agent_list metadata");
  assert(tools.payload?.data?.tools?.some((tool) => tool.name === "agent_read" && tool.risk === "read"), "/tools should expose agent_read metadata");
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
  const skillList = await request("/tools/skill_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 10 }),
  });
  assert(skillList.payload?.data?.skills?.some((skill) => skill?.name === "research" && skill?.path === ".oases/skills/research/SKILL.md"), "skill_list should discover workspace-local skills");
  const skillRead = await request("/tools/skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "research" }),
  });
  assert(skillRead.payload?.data?.content?.includes("Research Skill"), "skill_read should read skill content by name");
  const skillReadBlocked = await request("/tools/skill_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../package.json" }),
  });
  assert(skillReadBlocked.response.status >= 400, "skill_read should reject paths outside .oases/skills");

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
  const agentList = await request("/tools/agent_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxResults: 10 }),
  });
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "reviewer" && agent?.path === ".oases/agents/reviewer.md"), "agent_list should discover workspace-local agents");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "reader" && agent?.tools?.includes("read_file")), "agent_list should expose custom agent tool metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "skilled" && agent?.skills?.includes("research")), "agent_list should expose custom agent skill metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "starter" && agent?.initialPrompt === "initial prompt marker"), "agent_list should expose custom agent initialPrompt metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "yamlstarter" && agent?.tools?.includes("read_file") && agent?.disallowedTools?.includes("write_file") && agent?.skills?.includes("research") && String(agent?.initialPrompt || "").includes("second seeded line")), "agent_list should expose YAML list and block scalar custom agent metadata");
  assert(agentList.payload?.data?.agents?.some((agent) => agent?.name === "effortful" && agent?.effort === "low"), "agent_list should expose custom agent effort metadata");
  const agentRead = await request("/tools/agent_read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "reviewer" }),
  });
  assert(agentRead.payload?.data?.content?.includes("custom reviewer marker"), "agent_read should read agent content by name");
  assert(agentRead.payload?.data?.agent?.agentType === "verify", "agent_read should expose custom agent metadata");
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
  const metadata = JSON.parse(await readTextEventually(path.join(sessionDir, "metadata.json")));
  const result = JSON.parse(await readTextEventually(path.join(sessionDir, "result.json")));
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
  const approved = await request(`/agent/sessions/${encodeURIComponent(approvalSessionId)}/approvals/${encodeURIComponent(approvalEvent.approvalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert(approved.payload?.data?.approved === true, "approval endpoint should approve the pending tool");
  const approvalCompleted = await waitForSessionDone(approvalSessionId);
  assert(approvalCompleted?.data?.result?.finalText?.includes("approval smoke completed"), "approval session should complete after approved tool execution");
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
  assert(crawlerArtifactCompleted?.data?.result?.finalText?.includes("crawler artifact smoke completed"), "crawler artifact smoke should reach final response");
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
  assert(longCompleted?.data?.result?.finalText?.includes("long max turn smoke completed"), "long max turn smoke should reach the final model response");

  console.log("ocli smoke passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => fakeApiServer.close(resolve));
  await rm(workspace, { recursive: true, force: true });
  await rm(outsideWorkspace, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 143 && stderr.trim()) console.error(stderr.trim());
}
