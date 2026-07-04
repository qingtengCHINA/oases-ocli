import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SESSION_ROOT = ".oases/ocli/sessions";

function sessionDirectory(root, sessionId) {
  if (!/^sess_[a-z0-9_]+$/i.test(String(sessionId || ""))) throw new Error("Invalid session id.");
  return path.join(root, SESSION_ROOT, sessionId);
}

function countPendingApprovals(session) {
  return session?.pendingApprovals instanceof Map
    ? [...session.pendingApprovals.values()].filter((approval) => !approval?.status || approval.status === "pending").length
    : 0;
}

function continuationSummary(session) {
  const result = session?.result && typeof session.result === "object" ? session.result : {};
  const stoppedReason = typeof result.stoppedReason === "string" && result.stoppedReason
    ? result.stoppedReason
    : session?.status === "failed" ? "failed" : "";
  const openTodoCount = Array.isArray(result.openTodos) ? result.openTodos.length : 0;
  return {
    stoppedReason,
    needsContinuation: session?.status === "failed" || (
      session?.status === "completed" && ((stoppedReason && stoppedReason !== "completed") || openTodoCount > 0)
    ),
  };
}

function publicSessionMetadata(session) {
  const pendingApprovalCount = countPendingApprovals(session);
  const continuation = continuationSummary(session);
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
    ...(continuation.stoppedReason ? { stoppedReason: continuation.stoppedReason } : {}),
    needsContinuation: continuation.needsContinuation,
    eventCount: session.events.length,
    result: session.result,
    error: session.error || undefined,
  };
}

export async function createSessionPersistence(root, session) {
  const directory = sessionDirectory(root, session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "request.json"), JSON.stringify(session.request ?? {}, null, 2), "utf8");
  await writeFile(path.join(directory, "events.ndjson"), "", "utf8");
  await writeSessionMetadata(root, session);
}

export async function writeSessionMetadata(root, session) {
  const directory = sessionDirectory(root, session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "metadata.json"), JSON.stringify(publicSessionMetadata(session), null, 2), "utf8");
}

export async function appendSessionEvent(root, session, event) {
  const directory = sessionDirectory(root, session.id);
  await mkdir(directory, { recursive: true });
  await appendFile(path.join(directory, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
  await writeSessionMetadata(root, session);
}

export async function writeSessionResult(root, session) {
  const directory = sessionDirectory(root, session.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ result: session.result, error: session.error || undefined, status: session.status }, null, 2), "utf8");
  await writeSessionMetadata(root, session);
}

export async function listPersistedSessionSummaries(root) {
  const directory = path.join(root, SESSION_ROOT);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        const raw = await readFile(path.join(directory, entry.name, "metadata.json"), "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && typeof parsed.id === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }));
  return summaries.filter(Boolean).sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
}

export async function readPersistedSessionDetail(root, sessionId) {
  const directory = sessionDirectory(root, sessionId);
  const metadata = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8"));
  const eventsRaw = await readFile(path.join(directory, "events.ndjson"), "utf8").catch(() => "");
  const resultRaw = await readFile(path.join(directory, "result.json"), "utf8").catch(() => "");
  const events = eventsRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  const resultEnvelope = resultRaw ? JSON.parse(resultRaw) : {};
  return {
    summary: {
      ...metadata,
      ...(resultEnvelope && typeof resultEnvelope === "object" ? { result: resultEnvelope.result ?? metadata.result, error: resultEnvelope.error ?? metadata.error, status: resultEnvelope.status ?? metadata.status } : {}),
    },
    events,
  };
}

export async function readPersistedSessionRequest(root, sessionId) {
  const directory = sessionDirectory(root, sessionId);
  const raw = await readFile(path.join(directory, "request.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Persisted session request is invalid.");
  return parsed;
}

export { SESSION_ROOT };
