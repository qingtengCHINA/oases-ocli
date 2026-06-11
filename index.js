#!/usr/bin/env node
import { parseArgs, printHelp } from "./src/cli.js";
import { serve } from "./src/server.js";
import { updateSelf } from "./src/updater.js";

const args = parseArgs(process.argv);

if (args.command === "help" || args.command === "--help") printHelp();
else if (args.command === "serve") await serve(args);
else if (args.command === "update" || args.command === "upgrade") {
  const code = await updateSelf(args);
  process.exit(code);
}
else {
  console.error(`Unknown command: ${args.command}`);
  printHelp();
  process.exit(1);
}
