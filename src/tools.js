import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_TOOL_NAMES } from "./constants.js";
import { fetchUrl, webSearch } from "./network.js";
import { listMcpTools, callMcpTool, listMcpResources, readMcpResource, shutdownAllMcpServers } from "./mcpClient.js";
import { commandContainsShellControlOperators, getDangerousCommandReason, runProcess } from "./process.js";
import { listFiles, workspacePath, workspaceRelativePath } from "./workspace.js";

const DEFAULT_IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "coverage", ".oases"]);
const TEXT_PREVIEW_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".css", ".csv", ".go", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".py", ".rs", ".sh", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml"]);
const TYPE_EXTENSIONS = {
  js: [".js", ".jsx", ".mjs", ".cjs"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py"],
  rust: [".rs"],
  go: [".go"],
  json: [".json"],
  md: [".md", ".mdx"],
  css: [".css", ".scss", ".sass", ".less"],
  html: [".html", ".htm"],
  vue: [".vue"],
  yaml: [".yaml", ".yml"],
  shell: [".sh", ".bash", ".zsh"],
};
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..");
const SENSITIVE_KEY_RE = /(?:token|secret|key|password|credential|authorization|auth|api[_-]?key)/i;
const WORKSPACE_SETTINGS_PATHS = [
  ".oases/settings.json",
  ".oases/settings.local.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
];
const MEMORY_SCOPES = new Set(["project", "team", "private"]);

function truncateText(text, limit) {
  const value = String(text || "");
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`, truncated: true };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fileArtifact(filePath, info, role = "output") {
  return {
    type: "file",
    role,
    path: filePath,
    ...(typeof info?.size === "number" ? { bytes: info.size } : {}),
    ...(filePath ? { extension: path.extname(filePath).toLowerCase() || undefined } : {}),
  };
}

async function runGit(root, args, options = {}) {
  const quotedArgs = args.map((arg) => JSON.stringify(String(arg))).join(" ");
  const result = await runProcess(`git ${quotedArgs}`, { cwd: root, timeoutMs: options.timeoutMs || 10000, signal: options.signal });
  return { ...result, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

async function walkWorkspace(root, body = {}) {
  const start = body.path ? workspacePath(root, body.path) : root;
  const maxResults = Math.max(1, Math.min(500, Number(body.maxResults) || 100));
  const results = [];

  async function visit(directory) {
    if (results.length >= maxResults) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.isDirectory() && DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) results.push({ path: relative });
    }
  }

  await visit(start);
  return results;
}

async function snapshotWorkspaceFiles(root) {
  const snapshot = new Map();
  const files = await walkWorkspace(root, { maxResults: 2000 }).catch(() => []);
  for (const file of files) {
    try {
      const info = await stat(path.join(root, file.path));
      if (info.isFile()) snapshot.set(file.path, { size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore files that disappear during a command.
    }
  }
  return snapshot;
}

async function changedFileArtifacts(root, before, role = "generated_or_modified_file") {
  const after = await snapshotWorkspaceFiles(root);
  const artifacts = [];
  for (const [filePath, info] of after.entries()) {
    const previous = before.get(filePath);
    if (!previous || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
      artifacts.push(fileArtifact(filePath, info, role));
    }
    if (artifacts.length >= 30) break;
  }
  return artifacts;
}

function wildcardToRegExp(pattern) {
  const deepDirectoryPlaceholder = "\u0000";
  const deepPlaceholder = "\u0001";
  const escaped = String(pattern || "*")
    .replace(/\*\*\//g, deepDirectoryPlaceholder)
    .replace(/\*\*/g, deepPlaceholder)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replaceAll(deepDirectoryPlaceholder, "(?:.*/)?")
    .replaceAll(deepPlaceholder, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function extensionFilter(type) {
  const key = String(type || "").trim().toLowerCase();
  const extensions = TYPE_EXTENSIONS[key];
  if (!extensions) return undefined;
  return new Set(extensions);
}

function matchesGlob(filePath, glob) {
  if (!glob || typeof glob !== "string") return true;
  const normalized = glob.trim().replace(/\\+/g, "/");
  const target = normalized.includes("/") ? filePath : path.basename(filePath);
  return wildcardToRegExp(normalized).test(target);
}

async function searchFiles(root, body) {
  const query = String(body.query || "").trim().toLowerCase();
  const pattern = typeof body.pattern === "string" && body.pattern.trim() ? wildcardToRegExp(body.pattern.trim()) : undefined;
  const files = await walkWorkspace(root, body);
  const matches = files.filter((file) => {
    const base = path.basename(file.path).toLowerCase();
    return (!query || file.path.toLowerCase().includes(query) || base.includes(query)) && (!pattern || pattern.test(file.path));
  });
  return { query, matches, count: matches.length, truncated: matches.length >= (Number(body.maxResults) || 100) };
}

async function globFiles(root, body = {}) {
  const glob = String(body.glob || body.pattern || "**/*").trim() || "**/*";
  const maxResults = Math.max(1, Math.min(1000, Number(body.maxResults) || 100));
  const typeExtensions = extensionFilter(body.type);
  const files = await walkWorkspace(root, { ...body, maxResults: Math.max(maxResults * 8, maxResults) });
  const matches = [];
  for (const file of files) {
    if (!matchesGlob(file.path, glob)) continue;
    if (typeExtensions && !typeExtensions.has(path.extname(file.path).toLowerCase())) continue;
    try {
      const info = await stat(path.join(root, file.path));
      matches.push({ path: file.path, mtimeMs: info.mtimeMs, bytes: info.size });
    } catch {
      matches.push({ path: file.path });
    }
  }
  matches.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || a.path.localeCompare(b.path));
  const sliced = matches.slice(0, maxResults);
  return { glob, matches: sliced, count: sliced.length, truncated: matches.length > maxResults };
}

async function grepFiles(root, body) {
  const query = String(body.query || body.regex || "");
  if (!query) throw new Error("grep_files requires query or regex.");
  const caseSensitive = body.caseSensitive === true;
  const glob = typeof body.glob === "string" && body.glob.trim() ? body.glob.trim() : typeof body.pattern === "string" && body.pattern.trim() ? body.pattern.trim() : "";
  const typeExtensions = extensionFilter(body.type);
  const useRegex = body.useRegex === true || typeof body.regex === "string";
  const outputMode = ["content", "files_with_matches", "count"].includes(body.outputMode) ? body.outputMode : "content";
  const maxResults = Math.max(1, Math.min(500, Number(body.maxResults) || 100));
  const files = await walkWorkspace(root, { ...body, maxResults: Math.max(maxResults * 4, maxResults) });
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = [];
  const counts = [];
  const flags = caseSensitive ? "g" : "gi";
  let regex;
  if (useRegex) {
    try {
      regex = new RegExp(query, flags);
    } catch (error) {
      throw new Error(`Invalid grep_files regex: ${error instanceof Error ? error.message : "unknown regex error"}`);
    }
  }

  for (const file of files) {
    if (matches.length >= maxResults) break;
    if (glob && !matchesGlob(file.path, glob)) continue;
    if (typeExtensions && !typeExtensions.has(path.extname(file.path).toLowerCase())) continue;
    let content;
    try {
      content = await readFile(path.join(root, file.path), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    let fileMatchCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= maxResults && outputMode !== "count") break;
      const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
      const matched = regex ? (regex.lastIndex = 0, regex.test(lines[index])) : haystack.includes(needle);
      if (!matched) continue;
      fileMatchCount += 1;
      if (outputMode === "files_with_matches") {
        matches.push({ path: file.path });
        break;
      }
      if (outputMode === "content") matches.push({ path: file.path, line: index + 1, text: lines[index].slice(0, 500) });
    }
    if (outputMode === "count" && fileMatchCount > 0) counts.push({ path: file.path, count: fileMatchCount });
  }

  if (outputMode === "count") {
    const sliced = counts.slice(0, maxResults);
    return { query, useRegex, outputMode, matches: sliced, count: sliced.length, totalMatches: counts.reduce((sum, item) => sum + item.count, 0), truncated: counts.length > maxResults };
  }
  return { query, useRegex, outputMode, matches, count: matches.length, truncated: matches.length >= maxResults };
}

function parseStatusShort(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3).trim() }));
}

function shouldPreviewUntracked(filePath) {
  return TEXT_PREVIEW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function previewUntrackedFiles(root, entries, maxFiles, maxCharsPerFile) {
  const previews = [];
  for (const entry of entries) {
    if (previews.length >= maxFiles) break;
    if (!entry.status.startsWith("??") || !entry.path || !shouldPreviewUntracked(entry.path)) continue;
    try {
      const target = workspacePath(root, entry.path);
      const info = await stat(target);
      if (!info.isFile() || info.size > 256 * 1024) continue;
      const content = await readFile(target, "utf8");
      const preview = truncateText(content, maxCharsPerFile);
      previews.push({ path: entry.path, bytes: info.size, content: preview.text, truncated: preview.truncated });
    } catch {
      // Ignore files that disappeared or are not readable as UTF-8.
    }
  }
  return previews;
}

async function workspaceStatus(root, body = {}, options = {}) {
  const maxChars = Math.max(2000, Math.min(120000, Number(body.maxChars) || 40000));
  const includeDiff = body.includeDiff !== false;
  const includeUntrackedPreview = body.includeUntrackedPreview === true;
  const gitRoot = await runGit(root, ["rev-parse", "--show-toplevel"], { timeoutMs: 5000, signal: options.signal });
  if (gitRoot.code !== 0) {
    return { isGitRepo: false, status: [], summary: "当前 workspace 不是 git 仓库，无法生成 git diff。", gitError: gitRoot.stderr || gitRoot.stdout };
  }

  const statusResult = await runGit(root, ["status", "--short", "--branch", "--untracked-files=all"], { signal: options.signal });
  const diffStatResult = await runGit(root, ["diff", "--stat"], { signal: options.signal });
  const stagedDiffStatResult = await runGit(root, ["diff", "--cached", "--stat"], { signal: options.signal });
  const statusLines = String(statusResult.stdout || "").split(/\r?\n/).filter(Boolean);
  const branch = statusLines.find((line) => line.startsWith("##")) || "";
  const entries = parseStatusShort(statusLines.filter((line) => !line.startsWith("##")).join("\n"));
  const changedFiles = entries.length;

  let diff = { text: "", truncated: false };
  let stagedDiff = { text: "", truncated: false };
  if (includeDiff) {
    const diffResult = await runGit(root, ["diff", "--", "."], { timeoutMs: 15000, signal: options.signal });
    const stagedDiffResult = await runGit(root, ["diff", "--cached", "--", "."], { timeoutMs: 15000, signal: options.signal });
    const splitLimit = Math.floor(maxChars / 2);
    diff = truncateText(diffResult.stdout || diffResult.stderr, splitLimit);
    stagedDiff = truncateText(stagedDiffResult.stdout || stagedDiffResult.stderr, splitLimit);
  }

  const untrackedPreviews = includeUntrackedPreview ? await previewUntrackedFiles(root, entries, 8, 4000) : [];
  const summary = changedFiles === 0
    ? "工作区没有 git 变更。"
    : `工作区有 ${changedFiles} 个变更文件。${diff.truncated || stagedDiff.truncated ? " diff 已截断。" : ""}`.trim();
  return {
    isGitRepo: true,
    root: gitRoot.stdout.trim(),
    branch,
    status: entries,
    changedFiles,
    summary,
    diffStat: diffStatResult.stdout.trim(),
    stagedDiffStat: stagedDiffStatResult.stdout.trim(),
    diff: diff.text,
    stagedDiff: stagedDiff.text,
    diffTruncated: diff.truncated || stagedDiff.truncated,
    untrackedPreviews,
  };
}

function parseWorktreePorcelain(stdout) {
  const worktrees = [];
  let current;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = undefined;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? true : line.slice(separator + 1);
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { path: String(value) };
    } else if (current) {
      current[key] = value;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

async function getGitRoot(root, options = {}) {
  const gitRoot = await runGit(root, ["rev-parse", "--show-toplevel"], { timeoutMs: 5000, signal: options.signal });
  if (gitRoot.code !== 0 || !gitRoot.stdout.trim()) {
    throw new Error("worktree tools require the workspace to be inside a git repository.");
  }
  return gitRoot.stdout.trim();
}

async function canonicalPath(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function listWorktrees(root, body = {}, options = {}) {
  const gitRoot = await getGitRoot(root, options);
  const result = await runGit(gitRoot, ["worktree", "list", "--porcelain"], { timeoutMs: 10000, signal: options.signal });
  if (result.code !== 0) throw new Error(`Failed to list git worktrees: ${(result.stderr || result.stdout).trim()}`);
  const mainPath = await canonicalPath(gitRoot);
  const worktrees = [];
  for (const entry of parseWorktreePorcelain(result.stdout)) {
    const resolved = await canonicalPath(entry.path);
    worktrees.push({
      path: resolved,
      ...(resolved !== path.resolve(entry.path) ? { originalPath: path.resolve(entry.path) } : {}),
      head: typeof entry.HEAD === "string" ? entry.HEAD : "",
      branch: typeof entry.branch === "string" ? entry.branch.replace(/^refs\/heads\//, "") : "",
      detached: entry.detached === true || entry.branch === undefined,
      bare: entry.bare === true,
      isMain: resolved === mainPath,
      isOasesAgentWorktree: resolved.split(path.sep).some((segment) => segment.startsWith("oases-ocli-worktree-")),
    });
  }
  if (body.includeStatus === true) {
    for (const entry of worktrees) {
      if (entry.isMain) continue;
      entry.workspaceStatus = await workspaceStatus(entry.path, { includeDiff: false }, options).catch((error) => ({
        isGitRepo: false,
        summary: error instanceof Error ? error.message : "Failed to read worktree status.",
      }));
    }
  }
  return { gitRoot, worktrees, count: worktrees.length };
}

async function resolveLinkedWorktree(root, body = {}, options = {}) {
  const requested = String(body.worktreePath || body.path || "").trim();
  if (!requested) throw new Error("worktreePath is required.");
  const gitRoot = await getGitRoot(root, options);
  const listed = await listWorktrees(gitRoot, {}, options);
  const resolved = await canonicalPath(path.isAbsolute(requested) ? requested : path.join(root, requested));
  const worktree = listed.worktrees.find((entry) => path.resolve(entry.path) === resolved);
  if (!worktree) throw new Error("Requested path is not a linked git worktree for this workspace.");
  if (worktree.isMain || path.resolve(gitRoot) === resolved) throw new Error("Refusing to manage the main workspace as a worktree.");
  return { gitRoot, worktree };
}

async function worktreeDiff(root, body = {}, options = {}) {
  const { gitRoot, worktree } = await resolveLinkedWorktree(root, body, options);
  const status = await workspaceStatus(worktree.path, {
    includeDiff: body.includeDiff !== false,
    includeUntrackedPreview: body.includeUntrackedPreview !== false,
    maxChars: body.maxChars,
  }, options);
  return { gitRoot, worktree, workspaceStatus: status };
}

function normalizeRelativePathForApply(value) {
  const normalized = String(value || "").trim().replace(/\\+/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error(`Invalid worktree apply path: ${value}`);
  }
  return normalized;
}

function entryLooksDeleted(entry) {
  return String(entry.status || "").includes("D");
}

function entryLooksUnsupported(entry) {
  const status = String(entry.status || "");
  return status.includes("R") || status.includes("C") || String(entry.path || "").includes(" -> ");
}

async function worktreeApply(root, body = {}, options = {}) {
  const { gitRoot, worktree } = await resolveLinkedWorktree(root, body, options);
  const force = body.force === true;
  const status = await workspaceStatus(worktree.path, { includeDiff: false, includeUntrackedPreview: false }, options);
  const requestedPaths = Array.isArray(body.paths) && body.paths.length
    ? new Set(body.paths.map(normalizeRelativePathForApply))
    : undefined;
  const entries = (status.status || []).filter((entry) => !requestedPaths || requestedPaths.has(normalizeRelativePathForApply(entry.path)));
  if (!entries.length) return { gitRoot, worktree, applied: [], skipped: [], message: "No matching worktree changes to apply." };

  const unsupported = entries.filter(entryLooksUnsupported);
  if (unsupported.length) {
    throw new Error(`worktree_apply does not support renamed/copied entries yet: ${unsupported.map((entry) => entry.path).join(", ")}`);
  }

  const mainStatus = await workspaceStatus(gitRoot, { includeDiff: false, includeUntrackedPreview: false }, options);
  const mainDirtyPaths = new Set((mainStatus.status || []).map((entry) => normalizeRelativePathForApply(entry.path)));
  const conflicts = entries.filter((entry) => mainDirtyPaths.has(normalizeRelativePathForApply(entry.path)));
  if (conflicts.length && !force) {
    throw new Error(`Refusing to overwrite dirty main workspace paths: ${conflicts.map((entry) => entry.path).join(", ")}. Pass force: true to override.`);
  }

  const applied = [];
  const skipped = [];
  for (const entry of entries) {
    const relativePath = normalizeRelativePathForApply(entry.path);
    const target = workspacePath(gitRoot, relativePath);
    if (entryLooksDeleted(entry)) {
      await rm(target, { recursive: true, force: true });
      applied.push({ path: relativePath, action: "deleted" });
      continue;
    }
    const source = workspacePath(worktree.path, relativePath);
    let info;
    try {
      info = await stat(source);
    } catch {
      skipped.push({ path: relativePath, reason: "source file no longer exists" });
      continue;
    }
    if (!info.isFile()) {
      skipped.push({ path: relativePath, reason: "source is not a regular file" });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    const nextInfo = await stat(target);
    applied.push({ path: relativePath, action: "copied", bytes: nextInfo.size });
  }

  const nextMainStatus = await workspaceStatus(gitRoot, { includeDiff: false, includeUntrackedPreview: false }, options);
  return {
    gitRoot,
    worktree,
    applied,
    skipped,
    count: applied.length,
    mainWorkspaceStatus: nextMainStatus,
    artifacts: applied
      .filter((item) => item.action === "copied")
      .map((item) => ({ type: "file", role: "applied_from_worktree", path: item.path, ...(typeof item.bytes === "number" ? { bytes: item.bytes } : {}) })),
  };
}

async function worktreeRemove(root, body = {}, options = {}) {
  const { gitRoot, worktree } = await resolveLinkedWorktree(root, body, options);
  const force = body.force === true;
  const status = await workspaceStatus(worktree.path, { includeDiff: false, includeUntrackedPreview: false }, options);
  if ((status.changedFiles || 0) > 0 && !force) {
    throw new Error(`Worktree has ${status.changedFiles} changed file(s). Pass force: true to discard and remove it.`);
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktree.path);
  const result = await runGit(gitRoot, args, { timeoutMs: 30000, signal: options.signal });
  if (result.code !== 0) throw new Error(`Failed to remove worktree: ${(result.stderr || result.stdout).trim()}`);
  const parent = path.dirname(worktree.path);
  if (path.basename(parent).startsWith("oases-ocli-worktree-")) {
    await rm(parent, { recursive: true, force: true }).catch(() => {});
  }
  return { gitRoot, worktree, removed: true, discardedChanges: status.changedFiles || 0 };
}

function countLiteralMatches(content, needle) {
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length) {
    const index = content.indexOf(needle, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function previewAround(content, index, length, limit = 900) {
  const start = Math.max(0, index - Math.floor(limit / 2));
  const end = Math.min(content.length, index + length + Math.floor(limit / 2));
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

function linePreview(text, limit = 80) {
  const lines = String(text).split(/\r?\n/).slice(0, limit);
  const rendered = lines.join("\n");
  return lines.length >= limit ? `${rendered}\n...` : rendered;
}

function formatNumberedLines(lines, startLine) {
  return lines.map((line, index) => `${String(startLine + index).padStart(6, " ")}\t${line}`).join("\n");
}

function readFileRangeContent(content, body = {}) {
  const hasRange = body.offset !== undefined || body.limit !== undefined || body.numbered === true || body.maxChars !== undefined;
  if (!hasRange) return { content };
  const lines = content.split(/\r?\n/);
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.max(1, Math.min(2000, Number(body.limit) || 2000));
  const selected = lines.slice(offset, offset + limit);
  const rendered = body.numbered === true ? formatNumberedLines(selected, offset + 1) : selected.join("\n");
  const maxChars = Math.max(1000, Math.min(240000, Number(body.maxChars) || 120000));
  const preview = truncateText(rendered, maxChars);
  return {
    content: preview.text,
    offset,
    limit,
    startLine: offset + 1,
    endLine: offset + selected.length,
    totalLines: lines.length,
    rangeTruncated: offset + selected.length < lines.length,
    truncated: preview.truncated,
    numbered: body.numbered === true,
  };
}

function normalizeTodos(body) {
  const allowedStatuses = new Set(["todo", "doing", "done"]);
  const todos = Array.isArray(body.todos) ? body.todos : [];
  if (!todos.length) throw new Error("todo_write requires a non-empty todos array.");
  return todos.slice(0, 100).map((item, index) => {
    const text = String(item?.text || "").trim();
    if (!text) throw new Error(`todo_write todo at index ${index} requires text.`);
    const status = allowedStatuses.has(item?.status) ? item.status : "todo";
    return {
      id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `todo_${index + 1}`,
      text,
      status,
    };
  });
}

function summarizeTodos(todos) {
  return todos
    .map((todo) => `${todo.status === "done" ? "[x]" : todo.status === "doing" ? "[>]" : "[ ]"} ${todo.text}`)
    .join("\n");
}

function stripFrontmatterQuotes(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function deindentBlockLines(lines) {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)?.[0]?.length || 0);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(minIndent, line.length)));
}

function parseInlineArray(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => stripFrontmatterQuotes(item))
    .filter(Boolean);
}

function parseMarkdownFrontmatter(content) {
  const raw = String(content || "");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const metadata = {};
  if (match) {
    const lines = match[1].split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s/.test(line)) continue;
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      if (!key) continue;
      if (rawValue === "|" || rawValue === ">") {
        const block = [];
        while (index + 1 < lines.length && (!lines[index + 1].trim() || /^\s+/.test(lines[index + 1]))) {
          block.push(lines[index + 1]);
          index += 1;
        }
        const deindented = deindentBlockLines(block);
        metadata[key] = rawValue === ">" ? deindented.map((item) => item.trim()).filter(Boolean).join(" ") : deindented.join("\n").trimEnd();
        continue;
      }
      if (!rawValue) {
        const values = [];
        while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
          values.push(stripFrontmatterQuotes(lines[index + 1].replace(/^\s+-\s+/, "")));
          index += 1;
        }
        metadata[key] = values.length ? values : "";
        continue;
      }
      metadata[key] = parseInlineArray(rawValue) || stripFrontmatterQuotes(rawValue);
    }
  }
  return { metadata, body: match ? raw.slice(match[0].length) : raw };
}

function normalizeMemoryScope(value) {
  const scope = String(value || "project").trim().toLowerCase();
  if (!MEMORY_SCOPES.has(scope)) throw new Error("memory scope must be project, team, or private.");
  return scope;
}

function normalizeMemoryName(value, toolName = "memory_write") {
  const normalized = String(value || "").trim().replace(/\\+/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === ".." || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error(`${toolName} name must be a single safe memory name.`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) throw new Error(`${toolName} name may only contain letters, numbers, dot, underscore, or dash.`);
  const withoutExtension = normalized.replace(/\.md$/i, "");
  if (!withoutExtension) throw new Error(`${toolName} name must include a non-empty stem.`);
  return withoutExtension;
}

function validateMemoryPath(memoryPath, options = {}) {
  const normalized = String(memoryPath || "").replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/memory/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("memory tools can only access Markdown files under .oases/memory.");
  }
  if (!/\.md$/i.test(normalized)) throw new Error("memory tools can only access Markdown memory files.");
  const parts = normalized.split("/");
  if (parts.length !== 4 || !MEMORY_SCOPES.has(parts[2])) {
    throw new Error("memory path must be under .oases/memory/project, .oases/memory/team, or .oases/memory/private.");
  }
  normalizeMemoryName(parts[3], "memory_read");
  if (options.scope && parts[2] !== normalizeMemoryScope(options.scope)) throw new Error("memory path does not match requested scope.");
  return normalized;
}

function memoryPathFromName(name, scope = "project") {
  return `.oases/memory/${normalizeMemoryScope(scope)}/${normalizeMemoryName(name, "memory_write")}.md`;
}

function normalizeMemoryMetadata(file, content = "") {
  const parsed = parseMarkdownFrontmatter(content);
  const fallbackName = path.basename(file, path.extname(file));
  const heading = parsed.body.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() || "";
  const scope = file.split("/")[2] || "project";
  const metadataName = typeof parsed.metadata.name === "string" && parsed.metadata.name ? parsed.metadata.name : "";
  const tags = Array.isArray(parsed.metadata.tags)
    ? parsed.metadata.tags.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()).slice(0, 20)
    : typeof parsed.metadata.tags === "string" && parsed.metadata.tags
      ? parsed.metadata.tags.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20)
      : [];
  return {
    id: `${scope}:${metadataName || fallbackName}`,
    name: metadataName || fallbackName,
    title: typeof parsed.metadata.title === "string" && parsed.metadata.title ? parsed.metadata.title : heading || metadataName || fallbackName,
    description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : "",
    scope,
    tags,
    path: file,
    metadata: parsed.metadata,
  };
}

async function walkMemoryFiles(root, body = {}) {
  const scopeFilter = body.scope ? normalizeMemoryScope(body.scope) : "";
  const maxResults = Math.max(1, Math.min(300, Number(body.maxResults) || 100));
  const memoryRoot = path.join(root, ".oases", "memory");
  const files = [];
  async function visit(directory) {
    if (files.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxResults) return;
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          files.push(validateMemoryPath(relative, scopeFilter ? { scope: scopeFilter } : {}));
        } catch {
          // Ignore malformed memory paths.
        }
      }
    }
  }
  if (scopeFilter) await visit(path.join(memoryRoot, scopeFilter));
  else await visit(memoryRoot);
  return files.slice(0, maxResults);
}

async function listMemories(root, body = {}) {
  const maxResults = Math.max(1, Math.min(300, Number(body.maxResults) || 100));
  const files = await walkMemoryFiles(root, { ...body, maxResults: maxResults * 3 });
  const memories = [];
  for (const file of files.slice(0, maxResults)) {
    try {
      const target = workspacePath(root, file);
      const info = await stat(target);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      const content = await readFile(target, "utf8");
      memories.push({ ...normalizeMemoryMetadata(file, content), bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore unreadable memory files.
    }
  }
  memories.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  return { memories, count: memories.length, root: ".oases/memory", scopes: [...MEMORY_SCOPES], truncated: files.length > maxResults };
}

async function readMemory(root, body = {}) {
  const requested = String(body.path || body.memory || body.name || "").trim();
  if (!requested) throw new Error("memory_read requires path, memory, or name.");
  const memories = await listMemories(root, { scope: body.scope, maxResults: 300 });
  const requestedLower = requested.toLowerCase();
  const matched = memories.memories.find((memory) => (
    memory.path === requested
    || memory.name === requested
    || memory.title === requested
    || memory.id === requested
  )) || memories.memories.find((memory) => (
    memory.path.toLowerCase() === requestedLower
    || memory.name.toLowerCase() === requestedLower
    || memory.title.toLowerCase() === requestedLower
    || memory.id.toLowerCase() === requestedLower
  ));
  const normalized = validateMemoryPath(matched ? matched.path : requested, body.scope ? { scope: body.scope } : {});
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("memory_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("memory_read target is too large.");
  const content = await readFile(target, "utf8");
  const parsed = parseMarkdownFrontmatter(content);
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  const bodyPreview = truncateText(parsed.body.trim(), maxChars);
  return {
    memory: normalizeMemoryMetadata(normalized, content),
    path: normalized,
    bytes: info.size,
    content: preview.text,
    body: bodyPreview.text,
    metadata: parsed.metadata,
    truncated: preview.truncated || bodyPreview.truncated,
  };
}

function formatMemoryMarkdown(body = {}) {
  const title = String(body.title || body.name || "Memory").trim();
  const description = String(body.description || "").trim();
  const scope = normalizeMemoryScope(body.scope);
  const tags = Array.isArray(body.tags)
    ? body.tags.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
    : typeof body.tags === "string" && body.tags.trim()
      ? body.tags.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20)
      : [];
  const content = String(body.content || body.body || "").trim();
  if (!title) throw new Error("memory_write requires title or name.");
  if (!content) throw new Error("memory_write requires content or body.");
  const frontmatter = [
    "---",
    `name: ${normalizeMemoryName(body.name || title.toLowerCase().replace(/\s+/g, "-"), "memory_write")}`,
    `title: ${title.replace(/\r?\n/g, " ")}`,
    ...(description ? [`description: ${description.replace(/\r?\n/g, " ")}`] : []),
    `scope: ${scope}`,
    ...(tags.length ? [`tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`] : []),
    `updatedAt: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
  const bodyContent = content.startsWith("#") ? content : `# ${title}\n\n${content}`;
  return `${frontmatter}${bodyContent.trimEnd()}\n`;
}

async function writeMemory(root, body = {}) {
  const scope = normalizeMemoryScope(body.scope);
  const normalized = body.path
    ? validateMemoryPath(body.path, { scope })
    : memoryPathFromName(body.name || body.title, scope);
  const target = workspacePath(root, normalized);
  if (await fileExists(target) && body.overwrite !== true) throw new Error(`Memory already exists: ${normalized}. Pass overwrite: true to replace it.`);
  await mkdir(path.dirname(target), { recursive: true });
  const content = formatMemoryMarkdown({ ...body, scope });
  await writeFile(target, content, "utf8");
  const info = await stat(target);
  return {
    written: true,
    path: normalized,
    bytes: info.size,
    memory: normalizeMemoryMetadata(normalized, content),
    artifacts: [fileArtifact(normalized, info, "memory_file")],
  };
}

function parseSkillFrontmatter(content) {
  return parseMarkdownFrontmatter(content).metadata;
}

function isPathInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function maybeDirectory(directory) {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) return undefined;
    return await realpath(directory);
  } catch {
    return undefined;
  }
}

async function bundledSkillsRoot() {
  const candidates = [
    path.join(PACKAGE_ROOT, "OcliSkills"),
    path.join(REPO_ROOT, "oases-ocli", "OcliSkills"),
    path.join(REPO_ROOT, "ocli", "OcliSkills"),
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const resolved = await maybeDirectory(normalized);
    if (resolved) return resolved;
  }
  return undefined;
}

async function walkSkillFiles(root, maxResults = 100) {
  const skillsRoot = path.join(root, ".oases", "skills");
  const files = [];
  async function visit(directory) {
    if (files.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxResults) return;
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push({
        source: "workspace",
        root: ".oases/skills",
        path: relative,
        absolute,
        baseDir: path.dirname(absolute),
      });
    }
  }
  await visit(skillsRoot);
  return files;
}

async function walkBundledSkillFiles(maxResults = 100) {
  const skillsRoot = await bundledSkillsRoot();
  if (!skillsRoot) return { files: [], rootPath: undefined };
  const files = [];
  async function visit(directory) {
    if (files.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxResults) return;
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(skillsRoot, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push({
        source: "bundled",
        root: "OcliSkills",
        path: `OcliSkills/${relative}`,
        absolute,
        baseDir: path.dirname(absolute),
      });
    }
  }
  await visit(skillsRoot);
  return { files, rootPath: skillsRoot };
}

function skillRecordFromMetadata(file, metadata = {}) {
  const directoryName = path.basename(path.dirname(file.path));
  const name = typeof metadata.name === "string" && metadata.name ? metadata.name : directoryName;
  return {
    id: name,
    name,
    description: typeof metadata.description === "string" ? metadata.description : "",
    path: file.path,
    source: file.source,
    root: file.root,
    baseDir: file.baseDir,
  };
}

function normalizeSkillAssetPath(value, fallback = ".") {
  const normalized = String(value || fallback).trim().replace(/\\+/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return ".";
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.includes("../")) {
    throw new Error("Skill asset path must stay inside the selected skill directory.");
  }
  return normalized;
}

async function listSkills(root, body = {}) {
  const maxResults = Math.max(1, Math.min(500, Number(body.maxResults) || 80));
  const workspaceFiles = await walkSkillFiles(root, maxResults * 4);
  const bundled = await walkBundledSkillFiles(maxResults * 4);
  const allSkillFiles = [...workspaceFiles, ...bundled.files].filter((file) => /(^|\/)SKILL\.md$/i.test(file.path));
  const skillFiles = allSkillFiles.slice(0, maxResults);
  const skills = [];
  for (const file of skillFiles) {
    try {
      const content = await readFile(file.absolute, "utf8");
      const metadata = parseSkillFrontmatter(content);
      skills.push(skillRecordFromMetadata(file, metadata));
    } catch {
      // Ignore unreadable skill files.
    }
  }
  return {
    skills,
    count: skills.length,
    root: ".oases/skills + OcliSkills",
    roots: [".oases/skills", "OcliSkills"],
    bundledRootAvailable: Boolean(bundled.rootPath),
    truncated: allSkillFiles.length > maxResults,
  };
}

async function findSkillByRequest(root, requested) {
  const skills = await listSkills(root, { maxResults: 500 });
  const requestedLower = requested.toLowerCase();
  return skills.skills.find((skill) => skill.name === requested || skill.id === requested || skill.path === requested)
    || skills.skills.find((skill) => skill.name.toLowerCase() === requestedLower || skill.id.toLowerCase() === requestedLower || skill.path.toLowerCase() === requestedLower);
}

async function resolveSkillTarget(root, requested) {
  const matched = await findSkillByRequest(root, requested);
  const skillPath = matched ? matched.path : requested;
  const normalized = normalizeSkillAssetPath(skillPath);
  if (normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("skill_read can only read files under .oases/skills or bundled OcliSkills.");
  }
  let target;
  let source = matched?.source || "workspace";
  let rootLabel = matched?.root || ".oases/skills";
  if (normalized.startsWith("OcliSkills/")) {
    const skillsRoot = await bundledSkillsRoot();
    if (!skillsRoot) throw new Error("No bundled OcliSkills directory is available.");
    const relative = normalized.slice("OcliSkills/".length);
    target = path.resolve(skillsRoot, relative);
    const resolvedTarget = await realpath(target).catch(() => target);
    if (!isPathInside(skillsRoot, resolvedTarget)) throw new Error("skill_read target escapes bundled OcliSkills.");
    target = resolvedTarget;
    source = "bundled";
    rootLabel = "OcliSkills";
  } else if (normalized.startsWith(".oases/skills/")) {
    target = workspacePath(root, normalized);
    source = "workspace";
    rootLabel = ".oases/skills";
  } else {
    throw new Error("skill_read can only read files under .oases/skills or bundled OcliSkills.");
  }
  return { matched, normalized, target, source, rootLabel };
}

async function readSkill(root, body = {}) {
  const requested = String(body.path || body.name || "").trim();
  if (!requested) throw new Error("skill_read requires path or name.");
  const { matched, normalized, target, source, rootLabel } = await resolveSkillTarget(root, requested);
  if (!/(^|\/)SKILL\.md$/i.test(normalized)) throw new Error("skill_read can only read SKILL.md files.");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("skill_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("skill_read target is too large.");
  const content = await readFile(target, "utf8");
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  const skill = matched || skillRecordFromMetadata({
    source,
    root: rootLabel,
    path: normalized,
    absolute: target,
    baseDir: path.dirname(target),
  }, parseSkillFrontmatter(content));
  return {
    path: normalized,
    source,
    root: rootLabel,
    baseDir: path.dirname(target),
    bytes: info.size,
    content: preview.text,
    truncated: preview.truncated,
    skill,
  };
}

async function resolveSkillAssetTarget(root, body = {}, { requireFile = false } = {}) {
  const skillName = String(body.name || body.skill || "").trim();
  const directPath = String(body.path || "").trim();
  const requestedAssetPath = String(body.assetPath || body.file || "").trim();
  let skill;
  let relativeAssetPath;

  if (skillName) {
    skill = await findSkillByRequest(root, skillName);
    if (!skill) throw new Error(`Skill not found: ${skillName}`);
    relativeAssetPath = normalizeSkillAssetPath(requestedAssetPath || directPath || ".");
  } else if (directPath) {
    const normalized = normalizeSkillAssetPath(directPath);
    const skills = await listSkills(root, { maxResults: 500 });
    skill = skills.skills
      .map((item) => ({ ...item, skillDirPath: item.path.replace(/\/SKILL\.md$/i, "") }))
      .sort((a, b) => b.skillDirPath.length - a.skillDirPath.length)
      .find((item) => normalized === item.skillDirPath || normalized.startsWith(`${item.skillDirPath}/`));
    if (!skill) throw new Error("skill_asset_read path must be inside a known .oases/skills or OcliSkills skill directory.");
    const skillDirPath = skill.path.replace(/\/SKILL\.md$/i, "");
    relativeAssetPath = normalizeSkillAssetPath(normalized === skillDirPath ? "." : normalized.slice(skillDirPath.length + 1));
  } else {
    throw new Error("skill asset tools require name/skill or path.");
  }

  const baseDir = await realpath(skill.baseDir);
  const target = path.resolve(baseDir, relativeAssetPath === "." ? "" : relativeAssetPath);
  const resolvedTarget = await realpath(target).catch(() => target);
  if (!isPathInside(baseDir, resolvedTarget)) throw new Error("Skill asset path escapes the selected skill directory.");
  const info = await stat(resolvedTarget);
  if (requireFile && !info.isFile()) throw new Error("skill_asset_read target is not a file.");
  const skillDirPath = skill.path.replace(/\/SKILL\.md$/i, "");
  return {
    skill,
    source: skill.source,
    root: skill.root,
    baseDir,
    relativeAssetPath,
    target: resolvedTarget,
    info,
    path: relativeAssetPath === "." ? skillDirPath : `${skillDirPath}/${relativeAssetPath}`,
  };
}

async function listSkillAssets(root, body = {}) {
  const maxResults = Math.max(1, Math.min(500, Number(body.maxResults) || 100));
  const resolved = await resolveSkillAssetTarget(root, body);
  if (!resolved.info.isDirectory()) throw new Error("skill_asset_list target is not a directory.");
  const assets = [];
  async function visit(directory) {
    if (assets.length >= maxResults) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (assets.length >= maxResults) return;
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const realAbsolute = await realpath(absolute).catch(() => absolute);
      if (!isPathInside(resolved.baseDir, realAbsolute)) continue;
      const relativePath = path.relative(resolved.baseDir, realAbsolute).replace(/\\+/g, "/");
      const info = await stat(realAbsolute).catch(() => undefined);
      if (entry.isDirectory()) {
        assets.push({ type: "dir", path: relativePath });
        await visit(realAbsolute);
      } else if (entry.isFile()) {
        assets.push({ type: "file", path: relativePath, bytes: info?.size, extension: path.extname(relativePath).toLowerCase() || undefined });
      }
    }
  }
  await visit(resolved.target);
  return {
    skill: resolved.skill,
    source: resolved.source,
    root: resolved.root,
    baseDir: resolved.baseDir,
    path: resolved.path,
    assets,
    count: assets.length,
    truncated: assets.length >= maxResults,
  };
}

async function readSkillAsset(root, body = {}) {
  const resolved = await resolveSkillAssetTarget(root, body, { requireFile: true });
  if (resolved.info.size > 512 * 1024) throw new Error("skill_asset_read target is too large.");
  const content = await readFile(resolved.target, "utf8");
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  return {
    skill: resolved.skill,
    source: resolved.source,
    root: resolved.root,
    baseDir: resolved.baseDir,
    path: resolved.path,
    assetPath: resolved.relativeAssetPath,
    bytes: resolved.info.size,
    content: preview.text,
    truncated: preview.truncated,
  };
}

function normalizeInstallName(value, toolName = "skill_install") {
  const normalized = String(value || "").trim().replace(/\\+/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === ".." || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error(`${toolName} targetName must be a single safe directory name.`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) throw new Error(`${toolName} targetName may only contain letters, numbers, dot, underscore, or dash.`);
  return normalized;
}

async function directoryExists(target) {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(target) {
  try {
    const info = await stat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

async function copySkillDirectory(sourceDir, targetDir, sourceRoot) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const source = path.join(sourceDir, entry.name);
    const realSource = await realpath(source).catch(() => source);
    if (!isPathInside(sourceRoot, realSource)) throw new Error("Bundled skill source escapes its directory.");
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copySkillDirectory(realSource, target, sourceRoot);
    } else if (entry.isFile()) {
      await copyFile(realSource, target);
    }
  }
}

async function copySafeDirectory(sourceDir, targetDir, sourceRoot, label = "source") {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.name === ".git" || entry.name === "node_modules") continue;
    const source = path.join(sourceDir, entry.name);
    const realSource = await realpath(source).catch(() => source);
    if (!isPathInside(sourceRoot, realSource)) throw new Error(`${label} escapes its directory.`);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copySafeDirectory(realSource, target, sourceRoot, label);
    } else if (entry.isFile()) {
      await copyFile(realSource, target);
    }
  }
}

async function installSkill(root, body = {}) {
  const requested = String(body.name || body.skill || "").trim();
  if (!requested) throw new Error("skill_install requires a bundled skill name.");
  const skills = await listSkills(root, { maxResults: 500 });
  const requestedLower = requested.toLowerCase();
  const sourceSkill = skills.skills.find((skill) => skill.source === "bundled" && (skill.name === requested || skill.id === requested || skill.path === requested))
    || skills.skills.find((skill) => skill.source === "bundled" && (skill.name.toLowerCase() === requestedLower || skill.id.toLowerCase() === requestedLower || skill.path.toLowerCase() === requestedLower));
  if (!sourceSkill) throw new Error(`Bundled skill not found: ${requested}`);
  const defaultName = path.basename(path.dirname(sourceSkill.path));
  const targetName = normalizeInstallName(body.targetName || defaultName);
  const targetRelativeDir = `.oases/skills/${targetName}`;
  const parent = workspacePath(root, ".oases/skills");
  await mkdir(parent, { recursive: true });
  const targetDir = workspacePath(root, targetRelativeDir);
  if (await directoryExists(targetDir)) throw new Error(`Workspace skill already exists: ${targetRelativeDir}`);
  const sourceDir = await realpath(sourceSkill.baseDir);
  const sourceRoot = await realpath(sourceDir);
  await copySkillDirectory(sourceDir, targetDir, sourceRoot);
  const installedSkillPath = `${targetRelativeDir}/SKILL.md`;
  const installedInfo = await stat(workspacePath(root, installedSkillPath));
  return {
    installed: true,
    name: targetName,
    sourceSkill,
    path: installedSkillPath,
    targetDir: targetRelativeDir,
    bytes: installedInfo.size,
    artifacts: [{ type: "file", role: "installed_skill", path: installedSkillPath, bytes: installedInfo.size }],
  };
}

async function findPluginManifestInDirectory(directory) {
  for (const relative of PLUGIN_MANIFEST_PATHS) {
    const target = path.join(directory, relative);
    try {
      const info = await stat(target);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      const content = await readFile(target, "utf8");
      return { path: relative, manifest: JSON.parse(content), bytes: info.size };
    } catch {
      // Try the next supported manifest location.
    }
  }
  return undefined;
}

async function installPlugin(root, body = {}) {
  const requested = String(body.path || body.sourcePath || body.source || "").trim();
  if (!requested) throw new Error("plugin_install requires a source plugin directory path.");
  const sourcePath = workspacePath(root, requested);
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isDirectory()) throw new Error("plugin_install source path must be a directory.");
  const sourceRoot = await realpath(sourcePath);
  const manifestInfo = await findPluginManifestInDirectory(sourceRoot);
  if (!manifestInfo) throw new Error("plugin_install source must contain .oases-plugin/plugin.json or .claude-plugin/plugin.json.");
  const defaultName = path.basename(sourceRoot);
  const targetName = normalizeInstallName(body.targetName || defaultName, "plugin_install");
  const targetRelativeDir = `.oases/plugins/${targetName}`;
  const parent = workspacePath(root, ".oases/plugins");
  await mkdir(parent, { recursive: true });
  const targetDir = workspacePath(root, targetRelativeDir);
  if (await directoryExists(targetDir)) throw new Error(`Workspace plugin already exists: ${targetRelativeDir}`);
  await copySafeDirectory(sourceRoot, targetDir, sourceRoot, "Plugin source");
  const installedManifestPath = `${targetRelativeDir}/${manifestInfo.path}`.replace(/\\+/g, "/");
  const installedInfo = await stat(workspacePath(root, installedManifestPath));
  const summary = await summarizePluginFiles(root, targetRelativeDir);
  const plugin = normalizePluginMetadata(installedManifestPath, manifestInfo.manifest, summary);
  return {
    installed: true,
    name: targetName,
    sourcePath: workspaceRelativePath(root, sourcePath),
    path: installedManifestPath,
    targetDir: targetRelativeDir,
    bytes: installedInfo.size,
    manifest: manifestInfo.manifest,
    plugin,
    artifacts: [{ type: "file", role: "installed_plugin_manifest", path: installedManifestPath, bytes: installedInfo.size }],
  };
}

const PLUGIN_MANIFEST_PATHS = [".oases-plugin/plugin.json", ".claude-plugin/plugin.json"];
const PLUGIN_DISABLED_MARKER = ".oases-disabled";

function normalizePluginRootPath(value, toolName = "plugin_remove") {
  const normalized = String(value || "").trim().replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error(`${toolName} path must stay inside .oases/plugins.`);
  }
  if (!normalized.startsWith(".oases/plugins/")) {
    throw new Error(`${toolName} can only target installed plugins under .oases/plugins.`);
  }
  const manifestSuffix = PLUGIN_MANIFEST_PATHS.find((suffix) => normalized.endsWith(`/${suffix}`));
  const pluginRoot = manifestSuffix ? normalized.slice(0, -manifestSuffix.length - 1) : normalized;
  if (!pluginRoot || pluginRoot === ".oases/plugins" || pluginRoot === ".oases/plugins/") {
    throw new Error(`${toolName} requires a specific plugin directory.`);
  }
  return pluginRoot.replace(/\/+$/, "");
}

async function resolveInstalledPlugin(root, body = {}, toolName = "plugin_remove") {
  const requested = String(body.name || body.plugin || body.path || "").trim();
  if (!requested) throw new Error(`${toolName} requires name, plugin, or path.`);
  const matched = await findPluginByRequest(root, requested);
  const pluginRoot = matched ? matched.root : normalizePluginRootPath(requested, toolName);
  const normalizedRoot = normalizePluginRootPath(pluginRoot, toolName);
  const pluginsBase = await realpath(workspacePath(root, ".oases/plugins"));
  const targetDir = workspacePath(root, normalizedRoot);
  const resolvedTarget = await realpath(targetDir);
  if (!isPathInside(pluginsBase, resolvedTarget)) throw new Error(`${toolName} target escapes .oases/plugins.`);
  const info = await stat(resolvedTarget);
  if (!info.isDirectory()) throw new Error(`${toolName} target must be a plugin directory.`);
  const manifestInfo = await findPluginManifestInDirectory(resolvedTarget);
  if (!manifestInfo) throw new Error(`${toolName} target must contain .oases-plugin/plugin.json or .claude-plugin/plugin.json.`);
  const summary = await summarizePluginFiles(root, normalizedRoot);
  const manifestPath = `${normalizedRoot}/${manifestInfo.path}`.replace(/\\+/g, "/");
  const plugin = matched ? { ...matched, ...normalizePluginMetadata(manifestPath, manifestInfo.manifest, summary) } : normalizePluginMetadata(manifestPath, manifestInfo.manifest, summary);
  return { plugin, manifest: manifestInfo.manifest, manifestPath, targetDir, normalizedRoot };
}

async function removePlugin(root, body = {}) {
  const resolved = await resolveInstalledPlugin(root, body, "plugin_remove");
  await rm(resolved.targetDir, { recursive: true, force: false });
  return {
    removed: true,
    name: resolved.plugin.name,
    path: resolved.normalizedRoot,
    manifestPath: resolved.manifestPath,
    manifest: resolved.manifest,
    plugin: resolved.plugin,
    artifacts: [{ type: "file", role: "removed_plugin", path: resolved.normalizedRoot }],
  };
}

async function setPluginEnabled(root, body = {}, enabled = true) {
  const toolName = enabled ? "plugin_enable" : "plugin_disable";
  const resolved = await resolveInstalledPlugin(root, body, toolName);
  const markerPath = path.join(resolved.targetDir, PLUGIN_DISABLED_MARKER);
  if (enabled) {
    await rm(markerPath, { force: true });
  } else {
    await writeFile(markerPath, JSON.stringify({
      disabled: true,
      plugin: resolved.plugin.name,
      disabledAt: new Date().toISOString(),
    }, null, 2), "utf8");
  }
  const summary = await summarizePluginFiles(root, resolved.normalizedRoot);
  const plugin = normalizePluginMetadata(resolved.manifestPath, resolved.manifest, summary);
  return {
    enabled,
    disabled: !enabled,
    name: plugin.name,
    path: resolved.normalizedRoot,
    markerPath: `${resolved.normalizedRoot}/${PLUGIN_DISABLED_MARKER}`,
    manifestPath: resolved.manifestPath,
    manifest: resolved.manifest,
    plugin,
    artifacts: [{ type: "file", role: enabled ? "enabled_plugin" : "disabled_plugin", path: `${resolved.normalizedRoot}/${PLUGIN_DISABLED_MARKER}` }],
  };
}

function normalizePluginFileId(file) {
  return path.basename(path.dirname(path.dirname(file)));
}

function normalizePluginMetadata(file, metadata = {}, summary = {}) {
  const fallbackId = normalizePluginFileId(file);
  const name = typeof metadata.name === "string" && metadata.name ? metadata.name : fallbackId;
  return {
    id: name,
    name,
    version: typeof metadata.version === "string" ? metadata.version : "",
    description: typeof metadata.description === "string" ? metadata.description : "",
    path: file,
    root: path.dirname(path.dirname(file)).replace(/\\+/g, "/"),
    manifestType: file.includes("/.claude-plugin/") ? "claude-plugin" : "oases-plugin",
    ...(metadata.author ? { author: metadata.author } : {}),
    commands: summary.commands || [],
    agents: summary.agents || [],
    skills: summary.skills || [],
    hooks: summary.hooks || [],
    outputStyles: summary.outputStyles || [],
    settingsJson: summary.settingsJson || "",
    readme: summary.readme || "",
    enabled: summary.disabled !== true,
    disabled: summary.disabled === true,
    ...(summary.disabled ? { disabledPath: `${path.dirname(path.dirname(file)).replace(/\\+/g, "/")}/${PLUGIN_DISABLED_MARKER}` } : {}),
  };
}

async function summarizePluginFiles(root, pluginRoot) {
  const commands = [];
  const agents = [];
  const skills = [];
  const hooks = [];
  const outputStyles = [];
  let readme = "";
  let settingsJson = "";
  async function collect(folder, output, matcher = /\.md$/i) {
    const target = path.join(root, pluginRoot, folder);
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".") || !matcher.test(entry.name)) continue;
      output.push(`${pluginRoot}/${folder}/${entry.name}`.replace(/\\+/g, "/"));
    }
  }
  async function collectSkills(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) {
        await collectSkills(absolute);
      } else if (entry.isFile() && /^SKILL\.md$/i.test(entry.name)) {
        skills.push(relative);
      }
    }
  }
  await collect("commands", commands);
  await collect("agents", agents);
  await collectSkills(path.join(root, pluginRoot, "skills"));
  await collect("hooks", hooks, /\.(json|js|mjs|cjs|py|sh)$/i);
  await collect("hooks-handlers", hooks, /\.(json|js|mjs|cjs|py|sh)$/i);
  await collect("output-styles", outputStyles, /\.(md|json)$/i);
  for (const candidate of ["README.md", "readme.md"]) {
    const file = `${pluginRoot}/${candidate}`;
    try {
      const info = await stat(workspacePath(root, file));
      if (info.isFile()) {
        readme = file;
        break;
      }
    } catch {
      // Ignore missing README files.
    }
  }
  try {
    const settingsPath = `${pluginRoot}/settings.json`;
    const info = await stat(workspacePath(root, settingsPath));
    if (info.isFile()) settingsJson = settingsPath;
  } catch {
    settingsJson = "";
  }
  let disabled = false;
  try {
    const info = await stat(workspacePath(root, `${pluginRoot}/${PLUGIN_DISABLED_MARKER}`));
    disabled = info.isFile();
  } catch {
    disabled = false;
  }
  return { commands, agents, skills, hooks, outputStyles, readme, settingsJson, disabled };
}

function summarizeValueShape(value, key = "") {
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (SENSITIVE_KEY_RE.test(String(key || ""))) return { type, redacted: true };
  if (Array.isArray(value)) {
    return { type, length: value.length };
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return {
      type,
      keys,
      values: Object.fromEntries(keys.slice(0, 50).map((childKey) => [childKey, summarizeValueShape(value[childKey], childKey)])),
      truncated: keys.length > 50,
    };
  }
  return { type };
}

function summarizeSettingsShape(settings) {
  if (!isPlainObject(settings)) return { count: 0, keys: [], values: {}, type: Array.isArray(settings) ? "array" : typeof settings };
  const keys = Object.keys(settings).sort();
  return {
    count: keys.length,
    keys,
    values: Object.fromEntries(keys.slice(0, 80).map((key) => [key, summarizeValueShape(settings[key], key)])),
    truncated: keys.length > 80,
  };
}

function summarizeServerMap(value) {
  if (!isPlainObject(value)) return { count: 0, names: [], servers: {} };
  const names = Object.keys(value).sort();
  const servers = {};
  for (const name of names.slice(0, 80)) {
    const server = value[name];
    if (!isPlainObject(server)) {
      servers[name] = { type: Array.isArray(server) ? "array" : typeof server };
      continue;
    }
    const env = isPlainObject(server.env) ? server.env : undefined;
    servers[name] = {
      command: typeof server.command === "string" ? server.command : undefined,
      transport: typeof server.transport === "string" ? server.transport : undefined,
      url: typeof server.url === "string" ? server.url : undefined,
      argsCount: Array.isArray(server.args) ? server.args.length : 0,
      envKeys: env ? Object.keys(env).sort() : [],
      keys: Object.keys(server).sort(),
    };
  }
  return { count: names.length, names, servers, truncated: names.length > 80 };
}

function summarizeCommandsMetadata(value) {
  if (!isPlainObject(value)) return { count: 0, names: [], commands: {} };
  const names = Object.keys(value).sort();
  const commands = {};
  for (const name of names.slice(0, 100)) {
    const metadata = value[name];
    if (!isPlainObject(metadata)) {
      commands[name] = { type: Array.isArray(metadata) ? "array" : typeof metadata };
      continue;
    }
    commands[name] = {
      description: typeof metadata.description === "string" ? metadata.description : "",
      allowedTools: Array.isArray(metadata.allowedTools) ? metadata.allowedTools.filter((item) => typeof item === "string") : [],
      argumentHint: typeof metadata.argumentHint === "string" ? metadata.argumentHint : "",
      keys: Object.keys(metadata).sort(),
    };
  }
  return { count: names.length, names, commands, truncated: names.length > 100 };
}

function normalizeManifestPathList(value) {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function summarizeManifestPaths(manifest = {}) {
  return {
    commands: [...normalizeManifestPathList(manifest.commandsPath), ...normalizeManifestPathList(manifest.commandsPaths)],
    agents: [...normalizeManifestPathList(manifest.agentsPath), ...normalizeManifestPathList(manifest.agentsPaths)],
    skills: [...normalizeManifestPathList(manifest.skillsPath), ...normalizeManifestPathList(manifest.skillsPaths)],
    outputStyles: [...normalizeManifestPathList(manifest.outputStylesPath), ...normalizeManifestPathList(manifest.outputStylesPaths)],
  };
}

function summarizePluginCapability(plugin, manifest = {}, summary = {}) {
  const mcpServers = summarizeServerMap(manifest.mcpServers);
  const lspServers = summarizeServerMap(manifest.lspServers);
  const settings = summarizeSettingsShape(manifest.settings);
  const commandsMetadata = summarizeCommandsMetadata(manifest.commandsMetadata);
  const manifestPaths = summarizeManifestPaths(manifest);
  return {
    plugin: plugin.name,
    id: plugin.id,
    root: plugin.root,
    path: plugin.path,
    enabled: plugin.enabled !== false,
    disabled: plugin.disabled === true,
    manifestType: plugin.manifestType,
    manifest: {
      mcpServers: mcpServers.count,
      mcpServerNames: mcpServers.names,
      lspServers: lspServers.count,
      lspServerNames: lspServers.names,
      settings: settings.count,
      settingsKeys: settings.keys,
      commandsMetadata: commandsMetadata.count,
      commandsMetadataNames: commandsMetadata.names,
      paths: manifestPaths,
    },
    files: {
      commands: summary.commands || plugin.commands || [],
      agents: summary.agents || plugin.agents || [],
      skills: summary.skills || plugin.skills || [],
      hooks: summary.hooks || plugin.hooks || [],
      outputStyles: summary.outputStyles || plugin.outputStyles || [],
      readme: summary.readme || plugin.readme || "",
      settingsJson: summary.settingsJson || plugin.settingsJson || "",
    },
  };
}

async function readPluginSettingsSummary(root, settingsPath) {
  if (!settingsPath) return undefined;
  try {
    const target = workspacePath(root, settingsPath);
    const info = await stat(target);
    if (!info.isFile()) return undefined;
    if (info.size > 512 * 1024) return { path: settingsPath, bytes: info.size, tooLarge: true };
    const content = await readFile(target, "utf8");
    return { path: settingsPath, bytes: info.size, settings: summarizeSettingsShape(JSON.parse(content)) };
  } catch (error) {
    return { path: settingsPath, error: error?.message || String(error) };
  }
}

async function listPluginCapabilities(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const requested = String(body.plugin || body.name || body.path || "").trim();
  const requestedLower = requested.toLowerCase();
  const plugins = await listPlugins(root, { maxResults: 200 });
  const filtered = plugins.plugins
    .filter((plugin) => body.includeDisabled === true || plugin.disabled !== true)
    .filter((plugin) => !requested || matchesPluginRequest(plugin, requested, requestedLower))
    .slice(0, maxResults);
  const capabilities = [];
  for (const plugin of filtered) {
    try {
      const manifest = JSON.parse(await readFile(workspacePath(root, plugin.path), "utf8"));
      const summary = await summarizePluginFiles(root, plugin.root);
      capabilities.push(summarizePluginCapability(plugin, manifest, summary));
    } catch {
      // Ignore unreadable manifests after plugin_list already filtered them.
    }
  }
  capabilities.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.path.localeCompare(b.path));
  return {
    capabilities,
    count: capabilities.length,
    root: ".oases/plugins",
    includeDisabled: body.includeDisabled === true,
    truncated: filtered.length >= maxResults,
  };
}

async function readPluginCapability(root, body = {}) {
  const requested = String(body.plugin || body.name || body.path || "").trim();
  if (!requested) throw new Error("plugin_capability_read requires plugin, name, or path.");
  const plugins = await listPlugins(root, { maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const plugin = plugins.plugins.find((item) => matchesPluginRequest(item, requested, requestedLower));
  if (!plugin) throw new Error(`Plugin not found: ${requested}`);
  if (plugin.disabled === true && body.includeDisabled !== true) {
    throw new Error("plugin_capability_read skips disabled plugins unless includeDisabled is true.");
  }
  const content = await readFile(workspacePath(root, plugin.path), "utf8");
  const manifest = JSON.parse(content);
  const summary = await summarizePluginFiles(root, plugin.root);
  const capability = summarizePluginCapability(plugin, manifest, summary);
  const mcpServers = summarizeServerMap(manifest.mcpServers);
  const lspServers = summarizeServerMap(manifest.lspServers);
  const settings = summarizeSettingsShape(manifest.settings);
  const commandsMetadata = summarizeCommandsMetadata(manifest.commandsMetadata);
  const settingsFile = await readPluginSettingsSummary(root, summary.settingsJson);
  return {
    plugin,
    capability,
    manifest: {
      paths: summarizeManifestPaths(manifest),
      mcpServers,
      lspServers,
      settings,
      commandsMetadata,
    },
    ...(settingsFile ? { settingsFile } : {}),
  };
}

function normalizeSettingsPathRequest(value = "") {
  const requested = String(value || "").trim().replace(/\\+/g, "/").replace(/^\.\/+/, "");
  if (!requested || requested === "settings" || requested === "project") return ".oases/settings.json";
  if (requested === "local" || requested === "settings.local") return ".oases/settings.local.json";
  if (requested === "claude" || requested === "claude-settings") return ".claude/settings.json";
  if (requested === "claude-local" || requested === "claude-settings.local") return ".claude/settings.local.json";
  return requested;
}

function assertWorkspaceSettingsPath(normalized) {
  if (!WORKSPACE_SETTINGS_PATHS.includes(normalized)) {
    throw new Error("settings_read can only read .oases/settings.json, .oases/settings.local.json, .claude/settings.json, or .claude/settings.local.json.");
  }
}

async function summarizeWorkspaceSettingsFile(root, settingsPath) {
  const target = workspacePath(root, settingsPath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`Settings target is not a file: ${settingsPath}`);
  if (info.size > 512 * 1024) {
    return {
      path: settingsPath,
      bytes: info.size,
      source: settingsPath.startsWith(".claude/") ? "claude" : "oases",
      tooLarge: true,
    };
  }
  const content = await readFile(target, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      path: settingsPath,
      bytes: info.size,
      source: settingsPath.startsWith(".claude/") ? "claude" : "oases",
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    path: settingsPath,
    bytes: info.size,
    source: settingsPath.startsWith(".claude/") ? "claude" : "oases",
    settings: summarizeSettingsShape(parsed),
  };
}

async function listWorkspaceSettings(root, body = {}) {
  const includeClaude = body.includeClaude === true;
  const paths = WORKSPACE_SETTINGS_PATHS.filter((settingsPath) => includeClaude || settingsPath.startsWith(".oases/"));
  const settingsFiles = [];
  for (const settingsPath of paths) {
    try {
      settingsFiles.push(await summarizeWorkspaceSettingsFile(root, settingsPath));
    } catch {
      // Missing settings files are normal for most workspaces.
    }
  }
  settingsFiles.sort((a, b) => a.path.localeCompare(b.path));
  return {
    settingsFiles,
    count: settingsFiles.length,
    roots: includeClaude ? [".oases", ".claude"] : [".oases"],
    includeClaude,
  };
}

async function readWorkspaceSettings(root, body = {}) {
  const normalized = normalizeSettingsPathRequest(body.path || body.name || body.settings || "");
  assertWorkspaceSettingsPath(normalized);
  if (normalized.startsWith(".claude/") && body.includeClaude !== true) {
    throw new Error("settings_read skips .claude settings unless includeClaude is true.");
  }
  return summarizeWorkspaceSettingsFile(root, normalized);
}

async function walkPluginManifestFiles(root, maxResults = 100) {
  const pluginsRoot = path.join(root, ".oases", "plugins");
  const files = [];
  async function visit(directory) {
    if (files.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxResults) return;
      if (entry.name.startsWith(".") && ![".oases-plugin", ".claude-plugin"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && PLUGIN_MANIFEST_PATHS.some((suffix) => relative.endsWith(`/${suffix}`))) {
        files.push(relative);
      }
    }
  }
  await visit(pluginsRoot);
  return files;
}

async function listPlugins(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const files = (await walkPluginManifestFiles(root, maxResults * 4)).slice(0, maxResults);
  const plugins = [];
  for (const file of files) {
    try {
      const content = await readFile(workspacePath(root, file), "utf8");
      const manifest = JSON.parse(content);
      const pluginRoot = path.dirname(path.dirname(file)).replace(/\\+/g, "/");
      const summary = await summarizePluginFiles(root, pluginRoot);
      plugins.push(normalizePluginMetadata(file, manifest, summary));
    } catch {
      // Ignore unreadable or invalid plugin manifests.
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return { plugins, count: plugins.length, root: ".oases/plugins", truncated: files.length >= maxResults };
}

async function readPlugin(root, body = {}) {
  const requested = String(body.path || body.name || body.plugin || "").trim();
  if (!requested) throw new Error("plugin_read requires path or name.");
  const plugins = await listPlugins(root, { maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const matched = plugins.plugins.find((plugin) => plugin.name === requested || plugin.id === requested || plugin.path === requested || plugin.root === requested)
    || plugins.plugins.find((plugin) => plugin.name.toLowerCase() === requestedLower || plugin.id.toLowerCase() === requestedLower || plugin.path.toLowerCase() === requestedLower || plugin.root.toLowerCase() === requestedLower);
  const pluginPath = matched ? matched.path : requested;
  const normalized = pluginPath.replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/plugins/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("plugin_read can only read plugin manifests under .oases/plugins.");
  }
  if (!PLUGIN_MANIFEST_PATHS.some((suffix) => normalized.endsWith(`/${suffix}`))) {
    throw new Error("plugin_read can only read plugin.json manifests.");
  }
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("plugin_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("plugin_read target is too large.");
  const content = await readFile(target, "utf8");
  const manifest = JSON.parse(content);
  const pluginRoot = path.dirname(path.dirname(normalized)).replace(/\\+/g, "/");
  const summary = await summarizePluginFiles(root, pluginRoot);
  let readmeContent = "";
  let readmeTruncated = false;
  if (summary.readme) {
    try {
      const readme = await readFile(workspacePath(root, summary.readme), "utf8");
      const preview = truncateText(readme, Math.max(1000, Math.min(60000, Number(body.maxChars) || 20000)));
      readmeContent = preview.text;
      readmeTruncated = preview.truncated;
    } catch {
      // README is optional.
    }
  }
  const plugin = matched ? { ...matched, ...normalizePluginMetadata(normalized, manifest, summary) } : normalizePluginMetadata(normalized, manifest, summary);
  return {
    path: normalized,
    root: pluginRoot,
    bytes: info.size,
    content,
    manifest,
    plugin,
    ...(summary.readme ? { readmePath: summary.readme, readme: readmeContent, readmeTruncated } : {}),
  };
}

function matchesPluginRequest(plugin, requested, requestedLower = String(requested || "").toLowerCase()) {
  return plugin.name === requested
    || plugin.id === requested
    || plugin.root === requested
    || plugin.path === requested
    || plugin.name.toLowerCase() === requestedLower
    || plugin.id.toLowerCase() === requestedLower
    || plugin.root.toLowerCase() === requestedLower
    || plugin.path.toLowerCase() === requestedLower;
}

async function findPluginByRequest(root, requested) {
  const value = String(requested || "").trim();
  if (!value) return undefined;
  const plugins = await listPlugins(root, { maxResults: 200 });
  const valueLower = value.toLowerCase();
  return plugins.plugins.find((plugin) => matchesPluginRequest(plugin, value, valueLower));
}

function normalizePluginAssetPath(value, fallback = ".") {
  const normalized = String(value || fallback).trim().replace(/\\+/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return ".";
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.includes("../")) {
    throw new Error("Plugin asset path must stay inside the selected plugin directory.");
  }
  return normalized;
}

async function resolvePluginAssetTarget(root, body = {}, { requireFile = false } = {}) {
  const pluginName = String(body.plugin || body.name || "").trim();
  const directPath = String(body.path || "").trim();
  const requestedAssetPath = String(body.assetPath || body.file || "").trim();
  const plugins = await listPlugins(root, { maxResults: 200 });
  let plugin;
  let relativeAssetPath;

  if (pluginName) {
    const pluginLower = pluginName.toLowerCase();
    plugin = plugins.plugins.find((item) => matchesPluginRequest(item, pluginName, pluginLower));
    if (!plugin) throw new Error(`Plugin not found: ${pluginName}`);
    const requested = normalizePluginAssetPath(requestedAssetPath || directPath || ".");
    relativeAssetPath = requested === plugin.root ? "." : requested.startsWith(`${plugin.root}/`) ? requested.slice(plugin.root.length + 1) : requested;
  } else if (directPath) {
    const normalized = normalizePluginAssetPath(directPath);
    plugin = plugins.plugins
      .sort((a, b) => b.root.length - a.root.length)
      .find((item) => normalized === item.root || normalized.startsWith(`${item.root}/`));
    if (!plugin) throw new Error("plugin asset path must be inside a known .oases/plugins plugin directory.");
    relativeAssetPath = normalized === plugin.root ? "." : normalized.slice(plugin.root.length + 1);
  } else {
    throw new Error("plugin asset tools require plugin/name or path.");
  }

  relativeAssetPath = normalizePluginAssetPath(relativeAssetPath || ".");
  const baseDir = await realpath(workspacePath(root, plugin.root));
  const target = path.resolve(baseDir, relativeAssetPath === "." ? "" : relativeAssetPath);
  const resolvedTarget = await realpath(target).catch(() => target);
  if (!isPathInside(baseDir, resolvedTarget)) throw new Error("Plugin asset path escapes the selected plugin directory.");
  const info = await stat(resolvedTarget);
  if (requireFile && !info.isFile()) throw new Error("plugin_asset_read target is not a file.");
  return {
    plugin,
    baseDir,
    relativeAssetPath,
    target: resolvedTarget,
    info,
    path: relativeAssetPath === "." ? plugin.root : `${plugin.root}/${relativeAssetPath}`,
  };
}

async function listPluginAssets(root, body = {}) {
  const maxResults = Math.max(1, Math.min(500, Number(body.maxResults) || 100));
  const resolved = await resolvePluginAssetTarget(root, body);
  if (!resolved.info.isDirectory()) throw new Error("plugin_asset_list target is not a directory.");
  const assets = [];
  async function visit(directory) {
    if (assets.length >= maxResults) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (assets.length >= maxResults) return;
      if (entry.name === ".DS_Store") continue;
      const absolute = path.join(directory, entry.name);
      const realAbsolute = await realpath(absolute).catch(() => absolute);
      if (!isPathInside(resolved.baseDir, realAbsolute)) continue;
      const relativePath = path.relative(resolved.baseDir, realAbsolute).replace(/\\+/g, "/");
      const info = await stat(realAbsolute).catch(() => undefined);
      if (entry.isDirectory()) {
        assets.push({ type: "dir", path: relativePath });
        await visit(realAbsolute);
      } else if (entry.isFile()) {
        assets.push({ type: "file", path: relativePath, bytes: info?.size, extension: path.extname(relativePath).toLowerCase() || undefined });
      }
    }
  }
  await visit(resolved.target);
  return {
    plugin: resolved.plugin,
    root: resolved.plugin.root,
    baseDir: resolved.baseDir,
    path: resolved.path,
    assets,
    count: assets.length,
    truncated: assets.length >= maxResults,
  };
}

async function readPluginAsset(root, body = {}) {
  const resolved = await resolvePluginAssetTarget(root, body, { requireFile: true });
  if (resolved.info.size > 512 * 1024) throw new Error("plugin_asset_read target is too large.");
  const content = await readFile(resolved.target, "utf8");
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  return {
    plugin: resolved.plugin,
    root: resolved.plugin.root,
    baseDir: resolved.baseDir,
    path: resolved.path,
    assetPath: resolved.relativeAssetPath,
    bytes: resolved.info.size,
    content: preview.text,
    truncated: preview.truncated,
  };
}

function summarizeHookConfig(content = "") {
  try {
    const config = JSON.parse(content);
    const events = config?.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks)
      ? Object.entries(config.hooks).map(([event, entries]) => {
        const groups = Array.isArray(entries) ? entries : [];
        const hooks = groups.flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : []);
        return {
          event,
          groups: groups.length,
          hookCount: hooks.length,
          matchers: groups.map((group) => group?.matcher).filter(Boolean),
          commands: hooks.map((hook) => hook?.command).filter(Boolean),
          types: [...new Set(hooks.map((hook) => hook?.type).filter(Boolean))],
        };
      })
      : [];
    return {
      description: typeof config?.description === "string" ? config.description : "",
      events,
      eventNames: events.map((event) => event.event),
      hookCount: events.reduce((sum, event) => sum + event.hookCount, 0),
      config,
    };
  } catch {
    return { description: "", events: [], eventNames: [], hookCount: 0, config: undefined };
  }
}

function normalizePluginHookMetadata(file, content = "", plugin = {}, size = undefined) {
  const extension = path.extname(file).toLowerCase();
  const fallbackName = path.basename(file, extension);
  const configSummary = extension === ".json" ? summarizeHookConfig(content) : undefined;
  return {
    id: `${plugin.name || plugin.id || path.basename(path.dirname(path.dirname(file)))}:${fallbackName}`,
    name: fallbackName,
    path: file,
    plugin: plugin.name || plugin.id || "",
    pluginRoot: plugin.root || path.dirname(path.dirname(file)).replace(/\\+/g, "/"),
    kind: extension === ".json" ? "config" : "handler",
    extension: extension || undefined,
    bytes: size,
    description: configSummary?.description || "",
    events: configSummary?.eventNames || [],
    hookCount: configSummary?.hookCount || 0,
    commands: configSummary?.events?.flatMap((event) => event.commands).filter(Boolean) || [],
  };
}

async function listPluginHooks(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const requestedPlugin = String(body.plugin || body.name || "").trim();
  const requestedLower = requestedPlugin.toLowerCase();
  const plugins = await listPlugins(root, { maxResults: 200 });
  const includeDisabled = body.includeDisabled === true;
  const selectedPlugins = requestedPlugin
    ? plugins.plugins.filter((plugin) => matchesPluginRequest(plugin, requestedPlugin, requestedLower))
    : plugins.plugins.filter((plugin) => includeDisabled || plugin.enabled !== false);
  const hooks = [];
  for (const plugin of selectedPlugins) {
    for (const hookPath of plugin.hooks || []) {
      if (hooks.length >= maxResults) break;
      try {
        const info = await stat(workspacePath(root, hookPath));
        if (!info.isFile() || info.size > 512 * 1024) continue;
        const content = await readFile(workspacePath(root, hookPath), "utf8");
        hooks.push(normalizePluginHookMetadata(hookPath, content, plugin, info.size));
      } catch {
        // Ignore unreadable hook files.
      }
    }
    if (hooks.length >= maxResults) break;
  }
  hooks.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return {
    hooks,
    count: hooks.length,
    plugin: requestedPlugin || undefined,
    root: ".oases/plugins/*/hooks",
    truncated: hooks.length >= maxResults,
  };
}

function validatePluginHookPath(hookPath) {
  const normalized = String(hookPath || "").replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/plugins/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("plugin_hook_read can only read hook files under .oases/plugins.");
  }
  const isHookFile = normalized.includes("/hooks/") || normalized.includes("/hooks-handlers/");
  if (!isHookFile || !/\.(json|js|mjs|cjs|py|sh)$/i.test(normalized)) {
    throw new Error("plugin_hook_read can only read JSON or script files under plugin hooks directories.");
  }
  return normalized;
}

async function readPluginHook(root, body = {}) {
  const requested = String(body.path || body.hook || body.name || "").trim();
  if (!requested) throw new Error("plugin_hook_read requires path, hook, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const hooks = await listPluginHooks(root, { plugin: pluginFilter, includeDisabled: body.includeDisabled === true, maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const matched = hooks.hooks.find((hook) => (
    hook.path === requested
    || hook.name === requested
    || hook.id === requested
  )) || hooks.hooks.find((hook) => (
    hook.path.toLowerCase() === requestedLower
    || hook.name.toLowerCase() === requestedLower
    || hook.id.toLowerCase() === requestedLower
  ));
  const normalized = validatePluginHookPath(matched ? matched.path : requested);
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("plugin_hook_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("plugin_hook_read target is too large.");
  const content = await readFile(target, "utf8");
  const pluginRoot = normalized.includes("/hooks-handlers/")
    ? path.dirname(path.dirname(normalized)).replace(/\\+/g, "/")
    : path.dirname(path.dirname(normalized)).replace(/\\+/g, "/");
  const plugins = await listPlugins(root, { maxResults: 200 });
  const plugin = plugins.plugins.find((item) => item.root === pluginRoot) || { name: path.basename(pluginRoot), id: path.basename(pluginRoot), root: pluginRoot };
  const hook = normalizePluginHookMetadata(normalized, content, plugin, info.size);
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  return {
    path: normalized,
    root: pluginRoot,
    bytes: info.size,
    content: preview.text,
    hook,
    plugin,
    ...(hook.kind === "config" ? { config: summarizeHookConfig(content).config, events: summarizeHookConfig(content).events } : {}),
    truncated: preview.truncated,
  };
}

function normalizePluginCommandMetadata(file, content = "", plugin = {}) {
  const parsed = parseMarkdownFrontmatter(content);
  const fallbackName = path.basename(file, path.extname(file));
  const heading = parsed.body.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() || "";
  const metadataName = typeof parsed.metadata.name === "string" && parsed.metadata.name ? parsed.metadata.name : "";
  const title = typeof parsed.metadata.title === "string" && parsed.metadata.title
    ? parsed.metadata.title
    : heading || metadataName || fallbackName;
  return {
    id: `${plugin.name || plugin.id || path.basename(path.dirname(path.dirname(file)))}:${fallbackName}`,
    name: metadataName || fallbackName,
    title,
    description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : "",
    path: file,
    plugin: plugin.name || plugin.id || "",
    pluginRoot: plugin.root || path.dirname(path.dirname(file)).replace(/\\+/g, "/"),
    metadata: parsed.metadata,
  };
}

function normalizeWorkspaceCommandMetadata(file, content = "") {
  const parsed = parseMarkdownFrontmatter(content);
  const fallbackName = path.basename(file, path.extname(file));
  const heading = parsed.body.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() || "";
  const metadataName = typeof parsed.metadata.name === "string" && parsed.metadata.name ? parsed.metadata.name : "";
  return {
    id: metadataName || fallbackName,
    name: metadataName || fallbackName,
    title: typeof parsed.metadata.title === "string" && parsed.metadata.title ? parsed.metadata.title : heading || metadataName || fallbackName,
    description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : "",
    path: file,
    source: "workspace",
    metadata: parsed.metadata,
  };
}

async function walkCommandFiles(root, maxResults = 100) {
  const commandsRoot = path.join(root, ".oases", "commands");
  const files = [];
  async function visit(directory) {
    if (files.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxResults) return;
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(relative);
    }
  }
  await visit(commandsRoot);
  return files;
}

async function listCommands(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const files = (await walkCommandFiles(root, maxResults * 4))
    .filter((file) => file.startsWith(".oases/commands/"))
    .slice(0, maxResults);
  const commands = [];
  for (const file of files) {
    try {
      const target = workspacePath(root, file);
      const info = await stat(target);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      const content = await readFile(target, "utf8");
      commands.push({ ...normalizeWorkspaceCommandMetadata(file, content), bytes: info.size });
    } catch {
      // Ignore unreadable command files.
    }
  }
  commands.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return { commands, count: commands.length, root: ".oases/commands", truncated: files.length >= maxResults };
}

function validateWorkspaceCommandPath(commandPath) {
  const normalized = String(commandPath || "").replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/commands/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("command_read can only read command files under .oases/commands.");
  }
  if (!/\.md$/i.test(normalized)) throw new Error("command_read can only read Markdown command files.");
  return normalized;
}

async function readCommand(root, body = {}) {
  const requested = String(body.path || body.command || body.name || "").trim();
  if (!requested) throw new Error("command_read requires path, command, or name.");
  const commands = await listCommands(root, { maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const matched = commands.commands.find((command) => (
    command.path === requested
    || command.name === requested
    || command.title === requested
    || command.id === requested
  )) || commands.commands.find((command) => (
    command.path.toLowerCase() === requestedLower
    || command.name.toLowerCase() === requestedLower
    || command.title.toLowerCase() === requestedLower
    || command.id.toLowerCase() === requestedLower
  ));
  const normalized = validateWorkspaceCommandPath(matched ? matched.path : requested);
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("command_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("command_read target is too large.");
  const content = await readFile(target, "utf8");
  const parsed = parseMarkdownFrontmatter(content);
  const command = normalizeWorkspaceCommandMetadata(normalized, content);
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  const bodyPreview = truncateText(parsed.body.trim(), maxChars);
  return {
    path: normalized,
    bytes: info.size,
    content: preview.text,
    body: bodyPreview.text,
    metadata: parsed.metadata,
    command,
    truncated: preview.truncated || bodyPreview.truncated,
  };
}

async function listPluginCommands(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const requestedPlugin = String(body.plugin || body.name || "").trim();
  const requestedLower = requestedPlugin.toLowerCase();
  const plugins = await listPlugins(root, { maxResults: 200 });
  const includeDisabled = body.includeDisabled === true;
  const selectedPlugins = requestedPlugin
    ? plugins.plugins.filter((plugin) => (
      plugin.name === requestedPlugin
      || plugin.id === requestedPlugin
      || plugin.root === requestedPlugin
      || plugin.path === requestedPlugin
      || plugin.name.toLowerCase() === requestedLower
      || plugin.id.toLowerCase() === requestedLower
      || plugin.root.toLowerCase() === requestedLower
      || plugin.path.toLowerCase() === requestedLower
    ))
    : plugins.plugins.filter((plugin) => includeDisabled || plugin.enabled !== false);
  const commands = [];
  for (const plugin of selectedPlugins) {
    for (const commandPath of plugin.commands || []) {
      if (commands.length >= maxResults) break;
      try {
        const info = await stat(workspacePath(root, commandPath));
        if (!info.isFile() || info.size > 512 * 1024) continue;
        const content = await readFile(workspacePath(root, commandPath), "utf8");
        commands.push({ ...normalizePluginCommandMetadata(commandPath, content, plugin), bytes: info.size });
      } catch {
        // Ignore unreadable command files.
      }
    }
    if (commands.length >= maxResults) break;
  }
  commands.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return {
    commands,
    count: commands.length,
    plugin: requestedPlugin || undefined,
    root: ".oases/plugins/*/commands",
    truncated: commands.length >= maxResults,
  };
}

function validatePluginCommandPath(commandPath) {
  const normalized = String(commandPath || "").replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/plugins/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("plugin_command_read can only read command files under .oases/plugins.");
  }
  if (!normalized.includes("/commands/") || !/\.md$/i.test(normalized)) {
    throw new Error("plugin_command_read can only read Markdown command files under a plugin commands directory.");
  }
  return normalized;
}

async function readPluginCommand(root, body = {}) {
  const requested = String(body.path || body.command || body.name || "").trim();
  if (!requested) throw new Error("plugin_command_read requires path, command, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const commands = await listPluginCommands(root, { plugin: pluginFilter, maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const matched = commands.commands.find((command) => (
    command.path === requested
    || command.name === requested
    || command.title === requested
    || command.id === requested
  )) || commands.commands.find((command) => (
    command.path.toLowerCase() === requestedLower
    || command.name.toLowerCase() === requestedLower
    || command.title.toLowerCase() === requestedLower
    || command.id.toLowerCase() === requestedLower
  ));
  const normalized = validatePluginCommandPath(matched ? matched.path : requested);
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("plugin_command_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("plugin_command_read target is too large.");
  const content = await readFile(target, "utf8");
  const parsed = parseMarkdownFrontmatter(content);
  const pluginRoot = path.dirname(path.dirname(normalized)).replace(/\\+/g, "/");
  const plugins = await listPlugins(root, { maxResults: 200 });
  const plugin = plugins.plugins.find((item) => item.root === pluginRoot) || { name: path.basename(pluginRoot), id: path.basename(pluginRoot), root: pluginRoot };
  const command = normalizePluginCommandMetadata(normalized, content, plugin);
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  const bodyPreview = truncateText(parsed.body.trim(), maxChars);
  return {
    path: normalized,
    root: pluginRoot,
    bytes: info.size,
    content: preview.text,
    body: bodyPreview.text,
    metadata: parsed.metadata,
    command,
    plugin,
    truncated: preview.truncated || bodyPreview.truncated,
  };
}

async function installPluginCommand(root, body = {}) {
  const requested = String(body.path || body.command || body.name || "").trim();
  if (!requested) throw new Error("plugin_command_install requires path, command, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const commands = await listPluginCommands(root, { plugin: pluginFilter, includeDisabled: body.includeDisabled === true, maxResults: 500 });
  const requestedLower = requested.toLowerCase();
  const sourceCommand = commands.commands.find((command) => (
    command.path === requested
    || command.name === requested
    || command.title === requested
    || command.id === requested
  )) || commands.commands.find((command) => (
    command.path.toLowerCase() === requestedLower
    || command.name.toLowerCase() === requestedLower
    || command.title.toLowerCase() === requestedLower
    || command.id.toLowerCase() === requestedLower
  ));
  if (!sourceCommand) throw new Error(`Plugin command not found: ${requested}`);
  const sourceFile = workspacePath(root, validatePluginCommandPath(sourceCommand.path));
  const sourceReal = await realpath(sourceFile);
  const pluginRoot = await realpath(workspacePath(root, sourceCommand.pluginRoot));
  if (!isPathInside(pluginRoot, sourceReal)) throw new Error("plugin_command_install source escapes the selected plugin directory.");
  const defaultName = sourceCommand.name || path.basename(sourceCommand.path, path.extname(sourceCommand.path));
  const normalizedTargetName = normalizeInstallName(body.targetName || defaultName, "plugin_command_install");
  const targetFileName = /\.md$/i.test(normalizedTargetName) ? normalizedTargetName : `${normalizedTargetName}.md`;
  const targetRelativePath = `.oases/commands/${targetFileName}`;
  await mkdir(workspacePath(root, ".oases/commands"), { recursive: true });
  const targetFile = workspacePath(root, targetRelativePath);
  if (await fileExists(targetFile)) throw new Error(`Workspace command already exists: ${targetRelativePath}`);
  await copyFile(sourceReal, targetFile);
  const installedInfo = await stat(targetFile);
  return {
    installed: true,
    name: path.basename(targetFileName, path.extname(targetFileName)),
    sourceCommand,
    sourcePlugin: sourceCommand.plugin,
    path: targetRelativePath,
    bytes: installedInfo.size,
    artifacts: [{ type: "file", role: "installed_plugin_command", path: targetRelativePath, bytes: installedInfo.size }],
  };
}

function normalizeOutputStyleMetadata(file, content = "", plugin = undefined) {
  const parsed = parseMarkdownFrontmatter(content);
  const fallbackName = path.basename(file, path.extname(file));
  const heading = parsed.body.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() || "";
  const metadataName = typeof parsed.metadata.name === "string" && parsed.metadata.name ? parsed.metadata.name : "";
  const title = typeof parsed.metadata.title === "string" && parsed.metadata.title
    ? parsed.metadata.title
    : heading || metadataName || fallbackName;
  const pluginName = plugin ? plugin.name || plugin.id || path.basename(path.dirname(path.dirname(file))) : "";
  return {
    id: pluginName ? `${pluginName}:${metadataName || fallbackName}` : metadataName || fallbackName,
    name: metadataName || fallbackName,
    title,
    description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : "",
    path: file,
    source: plugin ? "plugin" : "workspace",
    ...(plugin ? { plugin: pluginName, pluginRoot: plugin.root || path.dirname(path.dirname(file)).replace(/\\+/g, "/") } : {}),
    metadata: parsed.metadata,
  };
}

async function walkOutputStyleFiles(root, maxResults = 100) {
  const stylesRoot = path.join(root, ".oases", "output-styles");
  const files = [];
  async function visit(directory) {
    if (files.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxResults) return;
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.(md|json)$/i.test(entry.name)) files.push(relative);
    }
  }
  await visit(stylesRoot);
  return files;
}

async function listOutputStyles(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const files = (await walkOutputStyleFiles(root, maxResults * 4))
    .filter((file) => file.startsWith(".oases/output-styles/"))
    .slice(0, maxResults);
  const outputStyles = [];
  for (const file of files) {
    try {
      const target = workspacePath(root, file);
      const info = await stat(target);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      const content = await readFile(target, "utf8");
      outputStyles.push({ ...normalizeOutputStyleMetadata(file, content), bytes: info.size });
    } catch {
      // Ignore unreadable output style files.
    }
  }
  outputStyles.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return { outputStyles, count: outputStyles.length, root: ".oases/output-styles", truncated: files.length >= maxResults };
}

function validateOutputStylePath(stylePath) {
  const normalized = String(stylePath || "").replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/output-styles/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("output_style_read can only read output style files under .oases/output-styles.");
  }
  if (!/\.(md|json)$/i.test(normalized)) throw new Error("output_style_read can only read Markdown or JSON output style files.");
  return normalized;
}

async function readOutputStyle(root, body = {}) {
  const requested = String(body.path || body.outputStyle || body.style || body.name || "").trim();
  if (!requested) throw new Error("output_style_read requires path, outputStyle, style, or name.");
  const outputStyles = await listOutputStyles(root, { maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const matched = outputStyles.outputStyles.find((style) => (
    style.path === requested
    || style.name === requested
    || style.title === requested
    || style.id === requested
  )) || outputStyles.outputStyles.find((style) => (
    style.path.toLowerCase() === requestedLower
    || style.name.toLowerCase() === requestedLower
    || style.title.toLowerCase() === requestedLower
    || style.id.toLowerCase() === requestedLower
  ));
  const normalized = validateOutputStylePath(matched ? matched.path : requested);
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("output_style_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("output_style_read target is too large.");
  const content = await readFile(target, "utf8");
  const parsed = parseMarkdownFrontmatter(content);
  const outputStyle = normalizeOutputStyleMetadata(normalized, content);
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  const bodyPreview = truncateText(parsed.body.trim(), maxChars);
  return {
    path: normalized,
    bytes: info.size,
    content: preview.text,
    body: bodyPreview.text,
    metadata: parsed.metadata,
    outputStyle,
    truncated: preview.truncated || bodyPreview.truncated,
  };
}

async function listPluginOutputStyles(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const requestedPlugin = String(body.plugin || body.name || "").trim();
  const requestedLower = requestedPlugin.toLowerCase();
  const plugins = await listPlugins(root, { maxResults: 200 });
  const includeDisabled = body.includeDisabled === true;
  const selectedPlugins = plugins.plugins
    .filter((plugin) => !requestedPlugin || matchesPluginRequest(plugin, requestedPlugin, requestedLower))
    .filter((plugin) => includeDisabled || plugin.enabled !== false);
  const outputStyles = [];
  for (const plugin of selectedPlugins) {
    for (const stylePath of plugin.outputStyles || []) {
      if (outputStyles.length >= maxResults) break;
      try {
        const target = workspacePath(root, stylePath);
        const info = await stat(target);
        if (!info.isFile() || info.size > 512 * 1024) continue;
        const content = await readFile(target, "utf8");
        outputStyles.push({ ...normalizeOutputStyleMetadata(stylePath, content, plugin), bytes: info.size });
      } catch {
        // Ignore unreadable plugin output style files.
      }
    }
    if (outputStyles.length >= maxResults) break;
  }
  outputStyles.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return {
    outputStyles,
    count: outputStyles.length,
    plugin: requestedPlugin || undefined,
    root: ".oases/plugins/*/output-styles",
    truncated: outputStyles.length >= maxResults,
  };
}

function validatePluginOutputStylePath(stylePath) {
  const normalized = String(stylePath || "").replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/plugins/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("plugin_output_style_read can only read output style files under .oases/plugins.");
  }
  if (!normalized.includes("/output-styles/") || !/\.(md|json)$/i.test(normalized)) {
    throw new Error("plugin_output_style_read can only read Markdown or JSON output style files under a plugin output-styles directory.");
  }
  return normalized;
}

async function readPluginOutputStyle(root, body = {}) {
  const requested = String(body.path || body.outputStyle || body.style || body.name || "").trim();
  if (!requested) throw new Error("plugin_output_style_read requires path, outputStyle, style, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const outputStyles = await listPluginOutputStyles(root, { plugin: pluginFilter, includeDisabled: body.includeDisabled === true, maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const matched = outputStyles.outputStyles.find((style) => (
    style.path === requested
    || style.name === requested
    || style.title === requested
    || style.id === requested
  )) || outputStyles.outputStyles.find((style) => (
    style.path.toLowerCase() === requestedLower
    || style.name.toLowerCase() === requestedLower
    || style.title.toLowerCase() === requestedLower
    || style.id.toLowerCase() === requestedLower
  ));
  const normalized = validatePluginOutputStylePath(matched ? matched.path : requested);
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("plugin_output_style_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("plugin_output_style_read target is too large.");
  const content = await readFile(target, "utf8");
  const parsed = parseMarkdownFrontmatter(content);
  const pluginRoot = normalized.split("/output-styles/")[0];
  const plugins = await listPlugins(root, { maxResults: 200 });
  const plugin = plugins.plugins.find((item) => item.root === pluginRoot) || { name: path.basename(pluginRoot), id: path.basename(pluginRoot), root: pluginRoot };
  const outputStyle = normalizeOutputStyleMetadata(normalized, content, plugin);
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  const bodyPreview = truncateText(parsed.body.trim(), maxChars);
  return {
    path: normalized,
    root: pluginRoot,
    bytes: info.size,
    content: preview.text,
    body: bodyPreview.text,
    metadata: parsed.metadata,
    outputStyle,
    plugin,
    truncated: preview.truncated || bodyPreview.truncated,
  };
}

async function installPluginOutputStyle(root, body = {}) {
  const requested = String(body.path || body.outputStyle || body.style || body.name || "").trim();
  if (!requested) throw new Error("plugin_output_style_install requires path, outputStyle, style, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const outputStyles = await listPluginOutputStyles(root, { plugin: pluginFilter, includeDisabled: body.includeDisabled === true, maxResults: 500 });
  const requestedLower = requested.toLowerCase();
  const sourceStyle = outputStyles.outputStyles.find((style) => (
    style.path === requested
    || style.name === requested
    || style.title === requested
    || style.id === requested
  )) || outputStyles.outputStyles.find((style) => (
    style.path.toLowerCase() === requestedLower
    || style.name.toLowerCase() === requestedLower
    || style.title.toLowerCase() === requestedLower
    || style.id.toLowerCase() === requestedLower
  ));
  if (!sourceStyle) throw new Error(`Plugin output style not found: ${requested}`);
  const sourceFile = workspacePath(root, validatePluginOutputStylePath(sourceStyle.path));
  const sourceReal = await realpath(sourceFile);
  const pluginRoot = await realpath(workspacePath(root, sourceStyle.pluginRoot));
  if (!isPathInside(pluginRoot, sourceReal)) throw new Error("plugin_output_style_install source escapes the selected plugin directory.");
  const defaultName = sourceStyle.name || path.basename(sourceStyle.path, path.extname(sourceStyle.path));
  const normalizedTargetName = normalizeInstallName(body.targetName || defaultName, "plugin_output_style_install");
  const sourceExt = path.extname(sourceStyle.path).toLowerCase() || ".md";
  const targetFileName = /\.(md|json)$/i.test(normalizedTargetName) ? normalizedTargetName : `${normalizedTargetName}${sourceExt}`;
  const targetRelativePath = `.oases/output-styles/${targetFileName}`;
  await mkdir(workspacePath(root, ".oases/output-styles"), { recursive: true });
  const targetFile = workspacePath(root, targetRelativePath);
  if (await fileExists(targetFile)) throw new Error(`Workspace output style already exists: ${targetRelativePath}`);
  await copyFile(sourceReal, targetFile);
  const installedInfo = await stat(targetFile);
  return {
    installed: true,
    name: path.basename(targetFileName, path.extname(targetFileName)),
    sourceStyle,
    sourcePlugin: sourceStyle.plugin,
    path: targetRelativePath,
    bytes: installedInfo.size,
    artifacts: [{ type: "file", role: "installed_plugin_output_style", path: targetRelativePath, bytes: installedInfo.size }],
  };
}

function normalizeAgentFileId(file) {
  const base = path.basename(file, path.extname(file));
  if (/^AGENT$/i.test(base)) return path.basename(path.dirname(file));
  return base;
}

function parseOptionalBoolean(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(normalized)) return true;
  if (["false", "no", "0", "off"].includes(normalized)) return false;
  return undefined;
}

function parseOptionalPositiveInteger(value, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseEffortValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["low", "medium", "high", "max"].includes(normalized)) return normalized;
  return undefined;
}

function parseCommaSeparatedList(value) {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item || "").trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeAgentMetadata(file, metadata = {}) {
  const fallbackId = normalizeAgentFileId(file);
  const name = typeof metadata.name === "string" && metadata.name ? metadata.name : fallbackId;
  const agentType = ["general", "explore", "plan", "verify"].includes(metadata.agentType) ? metadata.agentType : undefined;
  const maxTurns = parseOptionalPositiveInteger(metadata.maxTurns, 12);
  const background = parseOptionalBoolean(metadata.background);
  const isolation = ["workspace", "worktree"].includes(metadata.isolation) ? metadata.isolation : undefined;
  const effort = parseEffortValue(metadata.effort);
  const tools = parseCommaSeparatedList(metadata.tools);
  const disallowedTools = parseCommaSeparatedList(metadata.disallowedTools);
  const skills = parseCommaSeparatedList(metadata.skills);
  const commands = parseCommaSeparatedList(metadata.commands);
  const memories = parseCommaSeparatedList(metadata.memories);
  const initialPrompt = typeof metadata.initialPrompt === "string" && metadata.initialPrompt.trim()
    ? metadata.initialPrompt.trim()
    : undefined;
  return {
    id: name,
    name,
    description: typeof metadata.description === "string" ? metadata.description : "",
    path: file,
    ...(agentType ? { agentType } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    ...(typeof background === "boolean" ? { background } : {}),
    ...(isolation ? { isolation } : {}),
    ...(effort ? { effort } : {}),
    ...(tools ? { tools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(skills ? { skills } : {}),
    ...(commands ? { commands } : {}),
    ...(memories ? { memories } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
  };
}

function normalizePluginAgentMetadata(file, content = "", plugin = {}) {
  const parsed = parseMarkdownFrontmatter(content);
  const agent = normalizeAgentMetadata(file, parsed.metadata);
  const fallbackName = path.basename(file, path.extname(file));
  const pluginName = plugin.name || plugin.id || path.basename(path.dirname(path.dirname(file)));
  return {
    ...agent,
    id: `${pluginName}:${agent.name || fallbackName}`,
    plugin: pluginName,
    pluginRoot: plugin.root || path.dirname(path.dirname(file)).replace(/\\+/g, "/"),
    source: "plugin",
    metadata: parsed.metadata,
  };
}

async function listPluginAgents(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const requestedPlugin = String(body.plugin || body.name || "").trim();
  const requestedLower = requestedPlugin.toLowerCase();
  const plugins = await listPlugins(root, { maxResults: 200 });
  const includeDisabled = body.includeDisabled === true;
  const selectedPlugins = requestedPlugin
    ? plugins.plugins.filter((plugin) => (
      plugin.name === requestedPlugin
      || plugin.id === requestedPlugin
      || plugin.root === requestedPlugin
      || plugin.path === requestedPlugin
      || plugin.name.toLowerCase() === requestedLower
      || plugin.id.toLowerCase() === requestedLower
      || plugin.root.toLowerCase() === requestedLower
      || plugin.path.toLowerCase() === requestedLower
    ))
    : plugins.plugins.filter((plugin) => includeDisabled || plugin.enabled !== false);
  const agents = [];
  for (const plugin of selectedPlugins) {
    for (const agentPath of plugin.agents || []) {
      if (agents.length >= maxResults) break;
      try {
        const info = await stat(workspacePath(root, agentPath));
        if (!info.isFile() || info.size > 512 * 1024) continue;
        const content = await readFile(workspacePath(root, agentPath), "utf8");
        agents.push({ ...normalizePluginAgentMetadata(agentPath, content, plugin), bytes: info.size });
      } catch {
        // Ignore unreadable plugin agent files.
      }
    }
    if (agents.length >= maxResults) break;
  }
  agents.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return {
    agents,
    count: agents.length,
    plugin: requestedPlugin || undefined,
    root: ".oases/plugins/*/agents",
    truncated: agents.length >= maxResults,
  };
}

function validatePluginAgentPath(agentPath) {
  const normalized = String(agentPath || "").replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/plugins/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("plugin_agent_read can only read agent files under .oases/plugins.");
  }
  if (!normalized.includes("/agents/") || !/\.md$/i.test(normalized)) {
    throw new Error("plugin_agent_read can only read Markdown agent files under a plugin agents directory.");
  }
  return normalized;
}

async function readPluginAgent(root, body = {}) {
  const requested = String(body.path || body.agent || body.name || "").trim();
  if (!requested) throw new Error("plugin_agent_read requires path, agent, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const agents = await listPluginAgents(root, { plugin: pluginFilter, maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const matched = agents.agents.find((agent) => (
    agent.path === requested
    || agent.name === requested
    || agent.id === requested
  )) || agents.agents.find((agent) => (
    agent.path.toLowerCase() === requestedLower
    || agent.name.toLowerCase() === requestedLower
    || agent.id.toLowerCase() === requestedLower
  ));
  const normalized = validatePluginAgentPath(matched ? matched.path : requested);
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("plugin_agent_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("plugin_agent_read target is too large.");
  const content = await readFile(target, "utf8");
  const parsed = parseMarkdownFrontmatter(content);
  const pluginRoot = path.dirname(path.dirname(normalized)).replace(/\\+/g, "/");
  const plugins = await listPlugins(root, { maxResults: 200 });
  const plugin = plugins.plugins.find((item) => item.root === pluginRoot) || { name: path.basename(pluginRoot), id: path.basename(pluginRoot), root: pluginRoot };
  const agent = normalizePluginAgentMetadata(normalized, content, plugin);
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  const promptPreview = truncateText(parsed.body.trim(), maxChars);
  return {
    path: normalized,
    root: pluginRoot,
    bytes: info.size,
    content: preview.text,
    prompt: promptPreview.text,
    metadata: parsed.metadata,
    agent,
    plugin,
    truncated: preview.truncated || promptPreview.truncated,
  };
}

async function installPluginAgent(root, body = {}) {
  const requested = String(body.path || body.agent || body.name || "").trim();
  if (!requested) throw new Error("plugin_agent_install requires path, agent, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const agents = await listPluginAgents(root, { plugin: pluginFilter, includeDisabled: body.includeDisabled === true, maxResults: 500 });
  const requestedLower = requested.toLowerCase();
  const sourceAgent = agents.agents.find((agent) => (
    agent.path === requested
    || agent.name === requested
    || agent.id === requested
  )) || agents.agents.find((agent) => (
    agent.path.toLowerCase() === requestedLower
    || agent.name.toLowerCase() === requestedLower
    || agent.id.toLowerCase() === requestedLower
  ));
  if (!sourceAgent) throw new Error(`Plugin agent not found: ${requested}`);
  const sourceFile = workspacePath(root, validatePluginAgentPath(sourceAgent.path));
  const sourceReal = await realpath(sourceFile);
  const pluginRoot = await realpath(workspacePath(root, sourceAgent.pluginRoot));
  if (!isPathInside(pluginRoot, sourceReal)) throw new Error("plugin_agent_install source escapes the selected plugin directory.");
  const defaultName = sourceAgent.name || path.basename(sourceAgent.path, path.extname(sourceAgent.path));
  const normalizedTargetName = normalizeInstallName(body.targetName || defaultName, "plugin_agent_install");
  const targetFileName = /\.md$/i.test(normalizedTargetName) ? normalizedTargetName : `${normalizedTargetName}.md`;
  const targetRelativePath = `.oases/agents/${targetFileName}`;
  await mkdir(workspacePath(root, ".oases/agents"), { recursive: true });
  const targetFile = workspacePath(root, targetRelativePath);
  if (await fileExists(targetFile)) throw new Error(`Workspace agent already exists: ${targetRelativePath}`);
  await copyFile(sourceReal, targetFile);
  const installedInfo = await stat(targetFile);
  return {
    installed: true,
    name: path.basename(targetFileName, path.extname(targetFileName)),
    sourceAgent,
    sourcePlugin: sourceAgent.plugin,
    path: targetRelativePath,
    bytes: installedInfo.size,
    artifacts: [{ type: "file", role: "installed_plugin_agent", path: targetRelativePath, bytes: installedInfo.size }],
  };
}

function normalizePluginSkillMetadata(file, content = "", plugin = {}) {
  const metadata = parseSkillFrontmatter(content);
  const fallbackName = path.basename(path.dirname(file));
  const name = typeof metadata.name === "string" && metadata.name ? metadata.name : fallbackName;
  const pluginName = plugin.name || plugin.id || path.basename(path.dirname(path.dirname(path.dirname(file))));
  return {
    id: `${pluginName}:${name}`,
    name,
    description: typeof metadata.description === "string" ? metadata.description : "",
    path: file,
    plugin: pluginName,
    pluginRoot: plugin.root || path.dirname(path.dirname(path.dirname(file))).replace(/\\+/g, "/"),
    source: "plugin",
    root: "plugin skills",
    baseDir: path.dirname(file),
    metadata,
  };
}

async function listPluginSkills(root, body = {}) {
  const maxResults = Math.max(1, Math.min(200, Number(body.maxResults) || 50));
  const requestedPlugin = String(body.plugin || body.name || "").trim();
  const requestedLower = requestedPlugin.toLowerCase();
  const plugins = await listPlugins(root, { maxResults: 200 });
  const includeDisabled = body.includeDisabled === true;
  const selectedPlugins = requestedPlugin
    ? plugins.plugins.filter((plugin) => (
      plugin.name === requestedPlugin
      || plugin.id === requestedPlugin
      || plugin.root === requestedPlugin
      || plugin.path === requestedPlugin
      || plugin.name.toLowerCase() === requestedLower
      || plugin.id.toLowerCase() === requestedLower
      || plugin.root.toLowerCase() === requestedLower
      || plugin.path.toLowerCase() === requestedLower
    ))
    : plugins.plugins.filter((plugin) => includeDisabled || plugin.enabled !== false);
  const skills = [];
  for (const plugin of selectedPlugins) {
    for (const skillPath of plugin.skills || []) {
      if (skills.length >= maxResults) break;
      try {
        const target = workspacePath(root, skillPath);
        const info = await stat(target);
        if (!info.isFile() || info.size > 512 * 1024) continue;
        const content = await readFile(target, "utf8");
        skills.push({ ...normalizePluginSkillMetadata(skillPath, content, plugin), baseDir: path.dirname(target), bytes: info.size });
      } catch {
        // Ignore unreadable plugin skill files.
      }
    }
    if (skills.length >= maxResults) break;
  }
  skills.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return {
    skills,
    count: skills.length,
    plugin: requestedPlugin || undefined,
    root: ".oases/plugins/*/skills",
    truncated: skills.length >= maxResults,
  };
}

function validatePluginSkillPath(skillPath) {
  const normalized = String(skillPath || "").replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/plugins/") || normalized.includes("../") || path.isAbsolute(normalized)) {
    throw new Error("plugin_skill_read can only read skill files under .oases/plugins.");
  }
  if (!normalized.includes("/skills/") || !/(^|\/)SKILL\.md$/i.test(normalized)) {
    throw new Error("plugin_skill_read can only read SKILL.md files under a plugin skills directory.");
  }
  return normalized;
}

async function readPluginSkill(root, body = {}) {
  const requested = String(body.path || body.skill || body.name || "").trim();
  if (!requested) throw new Error("plugin_skill_read requires path, skill, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const skills = await listPluginSkills(root, { plugin: pluginFilter, maxResults: 200 });
  const requestedLower = requested.toLowerCase();
  const matched = skills.skills.find((skill) => (
    skill.path === requested
    || skill.name === requested
    || skill.id === requested
  )) || skills.skills.find((skill) => (
    skill.path.toLowerCase() === requestedLower
    || skill.name.toLowerCase() === requestedLower
    || skill.id.toLowerCase() === requestedLower
  ));
  const normalized = validatePluginSkillPath(matched ? matched.path : requested);
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("plugin_skill_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("plugin_skill_read target is too large.");
  const content = await readFile(target, "utf8");
  const pluginRoot = normalized.split("/skills/")[0];
  const plugins = await listPlugins(root, { maxResults: 200 });
  const plugin = plugins.plugins.find((item) => item.root === pluginRoot) || { name: path.basename(pluginRoot), id: path.basename(pluginRoot), root: pluginRoot };
  const skill = { ...normalizePluginSkillMetadata(normalized, content, plugin), baseDir: path.dirname(target) };
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  return {
    path: normalized,
    root: pluginRoot,
    source: "plugin",
    baseDir: path.dirname(target),
    bytes: info.size,
    content: preview.text,
    metadata: parseSkillFrontmatter(content),
    skill,
    plugin,
    truncated: preview.truncated,
  };
}

async function installPluginSkill(root, body = {}) {
  const requested = String(body.path || body.skill || body.name || "").trim();
  if (!requested) throw new Error("plugin_skill_install requires path, skill, or name.");
  const pluginFilter = String(body.plugin || "").trim();
  const skills = await listPluginSkills(root, { plugin: pluginFilter, includeDisabled: body.includeDisabled === true, maxResults: 500 });
  const requestedLower = requested.toLowerCase();
  const sourceSkill = skills.skills.find((skill) => (
    skill.path === requested
    || skill.name === requested
    || skill.id === requested
  )) || skills.skills.find((skill) => (
    skill.path.toLowerCase() === requestedLower
    || skill.name.toLowerCase() === requestedLower
    || skill.id.toLowerCase() === requestedLower
  ));
  if (!sourceSkill) throw new Error(`Plugin skill not found: ${requested}`);
  const sourceFile = workspacePath(root, validatePluginSkillPath(sourceSkill.path));
  const sourceDir = await realpath(path.dirname(sourceFile));
  const pluginRoot = await realpath(workspacePath(root, sourceSkill.pluginRoot));
  if (!isPathInside(pluginRoot, sourceDir)) throw new Error("plugin_skill_install source escapes the selected plugin directory.");
  const targetName = normalizeInstallName(body.targetName || sourceSkill.name || path.basename(sourceDir), "plugin_skill_install");
  const targetRelativeDir = `.oases/skills/${targetName}`;
  await mkdir(workspacePath(root, ".oases/skills"), { recursive: true });
  const targetDir = workspacePath(root, targetRelativeDir);
  if (await directoryExists(targetDir)) throw new Error(`Workspace skill already exists: ${targetRelativeDir}`);
  await copySkillDirectory(sourceDir, targetDir, sourceDir);
  const installedSkillPath = `${targetRelativeDir}/SKILL.md`;
  const installedInfo = await stat(workspacePath(root, installedSkillPath));
  return {
    installed: true,
    name: targetName,
    sourceSkill,
    sourcePlugin: sourceSkill.plugin,
    path: installedSkillPath,
    targetDir: targetRelativeDir,
    bytes: installedInfo.size,
    artifacts: [{ type: "file", role: "installed_plugin_skill", path: installedSkillPath, bytes: installedInfo.size }],
  };
}

async function walkAgentFiles(root, maxResults = 100) {
  const agentsRoot = path.join(root, ".oases", "agents");
  const files = [];
  async function visit(directory) {
    if (files.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxResults) return;
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\+/g, "/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(relative);
    }
  }
  await visit(agentsRoot);
  return files;
}

async function listAgents(root, body = {}) {
  const maxResults = Math.max(1, Math.min(100, Number(body.maxResults) || 50));
  const files = (await walkAgentFiles(root, maxResults * 4))
    .filter((file) => file.startsWith(".oases/agents/"))
    .slice(0, maxResults);
  const agents = [];
  for (const file of files) {
    try {
      const content = await readFile(path.join(root, file), "utf8");
      const { metadata } = parseMarkdownFrontmatter(content);
      agents.push(normalizeAgentMetadata(file, metadata));
    } catch {
      // Ignore unreadable agent files.
    }
  }
  agents.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return { agents, count: agents.length, root: ".oases/agents", truncated: files.length >= maxResults };
}

async function readAgent(root, body = {}) {
  const requested = String(body.path || body.name || "").trim();
  if (!requested) throw new Error("agent_read requires path or name.");
  const agents = await listAgents(root, { maxResults: 100 });
  const matched = agents.agents.find((agent) => agent.name === requested || agent.id === requested || agent.path === requested)
    || agents.agents.find((agent) => agent.name.toLowerCase() === requested.toLowerCase());
  const agentPath = matched ? matched.path : requested;
  const normalized = agentPath.replace(/^\.\//, "").replace(/\\+/g, "/");
  if (!normalized.startsWith(".oases/agents/") || normalized.includes("../")) {
    throw new Error("agent_read can only read files under .oases/agents.");
  }
  const target = workspacePath(root, normalized);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("agent_read target is not a file.");
  if (info.size > 512 * 1024) throw new Error("agent_read target is too large.");
  const content = await readFile(target, "utf8");
  const parsed = parseMarkdownFrontmatter(content);
  const agent = normalizeAgentMetadata(normalized, parsed.metadata);
  const maxChars = Math.max(1000, Math.min(120000, Number(body.maxChars) || 40000));
  const preview = truncateText(content, maxChars);
  const promptPreview = truncateText(parsed.body.trim(), maxChars);
  return {
    path: normalized,
    bytes: info.size,
    content: preview.text,
    prompt: promptPreview.text,
    truncated: preview.truncated || promptPreview.truncated,
    agent: matched ? { ...agent, path: normalized } : agent,
  };
}

function buildEditDiff(filePath, oldText, newText, replacements) {
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ literal replacement x${replacements} @@`,
    ...linePreview(oldText).split("\n").map((line) => `-${line}`),
    ...linePreview(newText).split("\n").map((line) => `+${line}`),
  ].join("\n");
}

async function editFile(root, body) {
  const filePath = body.path ? workspaceRelativePath(root, body.path) : "";
  const oldText = typeof body.oldText === "string" ? body.oldText : "";
  const newText = typeof body.newText === "string" ? body.newText : "";
  const replaceAll = body.replaceAll === true;
  if (!filePath.trim()) throw new Error("edit_file requires path.");
  if (!oldText) throw new Error("edit_file requires a non-empty oldText.");

  const target = workspacePath(root, filePath);
  const content = await readFile(target, "utf8");
  const replacements = countLiteralMatches(content, oldText);
  if (replacements === 0) throw new Error("edit_file oldText was not found.");
  if (!replaceAll && replacements !== 1) throw new Error(`edit_file oldText matched ${replacements} times; pass replaceAll: true or provide a more specific oldText.`);

  const firstIndex = content.indexOf(oldText);
  const nextContent = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
  await writeFile(target, nextContent, "utf8");
  const info = await stat(target);
  return {
    path: filePath,
    bytes: info.size,
    artifacts: [fileArtifact(filePath, info, "edited_file")],
    replacements: replaceAll ? replacements : 1,
    diff: buildEditDiff(filePath, oldText, newText, replaceAll ? replacements : 1),
    beforePreview: previewAround(content, firstIndex, oldText.length),
    afterPreview: previewAround(nextContent, firstIndex, newText.length),
  };
}

export const TOOL_REGISTRY = {
  list_files: {
    name: "list_files",
    title: "List files",
    description: "List files and folders under a workspace path. Accepts relative paths or absolute paths inside the current workspace.",
    risk: "read",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative folder path or absolute path inside the workspace." } } },
    execute: (root, body) => listFiles(root, body).then((entries) => ({ entries })),
  },
  search_files: {
    name: "search_files",
    title: "Search files",
    description: "Recursively search workspace file paths by query or wildcard pattern. Optional path accepts a relative path or absolute path inside the current workspace.",
    risk: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" }, query: { type: "string" }, pattern: { type: "string" }, maxResults: { type: "number" } } },
    execute: (root, body) => searchFiles(root, body),
  },
  glob_files: {
    name: "glob_files",
    title: "Glob files",
    description: "Fast file pattern matching inside the workspace. Optional path accepts a relative path or absolute path inside the current workspace. Supports glob patterns like **/*.js or src/**/*.ts and returns matches sorted by modification time.",
    risk: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" }, glob: { type: "string" }, pattern: { type: "string" }, type: { type: "string", description: "Optional file type such as js, ts, py, rust, go, json, md, css, html, vue, yaml, or shell." }, maxResults: { type: "number" } } },
    execute: (root, body) => globFiles(root, body),
  },
  grep_files: {
    name: "grep_files",
    title: "Grep files",
    description: "Recursively search UTF-8 workspace files for literal or regex text matches. Optional path accepts a relative path or absolute path inside the current workspace. Supports glob/type filters and output modes: content, files_with_matches, count.",
    risk: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" }, query: { type: "string" }, regex: { type: "string" }, useRegex: { type: "boolean" }, glob: { type: "string" }, pattern: { type: "string" }, type: { type: "string" }, outputMode: { type: "string", enum: ["content", "files_with_matches", "count"] }, caseSensitive: { type: "boolean" }, maxResults: { type: "number" } } },
    execute: (root, body) => grepFiles(root, body),
  },
  workspace_status: {
    name: "workspace_status",
    title: "Workspace status",
    description: "Summarize local git workspace changes, including status, diff stats, and optional truncated diffs for review.",
    risk: "read",
    inputSchema: { type: "object", properties: { includeDiff: { type: "boolean" }, includeUntrackedPreview: { type: "boolean" }, maxChars: { type: "number" } } },
    execute: (root, body, options) => workspaceStatus(root, body, options),
  },
  worktree_list: {
    name: "worktree_list",
    title: "List git worktrees",
    description: "List git worktrees linked to the current workspace. Use this to find isolated Oases sub-agent worktrees before inspecting, applying, or removing them.",
    risk: "read",
    inputSchema: { type: "object", properties: { includeStatus: { type: "boolean", description: "If true, include a compact status summary for linked non-main worktrees." } } },
    execute: (root, body, options) => listWorktrees(root, body, options),
  },
  worktree_diff: {
    name: "worktree_diff",
    title: "Inspect worktree diff",
    description: "Inspect changes in a linked git worktree by absolute worktreePath. The path must belong to this workspace's git worktree list.",
    risk: "read",
    inputSchema: { type: "object", required: ["worktreePath"], properties: { worktreePath: { type: "string" }, includeDiff: { type: "boolean" }, includeUntrackedPreview: { type: "boolean" }, maxChars: { type: "number" } } },
    execute: (root, body, options) => worktreeDiff(root, body, options),
  },
  worktree_apply: {
    name: "worktree_apply",
    title: "Apply worktree changes",
    description: "Copy selected changed files from a linked git worktree back into the main workspace. Refuses to overwrite dirty main-workspace paths unless force is true.",
    risk: "destructive",
    inputSchema: { type: "object", required: ["worktreePath"], properties: { worktreePath: { type: "string" }, paths: { type: "array", items: { type: "string" }, description: "Optional changed file paths to apply. If omitted, applies all supported changed files." }, force: { type: "boolean", description: "Allow overwriting dirty files at the same paths in the main workspace." } } },
    execute: (root, body, options) => worktreeApply(root, body, options),
  },
  worktree_remove: {
    name: "worktree_remove",
    title: "Remove worktree",
    description: "Remove a linked git worktree. Refuses to remove dirty worktrees unless force is true.",
    risk: "destructive",
    inputSchema: { type: "object", required: ["worktreePath"], properties: { worktreePath: { type: "string" }, force: { type: "boolean", description: "Discard worktree changes while removing it." } } },
    execute: (root, body, options) => worktreeRemove(root, body, options),
  },
  read_file: {
    name: "read_file",
    title: "Read file",
    description: "Read a UTF-8 text file from the local workspace. Accepts a relative path or absolute path inside the current workspace. Optional offset/limit reads a targeted line range; numbered returns cat -n style line numbers.",
    risk: "read",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Relative file path or absolute path inside the workspace." }, offset: { type: "number", description: "Zero-based line offset." }, limit: { type: "number", description: "Maximum number of lines to read, capped at 2000." }, numbered: { type: "boolean", description: "Return cat -n style line numbers." }, maxChars: { type: "number" } } },
    execute: async (root, body) => {
      const normalizedPath = workspaceRelativePath(root, body.path);
      const target = workspacePath(root, normalizedPath);
      const content = await readFile(target, "utf8");
      return { path: normalizedPath, ...readFileRangeContent(content, body) };
    },
  },
  write_file: {
    name: "write_file",
    title: "Write file",
    description: "Write a UTF-8 text file inside the local workspace, creating parent folders as needed. Accepts a relative path or absolute path inside the current workspace.",
    risk: "write",
    inputSchema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
    execute: async (root, body) => {
      const normalizedPath = workspaceRelativePath(root, body.path);
      let target = workspacePath(root, normalizedPath);
      await mkdir(path.dirname(target), { recursive: true });
      target = workspacePath(root, normalizedPath);
      await writeFile(target, String(body.content ?? ""), "utf8");
      const info = await stat(target);
      return { path: normalizedPath, bytes: info.size, artifacts: [fileArtifact(normalizedPath, info, "created_or_updated_file")] };
    },
  },
  edit_file: {
    name: "edit_file",
    title: "Edit file",
    description: "Precisely edit a UTF-8 text file by replacing an exact oldText fragment with newText. By default oldText must match exactly once.",
    risk: "write",
    inputSchema: { type: "object", required: ["path", "oldText", "newText"], properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } } },
    execute: (root, body) => editFile(root, body),
  },
  delete_file: {
    name: "delete_file",
    title: "Delete file",
    description: "Delete a file or folder inside the local workspace. Accepts a relative path or absolute path inside the current workspace.",
    risk: "destructive",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    execute: async (root, body) => {
      const normalizedPath = workspaceRelativePath(root, body.path);
      const target = workspacePath(root, normalizedPath);
      await rm(target, { recursive: true, force: false });
      return { path: normalizedPath, artifacts: [{ type: "file", role: "deleted_file", path: normalizedPath }] };
    },
  },
  fetch_url: {
    name: "fetch_url",
    title: "Fetch URL",
    description: "Fetch a public HTTP/HTTPS URL as text for analysis. Private network targets are blocked.",
    risk: "network",
    inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" }, maxChars: { type: "number" } } },
    execute: (_root, body, options) => fetchUrl(body, options.signal),
  },
  web_search: {
    name: "web_search",
    title: "Web search",
    description: "Search the web using DuckDuckGo HTML API. Returns structured results with titles, URLs, and snippets. Use this for current information, news, documentation lookup, or fact-checking. No API key required.",
    risk: "network",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, maxResults: { type: "number" } } },
    execute: (_root, body, options) => webSearch(body, options.signal),
  },
  mcp_list: {
    name: "mcp_list",
    title: "List MCP server tools",
    description: "List available tools from MCP servers configured in .oases/settings.json mcpServers. Returns tool names, descriptions, and input schemas from each server.",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
    execute: (root) => listMcpTools(root),
  },
  mcp_call: {
    name: "mcp_call",
    title: "Call MCP server tool",
    description: "Call a tool on a configured MCP server. The server must be listed in .oases/settings.json mcpServers.",
    risk: "network",
    inputSchema: { type: "object", required: ["server", "tool"], properties: { server: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } } },
    execute: (root, body) => callMcpTool(root, String(body.server || ""), String(body.tool || ""), body.arguments || {}),
  },
  mcp_resources_list: {
    name: "mcp_resources_list",
    title: "List MCP server resources",
    description: "List available resources from configured MCP servers. Resources are data sources exposed by MCP servers.",
    risk: "read",
    inputSchema: { type: "object", properties: { server: { type: "string", description: "Optional server name filter" } } },
    execute: (root, body) => listMcpResources(root, body.server),
  },
  mcp_resource_read: {
    name: "mcp_resource_read",
    title: "Read MCP server resource",
    description: "Read a specific resource from an MCP server by URI.",
    risk: "read",
    inputSchema: { type: "object", required: ["server", "uri"], properties: { server: { type: "string" }, uri: { type: "string" } } },
    execute: (root, body) => readMcpResource(root, String(body.server || ""), String(body.uri || "")),
  },
  run_command: {
    name: "run_command",
    title: "Run shell command",
    description: "Run a shell command with timeout and basic dangerous-command blocking. By default cwd is the workspace root; cwd may be a relative path or absolute path inside the workspace. Shell commands may reference absolute paths when the user explicitly requested them, but high-risk commands require approval.",
    risk: "execution",
    inputSchema: { type: "object", required: ["command"], properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } } },
    execute: async (root, body, options) => {
      const command = String(body.command || "").trim();
      if (!command) throw new Error("run_command requires command.");
      const dangerousReason = getDangerousCommandReason(command);
      if (dangerousReason) throw new Error(`Command blocked by ocli safety rules: ${dangerousReason}`);
      const cwd = body.cwd ? workspacePath(root, body.cwd) : root;
      const before = await snapshotWorkspaceFiles(root);
      const result = await runProcess(command, { cwd, timeoutMs: Math.max(1000, Math.min(120000, Number(body.timeoutMs) || 30000)), signal: options.signal });
      const artifacts = await changedFileArtifacts(root, before);
      return { ...result, ...(artifacts.length ? { artifacts } : {}) };
    },
  },
  run_python: {
    name: "run_python",
    title: "Run Python",
    description: "Run a Python snippet with timeout. By default cwd is the workspace root; cwd may be a relative path or absolute path inside the workspace.",
    risk: "execution",
    inputSchema: { type: "object", required: ["script"], properties: { script: { type: "string" }, cwd: { type: "string" }, python: { type: "string" }, timeoutMs: { type: "number" } } },
    execute: async (root, body, options) => {
      const script = String(body.script || "");
      if (!script.trim()) throw new Error("run_python requires script.");
      const cwd = body.cwd ? workspacePath(root, body.cwd) : root;
      const python = String(body.python || process.env.PYTHON || "python3");
      const before = await snapshotWorkspaceFiles(root);
      const result = await runProcess(`${JSON.stringify(python)} -c ${JSON.stringify(script)}`, { cwd, timeoutMs: Math.max(1000, Math.min(120000, Number(body.timeoutMs) || 30000)), signal: options.signal });
      const artifacts = await changedFileArtifacts(root, before);
      return { ...result, ...(artifacts.length ? { artifacts } : {}) };
    },
  },
  todo_write: {
    name: "todo_write",
    title: "Update task todos",
    description: "Update the structured project task checklist. Todos are persisted to .oases/todo.json in the workspace.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            required: ["text", "status"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["todo", "doing", "done"] },
            },
          },
        },
      },
    },
    execute: async (root, body) => {
      const todos = normalizeTodos(body);
      const counts = todos.reduce((acc, todo) => {
        acc[todo.status] = (acc[todo.status] || 0) + 1;
        return acc;
      }, {});
      // Persist to .oases/todo.json so todo_read and future sessions can load it
      try {
        const todoDir = workspacePath(root, ".oases");
        await mkdir(todoDir, { recursive: true });
        const todoPath = workspacePath(root, ".oases/todo.json");
        await writeFile(todoPath, JSON.stringify({ todos, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
      } catch {
        // Silent fallback: todo_write still returns results even if persistence fails
      }
      return { todos, count: todos.length, counts, summary: summarizeTodos(todos), persisted: true };
    },
  },
  todo_read: {
    name: "todo_read",
    title: "Read task todos",
    description: "Read the current project task checklist from the workspace .oases/todo.json file.",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
    execute: async (root) => {
      const todoPath = workspacePath(root, ".oases/todo.json");
      try {
        const fileContent = await readFile(todoPath, "utf8");
        const parsed = JSON.parse(fileContent);
        const todos = Array.isArray(parsed?.todos) ? parsed.todos : [];
        const counts = todos.reduce((acc, todo) => {
          const s = ["todo", "doing", "done"].includes(todo?.status) ? todo.status : "todo";
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {});
        return { todos, count: todos.length, counts, summary: summarizeTodos(todos), path: ".oases/todo.json" };
      } catch (error) {
        if (error?.code === "ENOENT") return { todos: [], count: 0, counts: {}, summary: "", note: "No .oases/todo.json found." };
        throw error;
      }
    },
  },
  settings_list: {
    name: "settings_list",
    title: "List workspace settings",
    description: "List project settings files under .oases and, when requested, .claude. Values are summarized by shape and sensitive keys are redacted; settings are not applied by this tool.",
    risk: "read",
    inputSchema: { type: "object", properties: { includeClaude: { type: "boolean", description: "Also include Claude-style .claude/settings.json and .claude/settings.local.json for compatibility audits." } } },
    execute: (root, body) => listWorkspaceSettings(root, body),
  },
  settings_read: {
    name: "settings_read",
    title: "Read workspace settings",
    description: "Read a project settings file from .oases/settings.json or .oases/settings.local.json. With includeClaude, can also inspect .claude/settings.json or .claude/settings.local.json. Values are shape-only and sensitive keys are redacted.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, settings: { type: "string" }, path: { type: "string" }, includeClaude: { type: "boolean" } } },
    execute: (root, body) => readWorkspaceSettings(root, body),
  },
  settings_write: {
    name: "settings_write",
    title: "Write workspace settings",
    description: "Safely merge key/value pairs into .oases/settings.local.json (the local-only settings file). Sensitive keys like tokens and passwords are rejected. Only whitelisted top-level keys are accepted. The file is created if missing.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["settings"],
      properties: {
        settings: {
          type: "object",
          description: "Key/value pairs to merge into settings.local.json. Allowed top-level keys: outputStyle, mcpServers, permissions, defaultMode, todoWrite, autoContinue.",
        },
        path: { type: "string", description: "Target settings path. Defaults to .oases/settings.local.json." },
      },
    },
    execute: async (root, body) => {
      const settingsPath = typeof body.path === "string" && body.path.trim() ? body.path.trim() : ".oases/settings.local.json";
      if (!settingsPath.startsWith(".oases/") || (!settingsPath.endsWith("settings.json") && !settingsPath.endsWith("settings.local.json"))) {
        throw new Error("settings_write can only write to .oases/settings.json or .oases/settings.local.json.");
      }
      const target = workspacePath(root, settingsPath);
      // Verify resolved path stays within workspace
      const resolvedTarget = path.resolve(target);
      const resolvedRoot = path.resolve(root);
      if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
        throw new Error("settings_write target is outside workspace.");
      }
      const ALLOWED_KEYS = new Set(["outputStyle", "mcpServers", "permissions", "defaultMode", "autoContinue", "todoWrite"]);
      const input = body.settings;
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("settings_write requires a settings object.");
      const merged = {};
      for (const [key, value] of Object.entries(input)) {
        if (SENSITIVE_KEY_RE.test(key)) throw new Error(`settings_write rejected sensitive key: ${key}`);
        if (!ALLOWED_KEYS.has(key)) throw new Error(`settings_write rejected unknown key: ${key}. Allowed: ${[...ALLOWED_KEYS].join(", ")}`);
        merged[key] = value;
      }
      let existing = {};
      try {
        existing = JSON.parse(await readFile(target, "utf8"));
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) existing = {};
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const result = { ...existing, ...merged };
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(result, null, 2) + "\n", "utf8");
      const changedKeys = Object.keys(merged);
      return { path: settingsPath, changedKeys, merged: changedKeys.length, note: `Updated ${changedKeys.join(", ")} in ${settingsPath}` };
    },
  },
  memory_list: {
    name: "memory_list",
    title: "List project memories",
    description: "List project memory Markdown files under .oases/memory/project, .oases/memory/team, or .oases/memory/private. This only discovers memory metadata; it does not automatically apply memory.",
    risk: "read",
    inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["project", "team", "private"] }, maxResults: { type: "number" } } },
    execute: (root, body) => listMemories(root, body),
  },
  memory_read: {
    name: "memory_read",
    title: "Read project memory",
    description: "Read a Markdown memory file from .oases/memory. Use path, memory, or name; optional scope narrows the lookup.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, memory: { type: "string" }, path: { type: "string" }, scope: { type: "string", enum: ["project", "team", "private"] }, maxChars: { type: "number" } } },
    execute: (root, body) => readMemory(root, body),
  },
  memory_write: {
    name: "memory_write",
    title: "Write project memory",
    description: "Create or replace a Markdown memory file under .oases/memory/<scope>. Use this only when the user explicitly asks to remember/save project guidance or when preserving durable project context is clearly useful.",
    risk: "write",
    inputSchema: { type: "object", required: ["content"], properties: { name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, content: { type: "string" }, body: { type: "string" }, scope: { type: "string", enum: ["project", "team", "private"] }, tags: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, path: { type: "string" }, overwrite: { type: "boolean" } } },
    execute: (root, body) => writeMemory(root, body),
  },
  skill_list: {
    name: "skill_list",
    title: "List Oases skills",
    description: "List Oases skills from the current workspace .oases/skills and bundled OcliSkills. Use this before reading a matching skill.",
    risk: "read",
    inputSchema: { type: "object", properties: { maxResults: { type: "number" } } },
    execute: (root, body) => listSkills(root, body),
  },
  skill_read: {
    name: "skill_read",
    title: "Read Oases skill",
    description: "Read a workspace-local or bundled Oases SKILL.md by skill name or relative path.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readSkill(root, body),
  },
  skill_asset_list: {
    name: "skill_asset_list",
    title: "List Oases skill assets",
    description: "List files inside a workspace-local or bundled Oases skill directory, such as references, scripts, and evals. Accepts a skill name plus optional assetPath, or a direct path under .oases/skills or OcliSkills.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, skill: { type: "string" }, path: { type: "string" }, assetPath: { type: "string" }, maxResults: { type: "number" } } },
    execute: (root, body) => listSkillAssets(root, body),
  },
  skill_asset_read: {
    name: "skill_asset_read",
    title: "Read Oases skill asset",
    description: "Read a UTF-8 text asset inside a workspace-local or bundled Oases skill directory. Use this for skill references, scripts, and examples after skill_read loads the main SKILL.md.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, skill: { type: "string" }, path: { type: "string" }, assetPath: { type: "string" }, file: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readSkillAsset(root, body),
  },
  skill_install: {
    name: "skill_install",
    title: "Install bundled Oases skill",
    description: "Copy a bundled Oases skill into the current workspace under .oases/skills/<targetName> so the project can customize it. Refuses to overwrite an existing workspace skill.",
    risk: "write",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "Bundled skill name to install, such as web-search." }, skill: { type: "string" }, targetName: { type: "string", description: "Optional workspace skill directory name. Defaults to the bundled skill directory name." } } },
    execute: (root, body) => installSkill(root, body),
  },
  command_list: {
    name: "command_list",
    title: "List workspace commands",
    description: "List workspace-local Markdown command templates under .oases/commands. These are reusable prompt templates and are not executed by this tool.",
    risk: "read",
    inputSchema: { type: "object", properties: { maxResults: { type: "number" } } },
    execute: (root, body) => listCommands(root, body),
  },
  command_read: {
    name: "command_read",
    title: "Read workspace command",
    description: "Read a workspace-local Markdown command template under .oases/commands by name or relative path. This does not execute command content.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" }, path: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readCommand(root, body),
  },
  output_style_list: {
    name: "output_style_list",
    title: "List workspace output styles",
    description: "List workspace-local output style templates under .oases/output-styles. These are reusable response style instructions and are not executed by this tool.",
    risk: "read",
    inputSchema: { type: "object", properties: { maxResults: { type: "number" } } },
    execute: (root, body) => listOutputStyles(root, body),
  },
  output_style_read: {
    name: "output_style_read",
    title: "Read workspace output style",
    description: "Read and explicitly load a workspace-local output style template under .oases/output-styles by name or relative path for the current agent session.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, outputStyle: { type: "string" }, style: { type: "string" }, path: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readOutputStyle(root, body),
  },
  plugin_list: {
    name: "plugin_list",
    title: "List workspace plugins",
    description: "List workspace-local Oases/Claude-style plugin manifests under .oases/plugins. This discovers plugin.json plus command, agent, hook, and README file summaries.",
    risk: "read",
    inputSchema: { type: "object", properties: { maxResults: { type: "number" } } },
    execute: (root, body) => listPlugins(root, body),
  },
  plugin_read: {
    name: "plugin_read",
    title: "Read workspace plugin",
    description: "Read a workspace-local plugin manifest under .oases/plugins by plugin name, root, or manifest path. Supports .oases-plugin/plugin.json and .claude-plugin/plugin.json.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, plugin: { type: "string" }, path: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readPlugin(root, body),
  },
  plugin_capability_list: {
    name: "plugin_capability_list",
    title: "List plugin manifest capabilities",
    description: "List read-only capability summaries from workspace-local plugin manifests, including MCP/LSP declarations, settings keys, custom paths, command metadata, output styles, and settings.json presence. This does not start servers, apply settings, or execute plugin files.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, path: { type: "string" }, includeDisabled: { type: "boolean" }, maxResults: { type: "number" } } },
    execute: (root, body) => listPluginCapabilities(root, body),
  },
  plugin_capability_read: {
    name: "plugin_capability_read",
    title: "Read plugin manifest capabilities",
    description: "Read a single workspace-local plugin's manifest capability details in a safe summarized form. Settings values are shape-only and sensitive keys are redacted; MCP/LSP servers are not started.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, path: { type: "string" }, includeDisabled: { type: "boolean" } } },
    execute: (root, body) => readPluginCapability(root, body),
  },
  plugin_command_list: {
    name: "plugin_command_list",
    title: "List plugin commands",
    description: "List Markdown command templates from workspace-local plugins under .oases/plugins/<plugin>/commands. This is read-only discovery; commands are not executed.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, includeDisabled: { type: "boolean" }, maxResults: { type: "number" } } },
    execute: (root, body) => listPluginCommands(root, body),
  },
  plugin_command_read: {
    name: "plugin_command_read",
    title: "Read plugin command",
    description: "Read a Markdown command template from a workspace-local plugin commands directory by plugin/name or relative path. This does not execute plugin code.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, command: { type: "string" }, path: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readPluginCommand(root, body),
  },
  plugin_command_install: {
    name: "plugin_command_install",
    title: "Install plugin command",
    description: "Copy a Markdown command template from an installed workspace plugin into .oases/commands/<targetName>.md so it can be used as a normal workspace command template.",
    risk: "write",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, command: { type: "string" }, path: { type: "string" }, targetName: { type: "string" }, includeDisabled: { type: "boolean" } } },
    execute: (root, body) => installPluginCommand(root, body),
  },
  plugin_output_style_list: {
    name: "plugin_output_style_list",
    title: "List plugin output styles",
    description: "List output style templates from workspace-local plugins under .oases/plugins/<plugin>/output-styles. This is read-only discovery; styles are not applied automatically.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, includeDisabled: { type: "boolean" }, maxResults: { type: "number" } } },
    execute: (root, body) => listPluginOutputStyles(root, body),
  },
  plugin_output_style_read: {
    name: "plugin_output_style_read",
    title: "Read plugin output style",
    description: "Read and explicitly load an output style template from a workspace-local plugin output-styles directory by plugin/name or relative path for the current agent session. This does not execute plugin code.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, outputStyle: { type: "string" }, style: { type: "string" }, path: { type: "string" }, includeDisabled: { type: "boolean" }, maxChars: { type: "number" } } },
    execute: (root, body) => readPluginOutputStyle(root, body),
  },
  plugin_output_style_install: {
    name: "plugin_output_style_install",
    title: "Install plugin output style",
    description: "Copy an output style template from an installed workspace plugin into .oases/output-styles/<targetName> so it becomes a normal workspace output style.",
    risk: "write",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, outputStyle: { type: "string" }, style: { type: "string" }, path: { type: "string" }, targetName: { type: "string" }, includeDisabled: { type: "boolean" } } },
    execute: (root, body) => installPluginOutputStyle(root, body),
  },
  plugin_hook_list: {
    name: "plugin_hook_list",
    title: "List plugin hooks",
    description: "List hook configuration and handler files from workspace-local plugins under .oases/plugins/<plugin>/hooks or hooks-handlers. This is read-only discovery; hooks are not executed.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, includeDisabled: { type: "boolean" }, maxResults: { type: "number" } } },
    execute: (root, body) => listPluginHooks(root, body),
  },
  plugin_hook_read: {
    name: "plugin_hook_read",
    title: "Read plugin hook",
    description: "Read a hook JSON configuration or hook handler script from a workspace-local plugin by plugin/name or relative path. This does not execute hook code.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, hook: { type: "string" }, path: { type: "string" }, includeDisabled: { type: "boolean" }, maxChars: { type: "number" } } },
    execute: (root, body) => readPluginHook(root, body),
  },
  plugin_agent_list: {
    name: "plugin_agent_list",
    title: "List plugin agents",
    description: "List Markdown agent definitions from workspace-local plugins under .oases/plugins/<plugin>/agents. This is read-only discovery; plugin agents are not executed by this tool.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, includeDisabled: { type: "boolean" }, maxResults: { type: "number" } } },
    execute: (root, body) => listPluginAgents(root, body),
  },
  plugin_agent_read: {
    name: "plugin_agent_read",
    title: "Read plugin agent",
    description: "Read a Markdown agent definition from a workspace-local plugin agents directory by plugin/name or relative path. This does not execute the plugin agent.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, agent: { type: "string" }, path: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readPluginAgent(root, body),
  },
  plugin_agent_install: {
    name: "plugin_agent_install",
    title: "Install plugin agent",
    description: "Copy a Markdown agent definition from an installed workspace plugin into .oases/agents/<targetName>.md so it can be used as a normal workspace custom agent.",
    risk: "write",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, agent: { type: "string" }, path: { type: "string" }, targetName: { type: "string" }, includeDisabled: { type: "boolean" } } },
    execute: (root, body) => installPluginAgent(root, body),
  },
  plugin_skill_list: {
    name: "plugin_skill_list",
    title: "List plugin skills",
    description: "List SKILL.md definitions from workspace-local plugins under .oases/plugins/<plugin>/skills. This is read-only discovery; plugin skills are not installed or executed by this tool.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, includeDisabled: { type: "boolean" }, maxResults: { type: "number" } } },
    execute: (root, body) => listPluginSkills(root, body),
  },
  plugin_skill_read: {
    name: "plugin_skill_read",
    title: "Read plugin skill",
    description: "Read a SKILL.md definition from a workspace-local plugin skills directory by plugin/name or relative path. This does not install or execute the plugin skill.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, skill: { type: "string" }, path: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readPluginSkill(root, body),
  },
  plugin_skill_install: {
    name: "plugin_skill_install",
    title: "Install plugin skill",
    description: "Copy a skill directory from an installed workspace plugin into .oases/skills/<targetName> so the project can load and customize it as a normal workspace skill.",
    risk: "write",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, skill: { type: "string" }, path: { type: "string" }, targetName: { type: "string" }, includeDisabled: { type: "boolean" } } },
    execute: (root, body) => installPluginSkill(root, body),
  },
  plugin_asset_list: {
    name: "plugin_asset_list",
    title: "List plugin assets",
    description: "List files inside a workspace-local plugin directory, such as references, scripts, examples, hooks, skills, commands, and agents. This is read-only and does not execute plugin files.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, path: { type: "string" }, assetPath: { type: "string" }, maxResults: { type: "number" } } },
    execute: (root, body) => listPluginAssets(root, body),
  },
  plugin_asset_read: {
    name: "plugin_asset_read",
    title: "Read plugin asset",
    description: "Read a UTF-8 text file inside a workspace-local plugin directory. This is read-only and does not execute scripts or hooks.",
    risk: "read",
    inputSchema: { type: "object", properties: { plugin: { type: "string" }, name: { type: "string" }, path: { type: "string" }, assetPath: { type: "string" }, file: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readPluginAsset(root, body),
  },
  plugin_install: {
    name: "plugin_install",
    title: "Install workspace plugin",
    description: "Copy a local plugin directory from the current workspace into .oases/plugins/<targetName>. Requires a supported plugin manifest and refuses to overwrite an existing plugin.",
    risk: "write",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Workspace-relative source plugin directory path." }, sourcePath: { type: "string" }, source: { type: "string" }, targetName: { type: "string", description: "Optional plugin directory name under .oases/plugins." } } },
    execute: (root, body) => installPlugin(root, body),
  },
  plugin_remove: {
    name: "plugin_remove",
    title: "Remove workspace plugin",
    description: "Remove an installed workspace-local plugin directory under .oases/plugins. The target must contain a supported plugin manifest and requires destructive approval in agent sessions.",
    risk: "destructive",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Plugin manifest name to remove." }, plugin: { type: "string", description: "Plugin name, id, root, or manifest path." }, path: { type: "string", description: "Installed plugin root or manifest path under .oases/plugins." } } },
    execute: (root, body) => removePlugin(root, body),
  },
  plugin_enable: {
    name: "plugin_enable",
    title: "Enable workspace plugin",
    description: "Re-enable an installed workspace-local plugin by removing its .oases-disabled marker.",
    risk: "write",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Plugin manifest name to enable." }, plugin: { type: "string", description: "Plugin name, id, root, or manifest path." }, path: { type: "string", description: "Installed plugin root or manifest path under .oases/plugins." } } },
    execute: (root, body) => setPluginEnabled(root, body, true),
  },
  plugin_disable: {
    name: "plugin_disable",
    title: "Disable workspace plugin",
    description: "Disable an installed workspace-local plugin by writing a .oases-disabled marker without deleting plugin files.",
    risk: "write",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Plugin manifest name to disable." }, plugin: { type: "string", description: "Plugin name, id, root, or manifest path." }, path: { type: "string", description: "Installed plugin root or manifest path under .oases/plugins." } } },
    execute: (root, body) => setPluginEnabled(root, body, false),
  },
  agent_list: {
    name: "agent_list",
    title: "List workspace agents",
    description: "List workspace-local Oases agent definitions under .oases/agents. Use this before delegating to a named custom agent.",
    risk: "read",
    inputSchema: { type: "object", properties: { maxResults: { type: "number" } } },
    execute: (root, body) => listAgents(root, body),
  },
  agent_read: {
    name: "agent_read",
    title: "Read workspace agent",
    description: "Read a workspace-local agent definition under .oases/agents by agent name or relative path.",
    risk: "read",
    inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" }, maxChars: { type: "number" } } },
    execute: (root, body) => readAgent(root, body),
  },
  agent_run: {
    name: "agent_run",
    title: "Run sub-agent",
    description: "Delegate a bounded engineering subtask to a fresh local Oases sub-agent. Use for independent exploration, verification, or planning work whose detailed tool output should be summarized back to the main agent.",
    risk: "agent",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "Specific subtask for the sub-agent. Include scope, expected output, and constraints." },
        description: { type: "string", description: "Short 3-5 word label for the sub-agent work." },
        agentName: { type: "string", description: "Optional workspace-local custom agent name from .oases/agents." },
        agentType: { type: "string", enum: ["general", "explore", "plan", "verify"], description: "Optional sub-agent role." },
        contextFiles: { type: "array", items: { type: "string" }, description: "Optional relative file paths the sub-agent should inspect first." },
        maxTurns: { type: "number", description: "Maximum model turns for the sub-agent, capped by ocli." },
        runInBackground: { type: "boolean", description: "If true, launch the sub-agent and return immediately. Use agent_status to retrieve completion." },
        isolation: { type: "string", enum: ["workspace", "worktree"], description: "workspace uses the current project directory. worktree creates a detached git worktree so the sub-agent can modify files without touching the main workspace." },
      },
    },
    execute: async () => {
      throw new Error("agent_run is only available inside an ocli agent session.");
    },
  },
  agent_status: {
    name: "agent_status",
    title: "Get sub-agent status",
    description: "Check the status or result of a background sub-agent launched with agent_run(runInBackground: true).",
    risk: "agent",
    inputSchema: {
      type: "object",
      properties: {
        subagentId: { type: "string", description: "Specific background sub-agent id. If omitted, returns all background sub-agents in the current parent agent run." },
      },
    },
    execute: async () => {
      throw new Error("agent_status is only available inside an ocli agent session.");
    },
  },
};

export function listToolCapabilities(options = {}) {
  const allowedNames = Array.isArray(options.allowedToolNames) ? new Set(options.allowedToolNames) : undefined;
  const disallowedNames = Array.isArray(options.disallowedToolNames) ? new Set(options.disallowedToolNames) : undefined;
  return Object.values(TOOL_REGISTRY)
    .filter((tool) => options.includeAgentRun !== false || !["agent_run", "agent_status"].includes(tool.name))
    .filter((tool) => !allowedNames || allowedNames.has(tool.name))
    .filter((tool) => !disallowedNames || !disallowedNames.has(tool.name))
    .map(({ execute: _execute, ...tool }) => tool);
}

export function listOpenAiTools(options = {}) {
  return listToolCapabilities(options).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  }));
}

export function getToolMetadata(name) {
  const tool = TOOL_REGISTRY[name];
  if (!tool) return undefined;
  const { execute: _execute, ...metadata } = tool;
  return metadata;
}

function normalizeShellCommand(command) {
  return String(command || "").trim().replace(/\s+/g, " ");
}

export function isReadOnlyShellCommand(command) {
  const normalized = normalizeShellCommand(command);
  if (!normalized) return false;
  if (commandContainsShellControlOperators(normalized)) return false;
  if (/^(pwd|git status(?: .*)?|git diff(?: .*)?|git rev-parse(?: .*)?|git log(?: .*)?)$/.test(normalized)) return true;
  if (/^find\s+/.test(normalized) && !/\s-(?:delete|exec|execdir|ok|okdir)\b/.test(normalized)) return true;
  return false;
}

function shellCommandMayModifyFiles(command) {
  const normalized = normalizeShellCommand(command);
  if (!normalized) return false;
  if (getDangerousCommandReason(normalized)) return true;
  const patterns = [
    /\b(?:rm|rmdir|mv|cp|touch|mkdir|truncate)\b/i,
    /\b(?:sed|perl)\b[^;&|\n]*\s-i\b/i,
    /(^|[^<])>>?\s*[^&\s]/,
    /\btee\b/i,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|link|unlink|dedupe|rebuild|ci)\b/i,
    /\b(?:pip|pip3|uv|poetry)\s+(?:install|add|remove|update|sync|lock)\b/i,
    /\bgit\s+(?:add|commit|checkout|restore|reset|clean|apply|am|merge|rebase|cherry-pick|pull|stash)\b/i,
    /\bgit\s+worktree\s+(?:add|remove|prune)\b/i,
    /\bgit\s+branch\s+(?:-d|-D|--delete)\b/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function pythonMayModifyFiles(script) {
  const source = String(script || "");
  const patterns = [
    /\bopen\s*\([^)]*,\s*["'][^"']*[wax+][^"']*["']/,
    /\bPath\s*\([^)]*\)\s*\.\s*(?:write_text|write_bytes|touch|mkdir|rename|replace|unlink|rmdir)\s*\(/,
    /\b(?:os|shutil)\s*\.\s*(?:remove|unlink|rmdir|removedirs|rename|replace|makedirs|mkdir|rmtree|copy|copy2|copyfile|move)\s*\(/,
    /\b(?:write_text|write_bytes|unlink|rmdir|mkdir|rename|replace)\s*\(/,
    /\bsubprocess\s*\.\s*(?:run|call|check_call|check_output|Popen)\s*\([^)]*(?:rm|mv|cp|touch|mkdir|git\s+(?:checkout|reset|clean)|npm\s+(?:install|add|remove))\b/i,
  ];
  return patterns.some((pattern) => pattern.test(source));
}

export function getPermissionPolicy(name, args = {}) {
  if (name === "run_command") {
    const command = String(args.command || "");
    if (shellCommandMayModifyFiles(command)) {
      return { requiresApproval: true, category: "file_modifying_shell", reason: "即将在本地 workspace 中执行可能修改或删除文件的 shell 命令。" };
    }
    return { requiresApproval: true, category: isReadOnlyShellCommand(command) ? "read_only_shell" : "execution_shell", reason: "即将在本机 workspace 中执行 shell 命令。为避免间接执行绕过，agent 发起的 shell 命令默认需要用户确认。" };
  }
  if (name === "run_python") {
    if (pythonMayModifyFiles(args.script)) {
      return { requiresApproval: true, category: "file_modifying_python", reason: "即将在本地 workspace 中执行可能修改或删除文件的 Python 代码。" };
    }
    return { requiresApproval: true, category: "execution_python", reason: "即将在本机 workspace 中执行 Python 代码。为避免间接执行绕过，agent 发起的 Python 代码默认需要用户确认。" };
  }
  if (name === "delete_file") {
    return { requiresApproval: true, category: "destructive_file_operation", reason: "即将删除本地 workspace 中的文件或目录。" };
  }
  if (name === "worktree_apply") {
    return { requiresApproval: true, category: "worktree_apply", reason: "即将把隔离 worktree 中的变更应用回主 workspace。" };
  }
  if (name === "worktree_remove") {
    return { requiresApproval: true, category: "destructive_worktree_operation", reason: "即将移除隔离 worktree；如果 force 为 true，会丢弃其中未应用的变更。" };
  }
  if (name === "plugin_remove") {
    return { requiresApproval: true, category: "destructive_plugin_operation", reason: "即将删除本地 workspace 中已安装的 ocli 插件目录。" };
  }
  const risk = TOOL_REGISTRY[name]?.risk;
  return { requiresApproval: risk === "destructive", category: risk || "unknown", reason: "该工具需要用户确认。" };
}

export function shouldRequireApproval(name, args = {}) {
  return getPermissionPolicy(name, args).requiresApproval;
}

export async function handleTool(root, name, body, options = {}) {
  const tool = TOOL_REGISTRY[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(root, body, options);
}

export function isProjectToolName(value) {
  return PROJECT_TOOL_NAMES.has(value);
}
