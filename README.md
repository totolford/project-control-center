# NEXUS — Multi-Agent Project Control Center

**A Windows mission control for multi-agent vibe coding with Claude Code.**

> NEXUS is the working name of the app (repository: `project-control-center`).

Pick a project folder, give a mission in plain language, and a permanent **Central
agent** plans it, creates specialised worker agents, splits the work into tasks with
dependencies, routes messages between agents, reviews results and keeps the
project's memory up to date. Every agent is a real Claude Code session; every task,
message and file change is real and persisted.

It is not an IDE with a chatbot: it is a control center where you watch a swarm of
agents work on your project live — tiled agent panels with their real terminals, the
Central agent's coordination view, connections such as Roblox Studio, missions,
memory and a timeline. Use your usual editor alongside it.

## Features

- **Swarm workspace** — a tiling workspace of panels (agent terminals, Central,
  missions, task board, Roblox Studio / connection panels, diffs, memory, activity):
  drag & drop, resize, maximize, minimize, pin, open in a new tab. Several workspace
  tabs per project; the layout is saved in `.agent-project/settings/workspace.json`.
- **Agent providers** — agents run on providers (adapters). Claude Code is supported;
  other runtimes (e.g. Codex CLI) are detected and shown as unavailable until an
  adapter exists — nothing is faked.
- **Projects as folders** — the app creates `.agent-project/` in your folder: the
  persistent brain of the project (settings, memory, agents, tasks, messages,
  sessions, logs, plans, snapshots). Close the app, reboot, reopen: the state is there.
- **Central agent** — plans missions, creates agents with free-form roles
  (Lighting Specialist, Database Specialist, Roblox Tester…), creates tasks with
  dependencies, forwards requests between agents, asks for reviews, closes missions
  with a summary.
- **Real sessions** — each agent runs `claude` in stream-json mode, driven by the app.
  Live terminal per agent, status derived from the process, cost per agent.
- **Tasks** — `pending → queued → in_progress → review → completed` (plus waiting,
  blocked, failed, cancelled); dependencies are enforced automatically.
- **Inter-agent communication** — workers ask Central, Central routes to the right
  agent; everything is journaled in `.agent-project/messages/`.
- **Memory** — curated Markdown memory per project and per agent, injected into
  prompts within a budget; raw history stays in the database.
- **Git** — one worktree and branch per worker (`agent/<id>`), automatic commits on
  task completion, conflict prediction, merge with automatic snapshot, restore.
  Works without git too.
- **Connections** — local folder, Git, GitHub (through your `gh` login), SSH, any MCP
  server, Roblox Studio (MCP), Docker; granted per agent. Secrets go to the Windows
  Credential Manager, never into the project.
- **Security** — per-agent capabilities (deny / ask / allow); destructive commands and
  paths outside the workspace always ask: *Reject / Allow once / Allow for this agent*.
- **Timeline, recovery, auto-update** — every event on a timeline; after a crash the
  app offers to resume the sessions; signed updates from GitHub Releases.

## Requirements

- Windows 10/11 (x64). WebView2 is installed automatically if missing.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup), signed in
  (`claude auth login`). The app uses your existing login and never asks for credentials.
- Optional: Git, GitHub CLI (`gh auth login`), OpenSSH client, Docker, Roblox Studio + its MCP server.

## Install

Download `ProjectControlCenter-vX.Y.Z-setup.exe` from the
[Releases](https://github.com/totolford/project-control-center/releases) page and run it.
The installer creates Start menu and desktop shortcuts and registers an uninstaller.

## Build from source

Prerequisites: Node.js 20+, Rust (stable, MSVC toolchain), Visual Studio Build Tools
with the C++ workload, Git.

```powershell
git clone https://github.com/totolford/project-control-center.git
cd project-control-center
npm ci
npm run dist        # -> dist-installer\ProjectControlCenter-Setup.exe
```

Development:

```powershell
npm run app:dev     # hot-reloading app window
npm test            # frontend tests
cargo test --workspace
```

Live end-to-end test against your real Claude Code (uses a few cents of tokens with haiku):

```powershell
$env:PCC_E2E = "1"; cargo test -p pcc-orchestrator --test real_claude -- --nocapture
```

## Releasing

```powershell
node scripts/set-version.mjs 1.0.0
cargo check                     # refreshes Cargo.lock
git commit -am "Release 1.0.0"
git tag v1.0.0
git push --follow-tags
```

The `Release` workflow tests, builds the NSIS installer, signs the updater artifacts
and publishes a GitHub Release with `ProjectControlCenter-v1.0.0-setup.exe` and
`latest.json` (used by the in-app updater).

One-time setup: add the repository secrets `TAURI_SIGNING_PRIVATE_KEY` (content of
the private key generated with `npx tauri signer generate`) and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if none), and make sure the public key
in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) matches it. If you fork
the project, also update the updater endpoint URL there.

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: a Rust engine drives one
Claude Code process per agent over the stream-json protocol, answers their
permission requests with a capability policy, and serves an in-process MCP server
(`create_task`, `complete_task`, `send_message`, …) through which agents coordinate.

## Project layout

```
src/                 React UI
src-tauri/           Tauri application (commands, window, installer config)
crates/pcc-core      domain model, events, permission classification, task graph
crates/pcc-store     .agent-project layout, SQLite, memory files
crates/pcc-claude    Claude Code detection, stream-json protocol, processes
crates/pcc-git       git CLI integration: worktrees, merges, snapshots
crates/pcc-connections  environment detection, connections, secrets
crates/pcc-orchestrator the engine: agents, tasks, messages, tools, policy
```

## License

MIT — see [LICENSE](LICENSE). Claude and Claude Code are products of Anthropic; this
project is an independent open-source tool that drives the Claude Code CLI.
