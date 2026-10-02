# Changelog

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
