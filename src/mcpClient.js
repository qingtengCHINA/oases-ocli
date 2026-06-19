/**
 * Lightweight MCP (Model Context Protocol) client using JSON-RPC over stdio.
 * Implements proper Content-Length header framing per MCP spec.
 * Zero external dependencies — uses only Node.js built-in child_process.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const activeServers = new Map();
const TIMEOUT_MS = 30_000;

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function encodeMcpMessage(obj) {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, "utf8");
  return `Content-Length: ${body.length}\r\n\r\n${body}`;
}

function startMcpServer(name, config) {
  if (activeServers.has(name)) return activeServers.get(name);
  const command = config.command;
  if (!command) throw new Error(`MCP server "${name}" has no command.`);
  const args = Array.isArray(config.args) ? config.args : [];
  const env = { ...process.env, ...(config.env && typeof config.env === "object" ? config.env : {}) };
  let child;
  try {
    child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env, shell: false });
  } catch (error) {
    throw new Error(`MCP server "${name}" spawn failed: ${error.message}`);
  }
  const entry = { process: child, pending: new Map(), tools: [], resources: [], nextId: 1, name, stderr: "" };
  activeServers.set(name, entry);

  // MCP Content-Length framed message parser
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffer.length > 10 * 1024 * 1024) {
      buffer = buffer.slice(-1024 * 1024); // Drop oldest data to prevent OOM
    }
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // Skip malformed header, try to find next one
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = parseInt(lengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      if (buffer.length < messageStart + contentLength) break; // Wait for more data
      const messageBody = buffer.slice(messageStart, messageStart + contentLength).toString("utf8");
      buffer = buffer.slice(messageStart + contentLength);
      const msg = tryParseJson(messageBody);
      if (!msg) continue;
      if (typeof msg.id === "number" && entry.pending.has(msg.id)) {
        const { resolve, reject, timer } = entry.pending.get(msg.id);
        entry.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    entry.stderr += chunk.toString("utf8");
    if (entry.stderr.length > 10000) entry.stderr = entry.stderr.slice(-5000);
  });

  child.on("error", (error) => {
    activeServers.delete(name);
    for (const [, { reject, timer }] of entry.pending) {
      clearTimeout(timer);
      reject(new Error(`MCP server "${name}" spawn error: ${error.message}`));
    }
    entry.pending.clear();
  });

  child.on("exit", (code) => {
    activeServers.delete(name);
    for (const [, { reject, timer }] of entry.pending) {
      clearTimeout(timer);
      reject(new Error(`MCP server "${name}" exited with code ${code}`));
    }
    entry.pending.clear();
  });

  return entry;
}

function sendRequest(entry, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = entry.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    const timer = setTimeout(() => {
      if (entry.pending.has(id)) {
        entry.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }
    }, TIMEOUT_MS);
    entry.pending.set(id, { resolve, reject, timer });
    try {
      entry.process.stdin.write(encodeMcpMessage(msg));
    } catch (error) {
      entry.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function sendNotification(entry, method, params = {}) {
  const msg = { jsonrpc: "2.0", method, params };
  try {
    entry.process.stdin.write(encodeMcpMessage(msg));
  } catch {}
}

async function ensureInitialized(name, config) {
  let entry = activeServers.get(name);
  if (!entry) entry = startMcpServer(name, config);
  if (entry.tools.length === 0) {
    try {
      await sendRequest(entry, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        clientInfo: { name: "ocli", version: "0.1.19" },
      });
      sendNotification(entry, "notifications/initialized");
      const toolsResult = await sendRequest(entry, "tools/list").catch(() => ({ tools: [] }));
      entry.tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
      const resourcesResult = await sendRequest(entry, "resources/list").catch(() => ({ resources: [] }));
      entry.resources = Array.isArray(resourcesResult?.resources) ? resourcesResult.resources : [];
    } catch (error) {
      throw new Error(`Failed to initialize MCP server "${name}": ${error.message}`);
    }
  }
  return entry;
}

export async function loadMcpServerConfigs(root) {
  const candidates = [".oases/settings.json", ".oases/settings.local.json"];
  const servers = {};
  for (const rel of candidates) {
    try {
      const raw = await readFile(path.join(root, rel), "utf8");
      const parsed = tryParseJson(raw);
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
        for (const [name, config] of Object.entries(parsed.mcpServers)) {
          if (config && typeof config === "object" && typeof config.command === "string") {
            servers[name] = config;
          }
        }
      }
    } catch {}
  }
  return servers;
}

export async function listMcpTools(root) {
  const configs = await loadMcpServerConfigs(root);
  const allTools = [];
  for (const [name, config] of Object.entries(configs)) {
    try {
      const entry = await ensureInitialized(name, config);
      for (const tool of entry.tools) {
        allTools.push({
          server: name,
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description.slice(0, 500) : "",
          inputSchema: tool.inputSchema || { type: "object" },
        });
      }
    } catch (error) {
      allTools.push({ server: name, name: "__error__", error: error.message });
    }
  }
  return { servers: Object.keys(configs).length, tools: allTools, count: allTools.filter((t) => t.name !== "__error__").length };
}

export async function callMcpTool(root, serverName, toolName, toolArgs = {}) {
  const configs = await loadMcpServerConfigs(root);
  const config = configs[serverName];
  if (!config) throw new Error(`MCP server "${serverName}" not found in .oases/settings.json mcpServers.`);
  const entry = await ensureInitialized(serverName, config);
  const tool = entry.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`MCP tool "${toolName}" not found on server "${serverName}". Available: ${entry.tools.map((t) => t.name).join(", ")}`);
  const result = await sendRequest(entry, "tools/call", { name: toolName, arguments: toolArgs });
  return { server: serverName, tool: toolName, result };
}

export async function listMcpResources(root, serverFilter) {
  const configs = await loadMcpServerConfigs(root);
  const allResources = [];
  for (const [name, config] of Object.entries(configs)) {
    if (serverFilter && name !== serverFilter) continue;
    try {
      const entry = await ensureInitialized(name, config);
      for (const resource of entry.resources) {
        allResources.push({ server: name, ...resource });
      }
    } catch (error) {
      allResources.push({ server: name, uri: "__error__", error: error.message });
    }
  }
  return { servers: Object.keys(configs).length, resources: allResources, count: allResources.filter((r) => r.uri !== "__error__").length };
}

export async function readMcpResource(root, serverName, resourceUri) {
  const configs = await loadMcpServerConfigs(root);
  const config = configs[serverName];
  if (!config) throw new Error(`MCP server "${serverName}" not found in .oases/settings.json mcpServers.`);
  const entry = await ensureInitialized(serverName, config);
  const result = await sendRequest(entry, "resources/read", { uri: resourceUri });
  return { server: serverName, uri: resourceUri, contents: result?.contents || [] };
}

export function shutdownAllMcpServers() {
  for (const [name, entry] of activeServers) {
    try { entry.process.kill(); } catch {}
    activeServers.delete(name);
  }
}
