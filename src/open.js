import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_INFO_PATH = ".oases/ocli/runtime.json";

export function buildOasesWebUrl(token) {
  const base = "https://www.oasesai.xyz/";
  if (!token) return base;
  return `${base}#/?ocliToken=${encodeURIComponent(token)}`;
}

export function openUrl(url) {
  const platformCommands = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
    linux: ["xdg-open", [url]],
  };
  const command = platformCommands[process.platform];
  if (!command) return false;
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return true;
}

export function openOasesWeb(token) {
  if (process.env.OCLI_NO_AUTO_OPEN === "1") return false;
  return openUrl(buildOasesWebUrl(token));
}

function runtimeInfoPath(workspace) {
  return path.join(path.resolve(workspace), RUNTIME_INFO_PATH);
}

export async function writeRuntimeInfo(workspace, info) {
  const filePath = runtimeInfoPath(workspace);
  const payload = {
    name: "ocli",
    workspace: path.resolve(workspace),
    port: info.port,
    token: info.token,
    version: info.version,
    runtimeSource: info.runtimeSource,
    pid: process.pid,
    localUrl: `http://127.0.0.1:${info.port}`,
    webUrl: buildOasesWebUrl(info.token),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  return payload;
}

export async function removeRuntimeInfo(workspace, token) {
  const filePath = runtimeInfoPath(workspace);
  if (token) {
    try {
      const current = JSON.parse(await readFile(filePath, "utf8"));
      if (current?.token && current.token !== token) return;
    } catch {
      return;
    }
  }
  await rm(filePath, { force: true }).catch(() => undefined);
}

export async function readRuntimeInfo(workspace) {
  const raw = await readFile(runtimeInfoPath(workspace), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || typeof parsed.token !== "string" || typeof parsed.port !== "number") {
    throw new Error("Invalid ocli runtime info.");
  }
  return parsed;
}

export async function openFromRuntime(args) {
  let info;
  try {
    info = await readRuntimeInfo(args.workspace);
  } catch {
    console.error("No running ocli runtime was found for this workspace. Start ocli first, then run `ocli open`.");
    return 1;
  }

  const webUrl = typeof info.webUrl === "string" && info.webUrl ? info.webUrl : buildOasesWebUrl(info.token);
  const localUrl = typeof info.localUrl === "string" && info.localUrl ? info.localUrl : `http://127.0.0.1:${info.port}`;
  try {
    const response = await fetch(`${localUrl.replace(/\/+$/, "")}/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    console.error("Found ocli runtime info, but the local runtime is not responding. Restart ocli and try again.");
    return 1;
  }

  if (args.dryRun) {
    console.log(webUrl);
    return 0;
  }
  if (!openUrl(webUrl)) {
    console.log(webUrl);
    return 0;
  }
  console.log(`Opened ${webUrl}`);
  return 0;
}
