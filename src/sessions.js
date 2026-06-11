import { MAX_SESSION_EVENTS } from "./constants.js";
import { runAgent } from "./agent.js";
import { appendSessionEvent, createSessionPersistence, listPersistedSessionSummaries, readPersistedSessionDetail, writeSessionResult } from "./sessionPersistence.js";

export function createSessionStore(root) {
  const agentSessions = new Map();

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
    return {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
      apiBaseUrl: session.apiBaseUrl,
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

  function extractLatestTodos(toolResults) {
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

  function buildResumePrompt(summary, toolResults, artifacts, todos) {
    const finalText = typeof summary?.result?.finalText === "string" ? summary.result.finalText.trim() : "";
    const stoppedReason = typeof summary?.result?.stoppedReason === "string" ? summary.result.stoppedReason : "";
    const openTodos = todos.filter((todo) => todo?.status !== "done").map((todo) => `- [${todo.status || "todo"}] ${todo.text}`).slice(0, 20);
    const artifactLines = artifacts.map((artifact) => `- ${artifact.path}${artifact.role ? ` (${artifact.role})` : ""}`).slice(0, 30);
    const failedTools = toolResults.filter((result) => result?.ok === false).map((result) => `- ${result.name}: ${result.message || "failed"}`).slice(0, 10);
    return [
      "请从这个 ocli 本地工程会话继续处理，先读取必要文件和 workspace_status，再决定下一步工具调用。",
      stoppedReason ? `上次停止原因：${stoppedReason}` : "",
      finalText ? `上次最终回复：${finalText.slice(0, 1200)}` : "",
      artifactLines.length ? `已生成/修改的关键文件：\n${artifactLines.join("\n")}` : "",
      openTodos.length ? `未完成 todo：\n${openTodos.join("\n")}` : "",
      failedTools.length ? `失败工具调用：\n${failedTools.join("\n")}` : "",
      "如果任务已经完成，请审计并总结；如果未完成，请继续执行到产物落盘，并在最终回复列出关键文件路径。",
    ].filter(Boolean).join("\n\n");
  }

  function enrichSessionDetail(detail) {
    const summary = detail.summary || {};
    const events = Array.isArray(detail.events) ? detail.events : [];
    const toolResults = extractToolResults(summary, events);
    const artifacts = extractArtifacts(toolResults);
    const todos = extractLatestTodos(toolResults);
    return {
      ...detail,
      eventCounts: buildEventCounts(events),
      toolResults,
      artifacts,
      todos,
      approvalSummary: buildApprovalSummary(events),
      resumePrompt: buildResumePrompt(summary, toolResults, artifacts, todos),
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
    return {
      sessionCount: sessions.length,
      activeSessionCount,
      latestSession: sessions[0] || null,
    };
  }

  function getSession(id) {
    return agentSessions.get(id);
  }

  async function getSessionDetail(id) {
    const live = agentSessions.get(id);
    if (live) return enrichSessionDetail({ summary: sessionSummary(live), events: live.events });
    return enrichSessionDetail(await readPersistedSessionDetail(root, id));
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
