# Architecture

Project Control Center (PCC) is a Tauri 2 desktop application. The UI is React +
TypeScript; everything else is Rust, split into focused crates.

```
┌──────────────────────────── React UI (src/) ────────────────────────────┐
│ views · zustand store · api.ts (invoke) · onEvent/onLog (Tauri events)  │
└───────────────▲─────────────────────────────────────────▲───────────────┘
                │ commands                                 │ pcc://event, pcc://log
┌───────────────┴──────────── src-tauri (app) ─────────────┴───────────────┐
│ commands.rs (1:1 with api.ts) · state.rs (open project, event relays)    │
└───────────────▲──────────────────────────────────────────────────────────┘
                │
┌───────────────┴──────────── pcc-orchestrator ────────────────────────────┐
│ Engine (one per project, behind one async mutex)                         │
│  engine.rs   sessions, delivery, scheduling, control requests, recovery  │
│  work.rs     agents, tasks, missions, memory                             │
│  tools.rs    in-process MCP server "pcc" (agents' only way to act)       │
│  policy.rs   tool-call permission decisions                              │
│  gitops.rs   worktrees, merges, snapshots · connections.rs               │
│  launch.rs / prompts.rs  per-agent launch spec and system prompts        │
└──────▲───────────────▲────────────────▲───────────────▲──────────────────┘
       │               │                │               │
  pcc-claude       pcc-store         pcc-git      pcc-connections
  CLI detection,   .agent-project,   git CLI:     environment detection,
  stream-json      SQLite (WAL),     worktrees,   SSH/MCP/Roblox/GitHub/
  protocol,        memory files,     merge-tree,  Docker checks, Windows
  processes, job   mirrors, recent   snapshots    Credential Manager
  object           projects
       └───────────────┴────────── pcc-core ──────────┴───────────────┘
                    model, events, permissions, task graph (no I/O)
```

## Agents are real Claude Code sessions

Each agent (the permanent **Central** agent and every worker) runs:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --permission-mode default --permission-prompt-tool stdio
       --strict-mcp-config --mcp-config <agent>.mcp.json
       --append-system-prompt-file <agent>.prompt.md
       --tools <built-in tools allowed by the agent's permissions>
       --session-id <uuid> | --resume <uuid>
```

The process stays alive between turns. The engine writes user turns and control
responses to stdin and parses newline-delimited JSON from stdout:

| stdout message                          | handling                                                     |
|-----------------------------------------|--------------------------------------------------------------|
| `system/init`                           | records the Claude session id (used by `--resume`)           |
| `assistant` (text, thinking, tool_use)  | transcript + "current action" of the agent                   |
| `user` (tool_result)                    | transcript                                                   |
| `result`                                | end of turn: cost, status → waiting, next input is delivered |
| `control_request` `can_use_tool`        | permission policy → allow / deny / ask the user              |
| `control_request` `mcp_message`         | JSON-RPC for the in-process `pcc` MCP server                 |

An agent is `working` exactly between writing a turn and receiving its `result`.
Processes are placed in a Windows job object with *kill on close*, so no session
survives the application. Authentication is the user's existing Claude Code login;
the application never reads or stores Claude credentials.

## Coordination

Agents act only through the `pcc` MCP tools (see `tools.rs`):

* **Central**: `create_agent`, `create_task` (with dependencies), `update_task`,
  `request_changes`, `send_message`, `list_agents`, `list_tasks`, `read_memory`,
  `write_memory`, `review_agent_changes`, `merge_agent_work`, `complete_mission`…
* **Workers**: `report_progress`, `complete_task`, `block_task`, `fail_task`,
  `send_message` (to Central), `read_memory`, `remember`.

Messages are stored, then written into the recipient's session when it is idle
(several pending messages are batched into one turn). The scheduler promotes
`pending` tasks to `queued` when their dependencies are completed, blocks tasks
whose dependencies failed, and dispatches the next queued task to each idle worker
(up to `maxParallelWorkers` live workers). Task results, failures, blocks, crashes
and merge outcomes are reported to Central as system messages, which wakes it up.
A worker that ends its turn without reporting is reminded twice, then its task is
parked in `waiting` and Central is told.

Agents are started automatically only after the user acted in the current app
session (mission, message, start, recovery), so opening a project never spends
tokens by itself.

## Isolation and git

In a git repository with worktrees enabled, a worker gets a worktree in
`.agent-project/worktrees/<id>` on branch `agent/<id>`. Completing a task commits
the worktree. Before a task starts, branches of the agents that completed its
dependencies are merged into the worker's worktree. Merging into the main branch
happens only with user approval (Git view, or `merge_agent_work` → permission
prompt), after a snapshot branch `pcc/snapshots/<timestamp>`; conflicts are
predicted with `git merge-tree` and the merge is refused instead of leaving a
half-merged tree. Restoring a snapshot uses `reset --keep` and first snapshots the
current state. Projects without git work in the shared folder.

## Permissions

Each agent has a capability map (`fs_read`, `fs_write`, `fs_execute`, `network`,
`git_read`, `git_write`, `github_read`, `github_write`, `github_admin`,
`ssh_read`, `ssh_execute`, `mcp`) with `deny | ask | allow`. Tool calls are
classified (`pcc-core/src/permissions.rs`): shell commands by their programs
(git sub-commands, `gh`, `ssh`, …), file tools by path. Destructive commands
(`rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, …) and paths
outside the agent's workspace always ask. MCP and SSH connections must be granted
to the agent. "Allow for this agent" stores a rule (exact command for destructive
ones). Central can create workers only within `maxWorkerPermissions`.

## Persistence

`.agent-project/` in the project folder:

```
project.json, settings.json       project identity and settings
state.db                          SQLite (WAL): agents, tasks, missions, messages,
                                  sessions, logs, events, permission rules, connections
memory/*.md, agents/<id>/memory.md  curated memory injected into prompts (budgeted)
agents/<id>/state.json            mirror of the agent record
tasks/{active,completed,failed}/  task JSON + completion summaries (Markdown)
messages/YYYY-MM-DD.jsonl         message journal
plans/M-xxxx.md                   mission plan, task list and final summary
sessions/                         session records, generated prompts and MCP configs
logs/agents/<id>/*.jsonl          raw stream-json transcripts
worktrees/                        git worktrees of worker agents
```

Runtime files (`state.db`, logs, sessions, worktrees) are git-ignored by
`.agent-project/.gitignore`; memory, plans and task records can be committed.

## Recovery

Sessions still marked `running` at start-up belong to processes that died with the
previous app instance. Their agents become `disconnected` and the UI offers to
**recover** (restart with `--resume <session id>` and tell each agent to continue)
or **discard** (tasks in progress are parked in `waiting`). A resume that fails
before initialising falls back to a fresh session.

## Memory and context

Raw history (transcripts, messages, events) lives in SQLite and is never replayed
into prompts. Each session starts with curated memory files (per-file character
budget, most recent content kept) and each task carries only the summaries of the
tasks it depends on. Workers add durable notes with `remember`; Central
consolidates the files (`write_memory`, or "Consolidate memory" in the UI).

## Secrets

Connection secrets (SSH passphrases, MCP API keys) are stored in the Windows
Credential Manager under the service `ProjectControlCenter`; the project stores
only a `credentialRef`. MCP secrets reach the server through `${VAR}` references
in the generated MCP config and environment variables of the session process, so
they are never written to disk.
