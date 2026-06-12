export const DEFAULT_PORT = 8787;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SESSION_EVENTS = 300;
export const VERSION = "0.1.5";
export const RUNTIME_SOURCE = "ocli";
export const BRIDGE_NAME = "Oases desktop bridge";

export const PROJECT_TOOL_NAMES = new Set([
  "list_files",
  "glob_files",
  "search_files",
  "grep_files",
  "workspace_status",
  "worktree_list",
  "worktree_diff",
  "worktree_apply",
  "worktree_remove",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "fetch_url",
  "run_command",
  "run_python",
  "todo_write",
  "skill_list",
  "skill_read",
  "agent_list",
  "agent_read",
  "agent_run",
  "agent_status",
]);
