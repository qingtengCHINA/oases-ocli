import { spawn } from "node:child_process";
import { MAX_OUTPUT_BYTES } from "./constants.js";

const DESTRUCTIVE_COMMAND_PATTERNS = [
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard may discard local changes." },
  { pattern: /\bgit\s+push\b[^;&|\n]*\s(?:--force|--force-with-lease|-f)\b/i, reason: "git push --force may overwrite remote history." },
  { pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/i, reason: "git clean -f may permanently delete untracked files." },
  { pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.[ \t]*(?:$|[;&|\n])/i, reason: "git checkout/restore . may discard workspace changes." },
  { pattern: /\bgit\s+stash\s+(drop|clear)\b/i, reason: "git stash drop/clear may permanently remove stashed changes." },
  { pattern: /\bgit\s+branch\s+(-D\b|--delete\s+--force\b|--force\s+--delete\b)/i, reason: "git branch force-delete may remove branch refs." },
  { pattern: /\b(?:mkfs|fdisk|parted|diskutil\s+erase|shutdown|reboot|halt|poweroff)\b/i, reason: "system-level disk or power command is not allowed." },
  { pattern: /\bdd\b[^;&|\n]*(?:\bif=|\bof=)/i, reason: "dd with input/output devices can overwrite data." },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*;?\s*\}/, reason: "fork bomb pattern is not allowed." },
  { pattern: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+777\s+(?:\/|~|"\/*"|'\/')/i, reason: "recursive chmod 777 on a system path is not allowed." },
  { pattern: /\bterraform\s+destroy\b/i, reason: "terraform destroy may remove infrastructure." },
  { pattern: /\bkubectl\s+delete\b/i, reason: "kubectl delete may remove cluster resources." },
  { pattern: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i, reason: "SQL drop/truncate may remove database objects." },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*(?:;|$)/i, reason: "SQL delete without a WHERE clause may remove all rows." },
];

export function commandContainsShellControlOperators(command) {
  return /(?:[;&|`\n\r]|\$\(|\$\{|<\(|>\(|=\()/.test(String(command || ""));
}

function tokenizeShellLike(segment) {
  return String(segment || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function unquoteToken(token) {
  return String(token || "").replace(/^(['"])([\s\S]*)\1$/, "$2");
}

function isDangerousRemovalTarget(target) {
  const clean = unquoteToken(target).replace(/[\\/]+$/g, "");
  const forwardSlashed = clean.replace(/[\\/]+/g, "/");
  if (!forwardSlashed || [".", "..", "/", "~", "*", "./*", "../*"].includes(forwardSlashed)) return true;
  if (forwardSlashed.endsWith("/*")) return true;
  if (forwardSlashed.includes("$") || forwardSlashed.includes("%") || forwardSlashed.startsWith("=")) return true;
  if (/^[A-Za-z]:$/.test(forwardSlashed) || /^[A-Za-z]:\/[^/]+$/.test(forwardSlashed)) return true;
  if (/^\/[^/]+$/.test(forwardSlashed)) return true;
  return false;
}

function getDangerousRemovalReason(command) {
  const segments = String(command || "").split(/(?:&&|\|\||;|\n|\|)/g);
  for (const segment of segments) {
    const tokens = tokenizeShellLike(segment).map(unquoteToken);
    const commandIndex = tokens.findIndex((token) => ["rm", "rmdir"].includes(token) || token.endsWith("/rm") || token.endsWith("/rmdir"));
    if (commandIndex === -1) continue;

    const args = tokens.slice(commandIndex + 1).filter((token) => token && token !== "--");
    const flags = args.filter((token) => token.startsWith("-")).join("");
    const targets = args.filter((token) => !token.startsWith("-"));
    const isRecursive = /r|R/.test(flags) || tokens[commandIndex].endsWith("/rmdir");
    const isForced = /f/.test(flags);
    if (targets.some(isDangerousRemovalTarget)) return "removal targets a root, home, wildcard, expansion, or workspace-wide path.";
    if (isRecursive && isForced && targets.some((target) => [".", "./"].includes(unquoteToken(target)))) {
      return "recursive forced removal of the current workspace is not allowed.";
    }
  }
  return "";
}

export function getDangerousCommandReason(command) {
  const removalReason = getDangerousRemovalReason(command);
  if (removalReason) return removalReason;
  for (const { pattern, reason } of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return "";
}

export function commandLooksDangerous(command) {
  return Boolean(getDangerousCommandReason(command));
}

export function runProcess(command, options) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let killed = false;
    const abort = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    const timeout = setTimeout(() => {
      abort();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, signal, stdout, stderr, durationMs: Date.now() - startedAt, timedOut: killed });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code: 1, signal: null, stdout, stderr: error.message, durationMs: Date.now() - startedAt, timedOut: killed });
    });
  });
}
