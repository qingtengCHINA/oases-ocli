import { createServer } from "node:http";
import path from "node:path";
import { runAgent, validateAgentRequest } from "./agent.js";
import { BRIDGE_NAME, PROJECT_TOOL_NAMES, RUNTIME_SOURCE, VERSION } from "./constants.js";
import { corsHeaders, readBody, sendJson } from "./http.js";
import { createSessionStore, sendSse } from "./sessions.js";
import { startTerminalStatusUi } from "./terminalUi.js";
import { handleTool, listToolCapabilities } from "./tools.js";

export async function serve(args) {
  const workspace = path.resolve(args.workspace);
  const token = args.token || Math.random().toString(36).slice(2, 10);
  const sessions = createSessionStore(workspace);
  const server = createServer(async (request, response) => {
    const headers = corsHeaders(request);
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/health" && request.method === "GET") {
        const sessionHealth = await sessions.healthSummary();
        sendJson(response, 200, { ok: true, name: "ocli", bridgeName: BRIDGE_NAME, runtimeSource: RUNTIME_SOURCE, version: VERSION, workspace, tools: [...PROJECT_TOOL_NAMES], toolCapabilities: listToolCapabilities(), agent: true, agentSessions: true, approvals: true, nativeToolCalls: true, nativeToolSchemas: true, protocolVersion: 2, modelSource: "web", apiSource: "web-proxy", ...sessionHealth }, headers);
        return;
      }
      if (args.token && request.headers["x-oases-token"] !== token && request.headers.authorization !== `Bearer ${token}`) {
        sendJson(response, 401, { ok: false, error: "Invalid ocli token." }, headers);
        return;
      }
      if (url.pathname === "/tools" && request.method === "GET") {
        sendJson(response, 200, { ok: true, data: { tools: listToolCapabilities() } }, headers);
        return;
      }
      const match = url.pathname.match(/^\/tools\/([a-z_]+)$/);
      if (request.method === "POST" && match) {
        const body = await readBody(request);
        const data = await handleTool(workspace, match[1], body);
        sendJson(response, 200, { ok: true, tool: match[1], data }, headers);
        return;
      }
      if (url.pathname === "/agent/run" && request.method === "POST") {
        const body = await readBody(request);
        validateAgentRequest(body);
        const data = await runAgent(workspace, body);
        sendJson(response, 200, { ok: true, data }, headers);
        return;
      }
      if (url.pathname === "/agent/sessions" && request.method === "POST") {
        const body = await readBody(request);
        validateAgentRequest(body);
        const session = await sessions.startAgentSession(body);
        sendJson(response, 202, { ok: true, data: sessions.sessionSummary(session) }, headers);
        return;
      }
      if (url.pathname === "/agent/sessions" && request.method === "GET") {
        sendJson(response, 200, { ok: true, data: { sessions: await sessions.listAgentSessions() } }, headers);
        return;
      }
      const sessionMatch = url.pathname.match(/^\/agent\/sessions\/([^/]+)$/);
      if (sessionMatch && request.method === "GET") {
        const detail = await sessions.getSessionDetail(sessionMatch[1]).catch(() => undefined);
        if (!detail) {
          sendJson(response, 404, { ok: false, error: "Agent session not found." }, headers);
          return;
        }
        sendJson(response, 200, {
          ok: true,
          data: detail.summary,
          events: detail.events,
          eventCounts: detail.eventCounts,
          toolResults: detail.toolResults,
          artifacts: detail.artifacts,
          todos: detail.todos,
          approvalSummary: detail.approvalSummary,
          resumePrompt: detail.resumePrompt,
        }, headers);
        return;
      }
      const eventsMatch = url.pathname.match(/^\/agent\/sessions\/([^/]+)\/events$/);
      if (eventsMatch && request.method === "GET") {
        const session = sessions.getSession(eventsMatch[1]);
        if (!session) {
          sendJson(response, 404, { ok: false, error: "Agent session not found." }, headers);
          return;
        }
        sendSse(response, headers, session, Number(url.searchParams.get("since") || 0));
        return;
      }
      const cancelMatch = url.pathname.match(/^\/agent\/sessions\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        const session = sessions.cancelSession(cancelMatch[1]);
        if (!session) {
          sendJson(response, 404, { ok: false, error: "Agent session not found." }, headers);
          return;
        }
        sendJson(response, 200, { ok: true, data: sessions.sessionSummary(session) }, headers);
        return;
      }
      const approvalMatch = url.pathname.match(/^\/agent\/sessions\/([^/]+)\/approvals\/([^/]+)$/);
      if (approvalMatch && request.method === "POST") {
        const body = await readBody(request);
        const decision = body.decision === "reject" ? "reject" : "approve";
        const result = sessions.resolveApproval(approvalMatch[1], approvalMatch[2], decision);
        if (!result.ok) {
          sendJson(response, result.status, { ok: false, error: result.error }, headers);
          return;
        }
        sendJson(response, 200, { ok: true, data: result.data }, headers);
        return;
      }
      sendJson(response, 404, { ok: false, error: "Not found." }, headers);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "ocli request failed." }, headers);
    }
  });
  server.listen(args.port, "127.0.0.1", () => {
    const terminalUi = startTerminalStatusUi({ port: args.port, workspace, token: args.token ? token : "", version: VERSION, runtimeSource: RUNTIME_SOURCE });
    server.once("close", terminalUi.stop);
  });
  return server;
}
