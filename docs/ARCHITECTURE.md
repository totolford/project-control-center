# Architecture

NEXUS (codename Project Control Center, "PCC") is a Tauri 2 desktop application. The UI is React +
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

## Providers

Every agent has a `provider` (runtime adapter). `pcc-orchestrator/src/providers.rs`
defines the `AgentProvider` trait and a registry: `claude-code` has an adapter; Codex
CLI, generic CLIs and MCP workers are detected/listed but not selectable until an
adapter is written. The engine refuses to start an agent whose provider has no adapter.

## Workspace layout

The UI's tiling layout (tabs, split tree, panels) is UI-owned JSON persisted per
project in `.agent-project/settings/workspace.json` through `load_workspace` /
`save_workspace`; the UI validates and migrates it on load and drops panels that
reference deleted agents or connections.

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
settings/workspace.json           UI workspace layout (tabs and panels)
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

0.4 (`crates/pcc-recovery`, `pcc-orchestrator/src/{recovery,watchdog}.rs`,
`src-tauri/src/recovery_commands.rs`):

- **Process registry.** Claude Code sessions (per project), AI Town `convex dev`
  and its local backend, terminals and local AI runtimes (application-wide,
  `pcc_recovery::app()`) are registered with PID, OS start time (to detect PID
  reuse), heartbeat, last event, state, mission/agent and restart history, and
  persisted to `.agent-project/runtime/processes.json` and
  `<data_dir>/runtime/processes.json`. An `instance.json` marker tells a clean
  exit from a crash, kill or reboot.
- **Watchdog** (every 15 s): diagnose → soft recovery (`interrupt`) → graceful
  restart with `--resume` and a precise brief. A session running a tool (a long
  Bash, a build, an MCP call), waiting for a permission or using CPU is never
  treated as stuck. Crashed sessions that were doing something are restarted with
  exponential backoff, at most 3 times in 30 min; then the user decides. The pure
  decisions are in `pcc_recovery::watchdog`.
- **Mission checkpoints.** `.agent-project/missions/<id>/mission.json` and
  `checkpoints/checkpoint-NNN.json` + `current.json` on task transitions, before
  and after merges, when a mission is sent/closed/resumed and every 5 minutes
  while running (only when something changed). Each records tasks, agents, their
  last tool call and the fingerprint of every uncommitted file.
- **Interrupted missions.** After a restart, missions still planning/active are
  offered with Resume / Inspect / Abandon and precise facts: the step in progress,
  the last tool call (from the transcript), the files written since the last
  checkpoint. Central receives the same brief on resume.
- **MCP supervision.** Claude Code owns the MCP processes of its sessions:
  NEXUS asks each session for `mcp_status` every minute, reconnects failed
  servers with `mcp_reconnect` (same backoff and cap) and tells the agent when a
  server is back. NEXUS's own probes (`probe_connection`) are kept per
  connection; a probe stops the whole server process tree when it ends.
- **Crash reports** (`runtime/crash-reports/*.json`): what happened, possible
  cause, component, what was preserved, restarted and lost. Shown once, then
  listed on the Diagnostics page with the interface incidents.
- **Orphans.** About 15 s after opening, processes of the previous run that are
  still alive (same PID *and* start time) and Claude Code processes of the project
  without a NEXUS parent are listed. Cleanup happens only on request and follows
  the rule: state check, recorded reason, saved context, modified-files check,
  soft stop, then termination.

## Memory and context

Raw history (transcripts, messages, events) lives in SQLite and is never replayed
into prompts. Each session starts with curated memory files (per-file character
budget, most recent content kept) and each task carries only the summaries of the
tasks it depends on. Workers add durable notes with `remember`; Central
consolidates the files (`write_memory`, or "Consolidate memory" in the UI).

## Platforms (0.5)

Windows and Ubuntu 24.04 LTS+ are both first-class. Everything that differs goes
through `crates/pcc-platform` (`PlatformManager`, `WindowsPlatform` / `LinuxPlatform`):

- **Processes** — Windows: no console window, the app job object kills children on
  exit, trees stop with `taskkill /T`. Linux: children start in their own process
  group; long-lived ones (Claude sessions, AI Town, local AI runtimes) get
  `PR_SET_PDEATHSIG(SIGKILL)` (forked from a thread that lives as long as NEXUS),
  trees stop through `killpg` plus the descendants found in `/proc`.
  `pid_alive`, the process table, start time and CPU time come from `/proc`.
- **Paths** — `%LOCALAPPDATA%` / `$XDG_DATA_HOME`, `%APPDATA%` / `$XDG_CONFIG_HOME`,
  PATH lookup with PATHEXT (`npm` → `npm.cmd`) without spawning `where`/`which`.
- **Shells and terminals** — PowerShell, PowerShell 7, CMD, WSL / bash, zsh, fish,
  sh; Windows Terminal / x-terminal-emulator, Ptyxis, GNOME Terminal, Konsole…
  The Raw Terminal offers the shells found on the machine (`shell` = default shell).
- **Credentials** — `keyring`: Windows Credential Manager / Secret Service (D-Bus,
  libdbus vendored). A missing Secret Service is reported with what to start.
- **Services** — optional components as `systemd --user` units in
  `~/.config/systemd/user` (`nexus-*`), never as root.
- **Installers** — local AI runtimes: winget on Windows; on Ubuntu the official
  Ollama script or apt, run through `pkexec` after the user confirmed the exact
  command (`InstallPlan`), recomputed by the backend (the UI never sends a command line).
- **GPU** — nvidia-smi on both; WMI on Windows; rocm-smi, `/sys/class/drm` and
  `lspci` on Linux; CPU-only otherwise.
- **Capability Matrix** — `platform_capabilities`: Windows / Ubuntu / WSL / Docker
  support per component plus its live status here (Environment view).
- **Packaging** — NSIS on Windows; AppImage and .deb on Linux
  (`src-tauri/tauri.linux.conf.json`); CI runs on `windows-latest` and `ubuntu-24.04`.

## Secrets

Connection secrets (SSH passphrases, MCP API keys) are stored in the OS
credential store (Windows Credential Manager; Secret Service — GNOME Keyring,
KWallet — on Linux) under the service `ProjectControlCenter`; the project stores
only a `credentialRef`. MCP secrets reach the server through `${VAR}` references
in the generated MCP config and environment variables of the session process, so
they are never written to disk.

## Claude Control Center

Everything shown about Claude Code comes from Claude Code itself, so the interface
adapts to the installed version:

| Area | Source |
|------|--------|
| Version, login | `claude --version`, `claude auth status` |
| Models, slash commands & skills, sub-agents, account, permission mode, output styles | `initialize` control request (stream-json), in a short-lived session that never calls a model |
| MCP servers (status, scope, transport) | `mcp_status` control request |
| Context window usage | `get_context_usage` |
| Session usage and subscription rate limits | `get_usage` |
| Effective settings (env values hidden) | `get_settings` |
| Plugins | `claude plugin list --json` |
| Command Center | `claude --help` and every sub-command's `--help`, parsed and cached per version |

Live session controls use the same protocol on running agents: `set_model`,
`mcp_reconnect`, `reload_plugins`. `mcp_toggle` is persisted by Claude Code for
the project, so NEXUS presents it as a configuration change.

### MCP

Two worlds are shown side by side. NEXUS connections are what agents receive
(sessions run with `--strict-mcp-config`); Claude Code's own servers are what the
user gets when running `claude` directly. A Claude Code server can be imported into
NEXUS: its environment/header values move to Windows Credential Manager. Servers
added to Claude Code's configuration from NEXUS may only reference secrets as
`${VAR}`. Probes speak MCP over stdio and streamable HTTP/SSE and list tools,
resources and prompts with the initialize latency.

### Skills

Skills are read from `~/.claude/skills` (including claude.ai synced skills),
`<project>/.claude/skills` and installed plugins. Claude Code has no per-skill
switch, so disabling a user/project skill moves it to a sibling
`skills-disabled/` folder (reversible) and deleting moves it to `skills-trash/`.
Plugin skills follow their plugin (`claude plugin enable|disable`). Edits are shown
as a unified diff before being saved. "Test" checks the frontmatter and whether
Claude Code actually lists the skill. Per agent, skills are all or nothing
(`--disable-slash-commands`).

### Power, CLAUDE UNLOCKED and the decision journal

Power levels (LOW, NORMAL, HIGH, MAXIMUM) are only permission presets; the
resulting capabilities are what is stored, enforced and displayed. CLAUDE UNLOCKED
replaces every agent's effective permissions by the configured unlocked set; with
Auto Approve, prompts that would be asked are answered by NEXUS, except the
categories kept manual (destructive commands, paths outside the workspace and
chosen capabilities by default). NEXUS never uses Claude Code's
`bypassPermissions`: every tool call still goes through the permission prompt, and
every decision (allowed, denied, asked, auto-approved, user decision) is written to
the `decisions` table.

**Emergency stop** kills every managed Claude Code process and Raw Terminal, rejects
pending prompts and blocks auto-start, auto-approval, new missions and messages
until released. **Revoke all** sets every agent to LOW, deletes saved "allow
always" rules and turns UNLOCKED off.

### Continuous improvement

When enabled, a minute tick starts an improvement mission for Central when none is
active, the interval has elapsed and the daily limit is not reached. Propose mode
asks for reviewed tasks only; implement mode lets workers change code (merges
still need approval). Traceability is the mission, its tasks (files, tests,
commits) and the git snapshots used for rollback.

### Raw Terminal

Interactive sessions run in a ConPTY pseudo-terminal (`pcc-pty`): Claude Code
itself, `claude --resume` of a stopped agent's session, PowerShell, CMD or WSL.
Processes join the application's kill-on-close job object.

## Project compatibility (0.2)

`project.json` records `formatVersion`, `createdWith`, `lastOpenedWith` and
`minimumNexusVersion`; fields written by other versions are preserved on rewrite
(`#[serde(flatten)] extra`, also in `settings.json`). `pcc-store::compat`:

```
Detect project version → compare with this build
  compatible            → open
  older format          → backup (.agent-project-backups/<stamp>) → migrate step by step
                          → integrity check (manifest, settings, PRAGMA integrity_check)
                          → report (.agent-project/migrations/*.md) → open
  newer format          → open, unknown data kept, features listed as unavailable
  requires newer NEXUS  → read-only compatibility mode (SQLite query_only, every write refused)
```

Any backup can be restored (`rollback`), after an automatic backup of the current
state. The database schema migrates independently (`PRAGMA user_version`).

## Command interpreter and journal

`pcc-core::interpreter` tokenises a command line (quotes, Windows paths) and
recognises `claude mcp add` (transport, scope, `-e`, `-H`, `--`), `ssh`, `git
clone`, `gh repo clone`, `gh auth login` and other `claude` commands; everything
else is classified with the permission classifier. `-e`/`-H` values are treated as
secrets: they go to Windows Credential Manager and are redacted everywhere.
Every Bash/PowerShell call of an agent is journaled (`commands` table): agent,
source, raw and parsed command, target, capability, permission decision, start,
end, exit code (recorded only when Claude Code reports one, "Exit code N"; the
error flag is always recorded) and redacted output. Shell wrappers (`timeout`,
`env`, `nohup`, `sudo`...) and nested shells (`powershell -Command "..."`, `cmd /c`)
are seen through by the permission classifier, and allowed SSH commands are made
non-interactive (`BatchMode`, `ConnectTimeout`, the connection's key) so an agent
never hangs on a password prompt.

## Agent-driven environment

Central has environment tools (`env_tools.rs`): `list_capabilities`,
`find_or_create_connection` (equivalent connections are reused: same host/user/port,
same MCP command/args or URL...), `add_mcp_from_command`, `grant_connection`,
`test_connection`, `request_secret`, `request_user_action` (SSH key setup, GitHub
sign-in, manual steps), `github_repositories`, `interpret_command`. Slow tools answer
later: the MCP reply is written by a background job when the work is done, so other
sessions are never blocked. Without MASTER CONTROL, connection creation and grants
wait for a user approval. Secrets never pass through agents: the user types them
into a NEXUS dialog, and stored values are redacted from logs and command outputs.

SSH works with keys or ssh-agent. "SSH key setup" generates `~/.ssh/nexus_<id>`,
switches the connection to it and opens a Raw Terminal that appends the public key
on the host; the user types the remote password there once.

## MASTER CONTROL

`settings.masterControl` opens domains (PC, GitHub, MCP, SSH, skills) to Central:
its effective permissions become the maximum preset for those domains, it may use
every enabled connection of an opened domain without a grant, its prompts are
answered automatically (destructive actions and paths outside the workspace still
follow the manual rules), and with "manage connections" it creates connections and
grants without a prompt. `master_status` reports, per domain, the user's choice,
the real availability (gh signed in, connections present...) and the effective
level. Emergency stop disables it.

## GitHub

The official `gh` CLI is the authentication (`gh auth login --web` in a Raw
Terminal). NEXUS reads the account, organisations and token scopes (shown as the
list of what the token allows), repositories, issues, pull requests, Actions runs,
releases, branches and commits, clones repositories, creates issues and dispatches
workflows on explicit user actions. Agents use `gh`/`git` through their
`github_*` capabilities.

## AI World on AI Town (0.3)

`ai-town/` is a16z-infra/ai-town imported unmodified (base commit in
`ai-town/nexus-upstream.json`), then changed in separate commits; NEXUS edits to
upstream files are marked `NEXUS:` and new code lives in `ai-town/convex/nexus*.ts`,
`ai-town/convex/aiTown/nexusInputs.ts`, `ai-town/data/nexus*.ts` and `ai-town/src/nexus/`.

* **Runtime** (`pcc-world::aitown::runtime`): the backend part of `ai-town/` is copied
  to the app's local data folder (`ai-town-runtime`, separate from the install folder
  that holds the bundled source), `npm ci` runs after the user's consent, and
  `convex dev` runs in anonymous local mode (127.0.0.1, no Convex account). The
  frontend is built into `public/ai-town/`, served by NEXUS at `/ai-town/` and embedded
  in an iframe (same origin, strict CSP; PixiJS uses `@pixi/unsafe-eval` instead of eval).
* **One world per project** (`nexus:ensureWorld`). Each NEXUS agent is an AI Town human
  player `nexus:<agentId>` with no LLM. The bridge (`src-tauri/src/aitown_commands.rs`)
  calls `nexus:syncAgents` every second with facts derived only from real state
  (`pcc-world::aitown::bridge`: zone, label, emoji) and forwards real messages and
  assistant text to `nexus:say` (bubbles; the speaker walks to the listener and an
  AI Town conversation records the text).
* **iframe protocol**: `AiTownToNexus` / `NexusToAiTown` in `src/lib/types.ts`
  (select, talk, view work, buildings, direct-control actions, camera).
* **Upstream sync** (`pcc-world::aitown::upstream`): clone upstream, compare with the
  base, 3-way merge with `git merge-file`; conflicts are written as `<file>.upstream`
  and the base only moves when nothing is left for review.
* The native 2D world below remains as a fallback when Node.js is missing.

## AI World (`pcc-world`)

Inspired by the architecture of a16z-infra/ai-town (MIT): world state, a tick-based
engine, characters with personality/goals/memory, a client. `World` is stored in
`.agent-project/ai-world/world.json`; the app runs one tick loop per open project
and streams frames on `pcc://world`.

* **Hybrid / real execution**: characters linked to NEXUS agents move to the room
  matching the agent's real state (Workshop = running a turn, Review Room = task in
  review, Meeting Room = messages, Library = memory, Server Room = SSH/MCP, Security
  Desk = waiting for a permission, Lounge = idle, Infirmary = crashed, Gate =
  offline) and show its real current action.
* **Simulation**: unlinked behaviour follows a deterministic routine; mood and
  conversations are simulated, conversations being generated on request by a
  one-shot Claude Code call (no tools, budget-capped).
* **Providers** (`AIWorldProvider`): integrated AI Town (above), NEXUS Native, and
  Custom (an existing world project folder). Conversions back up `.agent-project`
  first and never modify project files.
