import { MAX_SESSION_EVENTS } from "./constants.js";
import { runAgent } from "./agent.js";
import { appendSessionEvent, createSessionPersistence, listPersistedSessionSummaries, readPersistedSessionDetail, readPersistedSessionRequest, writeSessionResult } from "./sessionPersistence.js";

export function createSessionStore(root) {
  const agentSessions = new Map();

  function sessionStateError(message, status = 409) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function createApprovalRequest(session, request) {
    const approvalId = `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const approval = {
      id: approvalId,
      status: "pending",
      createdAt: Date.now(),
      request,
      resolve: settle,
      promise,
    };
    session.pendingApprovals.set(approvalId, approval);
    createSessionEvent(session, {
      type: "approval_required",
      approvalId,
      status: "pending",
      turn: request.turn,
      tool: request.tool,
      arguments: request.arguments || {},
      summary: request.summary,
      risk: request.risk,
      category: request.category,
      reason: request.reason,
      approvalKey: request.approvalKey,
    });
    return approval;
  }

  function createSessionEvent(session, event) {
    const next = { id: `${session.id}:${session.nextEventId++}`, timestamp: Date.now(), ...event };
    session.events.push(next);
    if (session.events.length > MAX_SESSION_EVENTS) session.events.splice(0, session.events.length - MAX_SESSION_EVENTS);
    session.persistenceQueue = session.persistenceQueue
      .then(() => appendSessionEvent(root, session, next))
      .catch(() => undefined);
    for (const subscriber of session.subscribers) subscriber(next);
    return next;
  }

  function persistSessionResult(session) {
    session.persistenceQueue = session.persistenceQueue
      .then(() => writeSessionResult(root, session))
      .catch(() => undefined);
  }

  async function startAgentSession(body) {
    const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    const session = {
      id,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: String(body.model || ""),
      apiBaseUrl: String(body.apiBaseUrl || ""),
      resumedFromSessionId: typeof body.resumedFromSessionId === "string" ? body.resumedFromSessionId : "",
      request: body,
      nextEventId: 1,
      events: [],
      subscribers: new Set(),
      pendingApprovals: new Map(),
      approvedApprovalKeys: new Set(),
      controller,
      result: null,
      error: "",
      persistenceQueue: Promise.resolve(),
    };
    agentSessions.set(id, session);
    await createSessionPersistence(root, session);
    createSessionEvent(session, { type: "started", summary: "ocli 本地 agent 已启动" });
    if (session.resumedFromSessionId) {
      createSessionEvent(session, {
        type: "session_resumed",
        resumedFromSessionId: session.resumedFromSessionId,
        summary: `ocli 已从会话 ${session.resumedFromSessionId} 续跑`,
      });
    }
    void runAgent(root, body, {
      signal: controller.signal,
      onEvent: (event) => {
        session.updatedAt = Date.now();
        createSessionEvent(session, event);
      },
      requestApproval: async (request) => {
        if (request.approvalKey && session.approvedApprovalKeys.has(request.approvalKey)) {
          createSessionEvent(session, {
            type: "approval_reused",
            turn: request.turn,
            tool: request.tool,
            arguments: request.arguments || {},
            summary: request.summary,
            risk: request.risk,
            category: request.category,
            reason: "当前会话已允许相同工具调用。",
            approvalKey: request.approvalKey,
          });
          return { approved: true, reason: "当前会话已允许相同工具调用。" };
        }
        const approval = createApprovalRequest(session, request);
        return approval.promise;
      },
    })
      .then((result) => {
        session.status = controller.signal.aborted ? "cancelled" : "completed";
        session.updatedAt = Date.now();
        session.result = result;
        createSessionEvent(session, { type: "done", status: session.status, result });
        persistSessionResult(session);
      })
      .catch((error) => {
        session.status = controller.signal.aborted ? "cancelled" : "failed";
        session.updatedAt = Date.now();
        session.error = error instanceof Error ? error.message : "ocli agent failed.";
        createSessionEvent(session, { type: session.status === "cancelled" ? "cancelled" : "error", error: session.error });
        persistSessionResult(session);
      });
    return session;
  }

  function sessionSummary(session) {
    const pendingApprovalCount = session.pendingApprovals instanceof Map
      ? [...session.pendingApprovals.values()].filter((approval) => !approval?.status || approval.status === "pending").length
      : typeof session.pendingApprovalCount === "number" ? session.pendingApprovalCount : 0;
    const result = session.result && typeof session.result === "object" ? session.result : {};
    const stoppedReason = typeof result.stoppedReason === "string" && result.stoppedReason
      ? result.stoppedReason
      : session.status === "failed" ? "failed" : "";
    const openTodoCount = Array.isArray(result.openTodos) ? result.openTodos.length : 0;
    const needsContinuation = pendingApprovalCount === 0 && (
      session.status === "failed" || (
        session.status === "completed" && ((stoppedReason && stoppedReason !== "completed") || openTodoCount > 0)
      )
    );
    return {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
      apiBaseUrl: session.apiBaseUrl,
      resumedFromSessionId: session.resumedFromSessionId || undefined,
      pendingApprovalCount,
      waitingForApproval: pendingApprovalCount > 0,
      ...(stoppedReason ? { stoppedReason } : {}),
      needsContinuation,
      result: session.result,
      error: session.error || undefined,
    };
  }

  function buildEventCounts(events) {
    return events.reduce((counts, event) => {
      const type = typeof event?.type === "string" ? event.type : "unknown";
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {});
  }

  function extractToolResults(summary, events) {
    const fromResult = Array.isArray(summary?.result?.toolResults) ? summary.result.toolResults : [];
    const fromEvents = events
      .filter((event) => event?.type === "tool_result" && event.result)
      .map((event) => event.result);
    return [...fromEvents, ...fromResult]
      .filter((result, index, all) => result && typeof result === "object" && all.findIndex((item) => item?.name === result.name && item?.message === result.message) === index)
      .map((result) => ({
        name: typeof result.name === "string" ? result.name : "tool",
        ok: result.ok !== false,
        message: typeof result.message === "string" ? result.message : "",
        ...(result.data && typeof result.data === "object" ? { data: result.data } : {}),
        ...(Array.isArray(result.artifacts) ? { artifacts: result.artifacts } : {}),
      }));
  }

  function extractArtifacts(toolResults) {
    const artifacts = [];
    for (const result of toolResults) {
      const resultArtifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
      for (const artifact of resultArtifacts) {
        if (!artifact || typeof artifact !== "object" || typeof artifact.path !== "string") continue;
        const item = {
          type: typeof artifact.type === "string" ? artifact.type : "file",
          role: typeof artifact.role === "string" ? artifact.role : "output",
          path: artifact.path,
          ...(typeof artifact.bytes === "number" ? { bytes: artifact.bytes } : {}),
          ...(typeof artifact.extension === "string" ? { extension: artifact.extension } : {}),
          tool: typeof result.name === "string" ? result.name : "tool",
        };
        if (!artifacts.some((existing) => existing.path === item.path && existing.role === item.role)) artifacts.push(item);
      }
    }
    return artifacts;
  }

  function compactSessionText(value, maxChars = 700) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.floor(maxChars * 0.7)).trim()} ... ${text.slice(-Math.floor(maxChars * 0.2)).trim()}`;
  }

  function compactSubAgentToolEvidence(toolResults = []) {
    return (Array.isArray(toolResults) ? toolResults : [])
      .slice(-10)
      .map((tool) => ({
        name: typeof tool?.name === "string" ? tool.name : "tool",
        status: tool?.ok === false ? "failed" : "ok",
        ...(typeof tool?.message === "string" && tool.message ? { message: compactSessionText(tool.message, 220) } : {}),
        ...(typeof tool?.data?.path === "string" ? { path: tool.data.path } : {}),
      }));
  }

  function extractSubAgents(toolResults) {
    const byKey = new Map();
    const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
    const addRecord = (value, fallback = {}) => {
      if (!isObject(value)) return;
      const result = isObject(value.result) ? value.result : value;
      const customAgent = isObject(result.customAgent) ? result.customAgent : isObject(value.customAgent) ? value.customAgent : undefined;
      const worktree = isObject(result.worktree) ? result.worktree : isObject(value.worktree) ? value.worktree : undefined;
      const workspaceStatus = isObject(result.workspaceStatus) ? result.workspaceStatus : isObject(value.workspaceStatus) ? value.workspaceStatus : undefined;
      const id = value.id || value.subagentId || result.id || fallback.id || "";
      const agentName = result.agentName || value.agentName || customAgent?.name || fallback.agentName || "";
      const description = result.description || value.description || fallback.description || "";
      const fallbackKey = [agentName, description, String(result.finalText || value.finalText || fallback.finalText || "").slice(0, 80)].filter(Boolean).join(":");
      const key = id || fallbackKey || `subagent-${byKey.size + 1}`;
      const current = byKey.get(key) || {};
      const next = {
        ...current,
        ...(id ? { id } : {}),
        status: result.status || value.status || fallback.status || current.status || "unknown",
        ...(agentName ? { agentName } : {}),
        ...(customAgent?.path ? { customAgentPath: customAgent.path } : {}),
        ...(result.agentType || value.agentType || fallback.agentType ? { agentType: result.agentType || value.agentType || fallback.agentType } : {}),
        ...(description ? { description } : {}),
        ...(result.task || value.task || fallback.task ? { task: compactSessionText(result.task || value.task || fallback.task, 420) } : {}),
        ...(result.isolation || value.isolation || fallback.isolation ? { isolation: result.isolation || value.isolation || fallback.isolation } : {}),
        ...(worktree?.worktreePath ? { worktreePath: worktree.worktreePath } : {}),
        ...(result.stoppedReason || value.stoppedReason ? { stoppedReason: result.stoppedReason || value.stoppedReason } : {}),
        ...(result.finalText || value.finalText || fallback.finalText ? { finalText: compactSessionText(result.finalText || value.finalText || fallback.finalText, 900) } : {}),
        ...(workspaceStatus?.summary ? { workspaceSummary: compactSessionText(workspaceStatus.summary, 420) } : {}),
        toolResults: compactSubAgentToolEvidence(result.toolResults || value.toolResults || current.toolResults || []),
        artifacts: [
          ...(Array.isArray(current.artifacts) ? current.artifacts : []),
          ...(Array.isArray(result.artifacts) ? result.artifacts : []),
          ...(Array.isArray(value.artifacts) ? value.artifacts : []),
          ...(Array.isArray(fallback.artifacts) ? fallback.artifacts : []),
        ]
          .map((artifact) => typeof artifact === "string" ? artifact : artifact?.path)
          .filter(Boolean)
          .slice(0, 20),
      };
      byKey.set(key, next);
    };
    for (const result of toolResults) {
      if (result?.name === "agent_run") {
        if (result.ok === false) addRecord({ status: "failed", finalText: result.message || "" }, { ok: false });
        else addRecord(result.data, { artifacts: result.artifacts });
      }
      if (result?.name === "agent_status") {
        const data = result.data;
        const records = Array.isArray(data?.subagents) ? data.subagents : [data].filter(Boolean);
        records.forEach((record) => addRecord(record));
      }
    }
    return [...byKey.values()].slice(0, 12);
  }

  function extractLatestTodos(summary, toolResults) {
    const result = summary?.result && typeof summary.result === "object" ? summary.result : {};
    if (Array.isArray(result.latestTodos)) return result.latestTodos;
    if (Array.isArray(result.openTodos)) return result.openTodos;
    const todoResult = [...toolResults].reverse().find((result) => result?.name === "todo_write" && Array.isArray(result?.data?.todos));
    return Array.isArray(todoResult?.data?.todos) ? todoResult.data.todos : [];
  }

  function buildApprovalSummary(events) {
    return events.reduce((summary, event) => {
      if (event?.type === "approval_required") summary.required += 1;
      if (event?.type === "approval_resolved" && event.approved === true) summary.approved += 1;
      if (event?.type === "approval_resolved" && event.approved === false) summary.rejected += 1;
      if (event?.type === "approval_reused") summary.reused += 1;
      return summary;
    }, { required: 0, approved: 0, rejected: 0, reused: 0 });
  }

  function pendingApprovalFromEvent(event, actionable = false) {
    if (!event || typeof event !== "object" || typeof event.approvalId !== "string") return undefined;
    return {
      approvalId: event.approvalId,
      status: typeof event.status === "string" ? event.status : "pending",
      actionable,
      source: actionable ? "live" : "events",
      ...(typeof event.timestamp === "number" ? { createdAt: event.timestamp } : {}),
      ...(typeof event.turn === "number" ? { turn: event.turn } : {}),
      ...(typeof event.tool === "string" ? { tool: event.tool } : {}),
      ...(event.arguments && typeof event.arguments === "object" ? { arguments: event.arguments } : {}),
      ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
      ...(typeof event.risk === "string" ? { risk: event.risk } : {}),
      ...(typeof event.category === "string" ? { category: event.category } : {}),
      ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
      ...(typeof event.approvalKey === "string" ? { approvalKey: event.approvalKey } : {}),
    };
  }

  function pendingApprovalFromLiveRecord(approval) {
    const request = approval?.request && typeof approval.request === "object" ? approval.request : {};
    return {
      approvalId: approval.id,
      status: approval.status || "pending",
      actionable: true,
      source: "live",
      ...(typeof approval.createdAt === "number" ? { createdAt: approval.createdAt } : {}),
      ...(typeof request.turn === "number" ? { turn: request.turn } : {}),
      ...(typeof request.tool === "string" ? { tool: request.tool } : {}),
      ...(request.arguments && typeof request.arguments === "object" ? { arguments: request.arguments } : {}),
      ...(typeof request.summary === "string" ? { summary: request.summary } : {}),
      ...(typeof request.risk === "string" ? { risk: request.risk } : {}),
      ...(typeof request.category === "string" ? { category: request.category } : {}),
      ...(typeof request.reason === "string" ? { reason: request.reason } : {}),
      ...(typeof request.approvalKey === "string" ? { approvalKey: request.approvalKey } : {}),
    };
  }

  function buildPendingApprovals(events, session) {
    const pending = new Map();
    for (const event of events) {
      if (!event?.approvalId) continue;
      if (event.type === "approval_resolved" || event.status === "approved" || event.status === "rejected") {
        pending.delete(event.approvalId);
        continue;
      }
      if (event.type === "approval_required") {
        const approval = pendingApprovalFromEvent(event, false);
        if (approval) pending.set(event.approvalId, approval);
      }
    }
    if (session?.pendingApprovals instanceof Map) {
      for (const approval of session.pendingApprovals.values()) {
        if (approval?.status && approval.status !== "pending") continue;
        pending.set(approval.id, pendingApprovalFromLiveRecord(approval));
      }
    }
    return [...pending.values()].slice(-20);
  }

  function buildResumePrompt(summary, toolResults, artifacts, todos) {
    const finalText = typeof summary?.result?.finalText === "string" ? summary.result.finalText.trim() : "";
    const sourceStatus = typeof summary?.status === "string" ? summary.status : "";
    const sourceError = typeof summary?.error === "string" ? summary.error.trim() : "";
    const stoppedReason = typeof summary?.result?.stoppedReason === "string" && summary.result.stoppedReason
      ? summary.result.stoppedReason
      : sourceStatus === "failed" ? "failed" : "";
    const openTodos = todos.filter((todo) => todo?.status !== "done").map((todo) => `- [${todo.status || "todo"}] ${todo.text}`).slice(0, 20);
    const artifactLines = artifacts.map((artifact) => `- ${artifact.path}${artifact.role ? ` (${artifact.role})` : ""}`).slice(0, 30);
    const subAgentLines = extractSubAgents(toolResults).map((agent) => `- ${agent.agentName || agent.description || agent.id || "sub-agent"} [${agent.status}]${agent.finalText ? `: ${agent.finalText}` : ""}`).slice(0, 12);
    const failedTools = toolResults.filter((result) => result?.ok === false).map((result) => `- ${result.name}: ${result.message || "failed"}`).slice(0, 10);
    return [
      "请从这个 ocli 本地工程会话继续处理，先读取必要文件和 workspace_status，再决定下一步工具调用。",
      stoppedReason ? `上次停止原因：${stoppedReason}` : "",
      sourceError ? `上次错误：${sourceError.slice(0, 1200)}` : "",
      finalText ? `上次最终回复：${finalText.slice(0, 1200)}` : "",
      artifactLines.length ? `已生成/修改的关键文件：\n${artifactLines.join("\n")}` : "",
      subAgentLines.length ? `子代理结论：\n${subAgentLines.join("\n")}` : "",
      openTodos.length ? `未完成 todo：\n${openTodos.join("\n")}` : "",
      failedTools.length ? `失败工具调用：\n${failedTools.join("\n")}` : "",
      "如果任务已经完成，请审计并总结；如果未完成，请继续执行到产物落盘，并在最终回复列出关键文件路径。",
    ].filter(Boolean).join("\n\n");
  }

  function compactResumeCapability(item) {
    if (!item || typeof item !== "object") return undefined;
    return {
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(typeof item.description === "string" ? { description: item.description.slice(0, 280) } : {}),
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      ...(typeof item.scope === "string" ? { scope: item.scope } : {}),
      ...(typeof item.source === "string" ? { source: item.source } : {}),
      ...(typeof item.plugin === "string" ? { plugin: item.plugin } : {}),
      ...(typeof item.routingScore === "number" ? { routingScore: item.routingScore } : {}),
      ...(Array.isArray(item.agents) ? { agents: item.agents.slice(0, 12) } : {}),
      ...(Array.isArray(item.skills) ? { skills: item.skills.slice(0, 12) } : {}),
      ...(Array.isArray(item.commands) ? { commands: item.commands.slice(0, 12) } : {}),
      ...(Array.isArray(item.memories) ? { memories: item.memories.slice(0, 12) } : {}),
      ...(Array.isArray(item.mcpServers) ? { mcpServers: item.mcpServers.slice(0, 12) } : {}),
      ...(Array.isArray(item.mcpTools) ? { mcpTools: item.mcpTools.slice(0, 12) } : {}),
      ...(Array.isArray(item.mcpResources) ? { mcpResources: item.mcpResources.slice(0, 12) } : {}),
      ...(Array.isArray(item.agentRoles) ? { agentRoles: item.agentRoles.slice(0, 12) } : {}),
      ...(Array.isArray(item.handoffs) ? { handoffs: item.handoffs.slice(0, 12) } : {}),
      ...(Array.isArray(item.verificationGates) ? { verificationGates: item.verificationGates.slice(0, 12) } : {}),
    };
  }

  function compactResumeList(value, limit = 12) {
    return Array.isArray(value) ? value.map(compactResumeCapability).filter(Boolean).slice(0, limit) : [];
  }

  function compactTaggedJsonValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      if (value.length <= (depth >= 2 ? 500 : 1200)) return value;
      const head = value.slice(0, depth >= 2 ? 340 : 780).trim();
      const tail = value.slice(-(depth >= 2 ? 120 : 260)).trim();
      return `${head} ... ${tail}`;
    }
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const limit = depth <= 1 ? 12 : depth === 2 ? 8 : 5;
      return value.slice(0, limit).map((item) => compactTaggedJsonValue(item, depth + 1));
    }
    if (depth >= 5) return "[compact object]";
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactTaggedJsonValue(item, depth + 1)]));
  }

  function stringifyTaggedJson(value, maxChars = 12000) {
    const direct = JSON.stringify(value, null, 2);
    if (direct.length <= maxChars) return direct;
    const compact = JSON.stringify(compactTaggedJsonValue(value), null, 2);
    if (compact.length <= maxChars) return compact;
    return JSON.stringify({
      truncated: true,
      note: "Resume payload was compacted to preserve valid JSON.",
      sourceSessionId: value?.sourceSessionId || "",
      stoppedReason: value?.stoppedReason || "",
      sourceError: typeof value?.sourceError === "string" ? value.sourceError.slice(0, 1000) : "",
      finalText: typeof value?.finalText === "string" ? value.finalText.slice(0, 1000) : "",
      activeCapabilities: value?.activeCapabilities || {},
      memoryMaintenance: value?.memoryMaintenance || undefined,
      autoMemoryResults: Array.isArray(value?.autoMemoryResults) ? value.autoMemoryResults.slice(0, 5) : [],
      autoMcpResults: Array.isArray(value?.autoMcpResults) ? value.autoMcpResults.slice(0, 5) : [],
      routingDiagnostics: Array.isArray(value?.routingDiagnostics) ? value.routingDiagnostics.slice(-3) : [],
      contextCompactions: Array.isArray(value?.contextCompactions) ? value.contextCompactions.slice(-3) : [],
    }, null, 2);
  }

  function compactSessionMemoryMaintenance(value) {
    if (!value || typeof value !== "object") return undefined;
    const suggestion = value.suggestion && typeof value.suggestion === "object" ? value.suggestion : undefined;
    const written = value.written && typeof value.written === "object" ? value.written : undefined;
    const writtenPath = typeof written?.path === "string" ? written.path : "";
    const evidence = suggestion?.evidence && typeof suggestion.evidence === "object" ? suggestion.evidence : undefined;
    if (!suggestion && !writtenPath && typeof value.error !== "string") return undefined;
    return {
      autoWrite: value.autoWrite === true,
      ...(suggestion ? {
        suggestion: {
          ...(typeof suggestion.name === "string" ? { name: suggestion.name } : {}),
          ...(typeof suggestion.title === "string" ? { title: suggestion.title } : {}),
          ...(typeof suggestion.scope === "string" ? { scope: suggestion.scope } : {}),
          ...(Array.isArray(suggestion.tags) ? { tags: suggestion.tags.slice(0, 12) } : {}),
          ...(Array.isArray(suggestion.links) ? { links: suggestion.links.slice(0, 12) } : {}),
          ...(evidence ? { evidence: compactTaggedJsonValue(evidence, 1) } : {}),
        },
      } : {}),
      ...(writtenPath ? { writtenPath } : {}),
      ...(typeof value.error === "string" && value.error ? { error: value.error.slice(0, 300) } : {}),
    };
  }

  function buildSessionResumeContext(summary, toolResults, artifacts, todos) {
    const result = summary?.result && typeof summary.result === "object" ? summary.result : {};
    const capabilityRouting = result.capabilityRouting && typeof result.capabilityRouting === "object" ? result.capabilityRouting : {};
    const selected = capabilityRouting.selected && typeof capabilityRouting.selected === "object" ? capabilityRouting.selected : {};
    const sourceStatus = typeof summary?.status === "string" ? summary.status : "";
    const stoppedReason = typeof result.stoppedReason === "string" && result.stoppedReason
      ? result.stoppedReason
      : sourceStatus === "failed" ? "failed" : "";
    const payload = {
      sourceSessionId: summary?.id || "",
      sourceStatus,
      stoppedReason,
      sourceError: typeof summary?.error === "string" ? summary.error.slice(0, 1200) : "",
      finalText: typeof result.finalText === "string" ? result.finalText.slice(0, 1200) : "",
      activeCapabilities: {
        skills: compactResumeList(result.invokedSkills),
        commands: compactResumeList(result.activeCommands),
        outputStyles: compactResumeList(result.activeOutputStyles),
        memories: compactResumeList(result.activeMemories),
        agents: compactResumeList(result.activeAgents),
        frameworks: compactResumeList(result.activeAgentFrameworks),
        mcpTools: compactResumeList(selected.mcpTools),
        mcpResources: compactResumeList(selected.mcpResources),
      },
      autoMemoryResults: Array.isArray(capabilityRouting.autoMemoryResults)
        ? capabilityRouting.autoMemoryResults.map((item) => ({
          ...(typeof item?.name === "string" ? { name: item.name } : {}),
          ...(typeof item?.title === "string" ? { title: item.title } : {}),
          ...(typeof item?.path === "string" ? { path: item.path } : {}),
          ...(typeof item?.scope === "string" ? { scope: item.scope } : {}),
          ...(typeof item?.query === "string" ? { query: item.query } : {}),
          ...(typeof item?.score === "number" ? { score: item.score } : {}),
          ...(typeof item?.snippet === "string" ? { snippet: item.snippet.slice(0, 500) } : {}),
        })).slice(0, 8)
        : [],
      autoMcpResults: Array.isArray(capabilityRouting.autoMcpResults)
        ? capabilityRouting.autoMcpResults.map((item) => ({
          ...(typeof item?.server === "string" ? { server: item.server } : {}),
          ...(typeof item?.tool === "string" ? { tool: item.tool } : {}),
          ...(item?.arguments && typeof item.arguments === "object" ? { arguments: item.arguments } : {}),
          ok: item?.ok !== false,
          ...(typeof item?.resultText === "string" ? { resultText: item.resultText.slice(0, 700) } : {}),
          ...(typeof item?.error === "string" ? { error: item.error.slice(0, 300) } : {}),
        })).slice(0, 8)
        : [],
      routingDiagnostics: Array.isArray(capabilityRouting.diagnostics) ? capabilityRouting.diagnostics.slice(-5) : [],
      contextCompactions: Array.isArray(result.contextCompactions) ? result.contextCompactions.slice(-5) : [],
      frameworkBlueprintGuards: Array.isArray(result.frameworkBlueprintGuards) ? result.frameworkBlueprintGuards.slice(-8) : [],
      memoryMaintenance: compactSessionMemoryMaintenance(result.memoryMaintenance),
      subAgents: extractSubAgents(toolResults),
      todos: Array.isArray(todos) ? todos.slice(0, 30) : [],
      openTodos: Array.isArray(result.openTodos) ? result.openTodos.slice(0, 20) : (Array.isArray(todos) ? todos.filter((todo) => todo?.status !== "done").slice(0, 20) : []),
      todoCounts: result.todoCounts && typeof result.todoCounts === "object" ? result.todoCounts : {},
      artifacts: artifacts.map((artifact) => ({ path: artifact.path, role: artifact.role || "", type: artifact.type || "" })).slice(0, 30),
      failedTools: toolResults.filter((tool) => tool?.ok === false).map((tool) => ({ name: tool.name || "tool", message: tool.message || "" })).slice(0, 12),
    };
    return [
      "已恢复上一个 Ocli 会话的结构化续跑状态。继续时必须保留这些能力、证据、产物和未完成事项；不要把它当作新的用户目标。",
      `<session_resume_context>${stringifyTaggedJson(payload, 12000)}</session_resume_context>`,
    ].join("\n");
  }

  function enrichSessionDetail(detail, liveSession) {
    const summary = detail.summary || {};
    const events = Array.isArray(detail.events) ? detail.events : [];
    const toolResults = extractToolResults(summary, events);
    const artifacts = extractArtifacts(toolResults);
    const todos = extractLatestTodos(summary, toolResults);
    return {
      ...detail,
      eventCounts: buildEventCounts(events),
      toolResults,
      artifacts,
      todos,
      approvalSummary: buildApprovalSummary(events),
      pendingApprovals: buildPendingApprovals(events, liveSession),
      resumePrompt: buildResumePrompt(summary, toolResults, artifacts, todos),
      resumeContext: buildSessionResumeContext(summary, toolResults, artifacts, todos),
    };
  }

  async function listAgentSessions() {
    const liveSessions = [...agentSessions.values()]
      .map(sessionSummary)
      .sort((left, right) => right.createdAt - left.createdAt);
    const liveIds = new Set(liveSessions.map((session) => session.id));
    const persisted = (await listPersistedSessionSummaries(root)).filter((session) => !liveIds.has(session.id));
    return [...liveSessions, ...persisted].sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
  }

  async function healthSummary() {
    const sessions = await listAgentSessions();
    const activeSessionCount = sessions.filter((session) => session.status === "running").length;
    const pendingApprovalCount = sessions.reduce((total, session) => total + (Number(session.pendingApprovalCount) || 0), 0);
    const continuationPendingCount = sessions.reduce((total, session) => total + (session.needsContinuation === true ? 1 : 0), 0);
    return {
      sessionCount: sessions.length,
      activeSessionCount,
      pendingApprovalCount,
      continuationPendingCount,
      latestSession: sessions[0] || null,
    };
  }

  function getSession(id) {
    return agentSessions.get(id);
  }

  async function getSessionDetail(id) {
    const live = agentSessions.get(id);
    if (live) return enrichSessionDetail({ summary: sessionSummary(live), events: live.events }, live);
    return enrichSessionDetail(await readPersistedSessionDetail(root, id));
  }

  async function readOriginalRequest(id) {
    const live = agentSessions.get(id);
    if (live?.request && typeof live.request === "object") return live.request;
    return readPersistedSessionRequest(root, id);
  }

  function stringifyOriginalMessageContent(content) {
    if (typeof content === "string") return content;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content || "");
    }
  }

  function buildOriginalRequestResumeContext(request) {
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const compactMessages = messages
      .filter((message) => message && typeof message === "object")
      .map((message) => ({
        role: typeof message.role === "string" ? message.role : "user",
        content: compactSessionText(stringifyOriginalMessageContent(message.content), 1200),
      }))
      .filter((message) => message.content)
      .slice(-8);
    const systemPrompt = typeof request?.systemPrompt === "string" && request.systemPrompt.trim()
      ? compactSessionText(request.systemPrompt, 800)
      : "";
    if (!compactMessages.length && !systemPrompt) return "";
    return [
      "原始会话请求摘要。续跑时必须保留原始目标，不要只根据上次失败或摘要重定义任务。",
      `<original_session_request>${stringifyTaggedJson({
        ...(systemPrompt ? { systemPrompt } : {}),
        messages: compactMessages,
      }, 8000)}</original_session_request>`,
    ].join("\n");
  }

  function buildResumeRequest(originalRequest, sourceSessionId, resumePrompt, resumeContext, overrides = {}, sourceSummary = {}) {
    const request = originalRequest && typeof originalRequest === "object" ? originalRequest : {};
    const model = typeof overrides.model === "string" && overrides.model.trim()
      ? overrides.model.trim()
      : String(request.model || "").trim();
    const apiBaseUrl = typeof overrides.apiBaseUrl === "string" && overrides.apiBaseUrl.trim()
      ? overrides.apiBaseUrl.trim()
      : String(request.apiBaseUrl || "").trim();
    if (!model) throw new Error("Cannot resume session because the original model is missing.");
    if (!apiBaseUrl) throw new Error("Cannot resume session because the original apiBaseUrl is missing.");
    const includeOriginalRequestContext = sourceSummary?.status === "failed";
    const originalRequestContext = includeOriginalRequestContext ? buildOriginalRequestResumeContext(request) : "";
    return {
      ...request,
      apiBaseUrl,
      model,
      ...(typeof overrides.effort === "string" && overrides.effort.trim() ? { effort: overrides.effort.trim() } : {}),
      messages: [
        ...(originalRequestContext ? [{ role: "user", content: originalRequestContext }] : []),
        ...(resumeContext ? [{ role: "user", content: resumeContext }] : []),
        { role: "user", content: resumePrompt },
      ],
      maxTurns: Math.max(1, Math.min(32, Number(overrides.maxTurns ?? request.maxTurns) || 24)),
      maxAutoContinuations: Math.max(0, Math.min(8, Number(overrides.maxAutoContinuations ?? request.maxAutoContinuations) || 3)),
      resumedFromSessionId: sourceSessionId,
      resumePrompt,
      ...(resumeContext ? { resumeContext } : {}),
      ...(originalRequestContext ? { originalRequestContext } : {}),
    };
  }

  async function resumeAgentSession(id, overrides = {}) {
    const detail = await getSessionDetail(id);
    const pendingApprovals = Array.isArray(detail.pendingApprovals)
      ? detail.pendingApprovals.filter((approval) => !approval?.status || approval.status === "pending")
      : [];
    if (pendingApprovals.length) {
      throw sessionStateError(`Cannot resume session because ${pendingApprovals.length} approval request${pendingApprovals.length === 1 ? "" : "s"} are still pending. Resolve approval blockers before continuing.`);
    }
    const source = agentSessions.get(id);
    if (source?.status === "running") throw sessionStateError("Cannot resume a running session.");
    const resumePrompt = detail.resumePrompt;
    if (!resumePrompt) throw sessionStateError("Session has no resume prompt.");
    const originalRequest = await readOriginalRequest(id);
    return startAgentSession(buildResumeRequest(originalRequest, id, resumePrompt, detail.resumeContext, overrides, detail.summary));
  }

  function cancelSession(id) {
    const session = agentSessions.get(id);
    if (!session) return undefined;
    if (session.status === "running") {
      for (const approval of session.pendingApprovals.values()) {
        approval.status = "rejected";
        approval.resolvedAt = Date.now();
        approval.resolve({ approved: false, reason: "ocli agent 已取消。" });
      }
      session.pendingApprovals.clear();
      session.controller.abort();
      session.status = "cancelled";
      session.updatedAt = Date.now();
      createSessionEvent(session, { type: "cancelled", summary: "ocli 本地 agent 已取消" });
      persistSessionResult(session);
    }
    return session;
  }

  function resolveApproval(sessionId, approvalId, decision) {
    const session = agentSessions.get(sessionId);
    if (!session) return { ok: false, status: 404, error: "Agent session not found." };
    const approval = session.pendingApprovals.get(approvalId);
    if (!approval) return { ok: false, status: 404, error: "Approval request not found." };
    if (approval.status !== "pending") return { ok: false, status: 409, error: "Approval request has already been resolved." };

    const approved = decision === "approve";
    const reason = approved ? "用户已允许执行。" : "用户拒绝了该工具执行请求。";
    approval.status = approved ? "approved" : "rejected";
    approval.resolvedAt = Date.now();
    if (approved && approval.request.approvalKey) session.approvedApprovalKeys.add(approval.request.approvalKey);
    approval.resolve({ approved, reason });
    session.pendingApprovals.delete(approvalId);
    session.updatedAt = Date.now();
    createSessionEvent(session, {
      type: "approval_resolved",
      approvalId,
      status: approval.status,
      approved,
      tool: approval.request.tool,
      summary: approval.request.summary,
      reason,
      approvalKey: approval.request.approvalKey,
    });
    return { ok: true, status: 200, data: { approvalId, status: approval.status, approved } };
  }

  return {
    startAgentSession,
    sessionSummary,
    listAgentSessions,
    healthSummary,
    getSession,
    getSessionDetail,
    resumeAgentSession,
    cancelSession,
    resolveApproval,
  };
}

export function sendSse(response, headers, session, since = 0) {
  response.writeHead(200, {
    ...headers,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
  });
  const writeEvent = (event) => {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  for (const event of session.events) {
    const numericId = Number(String(event.id).split(":").at(-1));
    if (!since || numericId > since) writeEvent(event);
  }
  if (["completed", "failed", "cancelled"].includes(session.status)) {
    response.end();
    return;
  }
  const heartbeat = setInterval(() => response.write(`event: ping\ndata: ${JSON.stringify({ type: "ping", timestamp: Date.now() })}\n\n`), 15000);
  const subscriber = (event) => {
    writeEvent(event);
    if (["done", "error", "cancelled"].includes(event.type)) {
      clearInterval(heartbeat);
      session.subscribers.delete(subscriber);
      response.end();
    }
  };
  session.subscribers.add(subscriber);
  response.on("close", () => {
    clearInterval(heartbeat);
    session.subscribers.delete(subscriber);
  });
}
