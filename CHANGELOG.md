# Changelog

## 0.4.1

- Fix: in installed builds the AI Town runtime folder was the install folder's
  bundled `ai-town/`, so starting AI Town erased the bundled files ("The AI Town
  folder bundled with NEXUS was not found"). The runtime now lives in the app's data
  folder (`ai-town-runtime`) and the copy refuses any overlap with the source.
  Reinstall (or update) to restore the bundled files.

## 0.4.0

- Stability first: persistent PermissionManager (pending / approved / denied / expired /
  cancelled / consumed / lost / recovered, expiry, idempotent answers, "no longer
  available — checking the agent's real state" instead of a raw "not found"); idempotent
  critical operations; persisted event journal (dotted names, severity, source, PID).
- RecoveryManager and watchdog: process registry, soft recovery before any restart,
  orphan detection (cleanup only on request), mission checkpoints with an
  interrupted-mission dialog (Resume / Inspect / Abandon, last real action, files
  written since the checkpoint), crash reports, MCP supervision with restart and test.
- Renderer health monitor, error boundaries, Safe Recovery Overlay and a renderer
  watchdog that reloads the interface without stopping agents, missions, MCP or AI Town;
  Diagnostics page (process, agent, mission, MCP, permission and AI runtime trees,
  CPU/RAM/GPU/VRAM, errors, restarts, crash history); Activity as an event chain.
- Dynamic agent hierarchy: commander / lieutenants / specialists, required delegation
  decision, maxHierarchyDepth (default 3), routing through parents, lieutenant
  syntheses, promote / demote, real pause and sleeping agents; ranks in AI Town.
- Local AI: hardware detection, explained model recommendations, Ollama / LM Studio /
  llama.cpp runtime manager (installs and downloads only after confirmation), local
  providers, ModelRouter (Local / Claude / Hybrid) with a routing journal, Central and
  workers on a local model through Claude Code + Ollama's Anthropic-compatible API
  (tool-capable models only), fallback policy, first-launch AI Setup wizard, AI Town
  townspeople on the local runtime.

## 0.3.0

- AI World built on the real a16z-infra/ai-town (MIT, vendored in `ai-town/`): the
  embedded PixiJS world runs on a local Convex backend (anonymous mode, no account,
  data on this PC), installed only after consent. Each NEXUS agent is an AI Town
  player driven by its real state: NEXUS buildings (Central HQ, Coding Office, Skill
  Shop...), status labels, speech bubbles from real messages, profile card with Talk /
  View work / direct control, observer and cinematic camera modes.
- Character customization: honest presets (real Robot / Android / Wizard / Cyberpunk
  spritesheets), tint, badge, display name, import of AI Town-compatible spritesheets.
- "Sync with AI Town upstream": 3-way merge plan, NEXUS changes never overwritten.
- New layout: navigation, center window tabs, contextual right panel with the real
  Central chat (tool calls, commands, files, MCP, skills, delegations), universal
  command bar with slash commands. The duplicate mission composer is gone.
- Missions: Active / Queued / Completed / Failed / Archived, priority queue, automatic
  analysis (one Claude call, estimate), skill recommendations, selected skills passed
  to Central and its tasks.
- Skill Market: Claude Code marketplaces, NEXUS catalog (`skills/catalog.json`) and
  GitHub search; file list and static security analysis before any install;
  installs only on confirmation; deterministic skill recommendations.
- Project format 3 (backed-up migration): projects opened with 0.3 require 0.3.

## 0.2.0

- Project compatibility: versioned manifest, automatic backed-up migrations with integrity report and rollback, read-only compatibility mode, unknown fields preserved.
- Command interpreter (`claude mcp add`, `ssh`, `git`/`gh` clone, `gh auth login`) and command journal.
- Agent-driven environment: Central discovers capabilities, finds or creates connections without duplicates, adds MCP servers from a command line, grants access, requests secrets and manual steps (SSH key setup, GitHub sign-in).
- NEXUS MASTER CONTROL; secret redaction in logs.
- GitHub account, repositories, Actions, releases, clone, issues, workflow dispatch.
- AI World: native engine (hybrid with real agents, or simulation), AI Town compatible export, AI Town fork, custom worlds; Claude-generated characters and conversations.

- Claude Control Center: live Claude Code inspection, Command Center from `--help`, MCP manager (stdio/HTTP/SSE probes, Claude config management, import), Skills manager, models and live model switch, agent profiles (effort, skills, env), capability matrix.
- CLAUDE UNLOCKED with journaled auto-approval, power presets, Emergency Stop, Revoke all permissions.
- Continuous improvement loop, Raw Terminal (ConPTY), Environment Inspector, detachable panels.
- Connections: GitLab, SFTP, local terminals, HTTP/API, MCP over HTTP/SSE, enable/disable, last used.
- NEXUS branding and swarm workspace UI: tiling agent panels with live terminals, Central panel, workspace tabs, notifications, command bar, mission composer.
- Agent provider registry (Claude Code adapter; other runtimes detected but unavailable).
- Per-project workspace layout persisted in `.agent-project/settings/workspace.json`.
- "Show in Explorer" for project paths.

## 0.1.0

First public version.

- Project folders with a persistent `.agent-project/` (SQLite + Markdown/JSON mirrors).
- Central agent and dynamic worker agents running real Claude Code sessions (stream-json).
- Missions, tasks with dependencies, inter-agent messages, review flow.
- In-process MCP tools for coordination; capability-based permissions with user prompts.
- Git worktree per worker, automatic commits, conflict prediction, merges with snapshots.
- Connections: local, Git, GitHub (`gh`), SSH, MCP servers, Roblox Studio, Docker; secrets in Windows Credential Manager.
- Timeline, per-agent terminal, memory editor, crash recovery with session resume.
- NSIS installer, GitHub Actions CI and release pipeline, signed auto-updates.
