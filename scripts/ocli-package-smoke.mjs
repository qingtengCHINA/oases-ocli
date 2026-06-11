import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli.js";

const packageRoot = path.resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, cwd = packageRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr || stdout}`));
    });
  });
}

const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
assert(manifest.name === "oases-ocli", "package name should be oases-ocli for npx oases-ocli");
assert(manifest.type === "module", "package should be ESM");
assert(manifest.bin?.ocli === "./bin/ocli.js", "package should expose the ocli binary");
assert(manifest.bin?.["oases-ocli"] === "./bin/ocli.js", "package should expose the oases-ocli binary");
assert(Array.isArray(manifest.files) && manifest.files.includes("bin") && manifest.files.includes("src"), "package should publish the official runtime files");
assert(manifest.publishConfig?.access === "public", "package should be configured for public npm publishing");
assert(manifest.repository?.url === "git+https://github.com/qingtengCHINA/oases-ocli.git", "package should point to the public GitHub repository");
assert(manifest.bugs?.url === "https://github.com/qingtengCHINA/oases-ocli/issues", "package should expose the GitHub issues URL");
assert(manifest.homepage === "https://github.com/qingtengCHINA/oases-ocli#readme", "package should expose the GitHub README homepage");

const help = await run(process.execPath, ["bin/ocli.js", "--help"]);
assert(help.stdout.includes("ocli 0.1.0"), "packaged CLI should print help");
assert(help.stdout.includes("\n  ocli\n"), "packaged CLI help should include zero-argument startup");
assert(help.stdout.includes("ocli --workspace ~/Projects/my-app"), "packaged CLI help should include short workspace example");

const defaultArgs = parseArgs(["node", "bin/ocli.js"]);
assert(defaultArgs.command === "serve", "CLI parser should default to serve when no command is provided");
assert(defaultArgs.workspace === process.cwd(), "CLI parser should default workspace to cwd");

const shortWorkspaceArgs = parseArgs(["node", "bin/ocli.js", "--workspace", "."]);
assert(shortWorkspaceArgs.command === "serve", "CLI parser should treat leading flags as default serve options");
assert(shortWorkspaceArgs.workspace === ".", "CLI parser should preserve workspace in zero-command form");

const pnpmDelimitedArgs = parseArgs(["node", "bin/ocli.js", "--", "serve", "--workspace", "."]);
assert(pnpmDelimitedArgs.command === "serve", "CLI parser should ignore a pnpm/npm -- argument delimiter");
assert(pnpmDelimitedArgs.workspace === ".", "CLI parser should preserve arguments after a pnpm/npm -- delimiter");

const packed = await run("npm", ["pack", "--dry-run", "--json"]);
const packInfo = JSON.parse(packed.stdout)[0];
const files = packInfo.files.map((file) => file.path);
assert(files.includes("bin/ocli.js"), "npm package should include bin/ocli.js");
assert(files.includes("src/server.js"), "npm package should include src/server.js");
assert(files.includes("src/agent.js"), "npm package should include src/agent.js");
assert(!files.some((file) => file.startsWith("../") || file.includes("ocli-test") || file.includes("legacy-mvp-src")), "npm package should not include prototype or archived runtime source");

const tempRoot = await mkdtemp(path.join(tmpdir(), "oases-ocli-package-"));
try {
  const packedReal = await run("npm", ["pack", "--json", "--pack-destination", tempRoot]);
  const packedInfo = JSON.parse(packedReal.stdout)[0];
  const tarball = path.join(tempRoot, packedInfo.filename);
  const installRoot = path.join(tempRoot, "install-smoke");
  await mkdir(installRoot, { recursive: true });
  await run("npm", ["init", "-y"], installRoot);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installRoot);
  const installedHelp = await run(process.platform === "win32" ? "node_modules\\.bin\\oases-ocli.cmd" : "node_modules/.bin/oases-ocli", ["--help"], installRoot);
  assert(installedHelp.stdout.includes("ocli 0.1.0"), "installed tarball should expose the oases-ocli binary");
  assert(installedHelp.stdout.includes("\n  ocli\n"), "installed tarball help should include zero-argument startup");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("ocli package smoke passed");
