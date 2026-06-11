import { spawn } from "node:child_process";

const UPDATE_COMMAND = ["npm", ["install", "-g", "oases-ocli@latest"]];

export function getUpdateCommandText() {
  const [command, args] = UPDATE_COMMAND;
  return [command, ...args].join(" ");
}

export function updateSelf(args = {}) {
  const [command, commandArgs] = UPDATE_COMMAND;
  console.log(`Updating ocli with: ${getUpdateCommandText()}`);
  if (args.dryRun) return Promise.resolve(0);

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
