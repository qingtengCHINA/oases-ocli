import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

function assertInsideRoot(realRoot, candidate, message = "Path escapes the workspace.") {
  const relative = path.relative(realRoot, candidate);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) throw new Error(message);
}

function nearestExistingPath(target) {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function workspaceRelativePath(root, value) {
  const raw = typeof value === "string" ? value.trim().replace(/\\+/g, "/") : "";
  const resolvedRoot = path.resolve(root);
  if (!raw) throw new Error("Path must be inside the workspace.");

  if (path.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw)) {
    const resolvedAbsolute = path.resolve(raw);
    const relativeFromRoot = path.relative(resolvedRoot, resolvedAbsolute).replace(/\\+/g, "/");
    if (!relativeFromRoot) return ".";
    if (relativeFromRoot.startsWith("../") || relativeFromRoot === ".." || path.isAbsolute(relativeFromRoot)) {
      throw new Error(`Path must be inside the workspace. Workspace: ${resolvedRoot}`);
    }
    return relativeFromRoot;
  }

  const relative = raw.replace(/^\.\//, "");
  if (!relative || relative.includes("../") || relative === "..") throw new Error("Path must be inside the workspace.");
  const resolved = path.resolve(root, relative);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) throw new Error("Path escapes the workspace.");
  return relative;
}

export function workspacePath(root, value) {
  const relative = workspaceRelativePath(root, value);
  const resolved = relative === "." ? path.resolve(root) : path.resolve(root, relative);
  const realRoot = realpathSync(root);
  const existing = nearestExistingPath(resolved);
  const realExisting = realpathSync(existing);
  assertInsideRoot(realRoot, realExisting);
  return resolved;
}

export async function listFiles(root, body) {
  const target = body.path ? workspacePath(root, body.path) : root;
  const entries = await readdir(target, { withFileTypes: true });
  return entries.map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`).sort();
}
