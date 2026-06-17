import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_TOOL_NAMES } from "./constants.js";
import { fetchUrl } from "./network.js";
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

function truncateText(text, limit) {
  const value = String(text || "");
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`, truncated: true };
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

async function readSkill(root, body = {}) {
  const requested = String(body.path || body.name || "").trim();
  if (!requested) throw new Error("skill_read requires path or name.");
  const skills = await listSkills(root, { maxResults: 500 });
  const requestedLower = requested.toLowerCase();
  const matched = skills.skills.find((skill) => skill.name === requested || skill.id === requested || skill.path === requested)
    || skills.skills.find((skill) => skill.name.toLowerCase() === requestedLower || skill.id.toLowerCase() === requestedLower || skill.path.toLowerCase() === requestedLower);
  const skillPath = matched ? matched.path : requested;
  const normalized = skillPath.replace(/^\.\//, "").replace(/\\+/g, "/");
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
    ...(initialPrompt ? { initialPrompt } : {}),
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
    description: "Update the structured project task checklist for the current local agent session.",
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
    execute: async (_root, body) => {
      const todos = normalizeTodos(body);
      const counts = todos.reduce((acc, todo) => {
        acc[todo.status] = (acc[todo.status] || 0) + 1;
        return acc;
      }, {});
      return { todos, count: todos.length, counts, summary: summarizeTodos(todos) };
    },
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
