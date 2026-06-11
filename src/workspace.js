import { readdir } from "node:fs/promises";
import path from "node:path";

export function workspacePath(root, value) {
  const raw = typeof value === "string" ? value.trim().replace(/\\+/g, "/") : "";
  const relative = raw.replace(/^\.\//, "");
  if (!relative || relative.startsWith("/") || relative.includes("../") || relative === ".." || /^[a-zA-Z]:\//.test(relative)) {
    throw new Error("Path must be a relative path inside the workspace.");
  }
  const resolved = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) throw new Error("Path escapes the workspace.");
  return resolved;
}

export async function listFiles(root, body) {
  const target = body.path ? workspacePath(root, body.path) : root;
  const entries = await readdir(target, { withFileTypes: true });
  return entries.map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`).sort();
}
