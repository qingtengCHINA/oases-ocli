import { mkdtemp, rm } from "node:fs/promises";
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

function buildToolResultMessage(results) {
  return `工具执行结果：\n${JSON.stringify(results, null, 2)}`;
}

function buildSkillContextMessage(skills) {
  if (!skills.length) return "";
  return [
    "已加载以下工作区技能。接下来必须把这些技能内容当作当前任务的强约束执行；如果技能和用户要求冲突，以用户要求为准并说明取舍。",
    ...skills.map((skill) => [
      `<skill_context name="${String(skill.name || "skill").replace(/"/g, "&quot;")}" path="${String(skill.path || "").replace(/"/g, "&quot;")}">`,
      String(skill.content || "").slice(0, 60000),
      "</skill_context>",
    ].join("\n")),
  ].join("\n\n");
}

function normalizeLoadedSkillData(data) {
  if (!data || typeof data !== "object") return undefined;
  const path = typeof data.path === "string" ? data.path : "";
  const content = typeof data.content === "string" ? data.content : "";
  if (!path || !content) return undefined;
  const skill = data.skill && typeof data.skill === "object" ? data.skill : {};
  return {
    name: typeof skill.name === "string" && skill.name ? skill.name : typeof skill.id === "string" && skill.id ? skill.id : path.split("/").at(-2) || "skill",
    description: typeof skill.description === "string" ? skill.description : "",
    path,
    content,
  };
}

function extractLoadedSkill(result) {
  if (result?.name !== "skill_read" || result.ok === false || !result.data || typeof result.data !== "object") return undefined;
  return normalizeLoadedSkillData(result.data);
}

async function loadWorkspaceSkills(root, skillNames = [], options = {}) {
  const loaded = [];
  const seen = new Set();
  for (const value of Array.isArray(skillNames) ? skillNames : []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const data = await handleTool(root, "skill_read", { name, maxChars: 60000 }, { signal: options.signal });
    const skill = normalizeLoadedSkillData(data);
    if (skill) loaded.push(skill);
  }
  return loaded;
}

function projectResponseLooksUnfinished(content) {
  const visible = stripProjectToolBlocks(content).trim();
  if (!visible) return false;
  const hasPlanTodo = /"status"\s*:\s*"(?:todo|doing)"|待办|进行中/i.test(content);
  const saysWillContinue = /现在(?:开始|编写|生成|创建)|接下来|下一步|继续(?:处理|编写|生成)|准备(?:写入|创建|生成)|我会(?:先|继续|创建|生成|写入)|will\s+(?:write|create|generate|continue)|next\s+I\s+will/i.test(visible);
  const mentionsFileWork = /写入|创建|生成|保存|文件|代码|数据集|csv|json|python|\.py|\.csv|\.json|\.md|write_file/i.test(visible);
  const hasFinalSignal = /已(?:完成|写入|生成|创建)|完成了|可以下载|文件(?:已经|已)|任务已完成|done|completed/i.test(visible);
  return (hasPlanTodo || saysWillContinue) && mentionsFileWork && !hasFinalSignal;
}

function buildAgentContinuationPrompt(iteration) {
  return [
    `继续执行工程任务（ocli 自动续跑第 ${iteration} 次）。`,
    "上一轮看起来仍在计划或承诺后续动作，或工具执行后任务尚未收尾。",
    "请不要只描述“正在编写”或“接下来会做”；需要网页内容就调用 fetch_url，需要产出代码、数据集或说明文档就调用 write_file，必要时运行 run_python/run_command 验证。",
    "如果任务已经完成，请给出最终答复，并列出本轮生成或修改的关键文件路径。",
  ].join("\n");
}

async function loadCustomAgentDefinition(root, args = {}, options = {}) {
  const agentName = String(args.agentName || args.agent || "").trim();
  if (!agentName) return undefined;
  const data = await handleTool(root, "agent_read", { name: agentName, maxChars: 60000 }, { signal: options.signal });
  const agent = data?.agent && typeof data.agent === "object" ? data.agent : {};
  return {
    name: typeof agent.name === "string" && agent.name ? agent.name : agentName,
    description: typeof agent.description === "string" ? agent.description : "",
    path: typeof data?.path === "string" ? data.path : typeof agent.path === "string" ? agent.path : "",
    agentType: ["general", "explore", "plan", "verify"].includes(agent.agentType) ? agent.agentType : undefined,
    maxTurns: Number.isFinite(Number(agent.maxTurns)) ? Number(agent.maxTurns) : undefined,
    background: agent.background === true,
    isolation: ["workspace", "worktree"].includes(agent.isolation) ? agent.isolation : undefined,
    effort: ["low", "medium", "high", "max"].includes(agent.effort) ? agent.effort : undefined,
    tools: Array.isArray(agent.tools) ? agent.tools : undefined,
    disallowedTools: Array.isArray(agent.disallowedTools) ? agent.disallowedTools : undefined,
    skills: Array.isArray(agent.skills) ? agent.skills : undefined,
    initialPrompt: typeof agent.initialPrompt === "string" && agent.initialPrompt.trim() ? agent.initialPrompt.trim() : undefined,
    prompt: typeof data?.prompt === "string" && data.prompt.trim() ? data.prompt.trim() : typeof data?.content === "string" ? data.content.trim() : "",
  };
}

function hasOwnValue(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
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
    ...(agentName ? { agentName } : {}),
    ...(customAgent ? {
      customAgent: {
        name: customAgent.name,
        description: customAgent.description,
        path: customAgent.path,
        ...(customAgent.agentType ? { agentType: customAgent.agentType } : {}),
        ...(customAgent.maxTurns ? { maxTurns: customAgent.maxTurns } : {}),
        ...(customAgent.background ? { background: customAgent.background } : {}),
        ...(customAgent.isolation ? { isolation: customAgent.isolation } : {}),
        ...(customAgent.effort ? { effort: customAgent.effort } : {}),
        ...(customAgent.tools ? { tools: customAgent.tools } : {}),
        ...(customAgent.disallowedTools ? { disallowedTools: customAgent.disallowedTools } : {}),
        ...(customAgent.skills ? { skills: customAgent.skills } : {}),
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
    preloadedSkills: request.preloadedSkills,
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
  const maxTurns = Math.max(maxTurnsPerSlice, Math.min(128, Number(body.maxTotalTurns) || maxTurnsPerSlice * (maxAutoContinuations + 1)));
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter((item) => item && typeof item === "object" && ["user", "assistant", "system"].includes(item.role) && typeof item.content === "string")
        .map((item) => ({ role: item.role, content: item.content }))
    : [];
  const workingMessages = [...messages];
  const toolResults = [];
  const invokedSkills = [];
  const loadedSkillPaths = new Set();
  const backgroundSubAgents = new Map();
  let finalText = "";
  let stoppedReason = "completed";
  let autoContinuationCount = 0;

  const preloadedSkills = Array.isArray(body.preloadedSkills)
    ? body.preloadedSkills.filter((skill) => skill && typeof skill === "object" && typeof skill.path === "string" && typeof skill.content === "string")
    : [];
  const preloadedSkillContextMessage = buildSkillContextMessage(preloadedSkills);
  if (preloadedSkillContextMessage) workingMessages.push({ role: "user", content: preloadedSkillContextMessage });
  for (const skill of preloadedSkills) {
    if (loadedSkillPaths.has(skill.path)) continue;
    loadedSkillPaths.add(skill.path);
    invokedSkills.push({ name: skill.name, description: skill.description || "", path: skill.path });
    options.onEvent?.({ type: "skill_loaded", turn: -1, skill: { name: skill.name, description: skill.description || "", path: skill.path }, preloaded: true, summary: `ocli 已预加载技能 ${skill.name}` });
  }

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...workingMessages],
        temperature: 0.35,
        effort: body.effort || "high",
        reasoning_effort: body.effort || "high",
        stream: true,
        tools: listOpenAiTools({
          includeAgentRun: subAgentDepth < 1,
          allowedToolNames: body.allowedToolNames,
          disallowedToolNames: body.disallowedToolNames,
        }),
        tool_choice: "auto",
      }),
      signal: options.signal,
    });
    if (!response.ok) throw await buildModelRequestError(response);

    options.onEvent?.({ type: "model_turn", turn, summary: `模型第 ${turn + 1} 轮响应中` });
    const completion = await readCompletion(response, (text) => {
      options.onEvent?.({ type: "text", turn, text: stripProjectToolBlocks(text) });
    });
    const assistantText = completion.text;
    finalText = stripProjectToolBlocks(assistantText) || finalText || "工程工具已执行。";
    const calls = [...completion.toolCalls, ...extractProjectToolCalls(assistantText)];
    if (!calls.length) {
      if (projectResponseLooksUnfinished(assistantText) && turn + 1 < maxTurns) {
        autoContinuationCount += 1;
        workingMessages.push({ role: "assistant", content: assistantText }, { role: "user", content: buildAgentContinuationPrompt(autoContinuationCount) });
        stoppedReason = "auto_continued";
        options.onEvent?.({ type: "auto_continue", turn, iteration: autoContinuationCount, summary: `ocli 自动续跑第 ${autoContinuationCount} 次` });
        continue;
      }
      stoppedReason = "completed";
      break;
    }

    const turnResults = [];
    for (const call of calls) {
      options.onEvent?.({ type: "tool_start", turn, tool: call.name, arguments: call.arguments || {}, summary: summarizeToolCall(call) });
      try {
        assertToolAllowedForRun(call.name, body);
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
          const data = readSubAgentStatus(backgroundSubAgents, call.arguments || {});
          const status = typeof data.status === "string" ? data.status : "listed";
          const result = { name: call.name, ok: true, message: `ocli 已查询后台子代理状态 ${status}`, data };
          turnResults.push(result);
          options.onEvent?.({ type: "tool_result", turn, result });
          continue;
        }
        if (shouldRequireApproval(call.name, call.arguments || {})) {
          const policy = getPermissionPolicy(call.name, call.arguments || {});
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
    workingMessages.push({ role: "assistant", content: assistantText }, { role: "user", content: buildToolResultMessage(turnResults) });
    const newlyLoadedSkills = [];
    for (const result of turnResults) {
      const skill = extractLoadedSkill(result);
      if (!skill || loadedSkillPaths.has(skill.path)) continue;
      loadedSkillPaths.add(skill.path);
      invokedSkills.push({ name: skill.name, description: skill.description, path: skill.path });
      newlyLoadedSkills.push(skill);
      options.onEvent?.({ type: "skill_loaded", turn, skill: { name: skill.name, description: skill.description, path: skill.path }, summary: `ocli 已加载技能 ${skill.name}` });
    }
    const skillContextMessage = buildSkillContextMessage(newlyLoadedSkills);
    if (skillContextMessage) workingMessages.push({ role: "user", content: skillContextMessage });
    if ((turn + 1) % maxTurnsPerSlice === 0 && turn + 1 < maxTurns) {
      autoContinuationCount += 1;
      workingMessages.push({ role: "user", content: buildAgentContinuationPrompt(autoContinuationCount) });
      stoppedReason = "auto_continued";
      options.onEvent?.({ type: "auto_continue", turn, iteration: autoContinuationCount, summary: `ocli 自动续跑第 ${autoContinuationCount} 次` });
      continue;
    }
    stoppedReason = "max_turns";
  }

  return { finalText: finalText || "工程任务已完成，但没有可显示的回复。", toolResults, stoppedReason, ...(invokedSkills.length ? { invokedSkills } : {}) };
}

function summarizeToolCall(call) {
  const args = call.arguments || {};
  const target = typeof args.path === "string" ? args.path : typeof args.url === "string" ? args.url : typeof args.command === "string" ? args.command.slice(0, 80) : "";
  return `${call.name}${target ? ` ${target}` : ""}`;
}
