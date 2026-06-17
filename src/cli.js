import { DEFAULT_PORT, VERSION } from "./constants.js";

export function printHelp() {
  console.log(`ocli ${VERSION}

Usage:
  ocli
  ocli [--workspace <path>] [--port <port>] [--token <token>]
  ocli serve [--workspace <path>] [--port <port>] [--token <token>]
  ocli open [--workspace <path>]
  ocli update
  ocli upgrade
  ocli --help

Examples:
  ocli
  ocli --workspace ~/Projects/my-app
  ocli open
  ocli update
  ocli serve --workspace .
  ocli serve --workspace ~/Projects/my-app --port 8787
`);
}

export function parseArgs(argv) {
  const forwarded = argv.slice(2);
  if (forwarded[0] === "--") forwarded.shift();
  if (forwarded[0] === "--help" || forwarded[0] === "-h") return { command: "help", workspace: process.cwd(), port: DEFAULT_PORT, token: "" };
  const explicitCommand = forwarded[0] && !forwarded[0].startsWith("-") ? forwarded[0] : "";
  const args = { command: explicitCommand || "serve", workspace: process.cwd(), port: DEFAULT_PORT, token: "", dryRun: false };
  const startIndex = explicitCommand ? 1 : 0;
  for (let index = startIndex; index < forwarded.length; index += 1) {
    const item = forwarded[index];
    if (item === "--workspace" || item === "-w") args.workspace = forwarded[++index] || args.workspace;
    else if (item === "--port" || item === "-p") args.port = Number(forwarded[++index] || DEFAULT_PORT);
    else if (item === "--token") args.token = forwarded[++index] || "";
    else if (item === "--dry-run") args.dryRun = true;
    else if (item === "--help" || item === "-h") args.command = "help";
  }
  return args;
}
