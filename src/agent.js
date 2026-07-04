import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPermissionPolicy, getToolMetadata, handleTool, isProjectToolName, listOpenAiTools, shouldRequireApproval } from "./tools.js";
import { runProcess } from "./process.js";

export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractApiCandidate(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
  const message = choice?.message;
  if (typeof choice?.text === "string") return choice.text;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => typeof part?.text === "string" ? part.text : typeof part === "string" ? part : "").join("");
  }
  if (typeof payload?.content === "string") return payload.content;
  return "";
}

function extractNativeToolCalls(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
  const message = choice?.message;
  const direct = Array.isArray(payload?.tool_calls) ? payload.tool_calls : undefined;
  const messageCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : undefined;
  return (messageCalls || direct || []).map(normalizeProjectToolCall).filter(Boolean);
}

function appendToolCallDelta(accumulator, delta) {
  const chunks = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
  for (const chunk of chunks) {
    const index = Number.isInteger(chunk?.index) ? chunk.index : accumulator.length;
    const current = accumulator[index] || { id: "", type: "function", function: { name: "", arguments: "" } };
    if (typeof chunk.id === "string") current.id += chunk.id;
    if (typeof chunk.type === "string") current.type = chunk.type;
    if (chunk.function && typeof chunk.function === "object") {
      current.function = current.function && typeof current.function === "object" ? current.function : { name: "", arguments: "" };
      if (typeof chunk.function.name === "string") current.function.name += chunk.function.name;
      if (typeof chunk.function.arguments === "string") current.function.arguments += chunk.function.arguments;
    }
    accumulator[index] = current;
  }
}

async function readCompletion(response, onText) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await response.json();
    return { text: extractApiCandidate(payload), toolCalls: extractNativeToolCalls(payload) };
  }
  let finalText = "";
  const streamedToolCalls = [];
  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const data = trimmed.slice(5).trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    const parsed = tryParseJson(data);
    const delta = parsed?.choices?.[0]?.delta;
    appendToolCallDelta(streamedToolCalls, delta);
    const chunk = typeof delta?.content === "string" ? delta.content : extractApiCandidate(parsed);
    if (chunk) {
      finalText += chunk;
      onText?.(finalText, chunk);
    }
    return false;
  };

  const reader = response.body?.getReader?.();
  if (!reader) {
    const raw = await response.text();
    for (const line of raw.split("\n")) {
      if (consumeLine(line)) break;
    }
    return { text: finalText, toolCalls: streamedToolCalls.map(normalizeProjectToolCall).filter(Boolean) };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (consumeLine(line)) {
        done = true;
        break;
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (!done && buffer.trim()) {
    consumeLine(buffer);
  }
  return { text: finalText, toolCalls: streamedToolCalls.map(normalizeProjectToolCall).filter(Boolean) };
}

async function buildModelRequestError(response) {
  const raw = await response.text().catch(() => "");
  if (/Authentication Required/i.test(raw) && /requires Vercel authentication/i.test(raw)) {
    return new Error(`Oases model request failed (${response.status} ${response.statusText || "HTTP error"}) at ${response.url}: Vercel deployment protection blocked the local ocli request. Open Oases Chat from a public production domain or disable Deployment Protection for this deployment.`);
  }
  const parsed = tryParseJson(raw);
  const nestedMessage = typeof parsed?.error?.message === "string"
    ? parsed.error.message
    : typeof parsed?.message === "string"
      ? parsed.message
      : raw.trim();
  const suffix = nestedMessage ? `: ${nestedMessage}` : "";
  return new Error(`Oases model request failed (${response.status} ${response.statusText || "HTTP error"}) at ${response.url}${suffix}`);
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function isRetryableModelStatus(status) {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
}

function isRepairableModelStatus(status) {
  return status === 400 || status === 422;
}

function isRetryableModelError(error) {
  if (!error || isAbortError(error)) return false;
  return error instanceof TypeError || /fetch failed|network|socket|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(String(error.message || error));
}

function modelRequestRetryDelay(attempt) {
  return Math.min(1200, 120 * attempt * attempt);
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}

function buildModelRequestRepair({ requestBody, status, error, appliedRepairs }) {
  if (!isRepairableModelStatus(status)) return undefined;
  const message = error instanceof Error ? error.message : String(error || "");
  const nextRequestBody = { ...requestBody };
  const changedKeys = [];
  const removedKeys = [];
  const repairKeys = [];
  const hasParameterRejection = /unsupported|not supported|unknown|unrecognized|invalid|unexpected|not allowed|not permitted|extra/i.test(message);

  const temperatureOnlyOne = /temperature/i.test(message)
    && (/only\s+1/i.test(message) || /only\s+allowed.*1/i.test(message) || /must\s+be\s+1/i.test(message) || /1\s+is\s+allowed/i.test(message));
  if (temperatureOnlyOne && nextRequestBody.temperature !== 1 && !appliedRepairs.has("temperature_fixed_1")) {
    nextRequestBody.temperature = 1;
    changedKeys.push("temperature");
    repairKeys.push("temperature_fixed_1");
  } else if (/temperature/i.test(message) && hasParameterRejection && Object.prototype.hasOwnProperty.call(nextRequestBody, "temperature") && !appliedRepairs.has("temperature_removed")) {
    delete nextRequestBody.temperature;
    removedKeys.push("temperature");
    repairKeys.push("temperature_removed");
  }

  const effortRejected = /(effort|reasoning_effort)/i.test(message) && hasParameterRejection;
  if (effortRejected && !appliedRepairs.has("effort_removed")) {
    for (const key of ["effort", "reasoning_effort"]) {
      if (Object.prototype.hasOwnProperty.call(nextRequestBody, key)) {
        delete nextRequestBody[key];
        removedKeys.push(key);
      }
    }
    if (removedKeys.includes("effort") || removedKeys.includes("reasoning_effort")) repairKeys.push("effort_removed");
  }

  if (!repairKeys.length) return undefined;
  const key = repairKeys.join("+");
  for (const repairKey of repairKeys) appliedRepairs.add(repairKey);
  return {
    key,
    requestBody: nextRequestBody,
    changedKeys,
    removedKeys,
    summary: `ocli 已修正模型请求参数：${[...changedKeys.map((item) => `${item}=fixed`), ...removedKeys.map((item) => `${item}=removed`)].join(", ")}`,
  };
}

async function fetchModelResponseWithRetry({ apiBaseUrl, requestBody, signal, maxRetries, onEvent, turn }) {
  const maxAttempts = Math.max(1, maxRetries + 1);
  const maxRepairs = 3;
  const appliedRepairs = new Set();
  const repairs = [];
  let activeRequestBody = requestBody;
  let transientRetryCount = 0;
  let repairCount = 0;
  let lastError;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activeRequestBody),
        signal,
      });
      if (response.ok) {
        if (transientRetryCount || repairCount) {
          onEvent?.({
            type: "model_request_recovered",
            turn,
            attempt,
            retryCount: transientRetryCount,
            repairCount,
            repairs,
            maxAttempts,
            summary: repairCount
              ? `ocli 模型请求已在修复 ${repairCount} 次参数后恢复`
              : `ocli 模型请求已在第 ${attempt} 次尝试恢复`,
          });
        }
        return { response, retryCount: transientRetryCount, repairCount, repairs };
      }
      const requestError = await buildModelRequestError(response);
      lastError = requestError;
      const repair = repairCount < maxRepairs
        ? buildModelRequestRepair({ requestBody: activeRequestBody, status: response.status, error: requestError, appliedRepairs })
        : undefined;
      if (repair) {
        repairCount += 1;
        activeRequestBody = repair.requestBody;
        repairs.push({ key: repair.key, changedKeys: repair.changedKeys, removedKeys: repair.removedKeys });
        onEvent?.({
          type: "model_request_repair",
          turn,
          attempt,
          nextAttempt: attempt + 1,
          repairCount,
          maxRepairCount: maxRepairs,
          status: response.status,
          statusText: response.statusText || "",
          changedKeys: repair.changedKeys,
          removedKeys: repair.removedKeys,
          repair: { key: repair.key, changedKeys: repair.changedKeys, removedKeys: repair.removedKeys },
          error: requestError.message,
          summary: repair.summary,
        });
        continue;
      }
      if (!isRetryableModelStatus(response.status) || transientRetryCount >= maxRetries) throw requestError;
      transientRetryCount += 1;
      const delayMs = modelRequestRetryDelay(attempt);
      onEvent?.({
        type: "model_request_retry",
        turn,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        status: response.status,
        statusText: response.statusText || "",
        delayMs,
        error: requestError.message,
        summary: `ocli 模型请求失败，${delayMs}ms 后重试第 ${attempt + 1}/${maxAttempts} 次`,
      });
      await sleep(delayMs, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      if (!isRetryableModelError(error) || transientRetryCount >= maxRetries) throw error;
      transientRetryCount += 1;
      const delayMs = modelRequestRetryDelay(attempt);
      onEvent?.({
        type: "model_request_retry",
        turn,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        error: error instanceof Error ? error.message : String(error || "model request failed"),
        summary: `ocli 模型请求网络失败，${delayMs}ms 后重试第 ${attempt + 1}/${maxAttempts} 次`,
      });
      await sleep(delayMs, signal);
    }
  }
  throw lastError || new Error("Oases model request failed.");
}

function normalizeProjectToolCall(value) {
  if (!value || typeof value !== "object") return undefined;
  const functionPayload = value.function && typeof value.function === "object" ? value.function : undefined;
  const name = typeof functionPayload?.name === "string" ? functionPayload.name : typeof value.name === "string" ? value.name : "";
  if (!isProjectToolName(name)) return undefined;
  const rawArguments = functionPayload?.arguments ?? value.arguments;
  const parsedArguments = typeof rawArguments === "string" ? tryParseJson(rawArguments) : rawArguments;
  return { name, arguments: parsedArguments && typeof parsedArguments === "object" && !Array.isArray(parsedArguments) ? parsedArguments : {} };
}

function extractProjectToolCalls(content) {
  const calls = [];
  for (const match of content.matchAll(/<tool>([\s\S]*?)<\/tool>/gi)) {
    const parsed = normalizeProjectToolCall(tryParseJson(match[1]?.trim() || ""));
    if (parsed) calls.push(parsed);
  }
  if (calls.length) return calls;
  const parsed = tryParseJson(content.trim());
  const direct = normalizeProjectToolCall(parsed);
  if (direct) return [direct];
  const toolCalls = parsed && typeof parsed === "object" && Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
  return toolCalls.map(normalizeProjectToolCall).filter(Boolean);
}

function stripProjectToolBlocks(content) {
  return content.replace(/<tool>[\s\S]*?<\/tool>/gi, "").replace(/<tool>[\s\S]*$/i, "").trim();
}

const DEFAULT_AGENT_TEMPERATURE = 0.35;
const FIXED_TEMPERATURE_MODEL_KEYS = new Set(["kimi-k2.6", "gpt-5.4"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "max"]);

function normalizeModelProfileKey(model) {
  return String(model || "").trim().toLowerCase();
}

function fixedTemperatureForModel(model) {
  const key = normalizeModelProfileKey(model);
  if (FIXED_TEMPERATURE_MODEL_KEYS.has(key) || key.startsWith("gpt-5")) return 1;
  return undefined;
}

function modelSupportsEffort(model) {
  const key = normalizeModelProfileKey(model);
  return key === "deepseek-v4-pro" || key === "mimo-v2.5-pro" || key.startsWith("gpt-5");
}

function normalizeRequestTemperature(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(0, Math.min(2, number));
}

function normalizeEffortLevel(value, fallback = "high") {
  const raw = String(value || "").trim();
  if (EFFORT_LEVELS.has(raw)) return raw;
  return fallback;
}

function buildAgentModelRequestProfile(model, body = {}) {
  const fixedTemperature = fixedTemperatureForModel(model);
  const requestedTemperature = normalizeRequestTemperature(body.temperature);
  const temperature = fixedTemperature ?? requestedTemperature ?? DEFAULT_AGENT_TEMPERATURE;
  const supportsEffort = modelSupportsEffort(model);
  const effort = normalizeEffortLevel(body.effort);
  const request = {
    temperature,
    ...(supportsEffort ? { effort, reasoning_effort: effort } : {}),
  };
  return {
    model,
    normalizedModel: normalizeModelProfileKey(model),
    temperature,
    temperaturePolicy: fixedTemperature !== undefined ? "fixed" : requestedTemperature !== undefined ? "requested" : "default",
    supportsEffort,
    ...(supportsEffort ? { effort } : {}),
    request,
  };
}

function modelRequestProfileMetadata(profile) {
  return {
    model: profile.model,
    normalizedModel: profile.normalizedModel,
    temperature: profile.temperature,
    temperaturePolicy: profile.temperaturePolicy,
    supportsEffort: profile.supportsEffort,
    ...(profile.effort ? { effort: profile.effort } : {}),
    requestKeys: Object.keys(profile.request).sort(),
  };
}

function buildToolResultMessage(results) {
  return `工具执行结果：\n${JSON.stringify(results, null, 2)}`;
}

function escapeXmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildSkillContextMessage(skills) {
  if (!skills.length) return "";
  return [
    "已加载以下 Oases 技能。接下来必须把这些技能内容当作当前任务的强约束执行；如果技能和用户要求冲突，以用户要求为准并说明取舍。",
    ...skills.map((skill) => [
      `<skill_context name="${escapeXmlAttr(skill.name || "skill")}" path="${escapeXmlAttr(skill.path || "")}" source="${escapeXmlAttr(skill.source || "workspace")}" root="${escapeXmlAttr(skill.root || "")}" baseDir="${escapeXmlAttr(skill.baseDir || "")}">`,
      String(skill.content || "").slice(0, 60000),
      "</skill_context>",
    ].join("\n")),
  ].join("\n\n");
}

function buildOutputStyleContextMessage(outputStyles) {
  if (!outputStyles.length) return "";
  return [
    "已加载以下 Oases 输出风格。接下来必须按这些输出风格组织回复；如果输出风格和用户要求冲突，以用户要求为准并说明取舍。",
    ...outputStyles.map((style) => [
      `<output_style_context name="${escapeXmlAttr(style.name || "style")}" path="${escapeXmlAttr(style.path || "")}" source="${escapeXmlAttr(style.source || "workspace")}" plugin="${escapeXmlAttr(style.plugin || "")}">`,
      String(style.prompt || style.content || "").slice(0, 60000),
      "</output_style_context>",
    ].join("\n")),
  ].join("\n\n");
}

function buildCommandContextMessage(commands) {
  if (!commands.length) return "";
  return [
    "已加载以下 Oases 命令模板。接下来必须把这些命令模板当作当前任务的可复用工作流/提示约束执行；如果命令模板和用户要求冲突，以用户要求为准并说明取舍。",
    ...commands.map((command) => [
      `<command_context name="${escapeXmlAttr(command.name || "command")}" title="${escapeXmlAttr(command.title || "")}" path="${escapeXmlAttr(command.path || "")}" source="${escapeXmlAttr(command.source || "workspace")}" plugin="${escapeXmlAttr(command.plugin || "")}">`,
      String(command.body || command.content || "").slice(0, 60000),
      "</command_context>",
    ].join("\n")),
  ].join("\n\n");
}

function buildMemoryContextMessage(memories) {
  if (!memories.length) return "";
  return [
    "已加载以下 Oases 项目记忆。接下来可以把这些记忆作为当前项目的持久上下文参考；如果记忆和用户要求或当前文件事实冲突，以用户要求和当前文件事实为准，并说明取舍。",
    ...memories.map((memory) => [
      `<memory_context name="${escapeXmlAttr(memory.name || "memory")}" title="${escapeXmlAttr(memory.title || "")}" path="${escapeXmlAttr(memory.path || "")}" scope="${escapeXmlAttr(memory.scope || "project")}" tags="${escapeXmlAttr(Array.isArray(memory.tags) ? memory.tags.join(",") : "")}">`,
      memory.ragSnippet ? `<memory_rag_snippet>${String(memory.ragSnippet || "").slice(0, 2000)}</memory_rag_snippet>` : "",
      String(memory.body || memory.content || "").slice(0, 60000),
      "</memory_context>",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function buildTodoStateContextMessage(todoState) {
  const todos = Array.isArray(todoState?.todos) ? todoState.todos : [];
  if (!todos.length) return "";
  const payload = {
    source: todoState.source || "todo_read",
    counts: todoState.counts || {},
    openTodos: Array.isArray(todoState.openTodos) ? todoState.openTodos.slice(0, 50) : [],
    todos: todos.slice(0, 100),
  };
  return [
    "已恢复 Oases 结构化任务清单。接下来必须把未完成项当作当前工程任务的待办约束；最终答复前应实际处理未完成项，并在状态变化时调用 todo_write 更新为 done。",
    `<todo_state_context>${JSON.stringify(payload, null, 2)}</todo_state_context>`,
  ].join("\n\n");
}

function buildAgentContextMessage(agents) {
  if (!agents.length) return "";
  return [
    "已匹配以下 Oases 自定义 Agent。这里只是可委派代理定义，不代表已经启动子代理；需要委派时必须显式调用 agent_run({agentName, task})，并以实际子代理结果为准。",
    ...agents.map((agent) => [
      `<agent_context name="${escapeXmlAttr(agent.name || "agent")}" description="${escapeXmlAttr(agent.description || "")}" path="${escapeXmlAttr(agent.path || "")}" source="${escapeXmlAttr(agent.source || "workspace")}" plugin="${escapeXmlAttr(agent.plugin || "")}" agentType="${escapeXmlAttr(agent.agentType || "")}" tools="${escapeXmlAttr(Array.isArray(agent.tools) ? agent.tools.join(",") : "")}" disallowedTools="${escapeXmlAttr(Array.isArray(agent.disallowedTools) ? agent.disallowedTools.join(",") : "")}" mcpTools="${escapeXmlAttr(Array.isArray(agent.mcpTools) ? agent.mcpTools.join(",") : "")}" disallowedMcpTools="${escapeXmlAttr(Array.isArray(agent.disallowedMcpTools) ? agent.disallowedMcpTools.join(",") : "")}" skills="${escapeXmlAttr(Array.isArray(agent.skills) ? agent.skills.join(",") : "")}" commands="${escapeXmlAttr(Array.isArray(agent.commands) ? agent.commands.join(",") : "")}" memories="${escapeXmlAttr(Array.isArray(agent.memories) ? agent.memories.join(",") : "")}" frameworks="${escapeXmlAttr(Array.isArray(agent.frameworks) ? agent.frameworks.join(",") : "")}">`,
      String(agent.prompt || agent.content || "").slice(0, 60000),
      "</agent_context>",
    ].join("\n")),
  ].join("\n\n");
}

function buildAgentFrameworkContextMessage(frameworks) {
  if (!frameworks.length) return "";
  return [
    "已加载以下 Oases Agent Framework。接下来必须把这些框架当作多代理工作流/能力编排约束；框架声明的 agents、skills、commands、memories、MCP 提示是默认可用能力，但仍以用户要求和当前文件事实为准。若框架声明 agentRoles、handoffs 或 verificationGates，必须把它们作为可执行协作蓝图：需要委派时显式调用 agent_run({agentName, task})，按 handoffs 汇总子代理结果，并在最终回复前满足 verificationGates。",
    ...frameworks.map((framework) => [
      `<agent_framework_context name="${escapeXmlAttr(framework.name || "framework")}" title="${escapeXmlAttr(framework.title || "")}" path="${escapeXmlAttr(framework.path || "")}" agents="${escapeXmlAttr(Array.isArray(framework.agents) ? framework.agents.join(",") : "")}" skills="${escapeXmlAttr(Array.isArray(framework.skills) ? framework.skills.join(",") : "")}" commands="${escapeXmlAttr(Array.isArray(framework.commands) ? framework.commands.join(",") : "")}" memories="${escapeXmlAttr(Array.isArray(framework.memories) ? framework.memories.join(",") : "")}" mcpServers="${escapeXmlAttr(Array.isArray(framework.mcpServers) ? framework.mcpServers.join(",") : "")}" mcpTools="${escapeXmlAttr(Array.isArray(framework.mcpTools) ? framework.mcpTools.join(",") : "")}" mcpResources="${escapeXmlAttr(Array.isArray(framework.mcpResources) ? framework.mcpResources.join(",") : "")}" agentRoles="${escapeXmlAttr(Array.isArray(framework.agentRoles) ? framework.agentRoles.join(" | ") : "")}" handoffs="${escapeXmlAttr(Array.isArray(framework.handoffs) ? framework.handoffs.join(" | ") : "")}" verificationGates="${escapeXmlAttr(Array.isArray(framework.verificationGates) ? framework.verificationGates.join(" | ") : "")}">`,
      (Array.isArray(framework.agentRoles) && framework.agentRoles.length) || (Array.isArray(framework.handoffs) && framework.handoffs.length) || (Array.isArray(framework.verificationGates) && framework.verificationGates.length)
        ? `<framework_execution_blueprint>${JSON.stringify({
          agentRoles: framework.agentRoles || [],
          handoffs: framework.handoffs || [],
          verificationGates: framework.verificationGates || [],
        }, null, 2)}</framework_execution_blueprint>`
        : "",
      String(framework.prompt || framework.content || "").slice(0, 60000),
      "</agent_framework_context>",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function summarizeMcpInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object" };
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? Object.fromEntries(Object.entries(schema.properties).slice(0, 12).map(([name, value]) => [
        name,
        {
          type: typeof value?.type === "string" ? value.type : undefined,
          description: typeof value?.description === "string" ? value.description.slice(0, 180) : undefined,
          enum: Array.isArray(value?.enum) ? value.enum.slice(0, 12) : undefined,
        },
      ]))
    : undefined;
  return {
    type: typeof schema.type === "string" ? schema.type : "object",
    ...(Array.isArray(schema.required) ? { required: schema.required.slice(0, 20) } : {}),
    ...(properties ? { properties } : {}),
  };
}

function buildMcpContextMessage(context) {
  const tools = Array.isArray(context?.tools) ? context.tools : [];
  const resources = Array.isArray(context?.resources) ? context.resources : [];
  if (!tools.length && !resources.length) return "";
  const payload = {
    tools: tools.map((tool) => ({
      server: tool.server,
      name: tool.name,
      description: String(tool.description || "").slice(0, 500),
      inputSchema: summarizeMcpInputSchema(tool.inputSchema),
    })),
    resources: resources.map((resource) => ({
      server: resource.server,
      uri: resource.uri,
      name: resource.name,
      description: String(resource.description || "").slice(0, 500),
      mimeType: resource.mimeType,
    })),
  };
  return [
    "已发现以下 MCP 能力。这里只是能力清单，不代表已经调用工具或读取资源；需要使用时必须显式调用 mcp_call、mcp_resources_list 或 mcp_resource_read，并以实际返回结果为准。",
    `<mcp_context>${JSON.stringify(payload, null, 2)}</mcp_context>`,
  ].join("\n\n");
}

function mcpResultText(value) {
  const result = value?.result && typeof value.result === "object" ? value.result : value;
  const content = Array.isArray(result?.content) ? result.content : Array.isArray(result?.contents) ? result.contents : [];
  const text = content
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      return item && typeof item === "object" ? JSON.stringify(item) : "";
    })
    .filter(Boolean)
    .join("\n");
  return (text || JSON.stringify(result || {})).slice(0, 4000);
}

function buildMcpResultContextMessage(results) {
  const successful = Array.isArray(results) ? results.filter((result) => result?.ok !== false) : [];
  if (!successful.length) return "";
  const payload = {
    results: successful.map((result) => ({
      server: result.server,
      tool: result.tool,
      arguments: result.arguments || {},
      resultText: result.resultText || "",
    })),
  };
  return [
    "已自动调用以下只读 MCP 工具，并获得真实结果。后续回答必须以这些实际返回结果为准；如果还需要更多 MCP 数据，再显式调用 mcp_call 或 mcp_resource_read。",
    `<mcp_result_context>${JSON.stringify(payload, null, 2)}</mcp_result_context>`,
  ].join("\n\n");
}

const MCP_AUTO_CALL_SAFE_RE = /\b(search|query|lookup|find|list|read|get|fetch|docs?|documentation|resource|resources)\b/i;
const MCP_AUTO_CALL_MUTATION_RE = /\b(write|create|update|delete|remove|send|post|put|patch|apply|run|execute|exec|deploy|publish|merge|close|mutate|mutation)\b/i;
const MCP_QUERY_FIELDS = ["query", "q", "search", "term", "terms", "keyword", "keywords", "text", "prompt", "question"];

function inferAutoMcpArguments(tool, query) {
  const descriptor = `${tool?.name || ""} ${tool?.description || ""}`;
  if (!MCP_AUTO_CALL_SAFE_RE.test(descriptor) || MCP_AUTO_CALL_MUTATION_RE.test(descriptor)) return undefined;
  const schema = tool?.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) ? tool.inputSchema : {};
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : [];
  const stringFields = Object.entries(properties)
    .filter(([, value]) => !value || typeof value !== "object" || !value.type || value.type === "string")
    .map(([name]) => name);
  const queryField = MCP_QUERY_FIELDS.find((field) => stringFields.includes(field))
    || (required.length === 1 && stringFields.includes(required[0]) ? required[0] : "");
  if (!required.length && !queryField) return {};
  if (!queryField) return undefined;
  if (required.some((field) => field !== queryField)) return undefined;
  return { [queryField]: String(query || "").slice(0, 1000) };
}

async function autoCallRoutedMcpTools(root, tools, query, params = {}) {
  const routingPolicy = cloneCapabilityRoutingPolicy(params.routingPolicy);
  if (routingPolicy.autoMcpCalls === false || params.body?.autoMcpCalls === false || params.body?.disableAutoMcpCalls === true) return { results: [], errors: [] };
  const maxAutoCalls = normalizePolicyInteger(routingPolicy.limits.autoMcpCalls, DEFAULT_CAPABILITY_ROUTING_POLICY.limits.autoMcpCalls, 0, 50);
  const results = [];
  const errors = [];
  for (const tool of (Array.isArray(tools) ? tools : []).slice(0, maxAutoCalls)) {
    const args = inferAutoMcpArguments(tool, query);
    if (!args) continue;
    try {
      const data = await handleTool(root, "mcp_call", { server: tool.server, tool: tool.name, arguments: args }, { signal: params.signal });
      results.push({
        server: tool.server,
        tool: tool.name,
        arguments: args,
        ok: true,
        resultText: mcpResultText(data),
      });
    } catch (error) {
      errors.push({ source: "mcp_call", target: `${tool.server}/${tool.name}`, message: error instanceof Error ? error.message : String(error || "mcp_call failed") });
    }
  }
  return { results, errors };
}

const ROUTING_STOP_TERMS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "only", "should", "would", "could",
  "please", "need", "needs", "using", "use", "used", "smoke", "prompt", "task", "agent", "ocli",
  "auto", "delayed", "run", "check", "tool", "tools", "result", "results", "message", "name",
  "text", "content", "path", "status", "summary", "ok", "true", "false", "persisted", "count",
  "counts", "todo", "doing", "done", "completed", "completion", "generated", "artifact",
  "artifacts", "file", "files", "write", "written", "read", "fetch", "source", "page", "output",
  "data", "dataset", "export",
  "oases", "工程", "项目", "现在", "这个", "那个", "一下", "需要", "使用", "处理", "检查", "实现",
]);

const ROUTING_MIN_SCORES = {
  skill: 12,
  command: 10,
  memory: 24,
  mcp: 8,
  agent: 16,
  framework: 12,
};

const DEFAULT_CAPABILITY_ROUTING_POLICY = {
  enabled: true,
  adaptive: true,
  includeAgents: true,
  autoMcpCalls: true,
  limits: {
    skills: 2,
    commands: 2,
    memories: 3,
    agents: 2,
    frameworks: 2,
    mcpTools: 12,
    mcpResources: 8,
    autoMcpCalls: 3,
  },
  discovery: {
    skills: 80,
    pluginSkills: 80,
    commands: 80,
    pluginCommands: 80,
    memories: 120,
    agents: 80,
    frameworks: 80,
    pluginAgents: 80,
  },
  memorySearch: {
    maxResults: 12,
    maxChars: 700,
  },
  minScores: ROUTING_MIN_SCORES,
  sourcePaths: [],
};

const CAPABILITY_ROUTING_LIMIT_ALIASES = {
  skills: ["skills", "skill", "maxSkills", "skillLimit"],
  commands: ["commands", "command", "maxCommands", "commandLimit"],
  memories: ["memories", "memory", "maxMemories", "memoryLimit"],
  agents: ["agents", "agent", "maxAgents", "agentLimit"],
  frameworks: ["frameworks", "framework", "maxFrameworks", "frameworkLimit"],
  mcpTools: ["mcpTools", "mcpTool", "maxMcpTools", "mcpToolLimit"],
  mcpResources: ["mcpResources", "mcpResource", "maxMcpResources", "mcpResourceLimit"],
  autoMcpCalls: ["autoMcpCalls", "mcpAutoCalls", "maxAutoMcpCalls", "autoMcpCallLimit"],
};

const CAPABILITY_ROUTING_TOP_LEVEL_LIMIT_ALIASES = {
  ...CAPABILITY_ROUTING_LIMIT_ALIASES,
  autoMcpCalls: ["maxAutoMcpCalls", "autoMcpCallLimit"],
};

const CAPABILITY_ROUTING_DISCOVERY_ALIASES = {
  skills: ["skills", "skill", "maxSkills"],
  pluginSkills: ["pluginSkills", "pluginSkill", "maxPluginSkills"],
  commands: ["commands", "command", "maxCommands"],
  pluginCommands: ["pluginCommands", "pluginCommand", "maxPluginCommands"],
  memories: ["memories", "memory", "maxMemories"],
  agents: ["agents", "agent", "maxAgents"],
  frameworks: ["frameworks", "framework", "maxFrameworks"],
  pluginAgents: ["pluginAgents", "pluginAgent", "maxPluginAgents"],
};

const CAPABILITY_ROUTING_SCORE_ALIASES = {
  skill: ["skill", "skills"],
  command: ["command", "commands"],
  memory: ["memory", "memories"],
  mcp: ["mcp", "mcpTools", "mcpResources"],
  agent: ["agent", "agents"],
  framework: ["framework", "frameworks"],
};

function cloneCapabilityRoutingPolicy(policy = DEFAULT_CAPABILITY_ROUTING_POLICY) {
  return {
    enabled: policy.enabled !== false,
    adaptive: policy.adaptive !== false,
    includeAgents: policy.includeAgents !== false,
    autoMcpCalls: policy.autoMcpCalls !== false,
    limits: { ...DEFAULT_CAPABILITY_ROUTING_POLICY.limits, ...(policy.limits || {}) },
    discovery: { ...DEFAULT_CAPABILITY_ROUTING_POLICY.discovery, ...(policy.discovery || {}) },
    memorySearch: { ...DEFAULT_CAPABILITY_ROUTING_POLICY.memorySearch, ...(policy.memorySearch || {}) },
    minScores: { ...DEFAULT_CAPABILITY_ROUTING_POLICY.minScores, ...(policy.minScores || {}) },
    sourcePaths: Array.isArray(policy.sourcePaths) ? policy.sourcePaths.slice(0, 8) : [],
  };
}

function firstOwnSettingValue(source, aliases) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function normalizePolicyInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function mergePolicyNumberMap(base, source, aliasMap, min, max) {
  const output = { ...base };
  if (!source || typeof source !== "object" || Array.isArray(source)) return output;
  for (const [target, aliases] of Object.entries(aliasMap)) {
    output[target] = normalizePolicyInteger(firstOwnSettingValue(source, aliases), output[target], min, max);
  }
  return output;
}

function mergeCapabilityRoutingPolicy(basePolicy, rawPolicy, sourcePath = "") {
  const policy = cloneCapabilityRoutingPolicy(basePolicy);
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) return policy;
  if (sourcePath && !policy.sourcePaths.includes(sourcePath)) policy.sourcePaths.push(sourcePath);
  if (typeof rawPolicy.enabled === "boolean") policy.enabled = rawPolicy.enabled;
  if (typeof rawPolicy.auto === "boolean") policy.enabled = rawPolicy.auto;
  if (typeof rawPolicy.adaptive === "boolean") policy.adaptive = rawPolicy.adaptive;
  if (typeof rawPolicy.autoAdaptive === "boolean") policy.adaptive = rawPolicy.autoAdaptive;
  if (typeof rawPolicy.includeAgents === "boolean") policy.includeAgents = rawPolicy.includeAgents;
  if (typeof rawPolicy.agentRouting === "boolean") policy.includeAgents = rawPolicy.agentRouting;
  if (typeof rawPolicy.autoMcpCalls === "boolean") policy.autoMcpCalls = rawPolicy.autoMcpCalls;
  if (typeof rawPolicy.mcpAutoCalls === "boolean") policy.autoMcpCalls = rawPolicy.mcpAutoCalls;
  policy.limits = mergePolicyNumberMap(policy.limits, rawPolicy.limits, CAPABILITY_ROUTING_LIMIT_ALIASES, 0, 50);
  policy.limits = mergePolicyNumberMap(policy.limits, rawPolicy, CAPABILITY_ROUTING_TOP_LEVEL_LIMIT_ALIASES, 0, 50);
  policy.discovery = mergePolicyNumberMap(policy.discovery, rawPolicy.discovery, CAPABILITY_ROUTING_DISCOVERY_ALIASES, 0, 500);
  if (rawPolicy.memorySearch && typeof rawPolicy.memorySearch === "object" && !Array.isArray(rawPolicy.memorySearch)) {
    policy.memorySearch = {
      maxResults: normalizePolicyInteger(rawPolicy.memorySearch.maxResults ?? rawPolicy.memorySearch.results, policy.memorySearch.maxResults, 0, 50),
      maxChars: normalizePolicyInteger(rawPolicy.memorySearch.maxChars ?? rawPolicy.memorySearch.chars, policy.memorySearch.maxChars, 200, 5000),
    };
  }
  policy.minScores = mergePolicyNumberMap(policy.minScores, rawPolicy.minScores, CAPABILITY_ROUTING_SCORE_ALIASES, 0, 200);
  policy.minScores = mergePolicyNumberMap(policy.minScores, rawPolicy.minimumScores, CAPABILITY_ROUTING_SCORE_ALIASES, 0, 200);
  return policy;
}

export function normalizeCapabilityRoutingSettings(rawPolicy = {}, basePolicy = DEFAULT_CAPABILITY_ROUTING_POLICY) {
  return mergeCapabilityRoutingPolicy(basePolicy, rawPolicy);
}

function publicCapabilityRoutingPolicy(policy) {
  const normalized = cloneCapabilityRoutingPolicy(policy);
  return {
    enabled: normalized.enabled,
    adaptive: normalized.adaptive,
    includeAgents: normalized.includeAgents,
    autoMcpCalls: normalized.autoMcpCalls,
    limits: normalized.limits,
    discovery: normalized.discovery,
    memorySearch: normalized.memorySearch,
    minScores: normalized.minScores,
    ...(normalized.sourcePaths.length ? { sourcePaths: normalized.sourcePaths } : {}),
  };
}

const ADAPTIVE_ROUTING_CONTEXT_TOOLS = new Set([
  "read_file",
  "fetch_url",
  "web_search",
  "grep_files",
  "list_files",
  "workspace_status",
  "worktree_diff",
  "settings_read",
  "skill_list",
  "skill_read",
  "skill_asset_list",
  "skill_asset_read",
  "command_list",
  "command_read",
  "output_style_list",
  "output_style_read",
  "memory_list",
  "memory_search",
  "memory_read",
  "agent_list",
  "agent_read",
  "agent_framework_list",
  "agent_framework_read",
  "plugin_list",
  "plugin_read",
  "plugin_capability_list",
  "plugin_capability_read",
  "plugin_command_list",
  "plugin_command_read",
  "plugin_output_style_list",
  "plugin_output_style_read",
  "plugin_agent_list",
  "plugin_agent_read",
  "plugin_skill_list",
  "plugin_skill_read",
  "plugin_asset_list",
  "plugin_asset_read",
  "mcp_list",
  "mcp_resources_list",
  "mcp_resource_read",
  "mcp_call",
]);

const ROUTING_CATEGORY_TERMS = {
  skill: ["skill", "skills", "技能", "workflow", "流程", "指南", "规范", "recipe"],
  command: ["command", "commands", "slash", "模板", "命令", "流程", "workflow", "review", "plan"],
  memory: ["memory", "memories", "记忆", "上下文", "长期", "项目知识", "之前", "规则", "policy", "背景"],
  mcp: ["mcp", "server", "servers", "tool", "tools", "resource", "resources", "docs", "github", "jira", "database", "db", "文档", "工具", "资源", "服务"],
  agent: ["agent", "agents", "subagent", "delegate", "delegation", "reviewer", "explorer", "planner", "verifier", "代理", "子代理", "委派", "审查", "验证", "探索", "规划"],
  framework: ["framework", "frameworks", "agent-framework", "orchestration", "workflow", "playbook", "框架", "编排", "工作流"],
};

function routeSearchText(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(routeSearchText).join(" ");
  if (typeof value === "object") return Object.values(value).map(routeSearchText).join(" ");
  return String(value);
}

function tokenizeRoutingQuery(value) {
  const lower = String(value || "").toLowerCase();
  const matches = lower.match(/[a-z0-9][a-z0-9._-]{1,}|[\u4e00-\u9fff]{2,}/g) || [];
  const terms = [];
  const seen = new Set();
  for (const term of matches) {
    if (ROUTING_STOP_TERMS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= 100) break;
  }
  return terms;
}

function isInjectedRoutingContextMessage(content) {
  const text = String(content || "").trimStart();
  if (!text) return false;
  if (/^已(?:加载|匹配|发现|自动调用)以下 Oases /.test(text)) return true;
  if (/^已恢复 Oases 结构化任务清单/.test(text)) return true;
  if (/^已恢复上一个 Ocli 会话的结构化续跑状态/.test(text)) return true;
  if (/^已发现以下 MCP 能力/.test(text)) return true;
  if (/^已自动调用以下只读 MCP 工具/.test(text)) return true;
  if (/<session_resume_context>/i.test(text)) return true;
  if (/^<context_compaction\b/i.test(text)) return true;
  if (/^<framework_execution_blueprint\b/i.test(text)) return true;
  return /^<(?:skill|command|memory|agent|agent_framework|mcp|mcp_result|output_style|todo_state|context_compaction|session_resume)_?context\b/i.test(text);
}

function truncateRoutingText(value, limit = 12000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n...` : text;
}

function compactRoutingObject(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateRoutingText(value, depth >= 2 ? 1000 : 3000);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactRoutingObject(item, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (["text", "html", "markdown", "content", "body"].includes(key) && typeof item === "string") {
      output[key] = truncateRoutingText(item, 600);
      continue;
    }
    output[key] = compactRoutingObject(item, depth + 1);
  }
  return output;
}

function summarizeRoutingToolResult(result) {
  if (!result || typeof result !== "object") return result;
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : {};
  const base = {
    name: result.name,
    ok: result.ok,
    message: result.message,
  };
  if (result.name === "read_file") {
    return {
      ...base,
      data: {
        path: data.path,
        content: truncateRoutingText(data.content, 24000),
      },
    };
  }
  if (result.name === "fetch_url") {
    return {
      ...base,
      data: {
        url: data.url,
        finalUrl: data.finalUrl,
        status: data.status,
        ok: data.ok,
        contentType: data.contentType,
        title: data.title,
        links: Array.isArray(data.links) ? data.links.slice(0, 8).map((link) => ({
          url: link?.url,
          text: link?.text,
        })) : [],
      },
    };
  }
  return compactRoutingObject(result);
}

function normalizeRoutingMessageContent(content) {
  const text = String(content || "");
  const prefix = "工具执行结果：";
  if (!text.trimStart().startsWith(prefix)) return text;
  const jsonStart = text.indexOf(prefix) + prefix.length;
  try {
    const parsed = JSON.parse(text.slice(jsonStart).trim());
    const results = Array.isArray(parsed) ? parsed : [parsed];
    return `${prefix}\n${JSON.stringify(results.map(summarizeRoutingToolResult), null, 2)}`;
  } catch {
    return text;
  }
}

export function adaptiveCapabilityRoutingResults(results) {
  return (Array.isArray(results) ? results : []).filter((result) => (
    result?.ok !== false && ADAPTIVE_ROUTING_CONTEXT_TOOLS.has(result?.name)
  ));
}

export function shouldRunAdaptiveCapabilityRouting(results) {
  return adaptiveCapabilityRoutingResults(results).length > 0;
}

function buildCapabilityRoutingQuery(messages, systemPrompt) {
  const promptText = typeof systemPrompt === "string" ? systemPrompt : "";
  const recentMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message.content === "string" && ["user", "system"].includes(message.role))
    .filter((message) => !isInjectedRoutingContextMessage(message.content))
    .slice(-10)
    .map((message) => normalizeRoutingMessageContent(message.content))
    .join("\n");
  return [promptText.slice(-12000), recentMessages].filter(Boolean).join("\n").slice(-40000);
}

function categoryHintScore(type, queryLower) {
  return (ROUTING_CATEGORY_TERMS[type] || []).some((term) => queryLower.includes(term)) ? 2 : 0;
}

function candidateDisplayName(candidate) {
  return String(candidate?.name || candidate?.id || candidate?.title || candidate?.uri || candidate?.path || "").trim();
}

function scoreRoutingCandidate(candidate, type, queryInfo) {
  if (!candidate || typeof candidate !== "object") return 0;
  const queryLower = queryInfo.queryLower;
  const terms = queryInfo.terms;
  const name = candidateDisplayName(candidate).toLowerCase();
  const pathText = String(candidate.path || candidate.uri || "").toLowerCase();
  const haystack = [
    candidate.name,
    candidate.id,
    candidate.title,
    candidate.description,
    candidate.path,
    candidate.scope,
    candidate.server,
    candidate.uri,
    candidate.mimeType,
    Array.isArray(candidate.tags) ? candidate.tags.join(" ") : "",
    Array.isArray(candidate.routingTerms) ? candidate.routingTerms.join(" ") : "",
    Array.isArray(candidate.agents) ? candidate.agents.join(" ") : "",
    Array.isArray(candidate.skills) ? candidate.skills.join(" ") : "",
    Array.isArray(candidate.commands) ? candidate.commands.join(" ") : "",
    Array.isArray(candidate.memories) ? candidate.memories.join(" ") : "",
    Array.isArray(candidate.agentRoles) ? candidate.agentRoles.join(" ") : "",
    Array.isArray(candidate.handoffs) ? candidate.handoffs.join(" ") : "",
    Array.isArray(candidate.verificationGates) ? candidate.verificationGates.join(" ") : "",
    routeSearchText(candidate.inputSchema?.properties || {}),
  ].join(" ").toLowerCase();
  let score = categoryHintScore(type, queryLower);
  if (name && queryLower.includes(name)) score += 18;
  const stem = pathText.split("/").pop()?.replace(/\.(md|json)$/i, "") || "";
  if (stem && queryLower.includes(stem)) score += 12;
  for (const term of terms) {
    if (!term || term.length < 2) continue;
    if (name === term) score += 10;
    else if (name.includes(term)) score += 5;
    else if (pathText.includes(term)) score += 4;
    else if (haystack.includes(term)) score += term.length >= 4 ? 3 : 1;
  }
  return score;
}

function minimumRoutingScore(type, policy) {
  const routingPolicy = cloneCapabilityRoutingPolicy(policy);
  const value = Number(routingPolicy.minScores[type]);
  return Number.isFinite(value) ? value : ROUTING_MIN_SCORES[type] || 1;
}

function sortAndLimitRoutedCandidates(candidates, type, queryInfo, limit, policy) {
  const minScore = minimumRoutingScore(type, policy);
  const safeLimit = normalizePolicyInteger(limit, 0, 0, 100);
  if (safeLimit <= 0) return [];
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({ candidate, score: scoreRoutingCandidate(candidate, type, queryInfo) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || candidateDisplayName(a.candidate).localeCompare(candidateDisplayName(b.candidate)))
    .slice(0, safeLimit)
    .map((entry) => ({ ...entry.candidate, routingScore: entry.score }));
}

function routingScoreType(type) {
  return type === "mcpTool" || type === "mcpResource" ? "mcp" : type;
}

function summarizeRoutingDiagnosticCandidate(candidate, type, score, selected = false) {
  const metadata = safeRoutingMetadata({ ...candidate, routingScore: score }, type);
  if (!metadata) return undefined;
  return {
    ...metadata,
    selected: selected === true,
    routingScore: score,
  };
}

function stableRoutingSnapshotValue(value) {
  if (Array.isArray(value)) return value.map(stableRoutingSnapshotValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableRoutingSnapshotValue(value[key])]),
  );
}

function routingSnapshotFingerprint(value) {
  const text = JSON.stringify(stableRoutingSnapshotValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function routingSnapshotKey(item, type) {
  return routingMetadataKey(item, type)
    || candidateDisplayName(item)
    || String(item?.uri || item?.path || item?.name || "").trim();
}

function buildRoutingDiagnostics(queryInfo, groups, policy) {
  const publicPolicy = publicCapabilityRoutingPolicy(policy);
  const categories = {};
  const snapshotCategories = {};
  let totalCandidates = 0;
  let totalSelected = 0;
  for (const [key, group] of Object.entries(groups || {})) {
    const metadataType = group.metadataType || key;
    const scoreType = routingScoreType(metadataType);
    const candidates = Array.isArray(group.candidates) ? group.candidates : [];
    const selected = Array.isArray(group.selected) ? group.selected : [];
    const selectedKeys = new Set(selected.map((item) => routingMetadataKey(item, metadataType)).filter(Boolean));
    const scored = candidates
      .map((candidate) => ({ candidate, score: scoreRoutingCandidate(candidate, scoreType, queryInfo) }))
      .sort((a, b) => b.score - a.score || candidateDisplayName(a.candidate).localeCompare(candidateDisplayName(b.candidate)));
    const topRejected = scored
      .filter((entry) => !selectedKeys.has(routingMetadataKey(entry.candidate, metadataType)))
      .slice(0, 5)
      .map((entry) => summarizeRoutingDiagnosticCandidate(entry.candidate, metadataType, entry.score, false))
      .filter(Boolean);
    const topSelected = selected
      .slice(0, 5)
      .map((entry) => summarizeRoutingDiagnosticCandidate(entry, metadataType, Number(entry.routingScore) || scoreRoutingCandidate(entry, scoreType, queryInfo), true))
      .filter(Boolean);
    const threshold = minimumRoutingScore(scoreType, policy);
    const candidateCount = candidates.length;
    const selectedCount = selected.length;
    totalCandidates += candidateCount;
    totalSelected += selectedCount;
    categories[key] = {
      candidateCount,
      selectedCount,
      threshold,
      topSelected,
      topRejected,
    };
    snapshotCategories[key] = {
      candidateCount,
      selectedCount,
      threshold,
      selectedKeys: selected.map((item) => routingSnapshotKey(item, metadataType)).filter(Boolean).slice(0, 50),
    };
  }
  const snapshot = {
    schemaVersion: 1,
    comparableWith: "capability_route_preview",
    totalCandidates,
    totalSelected,
    categories: snapshotCategories,
  };
  snapshot.fingerprint = routingSnapshotFingerprint({
    queryTerms: queryInfo.terms.slice(0, 40),
    policy: publicPolicy,
    categories: snapshotCategories,
  });
  return {
    queryChars: queryInfo.query.length,
    queryTerms: queryInfo.terms.slice(0, 40),
    policy: publicPolicy,
    categories,
    snapshot,
  };
}

function safeRoutingMetadata(item, type) {
  if (!item || typeof item !== "object") return undefined;
  if (type === "skill") {
    return {
      name: item.name || "skill",
      description: item.description || "",
      path: item.path || "",
      source: item.source || "workspace",
      plugin: item.plugin || "",
      root: item.root || "",
      routingScore: item.routingScore || 0,
    };
  }
  if (type === "command") {
    return {
      name: item.name || "command",
      title: item.title || "",
      description: item.description || "",
      path: item.path || "",
      source: item.source || "workspace",
      plugin: item.plugin || "",
      routingScore: item.routingScore || 0,
    };
  }
  if (type === "memory") {
    return {
      name: item.name || "memory",
      title: item.title || "",
      description: item.description || "",
      path: item.path || "",
      scope: item.scope || "project",
      tags: Array.isArray(item.tags) ? item.tags : [],
      ragSnippet: item.ragSnippet || item.snippet || "",
      routingScore: item.routingScore || 0,
    };
  }
  if (type === "agent") {
    return {
      name: item.name || "agent",
      description: item.description || "",
      path: item.path || "",
      source: item.source || "workspace",
      plugin: item.plugin || "",
      agentType: item.agentType || "",
      routingScore: item.routingScore || 0,
      ...(item.maxTurns ? { maxTurns: item.maxTurns } : {}),
      ...(typeof item.background === "boolean" ? { background: item.background } : {}),
      ...(item.isolation ? { isolation: item.isolation } : {}),
      ...(item.effort ? { effort: item.effort } : {}),
      ...(Array.isArray(item.tools) ? { tools: item.tools } : {}),
      ...(Array.isArray(item.disallowedTools) ? { disallowedTools: item.disallowedTools } : {}),
      ...(Array.isArray(item.skills) ? { skills: item.skills } : {}),
      ...(Array.isArray(item.commands) ? { commands: item.commands } : {}),
      ...(Array.isArray(item.memories) ? { memories: item.memories } : {}),
      ...(Array.isArray(item.frameworks) ? { frameworks: item.frameworks } : {}),
    };
  }
  if (type === "framework") {
    return {
      name: item.name || "framework",
      title: item.title || "",
      description: item.description || "",
      path: item.path || "",
      routingScore: item.routingScore || 0,
      ...(Array.isArray(item.agents) ? { agents: item.agents } : {}),
      ...(Array.isArray(item.skills) ? { skills: item.skills } : {}),
      ...(Array.isArray(item.commands) ? { commands: item.commands } : {}),
      ...(Array.isArray(item.memories) ? { memories: item.memories } : {}),
      ...(Array.isArray(item.mcpServers) ? { mcpServers: item.mcpServers } : {}),
      ...(Array.isArray(item.mcpTools) ? { mcpTools: item.mcpTools } : {}),
      ...(Array.isArray(item.mcpResources) ? { mcpResources: item.mcpResources } : {}),
      ...(Array.isArray(item.agentRoles) ? { agentRoles: item.agentRoles } : {}),
      ...(Array.isArray(item.handoffs) ? { handoffs: item.handoffs } : {}),
      ...(Array.isArray(item.verificationGates) ? { verificationGates: item.verificationGates } : {}),
    };
  }
  if (type === "mcpTool") {
    return {
      server: item.server || "",
      name: item.name || "",
      description: item.description || "",
      routingScore: item.routingScore || 0,
    };
  }
  if (type === "mcpResource") {
    return {
      server: item.server || "",
      uri: item.uri || "",
      name: item.name || "",
      description: item.description || "",
      routingScore: item.routingScore || 0,
    };
  }
  return undefined;
}

function routedReadArgs(item) {
  if (typeof item?.path === "string" && item.path.trim()) return { path: item.path, maxChars: 60000 };
  if (typeof item?.name === "string" && item.name.trim()) return { name: item.name, maxChars: 60000 };
  if (typeof item?.id === "string" && item.id.trim()) return { name: item.id, maxChars: 60000 };
  return undefined;
}

function isPluginCapabilityCandidate(item) {
  return item?.source === "plugin"
    || (typeof item?.plugin === "string" && item.plugin.trim())
    || String(item?.path || "").startsWith(".oases/plugins/");
}

function mcpToolKey(tool) {
  const server = String(tool?.server || "").trim();
  const name = String(tool?.name || "").trim();
  return server && name ? `${server}/${name}` : "";
}

function mergeMcpTools(...toolLists) {
  const seen = new Set();
  const merged = [];
  for (const tool of toolLists.flat()) {
    const key = mcpToolKey(tool);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(tool);
  }
  return merged;
}

function mcpResourceKey(resource) {
  const server = String(resource?.server || "").trim();
  const uri = String(resource?.uri || "").trim();
  return server && uri ? `${server}/${uri}` : "";
}

function mergeMcpResources(...resourceLists) {
  const seen = new Set();
  const merged = [];
  for (const resource of resourceLists.flat()) {
    const key = mcpResourceKey(resource);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(resource);
  }
  return merged;
}

function routingMetadataKey(item, type) {
  if (!item || typeof item !== "object") return "";
  if (type === "mcpTool") return mcpToolKey(item);
  if (type === "mcpResource") return mcpResourceKey(item);
  const pathValue = typeof item.path === "string" && item.path.trim() ? item.path.trim() : "";
  if (pathValue) return pathValue;
  const plugin = typeof item.plugin === "string" && item.plugin.trim() ? `${item.plugin.trim()}:` : "";
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "";
  return name ? `${plugin}${name}` : "";
}

function mergeRoutingMetadataList(current = [], next = [], type) {
  const seen = new Set();
  const merged = [];
  for (const item of [...current, ...next]) {
    const key = routingMetadataKey(item, type) || JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function mergeAutoMcpResults(current = [], next = []) {
  const seen = new Set();
  const merged = [];
  for (const item of [...current, ...next]) {
    const key = [
      item?.server || "",
      item?.tool || "",
      JSON.stringify(item?.arguments || {}),
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function autoMemoryResultKey(item) {
  if (!item || typeof item !== "object") return "";
  const pathValue = typeof item.path === "string" && item.path.trim() ? item.path.trim() : "";
  if (pathValue) return pathValue;
  const scope = typeof item.scope === "string" && item.scope.trim() ? `${item.scope.trim()}:` : "";
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "";
  return name ? `${scope}${name}` : "";
}

function normalizeAutoMemoryBacklink(value) {
  if (!value || typeof value !== "object") return undefined;
  const name = typeof value.name === "string" ? value.name : "";
  const title = typeof value.title === "string" ? value.title : "";
  const path = typeof value.path === "string" ? value.path : "";
  const scope = typeof value.scope === "string" ? value.scope : "";
  if (!name && !title && !path) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(path ? { path } : {}),
    ...(scope ? { scope } : {}),
  };
}

function normalizeAutoMemoryResult(result, query = "") {
  if (!result || typeof result !== "object") return undefined;
  const memory = result.memory && typeof result.memory === "object" ? result.memory : result;
  const path = typeof result.path === "string" && result.path ? result.path : typeof memory.path === "string" ? memory.path : "";
  const name = typeof memory.name === "string" && memory.name ? memory.name
    : typeof result.name === "string" && result.name ? result.name
      : path ? path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "memory" : "memory";
  const snippet = typeof result.snippet === "string" && result.snippet ? result.snippet
    : typeof result.ragSnippet === "string" && result.ragSnippet ? result.ragSnippet
      : typeof memory.ragSnippet === "string" && memory.ragSnippet ? memory.ragSnippet
        : typeof memory.snippet === "string" ? memory.snippet : "";
  if (!path && !name && !snippet) return undefined;
  const scoreValue = Number(result.score ?? result.routingScore);
  return {
    ...(query ? { query: String(query).slice(0, 500) } : {}),
    name,
    ...(typeof memory.title === "string" && memory.title ? { title: memory.title } : {}),
    ...(typeof memory.description === "string" && memory.description ? { description: memory.description } : {}),
    ...(path ? { path } : {}),
    scope: typeof memory.scope === "string" && memory.scope ? memory.scope : "project",
    ...(Array.isArray(memory.tags) ? { tags: memory.tags.slice(0, 12) } : {}),
    ...(Number.isFinite(scoreValue) ? { score: scoreValue } : {}),
    ...(snippet ? { snippet: snippet.slice(0, 1200) } : {}),
    ...(Array.isArray(result.matchedTerms) ? { matchedTerms: result.matchedTerms.map((item) => String(item || "")).filter(Boolean).slice(0, 20) } : {}),
    ...(Array.isArray(result.links) ? { links: result.links.map((item) => String(item || "")).filter(Boolean).slice(0, 20) } : Array.isArray(memory.links) ? { links: memory.links.map((item) => String(item || "")).filter(Boolean).slice(0, 20) } : {}),
    ...(Array.isArray(result.backlinks) ? { backlinks: result.backlinks.map(normalizeAutoMemoryBacklink).filter(Boolean).slice(0, 20) } : {}),
  };
}

function mergeAutoMemoryResults(current = [], next = []) {
  const seen = new Set();
  const merged = [];
  for (const item of [...current, ...next]) {
    const key = autoMemoryResultKey(item) || JSON.stringify({
      query: item?.query || "",
      snippet: item?.snippet || "",
      name: item?.name || "",
    });
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function normalizeRoutingDiagnostics(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((item) => item && typeof item === "object");
}

function mergeRoutingDiagnostics(current = [], next = []) {
  return [...normalizeRoutingDiagnostics(current), ...normalizeRoutingDiagnostics(next)].slice(-12);
}

function mergeCapabilityRouting(current, next) {
  if (!current) return next;
  if (!next) return current;
  return {
    selected: {
      skills: mergeRoutingMetadataList(current.selected?.skills || [], next.selected?.skills || [], "skill"),
      commands: mergeRoutingMetadataList(current.selected?.commands || [], next.selected?.commands || [], "command"),
      memories: mergeRoutingMetadataList(current.selected?.memories || [], next.selected?.memories || [], "memory"),
      agents: mergeRoutingMetadataList(current.selected?.agents || [], next.selected?.agents || [], "agent"),
      frameworks: mergeRoutingMetadataList(current.selected?.frameworks || [], next.selected?.frameworks || [], "framework"),
      mcpTools: mergeRoutingMetadataList(current.selected?.mcpTools || [], next.selected?.mcpTools || [], "mcpTool"),
      mcpResources: mergeRoutingMetadataList(current.selected?.mcpResources || [], next.selected?.mcpResources || [], "mcpResource"),
    },
    errors: [...(current.errors || []), ...(next.errors || [])],
    loadedSkills: [...(current.loadedSkills || []), ...(next.loadedSkills || [])],
    loadedCommands: [...(current.loadedCommands || []), ...(next.loadedCommands || [])],
    loadedMemories: [...(current.loadedMemories || []), ...(next.loadedMemories || [])],
    loadedAgents: [...(current.loadedAgents || []), ...(next.loadedAgents || [])],
    loadedFrameworks: [...(current.loadedFrameworks || []), ...(next.loadedFrameworks || [])],
    autoMemoryResults: mergeAutoMemoryResults(current.autoMemoryResults || [], next.autoMemoryResults || []),
    autoMcpResults: mergeAutoMcpResults(current.autoMcpResults || [], next.autoMcpResults || []),
    diagnostics: mergeRoutingDiagnostics(current.diagnostics, next.diagnostics),
    mcpContext: {
      tools: mergeRoutingMetadataList(current.mcpContext?.tools || [], next.mcpContext?.tools || [], "mcpTool"),
      resources: mergeRoutingMetadataList(current.mcpContext?.resources || [], next.mcpContext?.resources || [], "mcpResource"),
    },
  };
}

async function routeInitialCapabilities(root, params = {}) {
  const body = params.body || {};
  if (body.autoCapabilityRouting === false || body.disableCapabilityRouting === true) return undefined;
  const routingPolicy = normalizeCapabilityRoutingSettings(body.capabilityRouting || {}, params.settingsCapabilityRouting || DEFAULT_CAPABILITY_ROUTING_POLICY);
  if (routingPolicy.enabled === false) return undefined;
  if (params.phase === "adaptive" && routingPolicy.adaptive === false) return undefined;
  const includeAgentRouting = routingPolicy.includeAgents !== false && Math.max(0, Number(params.subAgentDepth) || 0) < 1 && body.autoAgentRouting !== false && body.disableAgentRouting !== true;
  const query = buildCapabilityRoutingQuery(params.messages, params.systemPrompt);
  const queryInfo = { query, queryLower: query.toLowerCase(), terms: tokenizeRoutingQuery(query) };
  if (!queryInfo.terms.length) return undefined;
  const routingSearchQuery = queryInfo.terms.join(" ");
  const discoveryNames = [
    "skill_list",
    "plugin_skill_list",
    "command_list",
    "plugin_command_list",
    "memory_list",
    "memory_search",
    "agent_list",
    "agent_framework_list",
    "plugin_agent_list",
    "mcp_list",
    "mcp_resources_list",
  ];
  const discovery = await Promise.allSettled([
    handleTool(root, "skill_list", { maxResults: routingPolicy.discovery.skills }, { signal: params.signal }),
    handleTool(root, "plugin_skill_list", { maxResults: routingPolicy.discovery.pluginSkills }, { signal: params.signal }),
    handleTool(root, "command_list", { maxResults: routingPolicy.discovery.commands }, { signal: params.signal }),
    handleTool(root, "plugin_command_list", { maxResults: routingPolicy.discovery.pluginCommands }, { signal: params.signal }),
    handleTool(root, "memory_list", { maxResults: routingPolicy.discovery.memories }, { signal: params.signal }),
    routingPolicy.memorySearch.maxResults > 0
      ? handleTool(root, "memory_search", { query: routingSearchQuery, maxResults: routingPolicy.memorySearch.maxResults, maxChars: routingPolicy.memorySearch.maxChars }, { signal: params.signal })
      : Promise.resolve(undefined),
    includeAgentRouting ? handleTool(root, "agent_list", { maxResults: routingPolicy.discovery.agents }, { signal: params.signal }) : Promise.resolve(undefined),
    includeAgentRouting ? handleTool(root, "agent_framework_list", { maxResults: routingPolicy.discovery.frameworks }, { signal: params.signal }) : Promise.resolve(undefined),
    includeAgentRouting ? handleTool(root, "plugin_agent_list", { maxResults: routingPolicy.discovery.pluginAgents }, { signal: params.signal }) : Promise.resolve(undefined),
    handleTool(root, "mcp_list", {}, { signal: params.signal }),
    handleTool(root, "mcp_resources_list", {}, { signal: params.signal }),
  ]);
  const [skillList, pluginSkillList, commandList, pluginCommandList, memoryList, memorySearch, agentList, frameworkList, pluginAgentList, mcpList, mcpResourcesList] = discovery.map((result) => result.status === "fulfilled" ? result.value : undefined);
  const errors = discovery
    .map((result, index) => result.status === "rejected" ? {
      source: discoveryNames[index],
      message: result.reason instanceof Error ? result.reason.message : String(result.reason || "discovery failed"),
    } : undefined)
    .filter(Boolean);
  const skillCandidates = [...(skillList?.skills || []), ...(pluginSkillList?.skills || [])]
    .filter((skill) => skill?.path && !params.loadedSkillPaths?.has(skill.path));
  const selectedSkills = sortAndLimitRoutedCandidates(skillCandidates, "skill", queryInfo, routingPolicy.limits.skills, routingPolicy);
  const commandCandidates = [...(commandList?.commands || []), ...(pluginCommandList?.commands || [])]
    .filter((command) => command?.path && !params.loadedCommandPaths?.has(command.path));
  const selectedCommands = sortAndLimitRoutedCandidates(commandCandidates, "command", queryInfo, routingPolicy.limits.commands, routingPolicy);
  const searchedMemories = (Array.isArray(memorySearch?.memories) ? memorySearch.memories : [])
    .map((result) => ({
      ...(result?.memory && typeof result.memory === "object" ? result.memory : {}),
      path: result?.path || result?.memory?.path || "",
      routingScore: Math.max(Number(result?.score) || 0, Number(result?.routingScore) || 0),
      ragSnippet: typeof result?.snippet === "string" ? result.snippet : "",
      matchedTerms: Array.isArray(result?.matchedTerms) ? result.matchedTerms : [],
      backlinks: Array.isArray(result?.backlinks) ? result.backlinks : [],
      links: Array.isArray(result?.links) ? result.links : result?.memory?.links,
    }))
    .filter((memory) => memory.path && (Number(memory.routingScore) || 0) >= minimumRoutingScore("memory", routingPolicy));
  const memoryCandidates = (searchedMemories.length
    ? searchedMemories
    : sortAndLimitRoutedCandidates(memoryList?.memories || [], "memory", queryInfo, 12, routingPolicy))
    .filter((memory) => memory?.path && !params.loadedMemoryPaths?.has(memory.path));
  const selectedMemories = (searchedMemories.length
    ? memoryCandidates.sort((a, b) => (b.routingScore || 0) - (a.routingScore || 0)).slice(0, routingPolicy.limits.memories)
    : sortAndLimitRoutedCandidates(memoryCandidates, "memory", queryInfo, routingPolicy.limits.memories, routingPolicy));
  let autoMemoryResults = searchedMemories
    .map((memory) => normalizeAutoMemoryResult(memory, routingSearchQuery))
    .filter(Boolean)
    .slice(0, 12);
  const agentCandidates = includeAgentRouting
    ? [...(agentList?.agents || []), ...(pluginAgentList?.agents || [])].filter((agent) => agent?.path && !params.loadedAgentPaths?.has(agent.path))
    : [];
  const selectedAgents = sortAndLimitRoutedCandidates(agentCandidates, "agent", queryInfo, routingPolicy.limits.agents, routingPolicy);
  const frameworkCandidates = includeAgentRouting
    ? (frameworkList?.frameworks || []).filter((framework) => framework?.path && !params.loadedAgentFrameworkPaths?.has(framework.path))
    : [];
  const selectedFrameworks = sortAndLimitRoutedCandidates(frameworkCandidates, "framework", queryInfo, routingPolicy.limits.frameworks, routingPolicy);
  const mcpToolCandidates = (mcpList?.tools || []).filter((tool) => {
    if (!tool?.name || tool.name === "__error__") return false;
      const key = mcpToolKey(tool);
      return key && !params.loadedMcpToolKeys?.has(key);
  });
  const selectedMcpTools = sortAndLimitRoutedCandidates(mcpToolCandidates, "mcp", queryInfo, routingPolicy.limits.mcpTools, routingPolicy);
  const mcpResourceCandidates = (mcpResourcesList?.resources || []).filter((resource) => {
    if (!resource?.uri || resource.uri === "__error__") return false;
      const key = mcpResourceKey(resource);
      return key && !params.loadedMcpResourceKeys?.has(key);
  });
  const selectedMcpResources = sortAndLimitRoutedCandidates(mcpResourceCandidates, "mcp", queryInfo, routingPolicy.limits.mcpResources, routingPolicy);
  const autoMcp = await autoCallRoutedMcpTools(root, selectedMcpTools, query, { ...params, routingPolicy });
  errors.push(...autoMcp.errors);

  const loadedSkills = [];
  for (const skill of selectedSkills) {
    const args = routedReadArgs(skill);
    if (!args) continue;
    const toolName = isPluginCapabilityCandidate(skill) ? "plugin_skill_read" : "skill_read";
    try {
      const data = await handleTool(root, toolName, args, { signal: params.signal });
      const loaded = normalizeLoadedSkillData(data);
      if (loaded) loadedSkills.push({ ...loaded, routingScore: skill.routingScore });
    } catch (error) {
      errors.push({ source: toolName, target: skill.path || skill.name, message: error instanceof Error ? error.message : String(error || "skill read failed") });
    }
  }

  const loadedCommands = [];
  for (const command of selectedCommands) {
    const args = routedReadArgs(command);
    if (!args) continue;
    const toolName = isPluginCapabilityCandidate(command) ? "plugin_command_read" : "command_read";
    try {
      const data = await handleTool(root, toolName, args, { signal: params.signal });
      const loaded = normalizeLoadedCommandData(data, toolName);
      if (loaded) loadedCommands.push({ ...loaded, routingScore: command.routingScore });
    } catch (error) {
      errors.push({ source: toolName, target: command.path || command.name, message: error instanceof Error ? error.message : String(error || "command read failed") });
    }
  }

  const loadedMemories = [];
  for (const memory of selectedMemories) {
    const args = routedReadArgs(memory);
    if (!args) continue;
    if (memory.scope) args.scope = memory.scope;
    try {
      const data = await handleTool(root, "memory_read", args, { signal: params.signal });
      const loaded = normalizeLoadedMemoryData(data);
      if (loaded) loadedMemories.push({ ...loaded, routingScore: memory.routingScore, ragSnippet: memory.ragSnippet || "", matchedTerms: memory.matchedTerms || [], backlinks: memory.backlinks || [] });
    } catch (error) {
      errors.push({ source: "memory_read", target: memory.path || memory.name, message: error instanceof Error ? error.message : String(error || "memory read failed") });
    }
  }
  autoMemoryResults = mergeAutoMemoryResults(
    autoMemoryResults,
    loadedMemories
      .map((memory) => normalizeAutoMemoryResult({
        ...memory,
        snippet: memory.ragSnippet || memory.body || memory.content || "",
        score: memory.routingScore,
      }, routingSearchQuery))
      .filter(Boolean),
  ).slice(0, 12);

  const loadedAgents = [];
  for (const agent of selectedAgents) {
    const args = routedReadArgs(agent);
    if (!args) continue;
    const toolName = isPluginCapabilityCandidate(agent) ? "plugin_agent_read" : "agent_read";
    try {
      const data = await handleTool(root, toolName, args, { signal: params.signal });
      const loaded = normalizeLoadedAgentData(data);
      if (loaded) loadedAgents.push({ ...loaded, routingScore: agent.routingScore });
    } catch (error) {
      errors.push({ source: toolName, target: agent.path || agent.name, message: error instanceof Error ? error.message : String(error || "agent read failed") });
    }
  }

  const loadedFrameworks = [];
  for (const framework of selectedFrameworks) {
    const args = routedReadArgs(framework);
    if (!args) continue;
    try {
      const data = await handleTool(root, "agent_framework_read", args, { signal: params.signal });
      const loaded = normalizeLoadedAgentFrameworkData(data);
      if (loaded) loadedFrameworks.push({ ...loaded, routingScore: framework.routingScore });
    } catch (error) {
      errors.push({ source: "agent_framework_read", target: framework.path || framework.name, message: error instanceof Error ? error.message : String(error || "agent framework read failed") });
    }
  }

  const frameworkMcpTools = [];
  const frameworkMcpResources = [];
  if (loadedFrameworks.length) {
    const dependencies = await loadAgentFrameworkDependencies(root, loadedFrameworks, { ...params, availableMcpTools: mcpList?.tools, availableMcpResources: mcpResourcesList?.resources });
    for (const skill of dependencies.skills) {
      if (!loadedSkills.some((item) => item.path === skill.path) && !params.loadedSkillPaths?.has(skill.path)) loadedSkills.push(skill);
    }
    for (const command of dependencies.commands) {
      if (!loadedCommands.some((item) => item.path === command.path) && !params.loadedCommandPaths?.has(command.path)) loadedCommands.push(command);
    }
    for (const memory of dependencies.memories) {
      if (!loadedMemories.some((item) => item.path === memory.path) && !params.loadedMemoryPaths?.has(memory.path)) loadedMemories.push(memory);
    }
    for (const agent of dependencies.agents) {
      if (!loadedAgents.some((item) => item.path === agent.path) && !params.loadedAgentPaths?.has(agent.path)) loadedAgents.push(agent);
    }
    for (const tool of dependencies.mcpTools) {
      const key = mcpToolKey(tool);
      if (key && !params.loadedMcpToolKeys?.has(key)) frameworkMcpTools.push(tool);
    }
    for (const resource of dependencies.mcpResources) {
      const key = mcpResourceKey(resource);
      if (key && !params.loadedMcpResourceKeys?.has(key)) frameworkMcpResources.push(resource);
    }
    errors.push(...dependencies.errors);
  }

  const combinedMcpTools = mergeMcpTools(selectedMcpTools, frameworkMcpTools);
  const combinedMcpResources = mergeMcpResources(selectedMcpResources, frameworkMcpResources);
  const selected = {
    skills: loadedSkills.map((skill) => safeRoutingMetadata(skill, "skill")).filter(Boolean),
    commands: loadedCommands.map((command) => safeRoutingMetadata(command, "command")).filter(Boolean),
    memories: loadedMemories.map((memory) => safeRoutingMetadata(memory, "memory")).filter(Boolean),
    agents: loadedAgents.map((agent) => safeRoutingMetadata(agent, "agent")).filter(Boolean),
    frameworks: loadedFrameworks.map((framework) => safeRoutingMetadata(framework, "framework")).filter(Boolean),
    mcpTools: combinedMcpTools.map((tool) => safeRoutingMetadata(tool, "mcpTool")).filter(Boolean),
    mcpResources: combinedMcpResources.map((resource) => safeRoutingMetadata(resource, "mcpResource")).filter(Boolean),
  };
  const diagnostics = buildRoutingDiagnostics(queryInfo, {
    skills: { metadataType: "skill", candidates: skillCandidates, selected: selectedSkills },
    commands: { metadataType: "command", candidates: commandCandidates, selected: selectedCommands },
    memories: { metadataType: "memory", candidates: memoryCandidates, selected: selectedMemories },
    agents: { metadataType: "agent", candidates: agentCandidates, selected: selectedAgents },
    frameworks: { metadataType: "framework", candidates: frameworkCandidates, selected: selectedFrameworks },
    mcpTools: { metadataType: "mcpTool", candidates: mcpToolCandidates, selected: combinedMcpTools },
    mcpResources: { metadataType: "mcpResource", candidates: mcpResourceCandidates, selected: combinedMcpResources },
  }, routingPolicy);
  if (!selected.skills.length && !selected.commands.length && !selected.memories.length && !selected.agents.length && !selected.frameworks.length && !selected.mcpTools.length && !selected.mcpResources.length && !errors.length) return undefined;
  return {
    selected,
    errors,
    diagnostics,
    loadedSkills,
    loadedCommands,
    loadedMemories,
    loadedAgents,
    loadedFrameworks,
    autoMemoryResults,
    autoMcpResults: autoMcp.results,
    mcpContext: combinedMcpTools.length || combinedMcpResources.length ? { tools: combinedMcpTools, resources: combinedMcpResources } : undefined,
  };
}

function normalizeLoadedSkillData(data) {
  if (!data || typeof data !== "object") return undefined;
  const path = typeof data.path === "string" ? data.path : "";
  const content = typeof data.content === "string" ? data.content : "";
  if (!path || !content) return undefined;
  const skill = data.skill && typeof data.skill === "object" ? data.skill : {};
  const plugin = data.plugin && typeof data.plugin === "object" ? data.plugin : {};
  const source = typeof data.source === "string" ? data.source : typeof skill.source === "string" ? skill.source : plugin.name ? "plugin" : "workspace";
  return {
    name: typeof skill.name === "string" && skill.name ? skill.name : typeof skill.id === "string" && skill.id ? skill.id : path.split("/").at(-2) || "skill",
    description: typeof skill.description === "string" ? skill.description : "",
    path,
    source,
    plugin: typeof skill.plugin === "string" && skill.plugin ? skill.plugin : typeof plugin.name === "string" ? plugin.name : typeof plugin.id === "string" ? plugin.id : "",
    root: typeof data.root === "string" ? data.root : typeof skill.root === "string" ? skill.root : "",
    baseDir: typeof data.baseDir === "string" ? data.baseDir : typeof skill.baseDir === "string" ? skill.baseDir : "",
    content,
  };
}

function extractLoadedSkill(result) {
  if (!["skill_read", "plugin_skill_read"].includes(result?.name) || result.ok === false || !result.data || typeof result.data !== "object") return undefined;
  return normalizeLoadedSkillData(result.data);
}

function normalizeLoadedOutputStyleData(data) {
  if (!data || typeof data !== "object") return undefined;
  const path = typeof data.path === "string" ? data.path : "";
  const prompt = typeof data.body === "string" && data.body.trim()
    ? data.body
    : typeof data.content === "string" ? data.content : "";
  if (!path || !prompt) return undefined;
  const outputStyle = data.outputStyle && typeof data.outputStyle === "object" ? data.outputStyle : {};
  return {
    name: typeof outputStyle.name === "string" && outputStyle.name ? outputStyle.name : typeof outputStyle.id === "string" && outputStyle.id ? outputStyle.id : path.split("/").pop()?.replace(/\.(md|json)$/i, "") || "output-style",
    title: typeof outputStyle.title === "string" ? outputStyle.title : "",
    description: typeof outputStyle.description === "string" ? outputStyle.description : "",
    path,
    source: typeof outputStyle.source === "string" ? outputStyle.source : "workspace",
    plugin: typeof outputStyle.plugin === "string" ? outputStyle.plugin : "",
    prompt,
  };
}

function extractLoadedOutputStyle(result) {
  if (!["output_style_read", "plugin_output_style_read"].includes(result?.name) || result.ok === false || !result.data || typeof result.data !== "object") return undefined;
  return normalizeLoadedOutputStyleData(result.data);
}

function normalizeLoadedCommandData(data, toolName) {
  if (!data || typeof data !== "object") return undefined;
  const path = typeof data.path === "string" ? data.path : "";
  const body = typeof data.body === "string" && data.body.trim()
    ? data.body
    : typeof data.content === "string" ? data.content : "";
  if (!path || !body) return undefined;
  const command = data.command && typeof data.command === "object" ? data.command : {};
  const plugin = data.plugin && typeof data.plugin === "object" ? data.plugin : {};
  const source = toolName === "plugin_command_read" || command.source === "plugin" || plugin.name ? "plugin" : "workspace";
  return {
    name: typeof command.name === "string" && command.name ? command.name : typeof command.id === "string" && command.id ? command.id : path.split("/").pop()?.replace(/\.md$/i, "") || "command",
    title: typeof command.title === "string" ? command.title : "",
    description: typeof command.description === "string" ? command.description : "",
    path,
    source,
    plugin: typeof command.plugin === "string" && command.plugin ? command.plugin : typeof plugin.name === "string" ? plugin.name : typeof plugin.id === "string" ? plugin.id : "",
    body,
    content: body,
  };
}

function extractLoadedCommand(result) {
  if (!["command_read", "plugin_command_read"].includes(result?.name) || result.ok === false || !result.data || typeof result.data !== "object") return undefined;
  return normalizeLoadedCommandData(result.data, result.name);
}

function normalizeLoadedMemoryData(data) {
  if (!data || typeof data !== "object") return undefined;
  const path = typeof data.path === "string" ? data.path : "";
  const body = typeof data.body === "string" && data.body.trim()
    ? data.body
    : typeof data.content === "string" ? data.content : "";
  if (!path || !body) return undefined;
  const memory = data.memory && typeof data.memory === "object" ? data.memory : {};
  return {
    name: typeof memory.name === "string" && memory.name ? memory.name : typeof data.name === "string" && data.name ? data.name : path.split("/").pop()?.replace(/\.md$/i, "") || "memory",
    title: typeof memory.title === "string" && memory.title ? memory.title : typeof data.title === "string" ? data.title : "",
    description: typeof memory.description === "string" && memory.description ? memory.description : typeof data.description === "string" ? data.description : "",
    scope: typeof memory.scope === "string" && memory.scope ? memory.scope : typeof data.scope === "string" && data.scope ? data.scope : path.split("/")[2] || "project",
    tags: Array.isArray(memory.tags) ? memory.tags.filter((item) => typeof item === "string" && item.trim()) : Array.isArray(data.tags) ? data.tags.filter((item) => typeof item === "string" && item.trim()) : [],
    links: Array.isArray(memory.links) ? memory.links.filter((item) => typeof item === "string" && item.trim()) : Array.isArray(data.links) ? data.links.filter((item) => typeof item === "string" && item.trim()) : [],
    path,
    body,
    content: body,
    metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {},
  };
}

function extractLoadedMemory(result) {
  if (result?.name !== "memory_read" || result.ok === false || !result.data || typeof result.data !== "object") return undefined;
  return normalizeLoadedMemoryData(result.data);
}

function normalizeLoadedAgentData(data) {
  if (!data || typeof data !== "object") return undefined;
  const path = typeof data.path === "string" ? data.path : "";
  const prompt = typeof data.prompt === "string" && data.prompt.trim()
    ? data.prompt
    : typeof data.content === "string" ? data.content : "";
  if (!path || !prompt) return undefined;
  const agent = data.agent && typeof data.agent === "object" ? data.agent : {};
  const plugin = data.plugin && typeof data.plugin === "object" ? data.plugin : {};
  const source = typeof agent.source === "string" ? agent.source : plugin.name ? "plugin" : "workspace";
  return {
    name: typeof agent.name === "string" && agent.name ? agent.name : typeof agent.id === "string" && agent.id ? agent.id : path.split("/").pop()?.replace(/\.md$/i, "") || "agent",
    description: typeof agent.description === "string" ? agent.description : "",
    path,
    source,
    plugin: typeof agent.plugin === "string" && agent.plugin ? agent.plugin : typeof plugin.name === "string" ? plugin.name : typeof plugin.id === "string" ? plugin.id : "",
    agentType: typeof agent.agentType === "string" ? agent.agentType : "",
    maxTurns: Number.isFinite(Number(agent.maxTurns)) ? Number(agent.maxTurns) : undefined,
    background: typeof agent.background === "boolean" ? agent.background : undefined,
    isolation: typeof agent.isolation === "string" ? agent.isolation : "",
    effort: typeof agent.effort === "string" ? agent.effort : "",
    tools: Array.isArray(agent.tools) ? agent.tools : undefined,
    disallowedTools: Array.isArray(agent.disallowedTools) ? agent.disallowedTools : undefined,
    mcpTools: Array.isArray(agent.mcpTools) ? agent.mcpTools : undefined,
    disallowedMcpTools: Array.isArray(agent.disallowedMcpTools) ? agent.disallowedMcpTools : undefined,
    skills: Array.isArray(agent.skills) ? agent.skills : undefined,
    commands: Array.isArray(agent.commands) ? agent.commands : undefined,
    memories: Array.isArray(agent.memories) ? agent.memories : undefined,
    frameworks: Array.isArray(agent.frameworks) ? agent.frameworks : undefined,
    initialPrompt: typeof agent.initialPrompt === "string" ? agent.initialPrompt : "",
    prompt,
    content: typeof data.content === "string" ? data.content : prompt,
  };
}

function extractLoadedAgent(result) {
  if (!["agent_read", "plugin_agent_read"].includes(result?.name) || result.ok === false || !result.data || typeof result.data !== "object") return undefined;
  return normalizeLoadedAgentData(result.data);
}

function normalizeLoadedAgentFrameworkData(data) {
  if (!data || typeof data !== "object") return undefined;
  const path = typeof data.path === "string" ? data.path : "";
  const prompt = typeof data.prompt === "string" && data.prompt.trim()
    ? data.prompt
    : typeof data.content === "string" ? data.content : "";
  if (!path || !prompt) return undefined;
  const framework = data.framework && typeof data.framework === "object" ? data.framework : {};
  return {
    name: typeof framework.name === "string" && framework.name ? framework.name : typeof framework.id === "string" && framework.id ? framework.id : path.split("/").pop()?.replace(/\.md$/i, "") || "framework",
    title: typeof framework.title === "string" ? framework.title : "",
    description: typeof framework.description === "string" ? framework.description : "",
    path,
    agents: Array.isArray(framework.agents) ? framework.agents : undefined,
    skills: Array.isArray(framework.skills) ? framework.skills : undefined,
    commands: Array.isArray(framework.commands) ? framework.commands : undefined,
    memories: Array.isArray(framework.memories) ? framework.memories : undefined,
    mcpServers: Array.isArray(framework.mcpServers) ? framework.mcpServers : undefined,
    mcpTools: Array.isArray(framework.mcpTools) ? framework.mcpTools : undefined,
    mcpResources: Array.isArray(framework.mcpResources) ? framework.mcpResources : undefined,
    routingTerms: Array.isArray(framework.routingTerms) ? framework.routingTerms : undefined,
    agentRoles: Array.isArray(framework.agentRoles) ? framework.agentRoles : undefined,
    handoffs: Array.isArray(framework.handoffs) ? framework.handoffs : undefined,
    verificationGates: Array.isArray(framework.verificationGates) ? framework.verificationGates : undefined,
    prompt,
    content: typeof data.content === "string" ? data.content : prompt,
  };
}

function extractLoadedAgentFramework(result) {
  if (result?.name !== "agent_framework_read" || result.ok === false || !result.data || typeof result.data !== "object") return undefined;
  return normalizeLoadedAgentFrameworkData(result.data);
}

async function loadWorkspaceSkills(root, skillNames = [], options = {}) {
  const loaded = [];
  const seen = new Set();
  for (const value of Array.isArray(skillNames) ? skillNames : []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const attempts = [
      ["skill_read", { name, maxChars: 60000 }],
      ["plugin_skill_read", { name, maxChars: 60000 }],
    ];
    for (const [toolName, args] of attempts) {
      try {
        const data = await handleTool(root, toolName, args, { signal: options.signal });
        const skill = normalizeLoadedSkillData(data);
        if (skill) {
          loaded.push(skill);
          break;
        }
      } catch {
        // Missing workspace skills are allowed; try plugin skills next.
      }
    }
  }
  return loaded;
}

async function loadWorkspaceCommands(root, commandNames = [], options = {}) {
  const loaded = [];
  const seen = new Set();
  for (const value of Array.isArray(commandNames) ? commandNames : []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const attempts = [
      ["command_read", { name, maxChars: 60000 }],
      ["plugin_command_read", { name, maxChars: 60000 }],
    ];
    for (const [toolName, args] of attempts) {
      try {
        const data = await handleTool(root, toolName, args, { signal: options.signal });
        const command = normalizeLoadedCommandData(data, toolName);
        if (command) {
          loaded.push(command);
          break;
        }
      } catch {
        // Missing workspace commands are allowed; try plugin commands next.
      }
    }
  }
  return loaded;
}

async function loadWorkspaceMemories(root, memoryNames = [], options = {}) {
  const loaded = [];
  const seen = new Set();
  for (const value of Array.isArray(memoryNames) ? memoryNames : []) {
    const raw = String(value || "").trim();
    if (!raw || seen.has(raw.toLowerCase())) continue;
    seen.add(raw.toLowerCase());
    const [maybeScope, ...rest] = raw.includes(":") ? raw.split(":") : ["", raw];
    const requested = rest.join(":").trim();
    const args = raw.startsWith(".oases/memory/")
      ? { path: raw, maxChars: 60000 }
      : ["project", "team", "private"].includes(maybeScope)
        ? { scope: maybeScope, name: requested, maxChars: 60000 }
        : { name: raw, maxChars: 60000 };
    const data = await handleTool(root, "memory_read", args, { signal: options.signal });
    const memory = normalizeLoadedMemoryData(data);
    if (memory) loaded.push(memory);
  }
  return loaded;
}

async function loadWorkspaceAgents(root, agentNames = [], options = {}) {
  const loaded = [];
  const seen = new Set();
  for (const value of Array.isArray(agentNames) ? agentNames : []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const readArgs = name.startsWith(".oases/") ? { path: name, maxChars: 60000 } : { name, maxChars: 60000 };
    const attempts = [
      ["agent_read", readArgs],
      ["plugin_agent_read", readArgs],
    ];
    for (const [toolName, args] of attempts) {
      try {
        const data = await handleTool(root, toolName, args, { signal: options.signal });
        const agent = normalizeLoadedAgentData(data);
        if (agent) {
          loaded.push(agent);
          break;
        }
      } catch {
        // Missing workspace agents are allowed; try plugin agents next.
      }
    }
  }
  return loaded;
}

async function loadWorkspaceAgentFrameworks(root, frameworkNames = [], options = {}) {
  const loaded = [];
  const seen = new Set();
  for (const value of Array.isArray(frameworkNames) ? frameworkNames : []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const args = name.startsWith(".oases/") ? { path: name, maxChars: 60000 } : { name, maxChars: 60000 };
    const data = await handleTool(root, "agent_framework_read", args, { signal: options.signal });
    const framework = normalizeLoadedAgentFrameworkData(data);
    if (framework) loaded.push(framework);
  }
  return loaded;
}

function collectFrameworkList(frameworks = [], key) {
  const seen = new Set();
  const values = [];
  for (const framework of Array.isArray(frameworks) ? frameworks : []) {
    for (const item of Array.isArray(framework?.[key]) ? framework[key] : []) {
      const value = String(item || "").trim();
      if (!value || seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      values.push(value);
    }
  }
  return values;
}

async function loadFrameworkMcpTools(root, frameworks = [], options = {}) {
  const mcpToolRules = normalizeMcpToolRuleList(collectFrameworkList(frameworks, "mcpTools")) || [];
  const mcpServerRules = normalizeMcpServerRuleList(collectFrameworkList(frameworks, "mcpServers")) || [];
  if (!mcpToolRules.length && !mcpServerRules.length) return [];
  const availableTools = Array.isArray(options.availableMcpTools)
    ? options.availableMcpTools
    : (await handleTool(root, "mcp_list", {}, { signal: options.signal }))?.tools || [];
  const matched = [];
  for (const tool of Array.isArray(availableTools) ? availableTools : []) {
    if (!tool?.name || tool.name === "__error__") continue;
    const server = String(tool.server || "").trim().toLowerCase();
    const name = String(tool.name || "").trim().toLowerCase();
    if (!server || !name) continue;
    const matchesServer = mcpServerRules.some((rule) => mcpServerRuleMatches(rule, server));
    const matchesTool = mcpToolRules.some((rule) => mcpToolRuleMatches(rule, server, name));
    if (matchesServer || matchesTool) matched.push({ ...tool, frameworkDeclared: true });
  }
  return mergeMcpTools(matched);
}

async function loadFrameworkMcpResources(root, frameworks = [], options = {}) {
  const mcpResourceRules = normalizeMcpResourceRuleList(collectFrameworkList(frameworks, "mcpResources")) || [];
  const mcpServerRules = normalizeMcpServerRuleList(collectFrameworkList(frameworks, "mcpServers")) || [];
  if (!mcpResourceRules.length && !mcpServerRules.length) return [];
  const availableResources = Array.isArray(options.availableMcpResources)
    ? options.availableMcpResources
    : (await handleTool(root, "mcp_resources_list", {}, { signal: options.signal }))?.resources || [];
  const matched = [];
  for (const resource of Array.isArray(availableResources) ? availableResources : []) {
    if (!resource?.uri || resource.uri === "__error__") continue;
    const server = String(resource.server || "").trim().toLowerCase();
    const uri = String(resource.uri || "").trim().toLowerCase();
    const name = String(resource.name || "").trim().toLowerCase();
    if (!server || !uri) continue;
    const matchesServer = mcpServerRules.some((rule) => mcpServerRuleMatches(rule, server));
    const matchesResource = mcpResourceRules.some((rule) => mcpResourceRuleMatches(rule, server, uri, name));
    if (matchesServer || matchesResource) matched.push({ ...resource, frameworkDeclared: true });
  }
  return mergeMcpResources(matched);
}

async function loadAgentFrameworkDependencies(root, frameworks = [], options = {}) {
  const result = { skills: [], commands: [], memories: [], agents: [], mcpTools: [], mcpResources: [], errors: [] };
  const loaders = [
    ["skills", "skill", () => loadWorkspaceSkills(root, collectFrameworkList(frameworks, "skills"), options)],
    ["commands", "command", () => loadWorkspaceCommands(root, collectFrameworkList(frameworks, "commands"), options)],
    ["memories", "memory", () => loadWorkspaceMemories(root, collectFrameworkList(frameworks, "memories"), options)],
    ["agents", "agent", () => loadWorkspaceAgents(root, collectFrameworkList(frameworks, "agents"), options)],
    ["mcpTools", "mcp", () => loadFrameworkMcpTools(root, frameworks, options)],
    ["mcpResources", "mcp_resource", () => loadFrameworkMcpResources(root, frameworks, options)],
  ];
  for (const [targetKey, source, load] of loaders) {
    try {
      result[targetKey] = await load();
    } catch (error) {
      result.errors.push({ source: `agent_framework_${source}`, message: error instanceof Error ? error.message : String(error || `${source} dependency load failed`) });
    }
  }
  return result;
}

async function readWorkspaceOutputStyleSetting(root) {
  const candidates = [".oases/settings.json", ".oases/settings.local.json"];
  let selected;
  for (const relativePath of candidates) {
    try {
      const content = await readFile(path.join(root, relativePath), "utf8");
      const parsed = tryParseJson(content);
      const outputStyle = typeof parsed?.outputStyle === "string" ? parsed.outputStyle.trim() : "";
      if (outputStyle) selected = { name: outputStyle, path: relativePath };
    } catch {
      // Missing or unreadable project settings are normal.
    }
  }
  return selected;
}

async function readWorkspaceSettingsJsonFiles(root) {
  const candidates = [".oases/settings.json", ".oases/settings.local.json"];
  const files = [];
  for (const relativePath of candidates) {
    try {
      const content = await readFile(path.join(root, relativePath), "utf8");
      const parsed = tryParseJson(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) files.push({ path: relativePath, settings: parsed });
    } catch {
      // Missing or unreadable project settings are normal.
    }
  }
  return files;
}

function findFirstUnescapedChar(value, char) {
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== char) continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function findLastUnescapedChar(value, char) {
  const source = String(value || "");
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index] !== char) continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function normalizePermissionToolName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const legacyMap = {
    bash: "run_command",
    shell: "run_command",
    runcommand: "run_command",
    run_command: "run_command",
    python: "run_python",
    runpython: "run_python",
    run_python: "run_python",
    read: "read_file",
    readfile: "read_file",
    read_file: "read_file",
    write: "write_file",
    writefile: "write_file",
    write_file: "write_file",
    edit: "edit_file",
    editfile: "edit_file",
    edit_file: "edit_file",
    delete: "delete_file",
    deletefile: "delete_file",
    delete_file: "delete_file",
    webfetch: "fetch_url",
    fetch: "fetch_url",
    fetch_url: "fetch_url",
    glob: "glob_files",
    globfiles: "glob_files",
    glob_files: "glob_files",
    grep: "grep_files",
    grepfiles: "grep_files",
    grep_files: "grep_files",
    ls: "list_files",
    list: "list_files",
    listfiles: "list_files",
    list_files: "list_files",
    todowrite: "todo_write",
    todo_write: "todo_write",
    task: "agent_run",
    agent: "agent_run",
    agentrun: "agent_run",
    agent_run: "agent_run",
  };
  return legacyMap[lower] || raw;
}

function parsePermissionRule(rawRule, sourcePath) {
  const rule = String(rawRule || "").trim();
  if (!rule) return undefined;
  const openIndex = findFirstUnescapedChar(rule, "(");
  const closeIndex = findLastUnescapedChar(rule, ")");
  if (openIndex === -1 || closeIndex <= openIndex || closeIndex !== rule.length - 1) {
    const toolName = normalizePermissionToolName(rule);
    return toolName ? { raw: rule, toolName, sourcePath } : undefined;
  }
  const toolName = normalizePermissionToolName(rule.slice(0, openIndex));
  const rawContent = rule.slice(openIndex + 1, closeIndex);
  const ruleContent = rawContent === "*" ? "" : rawContent.replace(/\\([()])/g, "$1").trim();
  return toolName ? { raw: rule, toolName, ruleContent, sourcePath } : undefined;
}

async function readWorkspacePermissionDenyRules(root) {
  const files = await readWorkspaceSettingsJsonFiles(root);
  const denied = [];
  for (const file of files) {
    const rules = Array.isArray(file.settings?.permissions?.deny) ? file.settings.permissions.deny : [];
    for (const rawRule of rules) {
      const parsed = parsePermissionRule(rawRule, file.path);
      if (parsed) denied.push(parsed);
    }
  }
  return denied;
}

async function readWorkspacePermissionAskRules(root) {
  const files = await readWorkspaceSettingsJsonFiles(root);
  const asked = [];
  for (const file of files) {
    const rules = Array.isArray(file.settings?.permissions?.ask) ? file.settings.permissions.ask : [];
    for (const rawRule of rules) {
      const parsed = parsePermissionRule(rawRule, file.path);
      if (parsed) asked.push(parsed);
    }
  }
  return asked;
}

async function readWorkspacePermissionAllowRules(root) {
  const files = await readWorkspaceSettingsJsonFiles(root);
  const allowed = [];
  for (const file of files) {
    // Only local project settings can reduce approval prompts. Committed project
    // settings may deny or ask, but should not silently broaden execution.
    if (file.path !== ".oases/settings.local.json") continue;
    const rules = Array.isArray(file.settings?.permissions?.allow) ? file.settings.permissions.allow : [];
    for (const rawRule of rules) {
      const parsed = parsePermissionRule(rawRule, file.path);
      if (parsed) allowed.push(parsed);
    }
  }
  return allowed;
}

async function readWorkspacePermissionDefaultMode(root, options = {}) {
  const files = await readWorkspaceSettingsJsonFiles(root);
  let selected;
  for (const file of files) {
    const mode = typeof file.settings?.permissions?.defaultMode === "string"
      ? file.settings.permissions.defaultMode.trim()
      : "";
    if (!mode) continue;
    if (["default", "plan", "dontAsk"].includes(mode)) {
      selected = { mode, path: file.path };
      continue;
    }
    options.onEvent?.({
      type: "settings_warning",
      setting: "permissions.defaultMode",
      path: file.path,
      value: mode,
      summary: `ocli 暂不支持 settings permissions.defaultMode=${mode}`,
    });
  }
  return selected;
}

const MEMORY_SETTING_SCOPES = new Set(["project", "team", "private"]);

async function readWorkspaceMemorySettings(root, options = {}) {
  const files = await readWorkspaceSettingsJsonFiles(root);
  const settings = { autoSuggest: true, autoWrite: false, scope: "project" };
  for (const file of files) {
    const memory = file.settings?.memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) continue;
    if (typeof memory.autoSuggest === "boolean") settings.autoSuggest = memory.autoSuggest;
    if (typeof memory.scope === "string" && MEMORY_SETTING_SCOPES.has(memory.scope)) settings.scope = memory.scope;
    else if (typeof memory.scope === "string" && memory.scope.trim()) {
      options.onEvent?.({
        type: "settings_warning",
        setting: "memory.scope",
        path: file.path,
        value: memory.scope,
        summary: `ocli 暂不支持 settings memory.scope=${memory.scope}`,
      });
    }
    if (file.path === ".oases/settings.local.json" && typeof memory.autoWrite === "boolean") {
      settings.autoWrite = memory.autoWrite;
    } else if (file.path !== ".oases/settings.local.json" && memory.autoWrite === true) {
      options.onEvent?.({
        type: "settings_warning",
        setting: "memory.autoWrite",
        path: file.path,
        value: true,
        summary: "ocli 只允许在 .oases/settings.local.json 中启用 memory.autoWrite",
      });
    }
  }
  return settings;
}

async function readWorkspaceCapabilityRoutingSettings(root, options = {}) {
  const files = await readWorkspaceSettingsJsonFiles(root);
  let settings = cloneCapabilityRoutingPolicy();
  for (const file of files) {
    const capabilityRouting = file.settings?.capabilityRouting;
    if (capabilityRouting === undefined) continue;
    if (!capabilityRouting || typeof capabilityRouting !== "object" || Array.isArray(capabilityRouting)) {
      options.onEvent?.({
        type: "settings_warning",
        setting: "capabilityRouting",
        path: file.path,
        valueType: Array.isArray(capabilityRouting) ? "array" : typeof capabilityRouting,
        summary: `ocli 暂不支持 settings capabilityRouting 类型：${Array.isArray(capabilityRouting) ? "array" : typeof capabilityRouting}`,
      });
      continue;
    }
    settings = mergeCapabilityRoutingPolicy(settings, capabilityRouting, file.path);
  }
  return settings;
}

async function readWorkspaceContextCompactionSettings(root, options = {}) {
  const files = await readWorkspaceSettingsJsonFiles(root);
  let settings = cloneContextCompactionPolicy();
  for (const file of files) {
    const contextCompaction = file.settings?.contextCompaction;
    if (contextCompaction === undefined) continue;
    if (typeof contextCompaction === "boolean") {
      settings = mergeContextCompactionPolicy(settings, { enabled: contextCompaction }, file.path);
      continue;
    }
    if (!contextCompaction || typeof contextCompaction !== "object" || Array.isArray(contextCompaction)) {
      options.onEvent?.({
        type: "settings_warning",
        setting: "contextCompaction",
        path: file.path,
        valueType: Array.isArray(contextCompaction) ? "array" : typeof contextCompaction,
        summary: `ocli 暂不支持 settings contextCompaction 类型：${Array.isArray(contextCompaction) ? "array" : typeof contextCompaction}`,
      });
      continue;
    }
    settings = mergeContextCompactionPolicy(settings, contextCompaction, file.path);
  }
  return settings;
}

function permissionRuleArgumentText(toolName, args = {}) {
  if (toolName === "run_command") return String(args.command || "");
  if (toolName === "run_python") return String(args.script || "");
  if (["read_file", "write_file", "edit_file", "delete_file"].includes(toolName)) return String(args.path || "");
  if (toolName === "fetch_url") return String(args.url || "");
  if (toolName === "agent_run") return [args.agentName, args.agent, args.description, args.task].filter(Boolean).join(" ");
  return JSON.stringify(args || {});
}

function permissionRuleMatchesTool(rule, toolName, args = {}) {
  if (!rule || rule.toolName !== toolName) return false;
  if (!rule.ruleContent) return true;
  const haystack = permissionRuleArgumentText(toolName, args).toLowerCase();
  return haystack.includes(String(rule.ruleContent).toLowerCase());
}

function toolWideDeniedNames(rules = []) {
  return [...new Set(rules.filter((rule) => rule?.toolName && !rule.ruleContent).map((rule) => rule.toolName))];
}

function toolWideAskedNames(rules = []) {
  return [...new Set(rules.filter((rule) => rule?.toolName && !rule.ruleContent).map((rule) => rule.toolName))];
}

function toolWideAllowedNames(rules = []) {
  return [...new Set(rules.filter((rule) => rule?.toolName && !rule.ruleContent).map((rule) => rule.toolName))];
}

function planModeAllowsTool(toolName) {
  if (toolName === "todo_write") return true;
  const risk = getToolMetadata(toolName)?.risk || "unknown";
  return ["read", "network"].includes(risk);
}

async function loadOutputStyleFromSettings(root, options = {}) {
  const setting = await readWorkspaceOutputStyleSetting(root);
  if (!setting?.name) return undefined;
  const attempts = [
    ["output_style_read", { name: setting.name, maxChars: 60000 }],
    ["plugin_output_style_read", { name: setting.name, maxChars: 60000 }],
  ];
  const errors = [];
  for (const [toolName, args] of attempts) {
    try {
      const data = await handleTool(root, toolName, args, { signal: options.signal });
      const style = normalizeLoadedOutputStyleData(data);
      if (style) return { ...style, settingPath: setting.path, settingsOutputStyle: setting.name };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  options.onEvent?.({
    type: "settings_warning",
    setting: "outputStyle",
    path: setting.path,
    value: setting.name,
    summary: `ocli 未找到 settings outputStyle: ${setting.name}`,
    errors,
  });
  return undefined;
}

function projectResponseIncompleteReason(content) {
  const visible = stripProjectToolBlocks(content).trim();
  if (!visible) return "";
  const hasOpenTodo = /-\s*\[\s\]/.test(visible)
    || /"status"\s*:\s*"(?:todo|doing|pending|in_progress)"/i.test(content)
    || /\b(?:todo|pending|in progress|in_progress)\b/i.test(visible)
    || /待办|进行中|待处理/i.test(visible);
  const saysWorkRemains = /未完成|尚未完成|还(?:需要|需|要)|仍(?:需要|需|要)|剩余|待(?:处理|完成|验证)|pending|remaining|not\s+(?:done|complete|completed|finished)|still\s+(?:need|needs|todo|pending)|work\s+remains/i.test(visible);
  const isConditionalOffer = /如果.{0,24}(?:需要|想要|希望|还要)|if\s+you\s+(?:want|need|would\s+like)/i.test(visible);
  const saysWillContinue = /现在(?:开始|编写|生成|创建)|接下来|下一步|继续(?:处理|编写|生成)|准备(?:写入|创建|生成)|我会(?:先|继续|创建|生成|写入)|will\s+(?:write|create|generate|continue)|next\s+I\s+will/i.test(visible);
  const mentionsFileWork = /写入|创建|生成|保存|文件|代码|数据集|csv|json|python|\.py|\.csv|\.json|\.md|write_file/i.test(visible);
  const hasFinalSignal = /已(?:完成|写入|生成|创建)|完成了|可以下载|文件(?:已经|已)|任务已完成|done|completed/i.test(visible) && !saysWorkRemains;
  if (hasFinalSignal) return "";
  if (hasOpenTodo && saysWorkRemains) return "open_todo";
  if (hasOpenTodo && !isConditionalOffer) return "open_todo";
  if (saysWillContinue && (mentionsFileWork || saysWorkRemains)) return "promised_follow_up";
  if (saysWorkRemains && !isConditionalOffer) return "work_remains";
  return "";
}

const OPEN_TODO_STATUSES = new Set(["todo", "doing", "pending", "in_progress"]);

function normalizeTodoGuardItem(item, index) {
  if (!item || typeof item !== "object") return undefined;
  const text = String(item.text || item.title || item.task || "").trim();
  if (!text) return undefined;
  const status = String(item.status || "todo").trim().toLowerCase();
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `todo_${index + 1}`,
    text,
    status,
  };
}

function todoStateFromData(data, source = "todo") {
  const todos = Array.isArray(data?.todos)
    ? data.todos.map(normalizeTodoGuardItem).filter(Boolean)
    : [];
  if (!todos.length) return { todos: [], openTodos: [], counts: {}, source };
  const counts = todos.reduce((acc, todo) => {
    acc[todo.status] = (acc[todo.status] || 0) + 1;
    return acc;
  }, {});
  return {
    todos,
    openTodos: todos.filter((todo) => OPEN_TODO_STATUSES.has(todo.status)),
    counts,
    source,
  };
}

function todoStateFromToolResult(result) {
  if (!["todo_write", "todo_read"].includes(result?.name) || result.ok === false) return undefined;
  return todoStateFromData(result.data || {}, result.name);
}

function formatOpenTodosForContinuation(openTodos = []) {
  if (!openTodos.length) return "";
  return [
    "当前结构化 todo 状态仍有未完成项，不能直接结束：",
    ...openTodos.slice(0, 12).map((todo) => `- [${todo.status}] ${todo.text}`),
  ].join("\n");
}

function buildAgentContinuationPrompt(iteration, reason = "", details = "") {
  return [
    `继续执行工程任务（ocli 自动续跑第 ${iteration} 次）。`,
    reason ? `续跑原因：${reason}。` : "",
    details,
    "上一轮看起来仍在计划或承诺后续动作，或工具执行后任务尚未收尾。",
    "请不要只描述“正在编写”或“接下来会做”；需要网页内容就调用 fetch_url，需要产出代码、数据集或说明文档就调用 write_file，必要时运行 run_python/run_command 验证。",
    "如果存在结构化 todo，请先把未完成项实际处理完，并在必要时调用 todo_write 把对应项更新为 done。",
    "如果任务已经完成，请给出最终答复，并列出本轮生成或修改的关键文件路径。",
  ].filter(Boolean).join("\n");
}

const FRAMEWORK_ORCHESTRATOR_AGENT_NAMES = new Set([
  "main",
  "primary",
  "orchestrator",
  "coordinator",
  "lead",
  "owner",
  "user",
  "human",
]);

function normalizeFrameworkAgentName(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .toLowerCase();
}

function frameworkBlueprintItems(framework) {
  return [
    ...(Array.isArray(framework?.agentRoles) ? framework.agentRoles : []),
    ...(Array.isArray(framework?.handoffs) ? framework.handoffs : []),
    ...(Array.isArray(framework?.verificationGates) ? framework.verificationGates : []),
  ].map((item) => String(item || "").trim()).filter(Boolean);
}

function declaredFrameworkAgents(framework) {
  const agents = new Map();
  for (const item of Array.isArray(framework?.agents) ? framework.agents : []) {
    const name = String(item || "").trim();
    const normalized = normalizeFrameworkAgentName(name);
    if (!normalized || FRAMEWORK_ORCHESTRATOR_AGENT_NAMES.has(normalized)) continue;
    agents.set(normalized, name);
  }
  return agents;
}

function extractFrameworkAgentRoleName(role) {
  const match = String(role || "").match(/^\s*([A-Za-z0-9_.-]+)\s*[:：]/);
  return match?.[1] ? match[1].trim() : "";
}

function extractFrameworkHandoffNames(handoff) {
  const text = String(handoff || "");
  const match = text.match(/([A-Za-z0-9_.-]+)\s*(?:->|=>|→)\s*([A-Za-z0-9_.-]+)/);
  return match ? [match[1], match[2]].map((item) => item.trim()).filter(Boolean) : [];
}

function requiredFrameworkAgents(framework) {
  const blueprintItems = frameworkBlueprintItems(framework);
  if (!blueprintItems.length) return [];
  const declaredAgents = declaredFrameworkAgents(framework);
  const required = new Map();
  const addAgent = (value) => {
    const normalized = normalizeFrameworkAgentName(value);
    if (!normalized || FRAMEWORK_ORCHESTRATOR_AGENT_NAMES.has(normalized)) return;
    if (declaredAgents.size && !declaredAgents.has(normalized)) return;
    required.set(normalized, declaredAgents.get(normalized) || String(value || "").trim());
  };
  for (const role of Array.isArray(framework?.agentRoles) ? framework.agentRoles : []) {
    const roleName = extractFrameworkAgentRoleName(role);
    if (roleName) addAgent(roleName);
    for (const [normalized, display] of declaredAgents) {
      if (String(role || "").toLowerCase().includes(normalized)) addAgent(display);
    }
  }
  for (const handoff of Array.isArray(framework?.handoffs) ? framework.handoffs : []) {
    for (const name of extractFrameworkHandoffNames(handoff)) addAgent(name);
    for (const [normalized, display] of declaredAgents) {
      if (String(handoff || "").toLowerCase().includes(normalized)) addAgent(display);
    }
  }
  if (!required.size && declaredAgents.size === 1) {
    const [[normalized, display]] = declaredAgents.entries();
    required.set(normalized, display);
  }
  return [...required.entries()].map(([normalized, name]) => ({ normalized, name }));
}

function agentRunEvidenceMatchesAgent(result, agent) {
  if (result?.name !== "agent_run" || result.ok === false) return false;
  const data = result.data && typeof result.data === "object" ? result.data : {};
  const directNames = [
    data.agentName,
    data.customAgent?.name,
  ].map(normalizeFrameworkAgentName).filter(Boolean);
  if (directNames.includes(agent.normalized)) return true;
  const evidenceText = [
    data.agentName,
    data.customAgent?.name,
    data.description,
    data.agentType,
    data.task,
    data.finalText,
    result.message,
  ].map((item) => String(item || "").toLowerCase()).join("\n");
  return evidenceText.includes(agent.normalized);
}

function findFrameworkBlueprintGuardGap({ activeAgentFrameworks, toolResults, guardedKeys }) {
  for (const framework of Array.isArray(activeAgentFrameworks) ? activeAgentFrameworks : []) {
    const blueprintItems = frameworkBlueprintItems(framework);
    if (!blueprintItems.length) continue;
    const requiredAgents = requiredFrameworkAgents(framework);
    if (!requiredAgents.length) continue;
    const missingAgents = requiredAgents.filter((agent) => !toolResults.some((result) => agentRunEvidenceMatchesAgent(result, agent)));
    const nextMissingAgent = missingAgents.find((agent) => !guardedKeys.has(`${framework.name || framework.path || "framework"}:${agent.normalized}`));
    if (!nextMissingAgent) continue;
    return {
      key: `${framework.name || framework.path || "framework"}:${nextMissingAgent.normalized}`,
      framework: {
        name: framework.name || "framework",
        title: framework.title || "",
        path: framework.path || "",
      },
      missingAgent: nextMissingAgent.name,
      missingAgents: missingAgents.map((agent) => agent.name),
      agentRoles: Array.isArray(framework.agentRoles) ? framework.agentRoles.slice(0, 12) : [],
      handoffs: Array.isArray(framework.handoffs) ? framework.handoffs.slice(0, 12) : [],
      verificationGates: Array.isArray(framework.verificationGates) ? framework.verificationGates.slice(0, 12) : [],
    };
  }
  return undefined;
}

function publicFrameworkBlueprintGuard(gap) {
  if (!gap) return undefined;
  return {
    framework: gap.framework,
    missingAgent: gap.missingAgent,
    missingAgents: gap.missingAgents,
    agentRoles: gap.agentRoles,
    handoffs: gap.handoffs,
    verificationGates: gap.verificationGates,
  };
}

function buildFrameworkBlueprintGuardPrompt(iteration, gap) {
  const publicGap = publicFrameworkBlueprintGuard(gap);
  return [
    `继续执行工程任务（ocli Framework blueprint guard 第 ${iteration} 次）。`,
    `Framework「${publicGap.framework.name}」声明了 agentRoles/handoffs/verificationGates，但当前最终答复前缺少 agent_run 证据。`,
    `必须先委派缺少的子代理：${publicGap.missingAgent}。`,
    "",
    "<framework_blueprint_guard>",
    JSON.stringify(publicGap, null, 2),
    "</framework_blueprint_guard>",
    "",
    `请立即调用 agent_run({agentName: "${publicGap.missingAgent}", task: "按 Framework ${publicGap.framework.name} 的蓝图检查当前实现、handoff 和 verification gates，返回可供主代理最终回复引用的风险与证据。"})。`,
    "子代理返回后，再按 handoffs 汇总结果，并在最终回复中明确说明 verificationGates 的满足证据。",
  ].join("\n");
}

function buildFrameworkBlueprintGuardAgentRunArgs(gap, assistantText = "") {
  const publicGap = publicFrameworkBlueprintGuard(gap);
  const frameworkName = publicGap.framework.name || "framework";
  const missingAgent = publicGap.missingAgent || publicGap.missingAgents[0] || "reviewer";
  const candidateFinal = stripProjectToolBlocks(assistantText).trim().slice(0, 1800);
  return {
    agentName: missingAgent,
    agentType: "verify",
    description: `framework-${slugFromText(frameworkName, "framework")}-${slugFromText(missingAgent, "agent")}`.slice(0, 80),
    maxTurns: 4,
    task: [
      `按 Framework ${frameworkName} 的蓝图检查当前实现、handoff 和 verification gates。`,
      `缺少的子代理/handoff：${missingAgent}。`,
      publicGap.agentRoles.length ? `Agent roles:\n${publicGap.agentRoles.map((item) => `- ${item}`).join("\n")}` : "",
      publicGap.handoffs.length ? `Handoffs:\n${publicGap.handoffs.map((item) => `- ${item}`).join("\n")}` : "",
      publicGap.verificationGates.length ? `Verification gates:\n${publicGap.verificationGates.map((item) => `- ${item}`).join("\n")}` : "",
      candidateFinal ? `候选最终回复（需要复核，不能直接信任）：\n${candidateFinal}` : "",
      "请返回可供主代理最终回复引用的风险、证据和 gate 结论。",
    ].filter(Boolean).join("\n\n"),
  };
}

const MEMORY_MAINTENANCE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "settings_write",
  "memory_write",
  "command_read",
  "skill_read",
  "agent_write",
  "agent_framework_write",
  "agent_framework_read",
  "agent_run",
  "worktree_apply",
  "plugin_command_install",
  "plugin_output_style_install",
  "plugin_skill_install",
  "plugin_agent_install",
]);

function redactMemoryMaintenanceText(value, maxChars = 1200) {
  const text = String(value || "")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\b\s*[:=]\s*['"]?[^'"\s]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function lastUserMessageForMemory(messages = []) {
  for (const message of [...messages].reverse()) {
    if (message?.role !== "user" || typeof message.content !== "string") continue;
    const content = message.content.trim();
    if (!content || content.startsWith("工具执行结果：") || isInjectedRoutingContextMessage(content)) continue;
    return content;
  }
  return "";
}

function slugFromText(value, fallback = "agent-session") {
  const ascii = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii || fallback;
}

function memoryMaintenanceArtifacts(toolResults = []) {
  const artifacts = [];
  const seen = new Set();
  for (const result of toolResults) {
    const candidates = [
      ...(Array.isArray(result?.artifacts) ? result.artifacts.map((artifact) => artifact?.path) : []),
      typeof result?.data?.path === "string" ? result.data.path : undefined,
    ];
    for (const candidate of candidates) {
      const item = String(candidate || "").trim();
      if (!item || seen.has(item)) continue;
      seen.add(item);
      artifacts.push(item);
      if (artifacts.length >= 40) return artifacts;
    }
  }
  return artifacts;
}

function memoryMaintenanceToolSummary(toolResults = []) {
  return toolResults
    .filter((result) => result?.ok !== false && MEMORY_MAINTENANCE_TOOLS.has(result?.name))
    .slice(0, 30)
    .map((result) => ({
      name: result.name,
      message: redactMemoryMaintenanceText(result.message || "", 240),
      path: typeof result?.data?.path === "string" ? result.data.path : undefined,
    }));
}

function compactMemoryMaintenanceToolEvidence(toolResults = []) {
  return (Array.isArray(toolResults) ? toolResults : [])
    .filter((result) => result && typeof result === "object")
    .slice(-12)
    .map((result) => ({
      name: redactMemoryMaintenanceText(result.name || "tool", 120),
      status: result.ok === false ? "failed" : "ok",
      message: redactMemoryMaintenanceText(result.message || "", 220),
      ...(typeof result?.data?.path === "string" ? { path: redactMemoryMaintenanceText(result.data.path, 240) } : {}),
    }));
}

function memoryMaintenanceSubAgentSummary(toolResults = []) {
  const byKey = new Map();
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  const nonEmptyObject = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (Array.isArray(item)) return item.length > 0;
    return item !== undefined && item !== null && item !== "";
  }));
  const mergeEvidence = (key, item) => {
    const current = byKey.get(key) || {};
    byKey.set(key, nonEmptyObject({
      ...current,
      ...item,
      toolResults: item.toolResults?.length ? item.toolResults : current.toolResults,
      artifacts: item.artifacts?.length ? item.artifacts : current.artifacts,
      finalText: item.finalText || current.finalText,
      workspaceSummary: item.workspaceSummary || current.workspaceSummary,
    }));
  };
  const addEvidence = (value, fallback = {}) => {
    if (!isObject(value)) return;
    const resultData = isObject(value.result) ? value.result : value;
    const customAgent = isObject(resultData.customAgent) ? resultData.customAgent : isObject(value.customAgent) ? value.customAgent : undefined;
    const worktree = isObject(resultData.worktree) ? resultData.worktree : isObject(value.worktree) ? value.worktree : undefined;
    const workspaceStatus = isObject(resultData.workspaceStatus) ? resultData.workspaceStatus : isObject(value.workspaceStatus) ? value.workspaceStatus : undefined;
    const id = redactMemoryMaintenanceText(value.id || value.subagentId || resultData.id || fallback.id || "", 120);
    const description = redactMemoryMaintenanceText(resultData.description || value.description || fallback.description || "", 180);
    const agentName = redactMemoryMaintenanceText(resultData.agentName || value.agentName || fallback.agentName || customAgent?.name || "", 120);
    const status = redactMemoryMaintenanceText(resultData.status || value.status || fallback.status || (fallback.ok === false ? "failed" : ""), 80);
    const finalText = redactMemoryMaintenanceText(resultData.finalText || value.finalText || fallback.finalText || "", 900);
    const toolEvidence = compactMemoryMaintenanceToolEvidence(resultData.toolResults || value.toolResults || []);
    const artifacts = [
      ...(Array.isArray(resultData.artifacts) ? resultData.artifacts : []),
      ...(Array.isArray(value.artifacts) ? value.artifacts : []),
      ...(Array.isArray(fallback.artifacts) ? fallback.artifacts : []),
    ]
      .map((artifact) => redactMemoryMaintenanceText(typeof artifact === "string" ? artifact : artifact?.path || "", 240))
      .filter(Boolean)
      .slice(0, 20);
    const fallbackKey = [agentName, description, finalText.slice(0, 80), status].filter(Boolean).join(":");
    const key = id || fallbackKey || `subagent-${byKey.size + 1}`;
    mergeEvidence(key, {
      ...(id ? { id } : {}),
      status: status || "unknown",
      ...(agentName ? { agentName } : {}),
      ...(customAgent?.path ? { customAgentPath: redactMemoryMaintenanceText(customAgent.path, 240) } : {}),
      ...(resultData.agentType || value.agentType || fallback.agentType ? { agentType: redactMemoryMaintenanceText(resultData.agentType || value.agentType || fallback.agentType, 80) } : {}),
      ...(description ? { description } : {}),
      ...(resultData.task || value.task || fallback.task ? { task: redactMemoryMaintenanceText(resultData.task || value.task || fallback.task, 420) } : {}),
      ...(resultData.isolation || value.isolation || fallback.isolation ? { isolation: redactMemoryMaintenanceText(resultData.isolation || value.isolation || fallback.isolation, 80) } : {}),
      ...(worktree?.worktreePath ? { worktreePath: redactMemoryMaintenanceText(worktree.worktreePath, 260) } : {}),
      ...(resultData.stoppedReason || value.stoppedReason ? { stoppedReason: redactMemoryMaintenanceText(resultData.stoppedReason || value.stoppedReason, 80) } : {}),
      ...(finalText ? { finalText } : {}),
      ...(workspaceStatus?.summary ? { workspaceSummary: redactMemoryMaintenanceText(workspaceStatus.summary, 420) } : {}),
      toolResults: toolEvidence,
      artifacts,
    });
  };
  for (const result of toolResults || []) {
    if (result?.name === "agent_run") {
      if (result.ok === false) {
        addEvidence({ status: "failed", description: result?.data?.description || "", task: result?.data?.task || "", finalText: result.message || "" }, { ok: false });
      } else {
        addEvidence(result.data, { ok: result.ok, artifacts: result.artifacts });
      }
    }
    if (result?.name === "agent_status") {
      const data = result.data;
      const records = Array.isArray(data?.subagents) ? data.subagents : [data].filter(Boolean);
      records.forEach((record) => addEvidence(record));
    }
  }
  return [...byKey.values()].slice(0, 12);
}

function stringifyMemoryMaintenanceArguments(value) {
  if (!value || typeof value !== "object") return "";
  try {
    return redactMemoryMaintenanceText(JSON.stringify(value), 400);
  } catch {
    return "";
  }
}

function memoryMaintenanceMcpSummary(capabilityRouting) {
  const results = Array.isArray(capabilityRouting?.autoMcpResults) ? capabilityRouting.autoMcpResults : [];
  return results
    .filter((result) => result?.server || result?.tool)
    .slice(0, 12)
    .map((result) => ({
      server: redactMemoryMaintenanceText(result.server || "", 120),
      tool: redactMemoryMaintenanceText(result.tool || "", 120),
      arguments: stringifyMemoryMaintenanceArguments(result.arguments),
      resultText: redactMemoryMaintenanceText(result.resultText || result.error || "", 700),
      ok: result.ok !== false,
    }));
}

function memoryMaintenanceMemorySummary(capabilityRouting) {
  const results = Array.isArray(capabilityRouting?.autoMemoryResults) ? capabilityRouting.autoMemoryResults : [];
  return results
    .filter((result) => result?.path || result?.name || result?.snippet)
    .slice(0, 12)
    .map((result) => ({
      name: redactMemoryMaintenanceText(result.name || "", 120),
      title: redactMemoryMaintenanceText(result.title || "", 160),
      path: redactMemoryMaintenanceText(result.path || "", 240),
      scope: redactMemoryMaintenanceText(result.scope || "project", 80),
      query: redactMemoryMaintenanceText(result.query || "", 240),
      score: Number.isFinite(Number(result.score)) ? Number(result.score) : undefined,
      snippet: redactMemoryMaintenanceText(result.snippet || "", 700),
      matchedTerms: Array.isArray(result.matchedTerms) ? result.matchedTerms.map((item) => redactMemoryMaintenanceText(item, 80)).slice(0, 12) : [],
      links: Array.isArray(result.links) ? result.links.map((item) => redactMemoryMaintenanceText(item, 120)).slice(0, 12) : [],
      backlinks: Array.isArray(result.backlinks) ? result.backlinks.map((item) => ({
        name: redactMemoryMaintenanceText(item?.name || "", 120),
        title: redactMemoryMaintenanceText(item?.title || "", 160),
        path: redactMemoryMaintenanceText(item?.path || "", 240),
      })).slice(0, 12) : [],
    }));
}

function memoryMaintenanceTodoSummary(latestTodoState) {
  const todos = Array.isArray(latestTodoState?.todos) ? latestTodoState.todos : [];
  const openTodos = Array.isArray(latestTodoState?.openTodos)
    ? latestTodoState.openTodos
    : todos.filter((todo) => todo?.status !== "done");
  const normalizeTodo = (todo) => ({
    ...(typeof todo?.id === "string" && todo.id ? { id: redactMemoryMaintenanceText(todo.id, 80) } : {}),
    text: redactMemoryMaintenanceText(todo?.text || "", 320),
    status: redactMemoryMaintenanceText(todo?.status || "todo", 40),
  });
  return {
    todos: todos.map(normalizeTodo).filter((todo) => todo.text).slice(0, 80),
    openTodos: openTodos.map(normalizeTodo).filter((todo) => todo.text).slice(0, 30),
    counts: latestTodoState?.counts && typeof latestTodoState.counts === "object" ? latestTodoState.counts : {},
    totalCount: todos.length,
    openCount: openTodos.length,
  };
}

function memoryMaintenanceRoutingSummary({ activeAgentFrameworks, capabilityRouting }) {
  const selected = capabilityRouting?.selected && typeof capabilityRouting.selected === "object" ? capabilityRouting.selected : {};
  const uniqueBy = (items, keyFn, limit = 20) => {
    const seen = new Set();
    const values = [];
    for (const item of Array.isArray(items) ? items : []) {
      const key = keyFn(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      values.push(item);
      if (values.length >= limit) break;
    }
    return values;
  };
  const frameworks = uniqueBy([
    ...(activeAgentFrameworks || []),
    ...(selected.frameworks || []),
  ], (framework) => String(framework?.name || "").trim().toLowerCase()).map((framework) => ({
    name: redactMemoryMaintenanceText(framework.name || "", 160),
    path: redactMemoryMaintenanceText(framework.path || "", 240),
    agentRoles: Array.isArray(framework.agentRoles) ? framework.agentRoles.map((item) => redactMemoryMaintenanceText(item, 240)).slice(0, 12) : [],
    handoffs: Array.isArray(framework.handoffs) ? framework.handoffs.map((item) => redactMemoryMaintenanceText(item, 240)).slice(0, 12) : [],
    verificationGates: Array.isArray(framework.verificationGates) ? framework.verificationGates.map((item) => redactMemoryMaintenanceText(item, 240)).slice(0, 12) : [],
  }));
  const mcpTools = uniqueBy(selected.mcpTools || [], (tool) => mcpToolKey(tool)).map((tool) => ({
    server: redactMemoryMaintenanceText(tool.server || "", 120),
    name: redactMemoryMaintenanceText(tool.name || "", 120),
    description: redactMemoryMaintenanceText(tool.description || "", 240),
  }));
  const mcpResources = uniqueBy(selected.mcpResources || [], (resource) => mcpResourceKey(resource)).map((resource) => ({
    server: redactMemoryMaintenanceText(resource.server || "", 120),
    uri: redactMemoryMaintenanceText(resource.uri || "", 240),
    name: redactMemoryMaintenanceText(resource.name || "", 160),
    description: redactMemoryMaintenanceText(resource.description || "", 240),
  }));
  return { frameworks, mcpTools, mcpResources };
}

function buildMemoryMaintenanceSuggestion({ messages, finalText, toolResults, invokedSkills, activeCommands, activeMemories, activeAgents, activeAgentFrameworks, capabilityRouting, settingsMemory, latestTodoState, contextCompactions, autoContinuationCount, stoppedReason }) {
  const tools = memoryMaintenanceToolSummary(toolResults);
  const artifacts = memoryMaintenanceArtifacts(toolResults);
  const subAgents = memoryMaintenanceSubAgentSummary(toolResults);
  const mcpResults = memoryMaintenanceMcpSummary(capabilityRouting);
  const memoryResults = memoryMaintenanceMemorySummary(capabilityRouting);
  const routing = memoryMaintenanceRoutingSummary({ activeAgentFrameworks, capabilityRouting });
  const todoSummary = memoryMaintenanceTodoSummary(latestTodoState);
  const compactions = Array.isArray(contextCompactions) ? contextCompactions.slice(-5) : [];
  const continuationCount = Math.max(0, Number(autoContinuationCount) || 0);
  const normalizedStoppedReason = redactMemoryMaintenanceText(stoppedReason || "completed", 80);
  const hasContinuationEvidence = todoSummary.totalCount > 0 || compactions.length > 0 || continuationCount > 0 || (normalizedStoppedReason && normalizedStoppedReason !== "completed");
  if (!tools.length && !artifacts.length && !subAgents.length && !mcpResults.length && !memoryResults.length && !routing.frameworks.length && !routing.mcpTools.length && !routing.mcpResources.length && !hasContinuationEvidence) return undefined;
  const request = redactMemoryMaintenanceText(lastUserMessageForMemory(messages), 900);
  const outcome = redactMemoryMaintenanceText(finalText, 1400);
  const timestamp = new Date().toISOString();
  const titleSeed = request.split(/\r?\n/).find((line) => line.trim()) || outcome || "ocli agent session";
  const title = `Ocli session: ${redactMemoryMaintenanceText(titleSeed, 80)}`;
  const name = `ocli-${timestamp.replace(/[:.]/g, "-").slice(0, 19)}-${slugFromText(titleSeed)}`.slice(0, 90);
  const links = [
    ...(activeMemories || []).map((memory) => memory?.id || memory?.name || memory?.path),
    ...(invokedSkills || []).map((skill) => skill?.name),
    ...(activeCommands || []).map((command) => command?.name),
    ...(activeAgents || []).map((agent) => agent?.name),
    ...(activeAgentFrameworks || []).map((framework) => framework?.name),
    ...subAgents.map((agent) => agent.agentName || agent.description || agent.id),
    ...routing.frameworks.map((framework) => framework.name),
    ...routing.mcpTools.map((tool) => tool.server && tool.name ? `mcp:${tool.server}/${tool.name}` : ""),
    ...routing.mcpResources.map((resource) => resource.server && resource.uri ? `mcp-resource:${resource.server}/${resource.uri}` : ""),
    ...mcpResults.map((result) => result.server && result.tool ? `mcp:${result.server}/${result.tool}` : ""),
    ...memoryResults.map((result) => result.name || result.path),
  ].filter(Boolean).slice(0, 20);
  const content = [
    `# ${title}`,
    "",
    "## User Request",
    request || "-",
    "",
    "## Outcome",
    outcome || "-",
    "",
    "## Continuation State",
    [
      `- stoppedReason: ${normalizedStoppedReason || "completed"}`,
      `- autoContinuations: ${continuationCount}`,
      `- contextCompactions: ${compactions.length}`,
      `- todos: ${todoSummary.openCount} open / ${todoSummary.totalCount} total`,
    ].join("\n"),
    "",
    "## Todo Evidence",
    todoSummary.todos.length ? todoSummary.todos.map((todo) => `- [${todo.status}] ${todo.text}`).join("\n") : "- none recorded",
    "",
    "## Open Todo Evidence",
    todoSummary.openTodos.length ? todoSummary.openTodos.map((todo) => `- [${todo.status}] ${todo.text}`).join("\n") : "- none recorded",
    "",
    "## Context Compaction Evidence",
    compactions.length ? compactions.map((compaction) => `- turn ${compaction.turn ?? "?"}: ${compaction.beforeTokens ?? "?"}/${compaction.maxContextTokens ?? "?"} tokens -> ${compaction.afterTokens ?? "?"}, compacted ${compaction.compactedMessageCount ?? "?"} messages`).join("\n") : "- none recorded",
    "",
    "## Changed Or Relevant Files",
    artifacts.length ? artifacts.map((item) => `- ${item}`).join("\n") : "- none recorded",
    "",
    "## Tool Evidence",
    tools.length ? tools.map((tool) => `- ${tool.name}${tool.path ? ` ${tool.path}` : ""}${tool.message ? `: ${tool.message}` : ""}`).join("\n") : "- none recorded",
    "",
    "## Sub-agent Evidence",
    subAgents.length ? subAgents.map((agent) => {
      const label = [agent.agentName || agent.description || agent.id || "sub-agent", agent.agentType ? `(${agent.agentType})` : ""].filter(Boolean).join(" ");
      const details = [
        agent.status ? `status=${agent.status}` : "",
        agent.stoppedReason ? `stopped=${agent.stoppedReason}` : "",
        agent.isolation ? `isolation=${agent.isolation}` : "",
        agent.worktreePath ? `worktree=${agent.worktreePath}` : "",
        agent.artifacts?.length ? `artifacts=${agent.artifacts.join(",")}` : "",
        agent.toolResults?.length ? `tools=${agent.toolResults.map((tool) => `${tool.name}:${tool.status}`).join(",")}` : "",
      ].filter(Boolean).join(" ");
      return `- ${label}${details ? ` ${details}` : ""}${agent.finalText ? `: ${agent.finalText}` : agent.workspaceSummary ? `: ${agent.workspaceSummary}` : ""}`;
    }).join("\n") : "- none recorded",
    "",
    "## Routing Evidence",
    [
      routing.frameworks.length ? ["Frameworks:", ...routing.frameworks.map((framework) => `- ${framework.name}${framework.path ? ` ${framework.path}` : ""}`)].join("\n") : "Frameworks: none recorded",
      routing.frameworks.some((framework) => framework.agentRoles?.length || framework.handoffs?.length || framework.verificationGates?.length)
        ? ["Framework blueprints:", ...routing.frameworks.flatMap((framework) => [
          ...((framework.agentRoles || []).map((item) => `- ${framework.name} role: ${item}`)),
          ...((framework.handoffs || []).map((item) => `- ${framework.name} handoff: ${item}`)),
          ...((framework.verificationGates || []).map((item) => `- ${framework.name} gate: ${item}`)),
        ])].join("\n")
        : "Framework blueprints: none recorded",
      routing.mcpTools.length ? ["MCP tools:", ...routing.mcpTools.map((tool) => `- ${[tool.server, tool.name].filter(Boolean).join("/")}${tool.description ? `: ${tool.description}` : ""}`)].join("\n") : "MCP tools: none recorded",
      routing.mcpResources.length ? ["MCP resources:", ...routing.mcpResources.map((resource) => `- ${resource.server ? `${resource.server}/` : ""}${resource.uri}${resource.name ? ` ${resource.name}` : ""}${resource.description ? `: ${resource.description}` : ""}`)].join("\n") : "MCP resources: none recorded",
    ].join("\n"),
    "",
    "## MCP Evidence",
    mcpResults.length ? mcpResults.map((result) => {
      const name = [result.server, result.tool].filter(Boolean).join("/");
      return `- ${name || "mcp_call"}${result.ok ? "" : " (error)"}${result.arguments ? ` args=${result.arguments}` : ""}${result.resultText ? `: ${result.resultText}` : ""}`;
    }).join("\n") : "- none recorded",
    "",
    "## Memory RAG Evidence",
    memoryResults.length ? memoryResults.map((result) => {
      const label = [result.name || result.title, result.path].filter(Boolean).join(" ");
      const scoreText = result.score !== undefined ? ` score=${result.score}` : "";
      const termsText = result.matchedTerms?.length ? ` terms=${result.matchedTerms.join(",")}` : "";
      const linksText = result.links?.length ? ` links=${result.links.join(",")}` : "";
      const backlinksText = result.backlinks?.length ? ` backlinks=${result.backlinks.map((item) => item.name || item.title || item.path).filter(Boolean).join(",")}` : "";
      return `- ${label || "memory"}${scoreText}${termsText}${linksText}${backlinksText}${result.snippet ? `: ${result.snippet}` : ""}`;
    }).join("\n") : "- none recorded",
    "",
    "## Context Links",
    links.length ? links.map((item) => `- [[${String(item).replace(/\]\]/g, "")}]]`).join("\n") : "- none",
  ].join("\n");
  return {
    name,
    title,
    description: "Auto-generated ocli memory update suggestion from a completed engineering agent session.",
    scope: settingsMemory?.scope || "project",
    tags: ["ocli", "agent", "auto-memory"],
    links,
    content,
    evidence: {
      artifactPaths: artifacts,
      toolCount: tools.length,
      subAgentCount: subAgents.length,
      mcpResultCount: mcpResults.length,
      memoryRagResultCount: memoryResults.length,
      frameworkCount: routing.frameworks.length,
      frameworkBlueprintCount: routing.frameworks.reduce((sum, framework) => sum + (framework.agentRoles?.length || 0) + (framework.handoffs?.length || 0) + (framework.verificationGates?.length || 0), 0),
      mcpToolCount: routing.mcpTools.length,
      mcpResourceCount: routing.mcpResources.length,
      todoCount: todoSummary.totalCount,
      openTodoCount: todoSummary.openCount,
      compactionCount: compactions.length,
      autoContinuationCount: continuationCount,
      stoppedReason: normalizedStoppedReason || "completed",
      generatedAt: timestamp,
    },
  };
}

async function maintainAgentMemory(root, body, context, options = {}) {
  if (body.autoMemorySuggest === false || context.subAgentDepth > 0) return undefined;
  const autoSuggest = body.autoMemorySuggest === true || context.settingsMemory?.autoSuggest !== false;
  if (!autoSuggest) return undefined;
  const suggestion = buildMemoryMaintenanceSuggestion(context);
  if (!suggestion) return undefined;
  const autoWrite = body.autoMemoryWrite === true || context.settingsMemory?.autoWrite === true;
  const maintenance = { suggestion, autoWrite };
  options.onEvent?.({
    type: "memory_update_suggested",
    turn: -1,
    suggestion: {
      name: suggestion.name,
      title: suggestion.title,
      description: suggestion.description,
      scope: suggestion.scope,
      tags: suggestion.tags,
      links: suggestion.links,
      evidence: suggestion.evidence,
    },
    autoWrite,
    summary: autoWrite ? `ocli 已生成并准备写入记忆建议 ${suggestion.name}` : `ocli 已生成记忆更新建议 ${suggestion.name}`,
  });
  if (!autoWrite) return maintenance;
  try {
    const written = await handleTool(root, "memory_write", {
      name: suggestion.name,
      title: suggestion.title,
      description: suggestion.description,
      scope: suggestion.scope,
      tags: suggestion.tags,
      links: suggestion.links,
      content: suggestion.content,
      overwrite: false,
    }, { signal: options.signal });
    maintenance.written = written;
    options.onEvent?.({
      type: "memory_auto_written",
      turn: -1,
      memory: written?.memory || undefined,
      path: written?.path || "",
      summary: `ocli 已自动写入项目记忆 ${written?.path || suggestion.name}`,
    });
  } catch (error) {
    maintenance.error = error instanceof Error ? error.message : String(error || "memory auto-write failed");
    options.onEvent?.({
      type: "memory_auto_write_failed",
      turn: -1,
      error: maintenance.error,
      summary: `ocli 自动写入项目记忆失败：${maintenance.error}`,
    });
  }
  return maintenance;
}

async function loadCustomAgentDefinition(root, args = {}, options = {}) {
  const agentName = String(args.agentName || args.agent || args.path || "").trim();
  if (!agentName) return undefined;
  const readArgs = agentName.startsWith(".oases/") ? { path: agentName, maxChars: 60000 } : { name: agentName, maxChars: 60000 };
  const attempts = [
    ["agent_read", readArgs],
    ["plugin_agent_read", readArgs],
  ];
  let lastError;
  for (const [toolName, readBody] of attempts) {
    try {
      const data = await handleTool(root, toolName, readBody, { signal: options.signal });
      const agent = normalizeLoadedAgentData(data);
      if (agent) return agent;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Agent not found: ${agentName}`);
}

function hasOwnValue(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeMcpToolRuleList(value) {
  if (!Array.isArray(value)) return undefined;
  const rules = value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  return rules.length ? rules : undefined;
}

function normalizeMcpServerRuleList(value) {
  if (!Array.isArray(value)) return undefined;
  const rules = value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  return rules.length ? rules : undefined;
}

function normalizeMcpResourceRuleList(value) {
  if (!Array.isArray(value)) return undefined;
  const rules = value.map((item) => String(item || "").trim().toLowerCase().replace(/\\/g, "/")).filter(Boolean);
  return rules.length ? rules : undefined;
}

function mcpServerRuleMatches(rule, server) {
  const normalized = String(rule || "").trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "*" || normalized === server;
}

function mcpResourceRuleMatches(rule, server, uri, name = "") {
  const normalized = String(rule || "").trim().toLowerCase().replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized === "*" || normalized === "*/*" || normalized === "*:*") return true;
  if (normalized === `${server}/*` || normalized === `${server}:*`) return true;
  if (normalized.startsWith("*/")) {
    const target = normalized.slice(2);
    return target === uri || target === name;
  }
  if (normalized.startsWith("*:")) {
    const target = normalized.slice(2);
    return target === uri || target === name;
  }
  if (normalized.startsWith(`${server}/`)) {
    const target = normalized.slice(server.length + 1);
    return target === uri || target === name;
  }
  if (normalized.startsWith(`${server}:`) && !normalized.startsWith(`${server}://`)) {
    const target = normalized.slice(server.length + 1);
    return target === uri || target === name;
  }
  return normalized === uri || normalized === name || normalized === `${server}/${uri}` || normalized === `${server}:${uri}`;
}

function mcpToolRuleMatches(rule, server, tool) {
  const normalized = String(rule || "").trim().toLowerCase().replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized === "*" || normalized === "*/*" || normalized === "*:*") return true;
  const pattern = normalized.replace(":", "/");
  if (!pattern.includes("/")) return pattern === tool;
  const [ruleServer, ruleTool, extra] = pattern.split("/");
  if (extra !== undefined || !ruleServer || !ruleTool) return false;
  return (ruleServer === "*" || ruleServer === server) && (ruleTool === "*" || ruleTool === tool);
}

function assertMcpToolAllowedForRun(body = {}) {
  const args = body.currentToolArguments || {};
  const server = String(args.server || "").trim().toLowerCase();
  const tool = String(args.tool || "").trim().toLowerCase();
  const display = `${server || "?"}/${tool || "?"}`;
  const allowedMcpTools = normalizeMcpToolRuleList(body.allowedMcpTools);
  const disallowedMcpTools = normalizeMcpToolRuleList(body.disallowedMcpTools);
  if (disallowedMcpTools?.some((rule) => mcpToolRuleMatches(rule, server, tool))) {
    throw new Error(`MCP tool ${display} is not allowed for this sub-agent.`);
  }
  if (allowedMcpTools?.length && !allowedMcpTools.some((rule) => mcpToolRuleMatches(rule, server, tool))) {
    throw new Error(`MCP tool ${display} is not allowed for this sub-agent.`);
  }
}

function normalizeSubAgentRequest(args = {}, customAgent) {
  const task = String(args.task || args.prompt || "").trim();
  if (!task) throw new Error("agent_run requires task.");
  const agentName = customAgent?.name || String(args.agentName || args.agent || "").trim();
  const agentType = ["general", "explore", "plan", "verify"].includes(args.agentType)
    ? args.agentType
    : customAgent?.agentType || "general";
  const description = String(args.description || customAgent?.description || args.name || agentName || agentType).trim().slice(0, 80) || agentType;
  const contextFiles = Array.isArray(args.contextFiles)
    ? args.contextFiles.filter((item) => typeof item === "string" && item.trim()).slice(0, 12)
    : [];
  const maxTurnsDefault = customAgent?.maxTurns || 6;
  const maxTurns = Math.max(1, Math.min(12, Number(hasOwnValue(args, "maxTurns") ? args.maxTurns : maxTurnsDefault) || 6));
  const runInBackground = hasOwnValue(args, "runInBackground") ? args.runInBackground === true : customAgent?.background === true;
  const isolation = ["workspace", "worktree"].includes(args.isolation) ? args.isolation : customAgent?.isolation || "workspace";
  const effort = ["low", "medium", "high", "max"].includes(args.effort) ? args.effort : customAgent?.effort;
  const agentTools = Array.isArray(customAgent?.tools) ? customAgent.tools.filter((item) => typeof item === "string" && item.trim()) : undefined;
  const hasWildcardTools = !agentTools || agentTools.length === 0 || (agentTools.length === 1 && agentTools[0] === "*");
  const allowedToolNames = hasWildcardTools ? undefined : agentTools;
  const disallowedToolNames = Array.isArray(customAgent?.disallowedTools)
    ? customAgent.disallowedTools.filter((item) => typeof item === "string" && item.trim())
    : undefined;
  const allowedMcpTools = Array.isArray(customAgent?.mcpTools)
    ? customAgent.mcpTools.filter((item) => typeof item === "string" && item.trim())
    : undefined;
  const disallowedMcpTools = Array.isArray(customAgent?.disallowedMcpTools)
    ? customAgent.disallowedMcpTools.filter((item) => typeof item === "string" && item.trim())
    : undefined;
  const agentFrameworks = [
    ...(Array.isArray(customAgent?.frameworks) ? customAgent.frameworks : []),
    ...(Array.isArray(args.frameworks) ? args.frameworks : []),
    ...(Array.isArray(args.agentFrameworks) ? args.agentFrameworks : []),
    ...(typeof args.framework === "string" && args.framework.trim() ? [args.framework] : []),
    ...(typeof args.agentFramework === "string" && args.agentFramework.trim() ? [args.agentFramework] : []),
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return {
    task,
    agentType,
    description,
    contextFiles,
    maxTurns,
    runInBackground,
    isolation,
    ...(effort ? { effort } : {}),
    ...(allowedToolNames ? { allowedToolNames } : {}),
    ...(disallowedToolNames?.length ? { disallowedToolNames } : {}),
    ...(allowedMcpTools?.length ? { allowedMcpTools } : {}),
    ...(disallowedMcpTools?.length ? { disallowedMcpTools } : {}),
    ...(agentFrameworks.length ? { agentFrameworks } : {}),
    ...(agentName ? { agentName } : {}),
    ...(customAgent ? {
      customAgent: {
        name: customAgent.name,
        description: customAgent.description,
        path: customAgent.path,
        ...(customAgent.source ? { source: customAgent.source } : {}),
        ...(customAgent.plugin ? { plugin: customAgent.plugin } : {}),
        ...(customAgent.agentType ? { agentType: customAgent.agentType } : {}),
        ...(customAgent.maxTurns ? { maxTurns: customAgent.maxTurns } : {}),
        ...(customAgent.background ? { background: customAgent.background } : {}),
        ...(customAgent.isolation ? { isolation: customAgent.isolation } : {}),
        ...(customAgent.effort ? { effort: customAgent.effort } : {}),
        ...(customAgent.tools ? { tools: customAgent.tools } : {}),
        ...(customAgent.disallowedTools ? { disallowedTools: customAgent.disallowedTools } : {}),
        ...(customAgent.mcpTools ? { mcpTools: customAgent.mcpTools } : {}),
        ...(customAgent.disallowedMcpTools ? { disallowedMcpTools: customAgent.disallowedMcpTools } : {}),
        ...(customAgent.skills ? { skills: customAgent.skills } : {}),
        ...(customAgent.commands ? { commands: customAgent.commands } : {}),
        ...(customAgent.memories ? { memories: customAgent.memories } : {}),
        ...(customAgent.frameworks ? { frameworks: customAgent.frameworks } : {}),
        ...(customAgent.initialPrompt ? { initialPrompt: customAgent.initialPrompt } : {}),
      },
      customAgentPrompt: customAgent.prompt,
      ...(customAgent.initialPrompt ? { initialPrompt: customAgent.initialPrompt } : {}),
    } : {}),
  };
}

function assertToolAllowedForRun(toolName, body) {
  const allowedToolNames = Array.isArray(body.allowedToolNames) ? new Set(body.allowedToolNames) : undefined;
  const disallowedToolNames = Array.isArray(body.disallowedToolNames) ? new Set(body.disallowedToolNames) : undefined;
  if (disallowedToolNames?.has(toolName) || (allowedToolNames && !allowedToolNames.has(toolName))) {
    throw new Error(`Tool ${toolName} is not allowed for this sub-agent.`);
  }
  if (toolName === "mcp_call") {
    assertMcpToolAllowedForRun(body);
  }
  const deniedRule = Array.isArray(body.settingsDeniedToolRules)
    ? body.settingsDeniedToolRules.find((rule) => permissionRuleMatchesTool(rule, toolName, body.currentToolArguments || {}))
    : undefined;
  if (deniedRule) {
    throw new Error(`Tool ${toolName} is denied by ${deniedRule.sourcePath} permissions.deny rule: ${deniedRule.raw}`);
  }
}

function buildSubAgentSystemPrompt(parentSystemPrompt, request) {
  const roleGuidance = {
    general: "你是 Oases ocli 子代理，负责独立完成一个边界清晰的工程子任务。",
    explore: "你是 Oases ocli 探索子代理，负责快速检索代码、读取关键文件、找出事实和选项，不要擅自修改文件。",
    plan: "你是 Oases ocli 规划子代理，负责把复杂工程任务拆解成可执行方案、风险和验证步骤，除非必要不要修改文件。",
    verify: "你是 Oases ocli 验证子代理，负责检查实现、运行只读诊断或必要测试，并报告明确证据。",
  };
  return [
    parentSystemPrompt,
    "",
    roleGuidance[request.agentType],
    request.isolation === "worktree"
      ? "你运行在隔离 git worktree 中。所有文件访问仍必须通过 ocli 工具，并受同样的权限/审批约束；不要切回原始主 workspace。"
      : "你运行在同一个 workspace 中，所有文件访问仍必须通过 ocli 工具，并受同样的权限/审批约束。",
    request.customAgentPrompt
      ? [
          `你正在以工作区自定义 Agent「${request.agentName || request.customAgent?.name || request.description}」的身份执行。以下 <custom_agent_instructions> 是当前子任务的专用强约束：`,
          "<custom_agent_instructions>",
          String(request.customAgentPrompt).slice(0, 60000),
          "</custom_agent_instructions>",
        ].join("\n")
      : "",
    "优先使用 glob_files、grep_files、read_file、workspace_status 等低风险工具收集事实。",
    "最终回复必须简洁：列出结论、证据、生成/修改的文件路径、以及需要主代理继续处理的事项。",
  ].filter(Boolean).join("\n");
}

function buildSubAgentUserPrompt(request) {
  return [
    request.initialPrompt ? `初始指令：\n${String(request.initialPrompt).slice(0, 20000)}` : "",
    `子代理任务：${request.task}`,
    request.description ? `任务标签：${request.description}` : "",
    request.agentName ? `自定义 Agent：${request.agentName}${request.customAgent?.path ? ` (${request.customAgent.path})` : ""}` : "",
    request.isolation === "worktree" ? "隔离模式：git worktree。你的改动会留在隔离目录，主代理会读取 workspace_status 摘要。" : "",
    request.contextFiles.length ? `建议优先查看的文件：\n${request.contextFiles.map((file) => `- ${file}`).join("\n")}` : "",
    "请独立执行该子任务并返回可供主代理使用的结果。不要假设主代理已经知道你的工具输出细节。",
  ].filter(Boolean).join("\n\n");
}

function collectArtifacts(toolResults) {
  const artifacts = [];
  for (const result of toolResults || []) {
    for (const artifact of Array.isArray(result?.artifacts) ? result.artifacts : []) {
      if (!artifact || typeof artifact !== "object" || typeof artifact.path !== "string") continue;
      if (!artifacts.some((existing) => existing.path === artifact.path && existing.role === artifact.role)) artifacts.push(artifact);
    }
  }
  return artifacts;
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

async function runGit(root, args, options = {}) {
  const command = `git ${args.map(shellQuote).join(" ")}`;
  const result = await runProcess(command, { cwd: root, timeoutMs: options.timeoutMs || 15000, signal: options.signal });
  return { ...result, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

async function createDetachedAgentWorktree(root, id, signal) {
  const gitRoot = await runGit(root, ["rev-parse", "--show-toplevel"], { timeoutMs: 5000, signal });
  if (gitRoot.code !== 0) {
    throw new Error("agent_run isolation=worktree requires the workspace to be inside a git repository.");
  }
  const resolvedGitRoot = gitRoot.stdout.trim();
  const head = await runGit(resolvedGitRoot, ["rev-parse", "--verify", "HEAD"], { timeoutMs: 5000, signal });
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new Error("agent_run isolation=worktree requires a git repository with at least one commit.");
  }
  const branch = await runGit(resolvedGitRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5000, signal });
  const tempParent = await mkdtemp(path.join(tmpdir(), "oases-ocli-worktree-"));
  const worktreePath = path.join(tempParent, id);
  const add = await runGit(resolvedGitRoot, ["worktree", "add", "--detach", worktreePath, "HEAD"], { timeoutMs: 30000, signal });
  if (add.code !== 0) {
    await rm(tempParent, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to create agent worktree: ${(add.stderr || add.stdout).trim()}`);
  }
  return {
    isolation: "worktree",
    worktreePath,
    gitRoot: resolvedGitRoot,
    baseRef: branch.stdout.trim() || "HEAD",
    headCommit: head.stdout.trim(),
    createdAt: Date.now(),
  };
}

async function prepareSubAgentWorkspace(root, request, id, options) {
  if (request.isolation !== "worktree") return { root, metadata: { isolation: "workspace" } };
  const metadata = await createDetachedAgentWorktree(root, id, options.signal);
  return { root: metadata.worktreePath, metadata };
}

async function readSubAgentWorkspaceStatus(root, metadata, signal) {
  if (metadata?.isolation !== "worktree") return undefined;
  try {
    return await handleTool(root, "workspace_status", { includeDiff: true, includeUntrackedPreview: true, maxChars: 40000 }, { signal });
  } catch (error) {
    return {
      isGitRepo: false,
      summary: `无法读取子代理 worktree 状态：${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

async function runSubAgentCore(root, request, id, parent, options, parentTurn, workspaceMetadata) {
  const result = await runAgent(root, {
    apiBaseUrl: parent.apiBaseUrl,
    model: parent.model,
    effort: request.effort || parent.effort,
    systemPrompt: buildSubAgentSystemPrompt(parent.systemPrompt, request),
    messages: [{ role: "user", content: buildSubAgentUserPrompt(request) }],
    maxTurns: request.maxTurns,
    maxAutoContinuations: 1,
    maxTotalTurns: request.maxTurns,
    allowedToolNames: request.allowedToolNames,
    disallowedToolNames: request.disallowedToolNames,
    allowedMcpTools: request.allowedMcpTools,
    disallowedMcpTools: request.disallowedMcpTools,
    preloadedSkills: request.preloadedSkills,
    preloadedCommands: request.preloadedCommands,
    preloadedMemories: request.preloadedMemories,
    preloadedAgents: request.preloadedAgents,
    preloadedAgentFrameworks: request.preloadedAgentFrameworks,
  }, {
    signal: options.signal,
    subAgentDepth: (options.subAgentDepth || 0) + 1,
    onEvent: (event) => {
      options.onEvent?.({
        type: "subagent_event",
        turn: parentTurn,
        subagentId: id,
        agentType: request.agentType,
        description: request.description,
        event,
        summary: event?.summary ? `子代理 ${request.description}: ${event.summary}` : `子代理 ${request.description}: ${event?.type || "event"}`,
      });
    },
    requestApproval: async (approval) => options.requestApproval?.({
      ...approval,
      turn: parentTurn,
      summary: `子代理 ${request.description}: ${approval.summary || approval.tool}`,
      reason: approval.reason ? `子代理 ${request.description}: ${approval.reason}` : approval.reason,
    }),
  });
  const artifacts = collectArtifacts(result.toolResults);
  const workspaceStatus = await readSubAgentWorkspaceStatus(root, workspaceMetadata, options.signal);
  const data = {
    id,
    status: "completed",
    agentType: request.agentType,
    description: request.description,
    ...(request.agentName ? { agentName: request.agentName } : {}),
    ...(request.customAgent ? { customAgent: request.customAgent } : {}),
    ...(request.effort ? { effort: request.effort } : {}),
    isolation: workspaceMetadata?.isolation || request.isolation,
    ...(workspaceMetadata?.isolation === "worktree" ? { worktree: workspaceMetadata } : {}),
    finalText: result.finalText,
    stoppedReason: result.stoppedReason,
    toolResults: result.toolResults || [],
    ...(workspaceStatus ? { workspaceStatus } : {}),
    ...(result.invokedSkills ? { invokedSkills: result.invokedSkills } : {}),
    ...(result.activeCommands ? { activeCommands: result.activeCommands } : {}),
    ...(result.activeOutputStyles ? { activeOutputStyles: result.activeOutputStyles } : {}),
    ...(result.activeMemories ? { activeMemories: result.activeMemories } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
  return data;
}

async function startSubAgent(root, args, parent, options, parentTurn) {
  const customAgent = await loadCustomAgentDefinition(root, args, options);
  const request = normalizeSubAgentRequest(args, customAgent);
  if (Array.isArray(customAgent?.skills) && customAgent.skills.length) {
    request.preloadedSkills = await loadWorkspaceSkills(root, customAgent.skills, options);
  }
  if (Array.isArray(customAgent?.commands) && customAgent.commands.length) {
    request.preloadedCommands = await loadWorkspaceCommands(root, customAgent.commands, options);
  }
  if (Array.isArray(customAgent?.memories) && customAgent.memories.length) {
    request.preloadedMemories = await loadWorkspaceMemories(root, customAgent.memories, options);
  }
  if (Array.isArray(request.agentFrameworks) && request.agentFrameworks.length) {
    request.preloadedAgentFrameworks = await loadWorkspaceAgentFrameworks(root, request.agentFrameworks, options);
    const frameworkDependencies = await loadAgentFrameworkDependencies(root, request.preloadedAgentFrameworks, options);
    request.preloadedSkills = [...(request.preloadedSkills || []), ...frameworkDependencies.skills];
    request.preloadedCommands = [...(request.preloadedCommands || []), ...frameworkDependencies.commands];
    request.preloadedMemories = [...(request.preloadedMemories || []), ...frameworkDependencies.memories];
    request.preloadedAgents = [...(request.preloadedAgents || []), ...frameworkDependencies.agents];
  }
  const id = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const workspace = await prepareSubAgentWorkspace(root, request, id, options);
  const record = {
    id,
    status: "running",
    agentType: request.agentType,
    description: request.description,
    agentName: request.agentName,
    customAgent: request.customAgent,
    task: request.task,
    effort: request.effort,
    isolation: request.isolation,
    workspaceMetadata: workspace.metadata,
    startedAt: Date.now(),
    completedAt: undefined,
    result: undefined,
    error: "",
    promise: undefined,
  };
  options.onEvent?.({
    type: "subagent_start",
    turn: parentTurn,
    subagentId: id,
    agentType: request.agentType,
    description: request.description,
    ...(request.agentName ? { agentName: request.agentName } : {}),
    ...(request.customAgent ? { customAgent: request.customAgent } : {}),
    ...(request.effort ? { effort: request.effort } : {}),
    task: request.task,
    runInBackground: request.runInBackground,
    isolation: request.isolation,
    ...(workspace.metadata?.isolation === "worktree" ? { worktree: workspace.metadata } : {}),
    summary: `子代理 ${request.description} 已启动${request.runInBackground ? "（后台）" : ""}${request.isolation === "worktree" ? "（worktree 隔离）" : ""}`,
  });
  record.promise = runSubAgentCore(workspace.root, request, id, parent, options, parentTurn, workspace.metadata)
    .then((data) => {
      record.status = "completed";
      record.completedAt = Date.now();
      record.result = data;
      options.onEvent?.({
        type: "subagent_done",
        turn: parentTurn,
        subagentId: id,
        agentType: request.agentType,
        description: request.description,
        ...(request.agentName ? { agentName: request.agentName } : {}),
        ...(request.customAgent ? { customAgent: request.customAgent } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        runInBackground: request.runInBackground,
        isolation: request.isolation,
        result: data,
        summary: `子代理 ${request.description} 已完成`,
      });
      return data;
    })
    .catch((error) => {
      record.status = "failed";
      record.completedAt = Date.now();
      record.error = error instanceof Error ? error.message : "sub-agent failed.";
      options.onEvent?.({
        type: "subagent_error",
        turn: parentTurn,
        subagentId: id,
        agentType: request.agentType,
        description: request.description,
        ...(request.agentName ? { agentName: request.agentName } : {}),
        ...(request.customAgent ? { customAgent: request.customAgent } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        runInBackground: request.runInBackground,
        isolation: request.isolation,
        error: record.error,
        summary: `子代理 ${request.description} 失败`,
      });
      return undefined;
    });
  return { request, record };
}

function serializeSubAgentRecord(record) {
  return {
    id: record.id,
    status: record.status,
    agentType: record.agentType,
    description: record.description,
    ...(record.agentName ? { agentName: record.agentName } : {}),
    ...(record.customAgent ? { customAgent: record.customAgent } : {}),
    task: record.task,
    ...(record.effort ? { effort: record.effort } : {}),
    isolation: record.isolation,
    ...(record.workspaceMetadata?.isolation === "worktree" ? { worktree: record.workspaceMetadata } : {}),
    startedAt: record.startedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.result ? { result: record.result } : {}),
  };
}

function readSubAgentStatus(backgroundSubAgents, args = {}) {
  const subagentId = String(args.subagentId || "").trim();
  if (subagentId) {
    const record = backgroundSubAgents.get(subagentId);
    if (!record) throw new Error(`Unknown background sub-agent: ${subagentId}`);
    return serializeSubAgentRecord(record);
  }
  return { subagents: [...backgroundSubAgents.values()].map(serializeSubAgentRecord) };
}

async function waitForRunningSubAgents(backgroundSubAgents, args = {}, timeoutMs = 1000) {
  const subagentId = String(args.subagentId || "").trim();
  const records = subagentId
    ? [backgroundSubAgents.get(subagentId)].filter(Boolean)
    : [...backgroundSubAgents.values()];
  const running = records.filter((record) => record?.status === "running" && record.promise && typeof record.promise.then === "function");
  if (!running.length) return;
  let timer;
  await Promise.race([
    Promise.allSettled(running.map((record) => record.promise)),
    new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(100, Math.min(3000, Number(timeoutMs) || 1000)));
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

function approvalKeyFor(call, policy) {
  return `${call.name}:${policy.category || "unknown"}:${stableStringify(call.arguments || {})}`;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
const DEFAULT_CONTEXT_COMPACTION_RATIO = 0.9;
const DEFAULT_CONTEXT_RECENT_MESSAGES = 10;
const DEFAULT_CONTEXT_COMPACTION_POLICY = {
  enabled: true,
  maxContextTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
  ratio: DEFAULT_CONTEXT_COMPACTION_RATIO,
  recentMessages: DEFAULT_CONTEXT_RECENT_MESSAGES,
  sourcePaths: [],
};

const CONTEXT_COMPACTION_MAX_TOKEN_ALIASES = ["maxContextTokens", "contextWindowTokens", "contextWindow", "maxTokens", "windowTokens"];
const CONTEXT_COMPACTION_RATIO_ALIASES = ["ratio", "thresholdRatio", "compactionRatio", "contextCompactionRatio", "contextCompressionRatio"];
const CONTEXT_COMPACTION_RECENT_MESSAGE_ALIASES = ["recentMessages", "contextRecentMessages", "recentContextMessages", "retainedMessages", "tailMessages"];

function approximateTokenCount(value) {
  const text = String(value || "");
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

function estimateMessagesTokens(messages) {
  return messages.reduce((total, message) => total + 4 + approximateTokenCount(message.role) + approximateTokenCount(message.content), 2);
}

function normalizeContextPolicyRatio(value, fallback = DEFAULT_CONTEXT_COMPACTION_RATIO) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 1) return fallback;
  return raw;
}

function cloneContextCompactionPolicy(policy = DEFAULT_CONTEXT_COMPACTION_POLICY) {
  return {
    enabled: policy.enabled !== false,
    maxContextTokens: normalizePolicyInteger(policy.maxContextTokens ?? policy.contextWindowTokens ?? policy.contextWindow, DEFAULT_CONTEXT_WINDOW_TOKENS, 256, 2_000_000),
    ratio: normalizeContextPolicyRatio(policy.ratio ?? policy.contextCompactionRatio ?? policy.contextCompressionRatio, DEFAULT_CONTEXT_COMPACTION_RATIO),
    recentMessages: normalizePolicyInteger(policy.recentMessages ?? policy.contextRecentMessages ?? policy.recentContextMessages, DEFAULT_CONTEXT_RECENT_MESSAGES, 1, 200),
    sourcePaths: Array.isArray(policy.sourcePaths) ? policy.sourcePaths.slice(0, 8) : [],
  };
}

function mergeContextCompactionPolicy(basePolicy, rawPolicy, sourcePath = "") {
  const policy = cloneContextCompactionPolicy(basePolicy);
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) return policy;
  if (sourcePath && !policy.sourcePaths.includes(sourcePath)) policy.sourcePaths.push(sourcePath);
  if (typeof rawPolicy.enabled === "boolean") policy.enabled = rawPolicy.enabled;
  if (typeof rawPolicy.auto === "boolean") policy.enabled = rawPolicy.auto;
  if (typeof rawPolicy.disable === "boolean") policy.enabled = !rawPolicy.disable;
  if (typeof rawPolicy.disabled === "boolean") policy.enabled = !rawPolicy.disabled;
  policy.maxContextTokens = normalizePolicyInteger(firstOwnSettingValue(rawPolicy, CONTEXT_COMPACTION_MAX_TOKEN_ALIASES), policy.maxContextTokens, 256, 2_000_000);
  policy.ratio = normalizeContextPolicyRatio(firstOwnSettingValue(rawPolicy, CONTEXT_COMPACTION_RATIO_ALIASES), policy.ratio);
  policy.recentMessages = normalizePolicyInteger(firstOwnSettingValue(rawPolicy, CONTEXT_COMPACTION_RECENT_MESSAGE_ALIASES), policy.recentMessages, 1, 200);
  return policy;
}

export function normalizeContextCompactionSettings(rawPolicy = {}, basePolicy = DEFAULT_CONTEXT_COMPACTION_POLICY) {
  if (typeof rawPolicy === "boolean") return mergeContextCompactionPolicy(basePolicy, { enabled: rawPolicy });
  return mergeContextCompactionPolicy(basePolicy, rawPolicy);
}

function publicContextCompactionPolicy(policy) {
  const normalized = cloneContextCompactionPolicy(policy);
  return {
    enabled: normalized.enabled,
    maxContextTokens: normalized.maxContextTokens,
    ratio: normalized.ratio,
    thresholdTokens: Math.floor(normalized.maxContextTokens * normalized.ratio),
    recentMessages: normalized.recentMessages,
    ...(normalized.sourcePaths.length ? { sourcePaths: normalized.sourcePaths } : {}),
  };
}

function normalizeContextWindowTokens(body = {}, settingsContextCompaction) {
  const policy = cloneContextCompactionPolicy(settingsContextCompaction);
  const raw = firstOwnSettingValue(body, CONTEXT_COMPACTION_MAX_TOKEN_ALIASES);
  if (raw === undefined || raw === null || raw === "") return policy.maxContextTokens;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return policy.maxContextTokens;
  return Math.max(256, Math.min(2_000_000, Math.floor(numeric)));
}

function normalizeContextCompactionRatio(body = {}, settingsContextCompaction) {
  const policy = cloneContextCompactionPolicy(settingsContextCompaction);
  const raw = firstOwnSettingValue(body, CONTEXT_COMPACTION_RATIO_ALIASES);
  return normalizeContextPolicyRatio(raw, policy.ratio);
}

function normalizeRecentContextMessages(body = {}, totalMessages, settingsContextCompaction) {
  const policy = cloneContextCompactionPolicy(settingsContextCompaction);
  const raw = firstOwnSettingValue(body, CONTEXT_COMPACTION_RECENT_MESSAGE_ALIASES);
  const requested = normalizePolicyInteger(raw, policy.recentMessages, 1, 200);
  return Math.max(1, Math.min(totalMessages - 1, requested));
}

function compactExcerpt(value, maxChars = 280) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.65)).trim();
  const tail = text.slice(-Math.floor(maxChars * 0.25)).trim();
  return `${head} ... ${tail}`;
}

function compactJsonForTaggedContext(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return compactExcerpt(value, depth >= 2 ? 260 : 700);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const limit = depth <= 1 ? 12 : depth === 2 ? 8 : 5;
    return value.slice(0, limit).map((item) => compactJsonForTaggedContext(item, depth + 1));
  }
  if (depth >= 5) return compactExcerpt(JSON.stringify(value), 360);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactJsonForTaggedContext(item, depth + 1)]));
}

function stringifyTaggedContextJson(value, maxChars = 12000) {
  const direct = JSON.stringify(value, null, 2);
  if (direct.length <= maxChars) return direct;
  const compact = JSON.stringify(compactJsonForTaggedContext(value), null, 2);
  if (compact.length <= maxChars) return compact;
  return JSON.stringify({
    truncated: true,
    note: "Context payload was compacted to preserve valid JSON.",
    excerpt: compactExcerpt(compact, Math.max(500, maxChars - 240)),
  }, null, 2);
}

function summarizeToolResultsForCompaction(content) {
  if (!content.startsWith("工具执行结果：")) return "";
  const parsed = tryParseJson(content.replace(/^工具执行结果：\s*/u, ""));
  const results = Array.isArray(parsed) ? parsed : [];
  if (!results.length) return "";
  return results.slice(0, 12).map((result) => {
    const name = typeof result?.name === "string" ? result.name : "tool";
    const status = result?.ok === false ? "failed" : "ok";
    const message = typeof result?.message === "string" ? result.message : "";
    const path = typeof result?.data?.path === "string" ? ` path=${result.data.path}` : "";
    return `${name}:${status}${path}${message ? ` ${compactExcerpt(message, 160)}` : ""}`;
  }).join("; ");
}

function summarizeContextTagsForCompaction(content) {
  const tags = [];
  for (const match of content.matchAll(/<([a-z_]+_context)\b([^>]*)>/g)) {
    const tag = match[1];
    const attrs = match[2] || "";
    const name = attrs.match(/\bname="([^"]*)"/)?.[1] || "";
    const pathValue = attrs.match(/\bpath="([^"]*)"/)?.[1] || "";
    tags.push(`${tag}${name ? ` name=${name}` : ""}${pathValue ? ` path=${pathValue}` : ""}`.trim());
    if (tags.length >= 12) break;
  }
  return tags.join("; ");
}

function summarizeMessageForCompaction(message, index) {
  const content = String(message.content || "");
  const toolSummary = summarizeToolResultsForCompaction(content);
  if (toolSummary) return `${index + 1}. [${message.role}] tool results: ${toolSummary}`;
  const contextSummary = summarizeContextTagsForCompaction(content);
  if (contextSummary) return `${index + 1}. [${message.role}] loaded context: ${contextSummary}`;
  return `${index + 1}. [${message.role}] ${compactExcerpt(content)}`;
}

function summarizeActiveCapabilityForCompaction(item) {
  if (!item || typeof item !== "object") return undefined;
  return {
    name: item.name || item.title || item.path || "",
    ...(item.path ? { path: item.path } : {}),
    ...(item.source ? { source: item.source } : {}),
    ...(item.scope ? { scope: item.scope } : {}),
    ...(item.plugin ? { plugin: item.plugin } : {}),
    ...(Array.isArray(item.tags) && item.tags.length ? { tags: item.tags.slice(0, 8) } : {}),
    ...(Array.isArray(item.tools) && item.tools.length ? { tools: item.tools.slice(0, 12) } : {}),
    ...(Array.isArray(item.skills) && item.skills.length ? { skills: item.skills.slice(0, 12) } : {}),
    ...(Array.isArray(item.commands) && item.commands.length ? { commands: item.commands.slice(0, 12) } : {}),
    ...(Array.isArray(item.memories) && item.memories.length ? { memories: item.memories.slice(0, 12) } : {}),
    ...(Array.isArray(item.agents) && item.agents.length ? { agents: item.agents.slice(0, 12) } : {}),
    ...(Array.isArray(item.frameworks) && item.frameworks.length ? { frameworks: item.frameworks.slice(0, 12) } : {}),
    ...(Array.isArray(item.mcpTools) && item.mcpTools.length ? { mcpTools: item.mcpTools.slice(0, 12) } : {}),
    ...(Array.isArray(item.mcpResources) && item.mcpResources.length ? { mcpResources: item.mcpResources.slice(0, 12) } : {}),
    ...(Array.isArray(item.disallowedMcpTools) && item.disallowedMcpTools.length ? { disallowedMcpTools: item.disallowedMcpTools.slice(0, 12) } : {}),
    ...(Array.isArray(item.agentRoles) && item.agentRoles.length ? { agentRoles: item.agentRoles.slice(0, 12) } : {}),
    ...(Array.isArray(item.handoffs) && item.handoffs.length ? { handoffs: item.handoffs.slice(0, 12) } : {}),
    ...(Array.isArray(item.verificationGates) && item.verificationGates.length ? { verificationGates: item.verificationGates.slice(0, 12) } : {}),
  };
}

function summarizeToolResultForCompactionState(result) {
  if (!result || typeof result !== "object") return undefined;
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts.map((artifact) => artifact?.path).filter(Boolean).slice(0, 8)
    : [];
  return {
    name: result.name || "tool",
    status: result.ok === false ? "failed" : "ok",
    message: compactExcerpt(result.message || "", 220),
    ...(typeof result?.data?.path === "string" ? { path: result.data.path } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
}

function lastUserTaskForCompaction(messages = []) {
  for (const message of [...messages].reverse()) {
    if (message?.role !== "user") continue;
    const content = String(message.content || "").trim();
    if (!content || content.startsWith("工具执行结果：") || isInjectedRoutingContextMessage(content)) continue;
    return compactExcerpt(content, 900);
  }
  return "";
}

function openWorkSignalsForCompaction(messages = []) {
  const signals = [];
  for (const message of messages.slice(-12)) {
    const content = String(message?.content || "").trim();
    if (!content || isInjectedRoutingContextMessage(content)) continue;
    const reason = projectResponseIncompleteReason(content);
    if (!reason) continue;
    signals.push({ role: message.role || "unknown", reason, excerpt: compactExcerpt(stripProjectToolBlocks(content), 320) });
    if (signals.length >= 5) break;
  }
  return signals;
}

function compactSessionResumeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return {
    sourceSessionId: value.sourceSessionId || "",
    sourceStatus: value.sourceStatus || "",
    stoppedReason: value.stoppedReason || "",
    finalText: compactExcerpt(value.finalText || "", 900),
    activeCapabilities: value.activeCapabilities || {},
    autoMemoryResults: Array.isArray(value.autoMemoryResults) ? value.autoMemoryResults.slice(0, 8) : [],
    autoMcpResults: Array.isArray(value.autoMcpResults) ? value.autoMcpResults.slice(0, 8) : [],
    routingDiagnostics: Array.isArray(value.routingDiagnostics) ? value.routingDiagnostics.slice(-5) : [],
    contextCompactions: Array.isArray(value.contextCompactions) ? value.contextCompactions.slice(-5) : [],
    frameworkBlueprintGuards: Array.isArray(value.frameworkBlueprintGuards) ? value.frameworkBlueprintGuards.slice(-8) : [],
    subAgents: Array.isArray(value.subAgents) ? value.subAgents.slice(0, 12) : [],
    todos: Array.isArray(value.todos) ? value.todos.slice(0, 30) : [],
    openTodos: Array.isArray(value.openTodos) ? value.openTodos.slice(0, 20) : [],
    todoCounts: value.todoCounts && typeof value.todoCounts === "object" ? value.todoCounts : {},
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.slice(0, 30) : [],
    failedTools: Array.isArray(value.failedTools) ? value.failedTools.slice(0, 12) : [],
    ...(typeof value.raw === "string" ? { raw: compactExcerpt(value.raw, 2400) } : {}),
  };
}

function sessionResumeContextForCompaction(messages = []) {
  for (const message of [...messages].reverse()) {
    const content = String(message?.content || "");
    const match = content.match(/<session_resume_context>([\s\S]*?)<\/session_resume_context>/i);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      return compactSessionResumeContext(parsed);
    } catch {
      return { raw: compactExcerpt(match[1], 2400) };
    }
  }
  for (const message of [...messages].reverse()) {
    const content = String(message?.content || "");
    const match = content.match(/<context_state_snapshot>([\s\S]*?)<\/context_state_snapshot>/i);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      const nested = compactSessionResumeContext(parsed?.sessionResumeContext);
      if (nested) return nested;
    } catch {
      continue;
    }
  }
  return undefined;
}

function buildContextStateSnapshotForCompaction(context = {}) {
  const toolResults = Array.isArray(context.toolResults) ? context.toolResults : [];
  const capabilityRouting = context.capabilityRouting && typeof context.capabilityRouting === "object" ? context.capabilityRouting : {};
  const selected = capabilityRouting.selected && typeof capabilityRouting.selected === "object" ? capabilityRouting.selected : {};
  const snapshot = {
    currentTask: lastUserTaskForCompaction(context.workingMessages || []),
    resumeRules: [
      "Continue the engineering task from this state snapshot instead of restarting.",
      "Preserve loaded skills, memories, agents, frameworks, MCP context, memory RAG evidence, MCP result evidence, sub-agent evidence, session resume context, tool evidence, artifacts, and unresolved work signals.",
      "If the snapshot conflicts with newer messages or current files, trust newer messages and current files.",
    ],
    sessionResumeContext: sessionResumeContextForCompaction(context.workingMessages || []),
    activeCapabilities: {
      skills: (context.invokedSkills || []).map(summarizeActiveCapabilityForCompaction).filter(Boolean).slice(-20),
      commands: (context.activeCommands || []).map(summarizeActiveCapabilityForCompaction).filter(Boolean).slice(-20),
      outputStyles: (context.activeOutputStyles || []).map(summarizeActiveCapabilityForCompaction).filter(Boolean).slice(-10),
      memories: (context.activeMemories || []).map(summarizeActiveCapabilityForCompaction).filter(Boolean).slice(-20),
      agents: (context.activeAgents || []).map(summarizeActiveCapabilityForCompaction).filter(Boolean).slice(-20),
      frameworks: (context.activeAgentFrameworks || []).map(summarizeActiveCapabilityForCompaction).filter(Boolean).slice(-20),
      mcpTools: (selected.mcpTools || []).map(summarizeActiveCapabilityForCompaction).filter(Boolean).slice(-20),
      mcpResources: (selected.mcpResources || []).map(summarizeActiveCapabilityForCompaction).filter(Boolean).slice(-20),
    },
    autoMemoryResults: memoryMaintenanceMemorySummary(capabilityRouting),
    autoMcpResults: memoryMaintenanceMcpSummary(capabilityRouting),
    subAgentResults: memoryMaintenanceSubAgentSummary(toolResults),
    routingDiagnostics: normalizeRoutingDiagnostics(capabilityRouting.diagnostics).slice(-5),
    recentToolResults: toolResults.slice(-20).map(summarizeToolResultForCompactionState).filter(Boolean),
    artifactPaths: memoryMaintenanceArtifacts(toolResults).slice(-40),
    openWorkSignals: openWorkSignalsForCompaction(context.workingMessages || []),
    latestTodos: Array.isArray(context.latestTodoState?.todos) ? context.latestTodoState.todos.slice(0, 50) : [],
    openTodos: Array.isArray(context.latestTodoState?.openTodos) ? context.latestTodoState.openTodos.slice(0, 20) : [],
    autoContinuationCount: Number(context.autoContinuationCount) || 0,
    previousCompactions: Array.isArray(context.contextCompactions) ? context.contextCompactions.length : 0,
    contextCompactionPolicy: context.contextCompactionPolicy ? publicContextCompactionPolicy(context.contextCompactionPolicy) : undefined,
  };
  return [
    "<context_state_snapshot>",
    stringifyTaggedContextJson(snapshot, 12000),
    "</context_state_snapshot>",
  ].join("\n");
}

function buildContextCompactionMessage({ compactedMessages, turn, beforeTokens, afterTokens, thresholdTokens, maxContextTokens, stateSnapshot, requestedRetainedMessageCount, retainedMessageCount, overThresholdAfterCompaction }) {
  const lines = compactedMessages.map(summarizeMessageForCompaction);
  const body = lines.join("\n").slice(0, 6000);
  return {
    role: "user",
    content: [
      `<context_compaction turn="${turn}" compactedMessages="${compactedMessages.length}" requestedRetainedMessages="${requestedRetainedMessageCount ?? ""}" retainedMessages="${retainedMessageCount ?? ""}" beforeTokens="${beforeTokens}" afterTokens="${afterTokens}" thresholdTokens="${thresholdTokens}" maxContextTokens="${maxContextTokens}" overThresholdAfterCompaction="${overThresholdAfterCompaction === true}">`,
      "以下是 ocli 为避免上下文接近模型上限而自动压缩的历史摘要。继续执行时必须保留这些事实、文件路径、工具结果、未完成事项和用户意图；如果摘要与最近原文冲突，以最近原文和当前文件事实为准。",
      stateSnapshot || "",
      body,
      "</context_compaction>",
    ].filter(Boolean).join("\n"),
  };
}

function compactWorkingMessagesIfNeeded({ workingMessages, systemPrompt, body, turn, toolResults, invokedSkills, activeCommands, activeOutputStyles, activeMemories, activeAgents, activeAgentFrameworks, capabilityRouting, contextCompactions, autoContinuationCount, latestTodoState, settingsContextCompaction }) {
  const requestContextCompaction = body.contextCompaction;
  const requestPolicy = requestContextCompaction && typeof requestContextCompaction === "object" && !Array.isArray(requestContextCompaction)
    ? mergeContextCompactionPolicy(settingsContextCompaction, requestContextCompaction)
    : cloneContextCompactionPolicy(settingsContextCompaction);
  const compactionEnabled = body.disableContextCompaction === true || requestContextCompaction === false
    ? false
    : requestContextCompaction === true || body.enableContextCompaction === true
      ? true
      : requestPolicy.enabled !== false;
  if (!compactionEnabled || workingMessages.length < 2) return undefined;
  const maxContextTokens = normalizeContextWindowTokens(body, requestPolicy);
  const ratio = normalizeContextCompactionRatio(body, requestPolicy);
  const thresholdTokens = Math.floor(maxContextTokens * ratio);
  const beforeTokens = estimateMessagesTokens([{ role: "system", content: systemPrompt }, ...workingMessages]);
  if (beforeTokens < thresholdTokens) return undefined;
  const effectivePolicy = { ...requestPolicy, enabled: true, maxContextTokens, ratio };

  const stateSnapshot = buildContextStateSnapshotForCompaction({
    workingMessages,
    toolResults,
    invokedSkills,
    activeCommands,
    activeOutputStyles,
    activeMemories,
    activeAgents,
    activeAgentFrameworks,
    capabilityRouting,
    contextCompactions,
    autoContinuationCount,
    latestTodoState,
    contextCompactionPolicy: effectivePolicy,
  });
  const requestedRecentCount = normalizeRecentContextMessages(body, workingMessages.length, requestPolicy);
  let selected;
  for (let retainedCount = requestedRecentCount; retainedCount >= 1; retainedCount -= 1) {
    const splitIndex = Math.max(1, workingMessages.length - retainedCount);
    const compactedMessages = workingMessages.slice(0, splitIndex);
    const recentMessages = workingMessages.slice(splitIndex);
    if (!compactedMessages.length) continue;
    const provisionalMessage = buildContextCompactionMessage({
      compactedMessages,
      turn,
      beforeTokens,
      afterTokens: 0,
      thresholdTokens,
      maxContextTokens,
      stateSnapshot,
      requestedRetainedMessageCount: requestedRecentCount,
      retainedMessageCount: recentMessages.length,
      overThresholdAfterCompaction: false,
    });
    const provisionalMessages = [provisionalMessage, ...recentMessages];
    const afterTokens = estimateMessagesTokens([{ role: "system", content: systemPrompt }, ...provisionalMessages]);
    const overThresholdAfterCompaction = afterTokens >= thresholdTokens;
    const compactionMessage = buildContextCompactionMessage({
      compactedMessages,
      turn,
      beforeTokens,
      afterTokens,
      thresholdTokens,
      maxContextTokens,
      stateSnapshot,
      requestedRetainedMessageCount: requestedRecentCount,
      retainedMessageCount: recentMessages.length,
      overThresholdAfterCompaction,
    });
    selected = {
      compactedMessages,
      recentMessages,
      messages: [compactionMessage, ...recentMessages],
      afterTokens,
      retainedMessageCount: recentMessages.length,
      overThresholdAfterCompaction,
    };
    if (!overThresholdAfterCompaction) break;
  }
  if (!selected) return undefined;
  return {
    messages: selected.messages,
    event: {
      type: "context_compacted",
      turn,
      beforeTokens,
      afterTokens: selected.afterTokens,
      thresholdTokens,
      maxContextTokens,
      compactedMessageCount: selected.compactedMessages.length,
      requestedRetainedMessageCount: requestedRecentCount,
      retainedMessageCount: selected.retainedMessageCount,
      overThresholdAfterCompaction: selected.overThresholdAfterCompaction,
      adaptiveRetainedMessageCount: selected.retainedMessageCount < requestedRecentCount,
      stateSnapshot: true,
      policy: publicContextCompactionPolicy(effectivePolicy),
      summary: selected.overThresholdAfterCompaction
        ? `ocli 已在上下文达到 ${beforeTokens}/${maxContextTokens} tokens 时自动压缩 ${selected.compactedMessages.length} 条历史消息，但最近消息仍接近上限`
        : `ocli 已在上下文达到 ${beforeTokens}/${maxContextTokens} tokens 时自动压缩 ${selected.compactedMessages.length} 条历史消息，保留最近 ${selected.retainedMessageCount}/${requestedRecentCount} 条`,
    },
  };
}

export function normalizeApiBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("agent/run requires apiBaseUrl.");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("apiBaseUrl must be http or https.");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("Plain HTTP apiBaseUrl is only allowed for localhost development.");
  }
  return raw.replace(/\/+$/, "");
}

export function normalizeWebProvidedModel(value) {
  const model = String(value || "").trim();
  if (!model) throw new Error("ocli agent requires a model provided by Oases Web.");
  return model;
}

export function validateAgentRequest(body) {
  normalizeApiBaseUrl(body?.apiBaseUrl);
  normalizeWebProvidedModel(body?.model);
}

export async function runAgent(root, body, options = {}) {
  const apiBaseUrl = normalizeApiBaseUrl(body.apiBaseUrl);
  const model = normalizeWebProvidedModel(body.model);
  const systemPrompt = String(body.systemPrompt || "你是 Oases ocli 本地工程 agent。");
  const subAgentDepth = Math.max(0, Number(options.subAgentDepth) || 0);
  const maxTurnsPerSlice = Math.max(1, Math.min(32, Number(body.maxTurns) || 16));
  const maxAutoContinuations = Math.max(0, Math.min(8, Number(body.maxAutoContinuations ?? 3)));
  const maxModelRequestRetries = Math.max(0, Math.min(4, Number(body.maxModelRequestRetries ?? 2)));
  const maxTurns = Math.max(maxTurnsPerSlice, Math.min(128, Number(body.maxTotalTurns) || maxTurnsPerSlice * (maxAutoContinuations + 1)));
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter((item) => item && typeof item === "object" && ["user", "assistant", "system"].includes(item.role) && typeof item.content === "string")
        .map((item) => ({ role: item.role, content: item.content }))
    : [];
  let workingMessages = [...messages];
  const toolResults = [];
  const invokedSkills = [];
  const activeCommands = [];
  const activeOutputStyles = [];
  const activeMemories = [];
  const activeAgents = [];
  const activeAgentFrameworks = [];
  const contextCompactions = [];
  const frameworkBlueprintGuards = [];
  const frameworkBlueprintGuardedKeys = new Set();
  let capabilityRouting;
  const loadedSkillPaths = new Set();
  const loadedCommandPaths = new Set();
  const loadedOutputStylePaths = new Set();
  const loadedMemoryPaths = new Set();
  const loadedAgentPaths = new Set();
  const loadedAgentFrameworkPaths = new Set();
  const loadedMcpToolKeys = new Set();
  const loadedMcpResourceKeys = new Set();
  const settingsDeniedToolRules = await readWorkspacePermissionDenyRules(root);
  const settingsAskToolRules = await readWorkspacePermissionAskRules(root);
  const settingsAllowedToolRules = await readWorkspacePermissionAllowRules(root);
  const settingsDefaultMode = await readWorkspacePermissionDefaultMode(root, options);
  const settingsMemory = await readWorkspaceMemorySettings(root, options);
  const settingsCapabilityRouting = await readWorkspaceCapabilityRoutingSettings(root, options);
  const settingsContextCompaction = await readWorkspaceContextCompactionSettings(root, options);
  const settingsToolWideDeniedNames = toolWideDeniedNames(settingsDeniedToolRules);
  const settingsToolWideAskNames = toolWideAskedNames(settingsAskToolRules);
  const settingsToolWideAllowNames = toolWideAllowedNames(settingsAllowedToolRules);
  const backgroundSubAgents = new Map();
  let finalText = "";
  let stoppedReason = "completed";
  let autoContinuationCount = 0;
  let modelRequestRetryCount = 0;
  let modelRequestRepairCount = 0;
  const modelRequestRepairs = [];
  let latestTodoState;
  const modelRequestProfile = buildAgentModelRequestProfile(model, body);
  const modelRequestProfileSummary = modelRequestProfileMetadata(modelRequestProfile);

  options.onEvent?.({
    type: "model_request_profile",
    turn: -1,
    ...modelRequestProfileSummary,
    summary: `ocli 已为模型 ${model} 应用请求参数策略：temperature=${modelRequestProfile.temperature}${modelRequestProfile.supportsEffort ? `, effort=${modelRequestProfile.effort}` : ", no effort fields"}`,
  });

  function injectFrameworkMcpContext(context = {}, event = {}) {
    const newlyLoadedTools = [];
    for (const tool of Array.isArray(context.tools) ? context.tools : []) {
      const key = mcpToolKey(tool);
      if (!key || loadedMcpToolKeys.has(key)) continue;
      loadedMcpToolKeys.add(key);
      newlyLoadedTools.push(tool);
    }
    const newlyLoadedResources = [];
    for (const resource of Array.isArray(context.resources) ? context.resources : []) {
      const key = mcpResourceKey(resource);
      if (!key || loadedMcpResourceKeys.has(key)) continue;
      loadedMcpResourceKeys.add(key);
      newlyLoadedResources.push(resource);
    }
    const frameworkMcpContextMessage = buildMcpContextMessage({ tools: newlyLoadedTools, resources: newlyLoadedResources });
    if (!frameworkMcpContextMessage) return { tools: [], resources: [] };
    workingMessages.push({ role: "user", content: frameworkMcpContextMessage });
    const toolMetadata = newlyLoadedTools.map((tool) => safeRoutingMetadata(tool, "mcpTool")).filter(Boolean);
    const resourceMetadata = newlyLoadedResources.map((resource) => safeRoutingMetadata(resource, "mcpResource")).filter(Boolean);
    options.onEvent?.({
      type: "mcp_context_loaded",
      turn: -1,
      framework: true,
      tools: toolMetadata,
      resources: resourceMetadata,
      summary: `ocli 已按 Agent Framework 加载 MCP 能力清单 ${toolMetadata.length + resourceMetadata.length} 项`,
      ...event,
    });
    return { tools: newlyLoadedTools, resources: newlyLoadedResources };
  }

  if (settingsDeniedToolRules.length || settingsAskToolRules.length || settingsAllowedToolRules.length || settingsDefaultMode?.mode) {
    options.onEvent?.({
      type: "settings_permissions_loaded",
      turn: -1,
      permissions: {
        denyCount: settingsDeniedToolRules.length,
        askCount: settingsAskToolRules.length,
        allowCount: settingsAllowedToolRules.length,
        defaultMode: settingsDefaultMode?.mode || "default",
        defaultModePath: settingsDefaultMode?.path || "",
        deniedTools: [...new Set(settingsDeniedToolRules.map((rule) => rule.toolName))],
        askedTools: [...new Set(settingsAskToolRules.map((rule) => rule.toolName))],
        allowedTools: [...new Set(settingsAllowedToolRules.map((rule) => rule.toolName))],
        toolWideDenied: settingsToolWideDeniedNames,
        toolWideAsk: settingsToolWideAskNames,
        toolWideAllow: settingsToolWideAllowNames,
      },
      summary: `ocli 已加载项目权限规则：deny ${settingsDeniedToolRules.length} 条，ask ${settingsAskToolRules.length} 条，allow ${settingsAllowedToolRules.length} 条，defaultMode ${settingsDefaultMode?.mode || "default"}`,
    });
  }

  if (settingsCapabilityRouting.sourcePaths.length) {
    const policy = publicCapabilityRoutingPolicy(settingsCapabilityRouting);
    options.onEvent?.({
      type: "settings_capability_routing_loaded",
      turn: -1,
      policy,
      summary: `ocli 已加载项目能力路由策略：enabled=${policy.enabled}, adaptive=${policy.adaptive}, skills=${policy.limits.skills}, memories=${policy.limits.memories}, MCP=${policy.limits.mcpTools}/${policy.limits.mcpResources}`,
    });
  }

  if (settingsContextCompaction.sourcePaths.length) {
    const policy = publicContextCompactionPolicy(settingsContextCompaction);
    options.onEvent?.({
      type: "settings_context_compaction_loaded",
      turn: -1,
      policy,
      summary: `ocli 已加载项目上下文压缩策略：enabled=${policy.enabled}, threshold=${policy.thresholdTokens}/${policy.maxContextTokens}, recent=${policy.recentMessages}`,
    });
  }

  if (body.autoTodoRestore !== false && body.disableTodoRestore !== true) {
    try {
      const todoData = await handleTool(root, "todo_read", {}, { signal: options.signal });
      const restoredTodoState = todoStateFromData(todoData || {}, "todo_read");
      if (restoredTodoState.todos.length) {
        latestTodoState = restoredTodoState;
        if (restoredTodoState.openTodos.length) {
          const todoContextMessage = buildTodoStateContextMessage(restoredTodoState);
          if (todoContextMessage) workingMessages.push({ role: "user", content: todoContextMessage });
        }
        options.onEvent?.({
          type: "todo_state_loaded",
          turn: -1,
          counts: restoredTodoState.counts,
          openTodos: restoredTodoState.openTodos,
          source: restoredTodoState.source,
          path: typeof todoData?.path === "string" ? todoData.path : ".oases/todo.json",
          summary: restoredTodoState.openTodos.length
            ? `ocli 已恢复任务清单：仍有 ${restoredTodoState.openTodos.length} 项未完成`
            : "ocli 已恢复任务清单：全部完成",
        });
      }
    } catch (error) {
      options.onEvent?.({
        type: "todo_state_load_failed",
        turn: -1,
        error: error instanceof Error ? error.message : String(error || "todo restore failed"),
        summary: "ocli 恢复任务清单失败，将继续本轮会话",
      });
    }
  }

  const preloadedSkills = Array.isArray(body.preloadedSkills)
    ? body.preloadedSkills.filter((skill) => skill && typeof skill === "object" && typeof skill.path === "string" && typeof skill.content === "string")
    : [];
  const preloadedSkillContextMessage = buildSkillContextMessage(preloadedSkills);
  if (preloadedSkillContextMessage) workingMessages.push({ role: "user", content: preloadedSkillContextMessage });
  for (const skill of preloadedSkills) {
    if (loadedSkillPaths.has(skill.path)) continue;
    loadedSkillPaths.add(skill.path);
    const skillMetadata = { name: skill.name, description: skill.description || "", path: skill.path, source: skill.source || "workspace", plugin: skill.plugin || "", root: skill.root || "" };
    invokedSkills.push(skillMetadata);
    options.onEvent?.({ type: "skill_loaded", turn: -1, skill: skillMetadata, preloaded: true, summary: `ocli 已预加载技能 ${skill.name}` });
  }

  const preloadedCommands = Array.isArray(body.preloadedCommands)
    ? body.preloadedCommands
        .map((command) => {
          if (!command || typeof command !== "object" || typeof command.path !== "string") return undefined;
          const bodyText = typeof command.body === "string" && command.body.trim()
            ? command.body
            : typeof command.content === "string" ? command.content : "";
          return normalizeLoadedCommandData({
            path: command.path,
            body: bodyText,
            content: bodyText,
            command,
            plugin: command.plugin ? { name: command.plugin } : undefined,
          }, command.source === "plugin" ? "plugin_command_read" : "command_read");
        })
        .filter(Boolean)
    : [];
  const preloadedCommandContextMessage = buildCommandContextMessage(preloadedCommands);
  if (preloadedCommandContextMessage) workingMessages.push({ role: "user", content: preloadedCommandContextMessage });
  for (const command of preloadedCommands) {
    if (loadedCommandPaths.has(command.path)) continue;
    loadedCommandPaths.add(command.path);
    const commandMetadata = {
      name: command.name || "command",
      title: command.title || "",
      description: command.description || "",
      path: command.path,
      source: command.source || "workspace",
      plugin: command.plugin || "",
    };
    activeCommands.push(commandMetadata);
    options.onEvent?.({ type: "command_loaded", turn: -1, command: commandMetadata, preloaded: true, summary: `ocli 已预加载命令模板 ${commandMetadata.name}` });
  }

  const preloadedOutputStyles = Array.isArray(body.preloadedOutputStyles)
    ? body.preloadedOutputStyles.filter((style) => style && typeof style === "object" && typeof style.path === "string" && (typeof style.prompt === "string" || typeof style.content === "string"))
    : [];
  const preloadedOutputStyleContextMessage = buildOutputStyleContextMessage(preloadedOutputStyles);
  if (preloadedOutputStyleContextMessage) workingMessages.push({ role: "user", content: preloadedOutputStyleContextMessage });
  for (const style of preloadedOutputStyles) {
    if (loadedOutputStylePaths.has(style.path)) continue;
    loadedOutputStylePaths.add(style.path);
    const styleMetadata = { name: style.name || "output-style", title: style.title || "", description: style.description || "", path: style.path, source: style.source || "workspace", plugin: style.plugin || "" };
    activeOutputStyles.push(styleMetadata);
    options.onEvent?.({ type: "output_style_loaded", turn: -1, outputStyle: styleMetadata, preloaded: true, summary: `ocli 已预加载输出风格 ${styleMetadata.name}` });
  }

  const preloadedMemories = Array.isArray(body.preloadedMemories)
    ? body.preloadedMemories.map(normalizeLoadedMemoryData).filter(Boolean)
    : [];
  const preloadedMemoryContextMessage = buildMemoryContextMessage(preloadedMemories);
  if (preloadedMemoryContextMessage) workingMessages.push({ role: "user", content: preloadedMemoryContextMessage });
  for (const memory of preloadedMemories) {
    if (loadedMemoryPaths.has(memory.path)) continue;
    loadedMemoryPaths.add(memory.path);
    const memoryMetadata = { name: memory.name, title: memory.title || "", description: memory.description || "", path: memory.path, scope: memory.scope || "project", tags: memory.tags || [] };
    activeMemories.push(memoryMetadata);
    options.onEvent?.({ type: "memory_loaded", turn: -1, memory: memoryMetadata, preloaded: true, summary: `ocli 已预加载项目记忆 ${memoryMetadata.name}` });
  }

  const preloadedAgents = Array.isArray(body.preloadedAgents)
    ? body.preloadedAgents.map(normalizeLoadedAgentData).filter(Boolean)
    : [];
  const preloadedAgentContextMessage = buildAgentContextMessage(preloadedAgents);
  if (preloadedAgentContextMessage) workingMessages.push({ role: "user", content: preloadedAgentContextMessage });
  for (const agent of preloadedAgents) {
    if (loadedAgentPaths.has(agent.path)) continue;
    loadedAgentPaths.add(agent.path);
      const agentMetadata = {
        name: agent.name,
        description: agent.description || "",
        path: agent.path,
        source: agent.source || "workspace",
        plugin: agent.plugin || "",
        agentType: agent.agentType || "",
        ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
      ...(typeof agent.background === "boolean" ? { background: agent.background } : {}),
      ...(agent.isolation ? { isolation: agent.isolation } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      ...(Array.isArray(agent.tools) ? { tools: agent.tools } : {}),
      ...(Array.isArray(agent.disallowedTools) ? { disallowedTools: agent.disallowedTools } : {}),
      ...(Array.isArray(agent.mcpTools) ? { mcpTools: agent.mcpTools } : {}),
      ...(Array.isArray(agent.disallowedMcpTools) ? { disallowedMcpTools: agent.disallowedMcpTools } : {}),
      ...(Array.isArray(agent.skills) ? { skills: agent.skills } : {}),
      ...(Array.isArray(agent.commands) ? { commands: agent.commands } : {}),
      ...(Array.isArray(agent.memories) ? { memories: agent.memories } : {}),
      ...(Array.isArray(agent.frameworks) ? { frameworks: agent.frameworks } : {}),
    };
    activeAgents.push(agentMetadata);
    options.onEvent?.({ type: "agent_loaded", turn: -1, agent: agentMetadata, preloaded: true, summary: `ocli 已预加载自定义 Agent ${agentMetadata.name}` });
  }

  const requestedAgentFrameworkNames = [
    ...(Array.isArray(body.agentFrameworks) ? body.agentFrameworks : []),
    ...(Array.isArray(body.frameworks) ? body.frameworks : []),
    ...(typeof body.agentFramework === "string" && body.agentFramework.trim() ? [body.agentFramework] : []),
    ...(typeof body.framework === "string" && body.framework.trim() ? [body.framework] : []),
  ].filter((item) => typeof item === "string" && item.trim());
  const preloadedAgentFrameworks = [
    ...(Array.isArray(body.preloadedAgentFrameworks) ? body.preloadedAgentFrameworks.map(normalizeLoadedAgentFrameworkData).filter(Boolean) : []),
    ...(requestedAgentFrameworkNames.length ? await loadWorkspaceAgentFrameworks(root, requestedAgentFrameworkNames, options) : []),
  ];
  const preloadedAgentFrameworkContextMessage = buildAgentFrameworkContextMessage(preloadedAgentFrameworks);
  if (preloadedAgentFrameworkContextMessage) workingMessages.push({ role: "user", content: preloadedAgentFrameworkContextMessage });
  for (const framework of preloadedAgentFrameworks) {
    if (loadedAgentFrameworkPaths.has(framework.path)) continue;
    loadedAgentFrameworkPaths.add(framework.path);
    const frameworkMetadata = { name: framework.name, title: framework.title || "", description: framework.description || "", path: framework.path, agents: framework.agents || [], skills: framework.skills || [], commands: framework.commands || [], memories: framework.memories || [], mcpServers: framework.mcpServers || [], mcpTools: framework.mcpTools || [], mcpResources: framework.mcpResources || [], agentRoles: framework.agentRoles || [], handoffs: framework.handoffs || [], verificationGates: framework.verificationGates || [] };
    activeAgentFrameworks.push(frameworkMetadata);
    options.onEvent?.({ type: "agent_framework_loaded", turn: -1, framework: frameworkMetadata, preloaded: true, summary: `ocli 已预加载 Agent Framework ${framework.name}` });
  }
  if (preloadedAgentFrameworks.length) {
    const frameworkDependencies = await loadAgentFrameworkDependencies(root, preloadedAgentFrameworks, options);
    for (const skill of frameworkDependencies.skills) {
      if (loadedSkillPaths.has(skill.path)) continue;
      loadedSkillPaths.add(skill.path);
      const skillMetadata = { name: skill.name, description: skill.description || "", path: skill.path, source: skill.source || "workspace", plugin: skill.plugin || "", root: skill.root || "" };
      invokedSkills.push(skillMetadata);
      options.onEvent?.({ type: "skill_loaded", turn: -1, skill: skillMetadata, preloaded: true, framework: true, summary: `ocli 已按 Agent Framework 预加载技能 ${skill.name}` });
    }
    const frameworkSkillContextMessage = buildSkillContextMessage(frameworkDependencies.skills || []);
    if (frameworkSkillContextMessage) workingMessages.push({ role: "user", content: frameworkSkillContextMessage });
    for (const command of frameworkDependencies.commands) {
      if (loadedCommandPaths.has(command.path)) continue;
      loadedCommandPaths.add(command.path);
      const commandMetadata = { name: command.name || "command", title: command.title || "", description: command.description || "", path: command.path, source: command.source || "workspace", plugin: command.plugin || "" };
      activeCommands.push(commandMetadata);
      options.onEvent?.({ type: "command_loaded", turn: -1, command: commandMetadata, preloaded: true, framework: true, summary: `ocli 已按 Agent Framework 预加载命令模板 ${commandMetadata.name}` });
    }
    const frameworkCommandContextMessage = buildCommandContextMessage(frameworkDependencies.commands || []);
    if (frameworkCommandContextMessage) workingMessages.push({ role: "user", content: frameworkCommandContextMessage });
    for (const memory of frameworkDependencies.memories) {
      if (loadedMemoryPaths.has(memory.path)) continue;
      loadedMemoryPaths.add(memory.path);
      const memoryMetadata = { name: memory.name, title: memory.title || "", description: memory.description || "", path: memory.path, scope: memory.scope || "project", tags: memory.tags || [] };
      activeMemories.push(memoryMetadata);
      options.onEvent?.({ type: "memory_loaded", turn: -1, memory: memoryMetadata, preloaded: true, framework: true, summary: `ocli 已按 Agent Framework 预加载项目记忆 ${memory.name}` });
    }
    const frameworkMemoryContextMessage = buildMemoryContextMessage(frameworkDependencies.memories || []);
    if (frameworkMemoryContextMessage) workingMessages.push({ role: "user", content: frameworkMemoryContextMessage });
    for (const agent of frameworkDependencies.agents) {
      if (loadedAgentPaths.has(agent.path)) continue;
      loadedAgentPaths.add(agent.path);
      const agentMetadata = { name: agent.name, description: agent.description || "", path: agent.path, source: agent.source || "workspace", plugin: agent.plugin || "", agentType: agent.agentType || "", ...(Array.isArray(agent.tools) ? { tools: agent.tools } : {}), ...(Array.isArray(agent.skills) ? { skills: agent.skills } : {}), ...(Array.isArray(agent.commands) ? { commands: agent.commands } : {}), ...(Array.isArray(agent.memories) ? { memories: agent.memories } : {}), ...(Array.isArray(agent.frameworks) ? { frameworks: agent.frameworks } : {}) };
      activeAgents.push(agentMetadata);
      options.onEvent?.({ type: "agent_loaded", turn: -1, agent: agentMetadata, preloaded: true, framework: true, summary: `ocli 已按 Agent Framework 预加载自定义 Agent ${agent.name}` });
    }
    const frameworkAgentContextMessage = buildAgentContextMessage(frameworkDependencies.agents || []);
    if (frameworkAgentContextMessage) workingMessages.push({ role: "user", content: frameworkAgentContextMessage });
    injectFrameworkMcpContext({ tools: frameworkDependencies.mcpTools || [], resources: frameworkDependencies.mcpResources || [] }, { turn: -1, preloaded: true });
    for (const error of frameworkDependencies.errors || []) {
      options.onEvent?.({ type: "agent_framework_dependency_error", turn: -1, error, summary: `ocli 加载 Agent Framework 依赖失败：${error.message}` });
    }
  }

  const settingsOutputStyle = preloadedOutputStyles.length ? undefined : await loadOutputStyleFromSettings(root, options);
  if (settingsOutputStyle && !loadedOutputStylePaths.has(settingsOutputStyle.path)) {
    loadedOutputStylePaths.add(settingsOutputStyle.path);
    const styleMetadata = {
      name: settingsOutputStyle.name || "output-style",
      title: settingsOutputStyle.title || "",
      description: settingsOutputStyle.description || "",
      path: settingsOutputStyle.path,
      source: settingsOutputStyle.source || "workspace",
      plugin: settingsOutputStyle.plugin || "",
      settingPath: settingsOutputStyle.settingPath || "",
      settingsOutputStyle: settingsOutputStyle.settingsOutputStyle || "",
    };
    activeOutputStyles.push(styleMetadata);
    workingMessages.push({ role: "user", content: buildOutputStyleContextMessage([settingsOutputStyle]) });
    options.onEvent?.({
      type: "output_style_loaded",
      turn: -1,
      outputStyle: styleMetadata,
      preloaded: true,
      settings: true,
      summary: `ocli 已按项目设置加载输出风格 ${styleMetadata.name}`,
    });
  }

  function applyRoutedCapabilities(routedCapabilities, { turn = -1, phase = "initial" } = {}) {
    if (!routedCapabilities) return;
    const routingDiagnostics = routedCapabilities.diagnostics
      ? {
        ...routedCapabilities.diagnostics,
        phase,
        turn,
        ...(routedCapabilities.diagnostics.snapshot ? { snapshot: { ...routedCapabilities.diagnostics.snapshot, phase, turn } } : {}),
      }
      : undefined;
    capabilityRouting = mergeCapabilityRouting(capabilityRouting, {
      ...routedCapabilities,
      ...(routingDiagnostics ? { diagnostics: [routingDiagnostics] } : {}),
    });
    const adaptive = phase !== "initial";
    for (const tool of routedCapabilities.selected?.mcpTools || []) {
      const key = mcpToolKey(tool);
      if (key) loadedMcpToolKeys.add(key);
    }
    for (const resource of routedCapabilities.selected?.mcpResources || []) {
      const key = mcpResourceKey(resource);
      if (key) loadedMcpResourceKeys.add(key);
    }
    options.onEvent?.({
      type: "capability_routing",
      turn,
      phase,
      selected: routedCapabilities.selected,
      errors: routedCapabilities.errors || [],
      ...(routingDiagnostics ? { diagnostics: routingDiagnostics } : {}),
      summary: adaptive
        ? `ocli 已自适应匹配新上下文：技能 ${routedCapabilities.selected.skills.length}，命令 ${routedCapabilities.selected.commands.length}，记忆 ${routedCapabilities.selected.memories.length}，Agent ${routedCapabilities.selected.agents.length}，Framework ${routedCapabilities.selected.frameworks?.length || 0}，MCP ${routedCapabilities.selected.mcpTools.length + routedCapabilities.selected.mcpResources.length}`
        : `ocli 已自动匹配上下文：技能 ${routedCapabilities.selected.skills.length}，命令 ${routedCapabilities.selected.commands.length}，记忆 ${routedCapabilities.selected.memories.length}，Agent ${routedCapabilities.selected.agents.length}，Framework ${routedCapabilities.selected.frameworks?.length || 0}，MCP ${routedCapabilities.selected.mcpTools.length + routedCapabilities.selected.mcpResources.length}`,
    });

    for (const skill of routedCapabilities.loadedSkills || []) {
      if (loadedSkillPaths.has(skill.path)) continue;
      loadedSkillPaths.add(skill.path);
      const skillMetadata = { name: skill.name, description: skill.description || "", path: skill.path, source: skill.source || "workspace", plugin: skill.plugin || "", root: skill.root || "", routingScore: skill.routingScore || 0 };
      invokedSkills.push(skillMetadata);
      options.onEvent?.({ type: "skill_loaded", turn, skill: skillMetadata, autoRouted: true, adaptiveRouted: adaptive, summary: `ocli 已自动加载技能 ${skill.name}` });
    }
    const routedSkillContextMessage = buildSkillContextMessage(routedCapabilities.loadedSkills || []);
    if (routedSkillContextMessage) workingMessages.push({ role: "user", content: routedSkillContextMessage });

    for (const command of routedCapabilities.loadedCommands || []) {
      if (loadedCommandPaths.has(command.path)) continue;
      loadedCommandPaths.add(command.path);
      const commandMetadata = {
        name: command.name || "command",
        title: command.title || "",
        description: command.description || "",
        path: command.path,
        source: command.source || "workspace",
        plugin: command.plugin || "",
        routingScore: command.routingScore || 0,
      };
      activeCommands.push(commandMetadata);
      options.onEvent?.({ type: "command_loaded", turn, command: commandMetadata, autoRouted: true, adaptiveRouted: adaptive, summary: `ocli 已自动加载命令模板 ${commandMetadata.name}` });
    }
    const routedCommandContextMessage = buildCommandContextMessage(routedCapabilities.loadedCommands || []);
    if (routedCommandContextMessage) workingMessages.push({ role: "user", content: routedCommandContextMessage });

    for (const memory of routedCapabilities.loadedMemories || []) {
      if (loadedMemoryPaths.has(memory.path)) continue;
      loadedMemoryPaths.add(memory.path);
      const memoryMetadata = {
        name: memory.name,
        title: memory.title || "",
        description: memory.description || "",
        path: memory.path,
        scope: memory.scope || "project",
        tags: memory.tags || [],
        routingScore: memory.routingScore || 0,
      };
      activeMemories.push(memoryMetadata);
      options.onEvent?.({ type: "memory_loaded", turn, memory: memoryMetadata, autoRouted: true, adaptiveRouted: adaptive, summary: `ocli 已自动加载项目记忆 ${memoryMetadata.name}` });
    }
    const routedMemoryContextMessage = buildMemoryContextMessage(routedCapabilities.loadedMemories || []);
    if (routedMemoryContextMessage) workingMessages.push({ role: "user", content: routedMemoryContextMessage });
    if (routedCapabilities.autoMemoryResults?.length) {
      const query = routedCapabilities.autoMemoryResults.find((result) => result?.query)?.query || "";
      options.onEvent?.({
        type: "memory_auto_searched",
        turn,
        phase,
        query,
        results: routedCapabilities.autoMemoryResults,
        summary: `ocli 已自动检索项目记忆 ${routedCapabilities.autoMemoryResults.length} 条`,
      });
    }

    for (const agent of routedCapabilities.loadedAgents || []) {
      if (loadedAgentPaths.has(agent.path)) continue;
      loadedAgentPaths.add(agent.path);
      const agentMetadata = {
        name: agent.name,
        description: agent.description || "",
        path: agent.path,
        source: agent.source || "workspace",
        plugin: agent.plugin || "",
        agentType: agent.agentType || "",
        routingScore: agent.routingScore || 0,
        ...(Array.isArray(agent.tools) ? { tools: agent.tools } : {}),
        ...(Array.isArray(agent.disallowedTools) ? { disallowedTools: agent.disallowedTools } : {}),
        ...(Array.isArray(agent.mcpTools) ? { mcpTools: agent.mcpTools } : {}),
        ...(Array.isArray(agent.disallowedMcpTools) ? { disallowedMcpTools: agent.disallowedMcpTools } : {}),
        ...(Array.isArray(agent.skills) ? { skills: agent.skills } : {}),
        ...(Array.isArray(agent.commands) ? { commands: agent.commands } : {}),
        ...(Array.isArray(agent.memories) ? { memories: agent.memories } : {}),
        ...(Array.isArray(agent.frameworks) ? { frameworks: agent.frameworks } : {}),
      };
      activeAgents.push(agentMetadata);
      options.onEvent?.({ type: "agent_loaded", turn, agent: agentMetadata, autoRouted: true, adaptiveRouted: adaptive, summary: `ocli 已自动匹配自定义 Agent ${agent.name}` });
    }
    const routedAgentContextMessage = buildAgentContextMessage(routedCapabilities.loadedAgents || []);
    if (routedAgentContextMessage) workingMessages.push({ role: "user", content: routedAgentContextMessage });

    for (const framework of routedCapabilities.loadedFrameworks || []) {
      if (loadedAgentFrameworkPaths.has(framework.path)) continue;
      loadedAgentFrameworkPaths.add(framework.path);
      const frameworkMetadata = {
        name: framework.name,
        title: framework.title || "",
        description: framework.description || "",
        path: framework.path,
        routingScore: framework.routingScore || 0,
        agents: framework.agents || [],
        skills: framework.skills || [],
        commands: framework.commands || [],
        memories: framework.memories || [],
        mcpServers: framework.mcpServers || [],
        mcpTools: framework.mcpTools || [],
        mcpResources: framework.mcpResources || [],
        agentRoles: framework.agentRoles || [],
        handoffs: framework.handoffs || [],
        verificationGates: framework.verificationGates || [],
      };
      activeAgentFrameworks.push(frameworkMetadata);
      options.onEvent?.({ type: "agent_framework_loaded", turn, framework: frameworkMetadata, autoRouted: true, adaptiveRouted: adaptive, summary: `ocli 已自动加载 Agent Framework ${framework.name}` });
    }
    const routedAgentFrameworkContextMessage = buildAgentFrameworkContextMessage(routedCapabilities.loadedFrameworks || []);
    if (routedAgentFrameworkContextMessage) workingMessages.push({ role: "user", content: routedAgentFrameworkContextMessage });

    const routedMcpContextMessage = buildMcpContextMessage(routedCapabilities.mcpContext);
    if (routedMcpContextMessage) {
      workingMessages.push({ role: "user", content: routedMcpContextMessage });
      options.onEvent?.({
        type: "mcp_context_loaded",
        turn,
        phase,
        tools: routedCapabilities.selected.mcpTools,
        resources: routedCapabilities.selected.mcpResources,
        summary: `ocli 已加载 MCP 能力清单 ${routedCapabilities.selected.mcpTools.length + routedCapabilities.selected.mcpResources.length} 项`,
      });
    }
    const routedMcpResultContextMessage = buildMcpResultContextMessage(routedCapabilities.autoMcpResults || []);
    if (routedMcpResultContextMessage) {
      workingMessages.push({ role: "user", content: routedMcpResultContextMessage });
      for (const result of routedCapabilities.autoMcpResults || []) {
        options.onEvent?.({
          type: "mcp_auto_called",
          turn,
          phase,
          server: result.server,
          tool: result.tool,
          arguments: result.arguments || {},
          resultText: result.resultText || "",
          summary: `ocli 已自动调用 MCP 工具 ${result.server}/${result.tool}`,
        });
      }
    }
  }

  async function routeAndApplyCapabilities(routingMessages, { turn = -1, phase = "initial" } = {}) {
    const routedCapabilities = await routeInitialCapabilities(root, {
      body,
      messages: routingMessages,
      systemPrompt,
      signal: options.signal,
      subAgentDepth,
      settingsCapabilityRouting,
      phase,
      loadedSkillPaths,
      loadedCommandPaths,
      loadedMemoryPaths,
      loadedAgentPaths,
      loadedAgentFrameworkPaths,
      loadedMcpToolKeys,
      loadedMcpResourceKeys,
    });
    applyRoutedCapabilities(routedCapabilities, { turn, phase });
    return routedCapabilities;
  }

  await routeAndApplyCapabilities(messages, { turn: -1, phase: "initial" });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const compaction = compactWorkingMessagesIfNeeded({
      workingMessages,
      systemPrompt,
      body,
      turn,
      toolResults,
      invokedSkills,
      activeCommands,
      activeOutputStyles,
      activeMemories,
      activeAgents,
      activeAgentFrameworks,
      capabilityRouting,
      contextCompactions,
      autoContinuationCount,
      latestTodoState,
      settingsContextCompaction,
    });
    if (compaction) {
      workingMessages = compaction.messages;
      contextCompactions.push({
        turn,
        beforeTokens: compaction.event.beforeTokens,
        afterTokens: compaction.event.afterTokens,
        thresholdTokens: compaction.event.thresholdTokens,
        maxContextTokens: compaction.event.maxContextTokens,
        compactedMessageCount: compaction.event.compactedMessageCount,
        requestedRetainedMessageCount: compaction.event.requestedRetainedMessageCount,
        retainedMessageCount: compaction.event.retainedMessageCount,
        adaptiveRetainedMessageCount: compaction.event.adaptiveRetainedMessageCount === true,
        overThresholdAfterCompaction: compaction.event.overThresholdAfterCompaction === true,
        stateSnapshot: compaction.event.stateSnapshot === true,
        policy: compaction.event.policy,
      });
      options.onEvent?.(compaction.event);
    }

    const { response, retryCount, repairCount, repairs } = await fetchModelResponseWithRetry({
      apiBaseUrl,
      signal: options.signal,
      maxRetries: maxModelRequestRetries,
      onEvent: options.onEvent,
      turn,
      requestBody: {
        model,
        messages: [{ role: "system", content: systemPrompt }, ...workingMessages],
        ...modelRequestProfile.request,
        stream: true,
        tools: listOpenAiTools({
          includeAgentRun: subAgentDepth < 1,
          allowedToolNames: body.allowedToolNames,
          disallowedToolNames: [
            ...(Array.isArray(body.disallowedToolNames) ? body.disallowedToolNames : []),
            ...settingsToolWideDeniedNames,
          ],
        }),
        tool_choice: "auto",
      },
    });
    modelRequestRetryCount += retryCount;
    modelRequestRepairCount += repairCount;
    modelRequestRepairs.push(...repairs);

    options.onEvent?.({ type: "model_turn", turn, summary: `模型第 ${turn + 1} 轮响应中` });
    const completion = await readCompletion(response, (text) => {
      options.onEvent?.({ type: "text", turn, text: stripProjectToolBlocks(text) });
    });
    const assistantText = completion.text;
    finalText = stripProjectToolBlocks(assistantText) || finalText || "工程工具已执行。";
    const calls = [...completion.toolCalls, ...extractProjectToolCalls(assistantText)];
    if (!calls.length) {
      const frameworkBlueprintGap = subAgentDepth < 1
        ? findFrameworkBlueprintGuardGap({ activeAgentFrameworks, toolResults, guardedKeys: frameworkBlueprintGuardedKeys })
        : undefined;
      if (frameworkBlueprintGap && turn + 1 < maxTurns) {
        frameworkBlueprintGuardedKeys.add(frameworkBlueprintGap.key);
        const frameworkBlueprintGuard = publicFrameworkBlueprintGuard(frameworkBlueprintGap);
        const guardIteration = autoContinuationCount + 1;
        frameworkBlueprintGuards.push({ turn, iteration: guardIteration, autoDelegated: true, ...frameworkBlueprintGuard });
        autoContinuationCount += 1;
        stoppedReason = "auto_continued";
        options.onEvent?.({
          type: "auto_continue",
          turn,
          iteration: autoContinuationCount,
          reason: "framework_blueprint_guard",
          frameworkBlueprintGuard,
          autoDelegated: true,
          summary: `ocli Framework blueprint guard 第 ${autoContinuationCount} 次：${frameworkBlueprintGap.framework.name} 缺少 ${frameworkBlueprintGap.missingAgent} agent_run 证据`,
        });
        const guardAgentArgs = buildFrameworkBlueprintGuardAgentRunArgs(frameworkBlueprintGap, assistantText);
        options.onEvent?.({
          type: "tool_start",
          turn,
          tool: "agent_run",
          arguments: guardAgentArgs,
          frameworkBlueprintGuard,
          automatic: true,
          summary: `ocli Framework blueprint guard 自动委派 ${guardAgentArgs.agentName}`,
        });
        let guardResult;
        try {
          assertToolAllowedForRun("agent_run", { ...body, settingsDeniedToolRules, currentToolArguments: guardAgentArgs });
          const { request, record } = await startSubAgent(root, guardAgentArgs, { apiBaseUrl, model, systemPrompt, effort: body.effort || "high" }, options, turn);
          await record.promise;
          if (record.status === "failed") throw new Error(record.error || "sub-agent failed.");
          const data = record.result;
          const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
          guardResult = { name: "agent_run", ok: true, message: `ocli Framework blueprint guard 已自动完成 ${data.description || request.description}`, data, ...(artifacts.length ? { artifacts } : {}) };
        } catch (error) {
          guardResult = {
            name: "agent_run",
            ok: false,
            message: `ocli Framework blueprint guard 自动委派失败：${error instanceof Error ? error.message : "unknown error"}`,
            data: { frameworkBlueprintGuard, arguments: guardAgentArgs },
          };
        }
        toolResults.push(guardResult);
        options.onEvent?.({ type: "tool_result", turn, result: guardResult, frameworkBlueprintGuard, automatic: true });
        workingMessages.push({ role: "assistant", content: assistantText }, { role: "user", content: buildToolResultMessage([guardResult]) });
        continue;
      }
      const incompleteReason = projectResponseIncompleteReason(assistantText);
	      const openTodoState = latestTodoState?.openTodos?.length ? latestTodoState : undefined;
	      const continuationReason = incompleteReason || (openTodoState ? "open_todo_state" : "");
	      if (continuationReason) {
	        if (turn + 1 < maxTurns) {
	          autoContinuationCount += 1;
	          workingMessages.push({ role: "assistant", content: assistantText }, { role: "user", content: buildAgentContinuationPrompt(autoContinuationCount, continuationReason, openTodoState ? formatOpenTodosForContinuation(openTodoState.openTodos) : "") });
	          stoppedReason = "auto_continued";
	          options.onEvent?.({
	            type: "auto_continue",
	            turn,
	            iteration: autoContinuationCount,
	            reason: continuationReason,
	            ...(openTodoState ? { openTodos: openTodoState.openTodos, todoCounts: openTodoState.counts } : {}),
	            summary: `ocli 自动续跑第 ${autoContinuationCount} 次：${continuationReason}`,
	          });
	          continue;
	        }
	        stoppedReason = "max_turns";
	        break;
	      }
	      stoppedReason = "completed";
	      break;
    }

    const turnResults = [];
    for (const call of calls) {
      options.onEvent?.({ type: "tool_start", turn, tool: call.name, arguments: call.arguments || {}, summary: summarizeToolCall(call) });
      try {
        assertToolAllowedForRun(call.name, { ...body, settingsDeniedToolRules, currentToolArguments: call.arguments || {} });
        if (call.name === "agent_run") {
          if (subAgentDepth >= 1) throw new Error("agent_run cannot be called from a nested sub-agent.");
          const { request, record } = await startSubAgent(root, call.arguments || {}, { apiBaseUrl, model, systemPrompt, effort: body.effort || "high" }, options, turn);
          let data;
          if (request.runInBackground) {
            backgroundSubAgents.set(record.id, record);
            data = {
              status: "async_launched",
              subagentId: record.id,
              agentType: record.agentType,
              description: record.description,
              ...(record.agentName ? { agentName: record.agentName } : {}),
              ...(record.customAgent ? { customAgent: record.customAgent } : {}),
              ...(record.effort ? { effort: record.effort } : {}),
              task: record.task,
              isolation: record.isolation,
              ...(record.workspaceMetadata?.isolation === "worktree" ? { worktree: record.workspaceMetadata } : {}),
              startedAt: record.startedAt,
              message: "后台子代理已启动；稍后使用 agent_status 查询结果。",
            };
          } else {
            await record.promise;
            if (record.status === "failed") throw new Error(record.error || "sub-agent failed.");
            data = record.result;
          }
          const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
          const result = { name: call.name, ok: true, message: request.runInBackground ? `ocli 后台子代理已启动 ${data.description}` : `ocli 子代理已完成 ${data.description}`, data, ...(artifacts.length ? { artifacts } : {}) };
          turnResults.push(result);
          options.onEvent?.({ type: "tool_result", turn, result });
          continue;
        }
        if (call.name === "agent_status") {
          await waitForRunningSubAgents(backgroundSubAgents, call.arguments || {});
          const data = readSubAgentStatus(backgroundSubAgents, call.arguments || {});
          const status = typeof data.status === "string" ? data.status : "listed";
          const result = { name: call.name, ok: true, message: `ocli 已查询后台子代理状态 ${status}`, data };
          turnResults.push(result);
          options.onEvent?.({ type: "tool_result", turn, result });
          continue;
        }
        const settingsAskRule = settingsAskToolRules.find((rule) => permissionRuleMatchesTool(rule, call.name, call.arguments || {}));
        const settingsAllowRule = settingsAskRule
          ? undefined
          : settingsAllowedToolRules.find((rule) => permissionRuleMatchesTool(rule, call.name, call.arguments || {}));
        if (settingsDefaultMode?.mode === "plan" && !planModeAllowsTool(call.name)) {
          throw new Error(`Tool ${call.name} is blocked by ${settingsDefaultMode.path} permissions.defaultMode=plan.`);
        }
        const defaultPolicy = (settingsAskRule || settingsAllowRule) ? undefined : getPermissionPolicy(call.name, call.arguments || {});
        const policy = settingsAskRule
          ? {
              requiresApproval: true,
              category: "settings_permission_ask",
              reason: `项目 ${settingsAskRule.sourcePath} permissions.ask 要求确认此工具调用：${settingsAskRule.raw}`,
            }
          : defaultPolicy;
        if (settingsDefaultMode?.mode === "dontAsk" && !settingsAllowRule && (settingsAskRule || policy?.requiresApproval || shouldRequireApproval(call.name, call.arguments || {}))) {
          throw new Error(`Tool ${call.name} requires approval and is denied by ${settingsDefaultMode.path} permissions.defaultMode=dontAsk.`);
        }
        if (settingsAllowRule) {
          options.onEvent?.({
            type: "settings_permission_allowed",
            turn,
            tool: call.name,
            arguments: call.arguments || {},
            rule: { raw: settingsAllowRule.raw, sourcePath: settingsAllowRule.sourcePath, toolName: settingsAllowRule.toolName, ruleContent: settingsAllowRule.ruleContent || "" },
            summary: `项目 ${settingsAllowRule.sourcePath} permissions.allow 已允许 ${call.name}`,
          });
        }
        if (policy?.requiresApproval || (!settingsAskRule && !settingsAllowRule && shouldRequireApproval(call.name, call.arguments || {}))) {
          const approval = await options.requestApproval?.({
            turn,
            tool: call.name,
            arguments: call.arguments || {},
            summary: summarizeToolCall(call),
            risk: getToolMetadata(call.name)?.risk || "unknown",
            category: policy.category,
            reason: policy.reason,
            approvalKey: approvalKeyFor(call, policy),
          });
          if (!approval?.approved) throw new Error(approval?.reason || "用户拒绝了该工具执行请求。");
        }
        const data = await handleTool(root, call.name, call.arguments || {}, { signal: options.signal });
        const path = typeof data?.path === "string" ? data.path : typeof call.arguments?.path === "string" ? call.arguments.path : undefined;
        const message = call.name === "list_files"
          ? "ocli 已列出工作区文件"
          : call.name === "workspace_status"
            ? "ocli 已检查工作区变更"
          : call.name === "worktree_list"
            ? "ocli 已列出 git worktree"
          : call.name === "worktree_diff"
            ? "ocli 已检查 worktree 变更"
          : call.name === "worktree_apply"
            ? "ocli 已应用 worktree 变更"
          : call.name === "worktree_remove"
            ? "ocli 已移除 worktree"
          : call.name === "read_file"
            ? `ocli 已读取 ${path || "文件"}`
            : call.name === "write_file"
              ? `ocli 已写入 ${path || "文件"}`
              : call.name === "edit_file"
                ? `ocli 已编辑 ${path || "文件"}`
                : call.name === "delete_file"
                  ? `ocli 已删除 ${path || "文件"}`
                  : call.name === "fetch_url"
                    ? `ocli 已抓取 ${call.arguments?.url || "URL"}`
                    : call.name === "run_python"
                      ? "ocli 已运行 Python"
                      : call.name === "todo_write"
                        ? "ocli 已更新任务计划"
                      : call.name === "skill_list"
                        ? "ocli 已列出工作区技能"
                    : call.name === "skill_read"
                        ? `ocli 已读取技能 ${path || call.arguments?.name || "文件"}`
                    : call.name === "skill_asset_list"
                        ? `ocli 已列出技能资源 ${path || call.arguments?.name || call.arguments?.skill || ""}`.trim()
                    : call.name === "skill_asset_read"
                        ? `ocli 已读取技能资源 ${path || call.arguments?.assetPath || call.arguments?.file || "文件"}`
                    : call.name === "skill_install"
                        ? `ocli 已安装技能 ${data?.name || call.arguments?.targetName || call.arguments?.name || ""}`.trim()
                    : call.name === "settings_list"
                        ? "ocli 已列出项目设置"
                    : call.name === "settings_read"
                        ? `ocli 已读取项目设置 ${path || call.arguments?.path || call.arguments?.name || "settings.json"}`
                    : call.name === "memory_list"
                        ? "ocli 已列出项目记忆"
                    : call.name === "memory_search"
                        ? "ocli 已检索项目记忆"
                    : call.name === "memory_read"
                        ? `ocli 已读取项目记忆 ${path || call.arguments?.memory || call.arguments?.name || "memory"}`
                    : call.name === "memory_write"
                        ? `ocli 已写入项目记忆 ${path || call.arguments?.name || call.arguments?.title || "memory"}`
                    : call.name === "command_list"
                        ? "ocli 已列出工作区命令"
                    : call.name === "command_read"
                        ? `ocli 已读取工作区命令 ${path || call.arguments?.command || call.arguments?.name || "文件"}`
                    : call.name === "output_style_list"
                        ? "ocli 已列出输出风格"
                    : call.name === "output_style_read"
                        ? `ocli 已读取输出风格 ${path || call.arguments?.outputStyle || call.arguments?.style || call.arguments?.name || "文件"}`
                    : call.name === "plugin_list"
                        ? "ocli 已列出工作区插件"
                    : call.name === "plugin_read"
                        ? `ocli 已读取插件 ${path || call.arguments?.name || call.arguments?.plugin || "manifest"}`
                    : call.name === "plugin_capability_list"
                        ? `ocli 已列出插件能力 ${call.arguments?.plugin || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_capability_read"
                        ? `ocli 已读取插件能力 ${path || call.arguments?.plugin || call.arguments?.name || "manifest"}`
                    : call.name === "plugin_command_list"
                        ? `ocli 已列出插件命令 ${call.arguments?.plugin || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_command_read"
                        ? `ocli 已读取插件命令 ${path || call.arguments?.command || call.arguments?.name || "文件"}`
                    : call.name === "plugin_command_install"
                        ? `ocli 已安装插件命令 ${data?.name || call.arguments?.targetName || call.arguments?.command || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_output_style_list"
                        ? `ocli 已列出插件输出风格 ${call.arguments?.plugin || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_output_style_read"
                        ? `ocli 已读取插件输出风格 ${path || call.arguments?.outputStyle || call.arguments?.style || call.arguments?.name || "文件"}`
                    : call.name === "plugin_output_style_install"
                        ? `ocli 已安装插件输出风格 ${data?.name || call.arguments?.targetName || call.arguments?.outputStyle || call.arguments?.style || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_hook_list"
                        ? `ocli 已列出插件 Hook ${call.arguments?.plugin || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_hook_read"
                        ? `ocli 已读取插件 Hook ${path || call.arguments?.hook || call.arguments?.name || "文件"}`
                    : call.name === "plugin_agent_list"
                        ? `ocli 已列出插件代理 ${call.arguments?.plugin || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_agent_read"
                        ? `ocli 已读取插件代理 ${path || call.arguments?.agent || call.arguments?.name || "文件"}`
                    : call.name === "plugin_agent_install"
                        ? `ocli 已安装插件代理 ${data?.name || call.arguments?.targetName || call.arguments?.agent || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_skill_list"
                        ? `ocli 已列出插件技能 ${call.arguments?.plugin || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_skill_read"
                        ? `ocli 已读取插件技能 ${path || call.arguments?.skill || call.arguments?.name || "文件"}`
                    : call.name === "plugin_skill_install"
                        ? `ocli 已安装插件技能 ${data?.name || call.arguments?.targetName || call.arguments?.skill || call.arguments?.name || ""}`.trim()
                    : call.name === "plugin_asset_list"
                        ? `ocli 已列出插件资源 ${call.arguments?.plugin || call.arguments?.name || call.arguments?.path || ""}`.trim()
                    : call.name === "plugin_asset_read"
                        ? `ocli 已读取插件资源 ${path || call.arguments?.assetPath || call.arguments?.file || "文件"}`
                    : call.name === "plugin_install"
                        ? `ocli 已安装插件 ${data?.name || call.arguments?.targetName || call.arguments?.path || ""}`.trim()
                    : call.name === "plugin_remove"
                        ? `ocli 已移除插件 ${data?.name || call.arguments?.name || call.arguments?.plugin || call.arguments?.path || ""}`.trim()
                    : call.name === "plugin_enable"
                        ? `ocli 已启用插件 ${data?.name || call.arguments?.name || call.arguments?.plugin || call.arguments?.path || ""}`.trim()
                    : call.name === "plugin_disable"
                        ? `ocli 已停用插件 ${data?.name || call.arguments?.name || call.arguments?.plugin || call.arguments?.path || ""}`.trim()
                    : call.name === "agent_write"
                      ? `ocli 已写入自定义 Agent ${path || data?.path || call.arguments?.name || "agent"}`
                    : call.name === "agent_framework_list"
                      ? "ocli 已列出 Agent Framework"
                    : call.name === "agent_framework_read"
                      ? `ocli 已读取 Agent Framework ${path || call.arguments?.name || "framework"}`
                    : call.name === "agent_framework_write"
                      ? `ocli 已写入 Agent Framework ${path || data?.path || call.arguments?.name || "framework"}`
                      : call.name === "agent_run"
                        ? `ocli 子代理已完成 ${call.arguments?.description || call.arguments?.agentType || "任务"}`
                      : `ocli 已运行 ${call.arguments?.command || "命令"}`;
        const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
        const result = { name: call.name, ok: true, message, data, ...(artifacts.length ? { artifacts } : {}) };
        turnResults.push(result);
        options.onEvent?.({ type: "tool_result", turn, result });
      } catch (error) {
        const result = { name: call.name, ok: false, message: error instanceof Error ? error.message : "工具执行失败。" };
        turnResults.push(result);
        options.onEvent?.({ type: "tool_result", turn, result });
      }
    }
    toolResults.push(...turnResults);
    for (const result of turnResults) {
      const todoState = todoStateFromToolResult(result);
      if (!todoState) continue;
      latestTodoState = todoState;
      options.onEvent?.({
        type: "todo_state_updated",
        turn,
        counts: todoState.counts,
        openTodos: todoState.openTodos,
        source: todoState.source,
        summary: todoState.openTodos.length
          ? `ocli 已更新 todo 状态：仍有 ${todoState.openTodos.length} 项未完成`
          : "ocli 已更新 todo 状态：全部完成",
      });
    }
    workingMessages.push({ role: "assistant", content: assistantText }, { role: "user", content: buildToolResultMessage(turnResults) });
    const newlyLoadedSkills = [];
    for (const result of turnResults) {
      const skill = extractLoadedSkill(result);
      if (!skill || loadedSkillPaths.has(skill.path)) continue;
      loadedSkillPaths.add(skill.path);
      const skillMetadata = { name: skill.name, description: skill.description, path: skill.path, source: skill.source || "workspace", plugin: skill.plugin || "", root: skill.root || "" };
      invokedSkills.push(skillMetadata);
      newlyLoadedSkills.push(skill);
      options.onEvent?.({ type: "skill_loaded", turn, skill: skillMetadata, summary: `ocli 已加载技能 ${skill.name}` });
    }
    const skillContextMessage = buildSkillContextMessage(newlyLoadedSkills);
    if (skillContextMessage) workingMessages.push({ role: "user", content: skillContextMessage });
    const newlyLoadedCommands = [];
    for (const result of turnResults) {
      const command = extractLoadedCommand(result);
      if (!command || loadedCommandPaths.has(command.path)) continue;
      loadedCommandPaths.add(command.path);
      const commandMetadata = {
        name: command.name,
        title: command.title || "",
        description: command.description || "",
        path: command.path,
        source: command.source || "workspace",
        plugin: command.plugin || "",
      };
      activeCommands.push(commandMetadata);
      newlyLoadedCommands.push(command);
      options.onEvent?.({ type: "command_loaded", turn, command: commandMetadata, summary: `ocli 已加载命令模板 ${command.name}` });
    }
    const commandContextMessage = buildCommandContextMessage(newlyLoadedCommands);
    if (commandContextMessage) workingMessages.push({ role: "user", content: commandContextMessage });
    const newlyLoadedOutputStyles = [];
    for (const result of turnResults) {
      const outputStyle = extractLoadedOutputStyle(result);
      if (!outputStyle || loadedOutputStylePaths.has(outputStyle.path)) continue;
      loadedOutputStylePaths.add(outputStyle.path);
      const styleMetadata = {
        name: outputStyle.name,
        title: outputStyle.title || "",
        description: outputStyle.description || "",
        path: outputStyle.path,
        source: outputStyle.source || "workspace",
        plugin: outputStyle.plugin || "",
      };
      activeOutputStyles.push(styleMetadata);
      newlyLoadedOutputStyles.push(outputStyle);
      options.onEvent?.({ type: "output_style_loaded", turn, outputStyle: styleMetadata, summary: `ocli 已加载输出风格 ${outputStyle.name}` });
    }
    const outputStyleContextMessage = buildOutputStyleContextMessage(newlyLoadedOutputStyles);
    if (outputStyleContextMessage) workingMessages.push({ role: "user", content: outputStyleContextMessage });
    const newlyLoadedMemories = [];
    for (const result of turnResults) {
      const memory = extractLoadedMemory(result);
      if (!memory || loadedMemoryPaths.has(memory.path)) continue;
      loadedMemoryPaths.add(memory.path);
      const memoryMetadata = {
        name: memory.name,
        title: memory.title || "",
        description: memory.description || "",
        path: memory.path,
        scope: memory.scope || "project",
        tags: memory.tags || [],
      };
      activeMemories.push(memoryMetadata);
      newlyLoadedMemories.push(memory);
      options.onEvent?.({ type: "memory_loaded", turn, memory: memoryMetadata, summary: `ocli 已加载项目记忆 ${memory.name}` });
    }
    const memoryContextMessage = buildMemoryContextMessage(newlyLoadedMemories);
    if (memoryContextMessage) workingMessages.push({ role: "user", content: memoryContextMessage });
    const newlyLoadedAgents = [];
    for (const result of turnResults) {
      const agent = extractLoadedAgent(result);
      if (!agent || loadedAgentPaths.has(agent.path)) continue;
      loadedAgentPaths.add(agent.path);
      const agentMetadata = {
        name: agent.name,
        description: agent.description || "",
        path: agent.path,
        source: agent.source || "workspace",
        plugin: agent.plugin || "",
        agentType: agent.agentType || "",
        ...(Array.isArray(agent.tools) ? { tools: agent.tools } : {}),
        ...(Array.isArray(agent.disallowedTools) ? { disallowedTools: agent.disallowedTools } : {}),
        ...(Array.isArray(agent.skills) ? { skills: agent.skills } : {}),
        ...(Array.isArray(agent.commands) ? { commands: agent.commands } : {}),
        ...(Array.isArray(agent.memories) ? { memories: agent.memories } : {}),
        ...(Array.isArray(agent.frameworks) ? { frameworks: agent.frameworks } : {}),
      };
      activeAgents.push(agentMetadata);
      newlyLoadedAgents.push(agent);
      options.onEvent?.({ type: "agent_loaded", turn, agent: agentMetadata, summary: `ocli 已加载自定义 Agent ${agent.name}` });
    }
    const agentContextMessage = buildAgentContextMessage(newlyLoadedAgents);
    if (agentContextMessage) workingMessages.push({ role: "user", content: agentContextMessage });
    const newlyLoadedAgentFrameworks = [];
    for (const result of turnResults) {
      const framework = extractLoadedAgentFramework(result);
      if (!framework || loadedAgentFrameworkPaths.has(framework.path)) continue;
      loadedAgentFrameworkPaths.add(framework.path);
      const frameworkMetadata = {
        name: framework.name,
        title: framework.title || "",
        description: framework.description || "",
        path: framework.path,
        agents: framework.agents || [],
        skills: framework.skills || [],
        commands: framework.commands || [],
        memories: framework.memories || [],
        mcpServers: framework.mcpServers || [],
        mcpTools: framework.mcpTools || [],
        mcpResources: framework.mcpResources || [],
        agentRoles: framework.agentRoles || [],
        handoffs: framework.handoffs || [],
        verificationGates: framework.verificationGates || [],
      };
      activeAgentFrameworks.push(frameworkMetadata);
      newlyLoadedAgentFrameworks.push(framework);
      options.onEvent?.({ type: "agent_framework_loaded", turn, framework: frameworkMetadata, summary: `ocli 已加载 Agent Framework ${framework.name}` });
    }
    const agentFrameworkContextMessage = buildAgentFrameworkContextMessage(newlyLoadedAgentFrameworks);
    if (agentFrameworkContextMessage) workingMessages.push({ role: "user", content: agentFrameworkContextMessage });
    if (newlyLoadedAgentFrameworks.length) {
      const frameworkDependencies = await loadAgentFrameworkDependencies(root, newlyLoadedAgentFrameworks, options);
      const frameworkSkillContext = buildSkillContextMessage(frameworkDependencies.skills.filter((skill) => !loadedSkillPaths.has(skill.path)));
      for (const skill of frameworkDependencies.skills) {
        if (loadedSkillPaths.has(skill.path)) continue;
        loadedSkillPaths.add(skill.path);
        const skillMetadata = { name: skill.name, description: skill.description || "", path: skill.path, source: skill.source || "workspace", plugin: skill.plugin || "", root: skill.root || "" };
        invokedSkills.push(skillMetadata);
        options.onEvent?.({ type: "skill_loaded", turn, skill: skillMetadata, framework: true, summary: `ocli 已按 Agent Framework 加载技能 ${skill.name}` });
      }
      if (frameworkSkillContext) workingMessages.push({ role: "user", content: frameworkSkillContext });
      const frameworkCommandContext = buildCommandContextMessage(frameworkDependencies.commands.filter((command) => !loadedCommandPaths.has(command.path)));
      for (const command of frameworkDependencies.commands) {
        if (loadedCommandPaths.has(command.path)) continue;
        loadedCommandPaths.add(command.path);
        const commandMetadata = { name: command.name || "command", title: command.title || "", description: command.description || "", path: command.path, source: command.source || "workspace", plugin: command.plugin || "" };
        activeCommands.push(commandMetadata);
        options.onEvent?.({ type: "command_loaded", turn, command: commandMetadata, framework: true, summary: `ocli 已按 Agent Framework 加载命令模板 ${commandMetadata.name}` });
      }
      if (frameworkCommandContext) workingMessages.push({ role: "user", content: frameworkCommandContext });
      const frameworkMemoryContext = buildMemoryContextMessage(frameworkDependencies.memories.filter((memory) => !loadedMemoryPaths.has(memory.path)));
      for (const memory of frameworkDependencies.memories) {
        if (loadedMemoryPaths.has(memory.path)) continue;
        loadedMemoryPaths.add(memory.path);
        const memoryMetadata = { name: memory.name, title: memory.title || "", description: memory.description || "", path: memory.path, scope: memory.scope || "project", tags: memory.tags || [] };
        activeMemories.push(memoryMetadata);
        options.onEvent?.({ type: "memory_loaded", turn, memory: memoryMetadata, framework: true, summary: `ocli 已按 Agent Framework 加载项目记忆 ${memory.name}` });
      }
      if (frameworkMemoryContext) workingMessages.push({ role: "user", content: frameworkMemoryContext });
      const frameworkAgentContext = buildAgentContextMessage(frameworkDependencies.agents.filter((agent) => !loadedAgentPaths.has(agent.path)));
      for (const agent of frameworkDependencies.agents) {
        if (loadedAgentPaths.has(agent.path)) continue;
        loadedAgentPaths.add(agent.path);
        const agentMetadata = { name: agent.name, description: agent.description || "", path: agent.path, source: agent.source || "workspace", plugin: agent.plugin || "", agentType: agent.agentType || "", ...(Array.isArray(agent.tools) ? { tools: agent.tools } : {}), ...(Array.isArray(agent.skills) ? { skills: agent.skills } : {}), ...(Array.isArray(agent.commands) ? { commands: agent.commands } : {}), ...(Array.isArray(agent.memories) ? { memories: agent.memories } : {}), ...(Array.isArray(agent.frameworks) ? { frameworks: agent.frameworks } : {}) };
        activeAgents.push(agentMetadata);
        options.onEvent?.({ type: "agent_loaded", turn, agent: agentMetadata, framework: true, summary: `ocli 已按 Agent Framework 加载自定义 Agent ${agent.name}` });
      }
      if (frameworkAgentContext) workingMessages.push({ role: "user", content: frameworkAgentContext });
      injectFrameworkMcpContext({ tools: frameworkDependencies.mcpTools || [], resources: frameworkDependencies.mcpResources || [] }, { turn });
    }
    const adaptiveRoutingResults = adaptiveCapabilityRoutingResults(turnResults);
    if (body.adaptiveCapabilityRouting !== false && body.disableAdaptiveCapabilityRouting !== true && adaptiveRoutingResults.length) {
      await routeAndApplyCapabilities([
        { role: "assistant", content: assistantText },
        { role: "user", content: buildToolResultMessage(adaptiveRoutingResults) },
      ], { turn, phase: "adaptive" });
    }
    const postToolIncompleteReason = projectResponseIncompleteReason(assistantText);
    const postToolOpenTodoState = latestTodoState?.openTodos?.length ? latestTodoState : undefined;
    const postToolContinuationReason = postToolIncompleteReason || (postToolOpenTodoState ? "open_todo_state" : "");
    if (postToolContinuationReason && turn + 1 < maxTurns) {
      autoContinuationCount += 1;
      workingMessages.push({ role: "user", content: buildAgentContinuationPrompt(autoContinuationCount, postToolContinuationReason, postToolOpenTodoState ? formatOpenTodosForContinuation(postToolOpenTodoState.openTodos) : "") });
      stoppedReason = "auto_continued";
      options.onEvent?.({
        type: "auto_continue",
        turn,
        iteration: autoContinuationCount,
        reason: postToolContinuationReason,
        afterToolResults: true,
        ...(postToolOpenTodoState ? { openTodos: postToolOpenTodoState.openTodos, todoCounts: postToolOpenTodoState.counts } : {}),
        summary: `ocli 工具执行后自动续跑第 ${autoContinuationCount} 次：${postToolContinuationReason}`,
      });
      continue;
    }
    if ((turn + 1) % maxTurnsPerSlice === 0 && turn + 1 < maxTurns) {
      autoContinuationCount += 1;
      workingMessages.push({ role: "user", content: buildAgentContinuationPrompt(autoContinuationCount, "slice_limit") });
      stoppedReason = "auto_continued";
      options.onEvent?.({ type: "auto_continue", turn, iteration: autoContinuationCount, reason: "slice_limit", summary: `ocli 自动续跑第 ${autoContinuationCount} 次：slice_limit` });
      continue;
    }
    stoppedReason = "max_turns";
  }

  const memoryMaintenance = await maintainAgentMemory(root, body, {
    messages,
    finalText: finalText || "工程任务已完成，但没有可显示的回复。",
    toolResults,
    invokedSkills,
    activeCommands,
    activeMemories,
    activeAgents,
    activeAgentFrameworks,
    capabilityRouting,
    settingsMemory,
    latestTodoState,
    contextCompactions,
    autoContinuationCount,
    stoppedReason,
    subAgentDepth,
  }, options);

  return {
    finalText: finalText || "工程任务已完成，但没有可显示的回复。",
    toolResults,
    stoppedReason,
    ...(invokedSkills.length ? { invokedSkills } : {}),
    ...(activeCommands.length ? { activeCommands } : {}),
    ...(activeOutputStyles.length ? { activeOutputStyles } : {}),
    ...(activeMemories.length ? { activeMemories } : {}),
    ...(activeAgents.length ? { activeAgents } : {}),
    ...(activeAgentFrameworks.length ? { activeAgentFrameworks } : {}),
    ...(latestTodoState ? { latestTodos: latestTodoState.todos, openTodos: latestTodoState.openTodos, todoCounts: latestTodoState.counts } : {}),
    ...(memoryMaintenance ? { memoryMaintenance } : {}),
    ...(contextCompactions.length ? { contextCompactions } : {}),
    ...(frameworkBlueprintGuards.length ? { frameworkBlueprintGuards } : {}),
    modelRequestProfile: modelRequestProfileSummary,
    ...(modelRequestRetryCount ? { modelRequestRetryCount } : {}),
    ...(modelRequestRepairCount ? { modelRequestRepairCount, modelRequestRepairs } : {}),
    ...(settingsContextCompaction.sourcePaths.length ? { settingsContextCompaction: publicContextCompactionPolicy(settingsContextCompaction) } : {}),
    ...(settingsCapabilityRouting.sourcePaths.length ? { settingsCapabilityRouting: publicCapabilityRoutingPolicy(settingsCapabilityRouting) } : {}),
    ...(capabilityRouting ? { capabilityRouting: { selected: capabilityRouting.selected, errors: capabilityRouting.errors || [], diagnostics: capabilityRouting.diagnostics || [], autoMemoryResults: capabilityRouting.autoMemoryResults || [], autoMcpResults: capabilityRouting.autoMcpResults || [] } } : {}),
    ...(settingsDeniedToolRules.length || settingsAskToolRules.length || settingsAllowedToolRules.length || settingsDefaultMode?.mode ? {
      settingsPermissions: {
        denyCount: settingsDeniedToolRules.length,
        askCount: settingsAskToolRules.length,
        allowCount: settingsAllowedToolRules.length,
        defaultMode: settingsDefaultMode?.mode || "default",
        defaultModePath: settingsDefaultMode?.path || "",
        deniedTools: [...new Set(settingsDeniedToolRules.map((rule) => rule.toolName))],
        askedTools: [...new Set(settingsAskToolRules.map((rule) => rule.toolName))],
        allowedTools: [...new Set(settingsAllowedToolRules.map((rule) => rule.toolName))],
        toolWideDenied: settingsToolWideDeniedNames,
        toolWideAsk: settingsToolWideAskNames,
        toolWideAllow: settingsToolWideAllowNames,
      },
    } : {}),
  };
}

function summarizeToolCall(call) {
  const args = call.arguments || {};
  const target = typeof args.path === "string" ? args.path : typeof args.url === "string" ? args.url : typeof args.command === "string" ? args.command.slice(0, 80) : "";
  return `${call.name}${target ? ` ${target}` : ""}`;
}
