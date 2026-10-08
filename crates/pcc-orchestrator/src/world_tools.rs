//! NEXUS HQ (the AI World building) from the engine: Central's
//! `manage_ai_world` tool, the same operations for the AI World page, and
//! the world view's repair warnings and crash reports.
//!
//! Every change goes through `pcc_world::hq::HqStore::apply` (snapshot before
//! a structural change, validation, rollback on error) and is journaled
//! (`world.<op>`). Archiving a room asks the user first (unless it is a
//! temporary room and the world's rules let Central archive those alone).

use serde_json::{json, Value};

use pcc_core::{Error, Event, EventKind, PermissionRequest, Result, Severity};
use pcc_recovery::CrashReport;
use pcc_world::hq::{self, detect, validate, HqStore, OpContext, ProjectFacts, WorldConfig, WorldOp};

use crate::admin::AdminAction;
use crate::engine::{Engine, PendingKind};

pub const TOOL: &str = "manage_ai_world";

pub fn definition() -> Value {
    let kinds: Vec<&String> = hq::catalog::catalog().kinds.keys().collect();
    let decor: Vec<&String> = hq::catalog::catalog().decor.keys().collect();
    json!({
        "name": TOOL,
        "description": format!(
            "The AI World is ONE building, NEXUS HQ, made of functional rooms; agents walk to the room of what they really do. \
             op: list_rooms | suggest_rooms (read-only: rooms the project's real files/connections call for, and rooms that lost their reason to exist) | \
             create_room (type, name?, purpose?, temporary?, agents?, required_connections?) | delete_room (room; archives it, the user approves) | restore_room | \
             rename_room (room, name) | move_room (room, x, y) | resize_room (room, w, h) | connect_rooms / disconnect_rooms (from, to) | \
             assign_room (room, purpose?, agents? | add_agents? | remove_agents?, required_connections?) | decorate_room (room, decor: functional furniture only) | \
             change_language (language: auto|en|fr) | set_layout (mode: auto|manual) | repair_world. \
             Room types: {kinds:?}. Furniture: {decor:?}. Rooms are referenced by id or name."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "op": {"type": "string", "enum": [
                    "list_rooms", "suggest_rooms", "create_room", "delete_room", "restore_room", "rename_room", "move_room",
                    "resize_room", "connect_rooms", "disconnect_rooms", "assign_room", "decorate_room", "change_language",
                    "set_layout", "repair_world"
                ]},
                "room": {"type": "string"},
                "type": {"type": "string"},
                "name": {"type": "string"},
                "purpose": {"type": "string"},
                "temporary": {"type": "boolean"},
                "agents": {"type": "array", "items": {"type": "string"}},
                "add_agents": {"type": "array", "items": {"type": "string"}},
                "remove_agents": {"type": "array", "items": {"type": "string"}},
                "required_connections": {"type": "array", "items": {"type": "string"}, "description": "connection names or `mcp:<server>`"},
                "decor": {"type": "array", "items": {"type": "string"}},
                "x": {"type": "integer"}, "y": {"type": "integer"},
                "w": {"type": "integer"}, "h": {"type": "integer"},
                "from": {"type": "string"}, "to": {"type": "string"},
                "language": {"type": "string"},
                "mode": {"type": "string", "enum": ["auto", "manual"]}
            },
            "required": ["op"],
            "additionalProperties": false
        }
    })
}

/// `(kind, name)` of the project's connections, for domain detection and repair.
fn facts(e: &Engine) -> ProjectFacts {
    let connections = e
        .store
        .list_connections()
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            let kind =
                serde_json::to_value(c.kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            (kind, c.name)
        })
        .collect();
    ProjectFacts { connections }
}

/// Central's tool.
pub fn call(e: &mut Engine, me: &str, args: &Value) -> Result<String> {
    let op = args.get("op").and_then(Value::as_str).unwrap_or_default();
    match op {
        "list_rooms" => {
            let cfg = e.ai_world()?;
            Ok(serde_json::to_string_pretty(&summary(&cfg))?)
        }
        "suggest_rooms" => {
            let cfg = e.ai_world()?;
            let domains = detect::detect(e.store.root(), &facts(e));
            Ok(serde_json::to_string_pretty(&json!({
                "domains": domains,
                "suggestions": detect::suggestions(&cfg, &domains),
                "note": "Suggestions come from the project's real files, dependencies and connections. Create rooms with create_room; ask the user before archiving."
            }))?)
        }
        _ => {
            let parsed: WorldOp = serde_json::from_value(args.clone())
                .map_err(|err| Error::invalid(format!("manage_ai_world: {err}")))?;
            let cfg = e.ai_world()?;
            if parsed.needs_approval(&cfg) {
                let summary = parsed.summary(&cfg);
                let req = PermissionRequest {
                    id: format!("perm-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
                    agent_id: me.into(),
                    tool_name: TOOL.into(),
                    capability: "world".into(),
                    summary: summary.clone(),
                    input: serde_json::to_value(&parsed)?,
                    reason: "Central wants to archive a room of the AI World (nothing is erased; it can be restored)"
                        .into(),
                    rule_key: format!("admin:{TOOL}:{}", parsed.name()),
                    created_at: pcc_core::now(),
                };
                e.ask_user(req, PendingKind::Admin(Box::new(AdminAction::World { op: parsed })))?;
                return Ok(format!("{summary}: submitted to the user for approval. You will be notified."));
            }
            e.apply_world_op(me, &parsed)
        }
    }
}

/// What Central sees of the building.
fn summary(cfg: &WorldConfig) -> Value {
    json!({
        "language": cfg.language,
        "locale": cfg.locale,
        "layout": cfg.layout,
        "revision": cfg.revision,
        "rooms": cfg.rooms.iter().map(|r| json!({
            "id": r.id, "name": r.name, "type": r.kind, "purpose": r.purpose, "agents": r.agents,
            "requiredConnections": r.required_connections, "temporary": r.temporary, "archived": r.archived,
            "persistent": r.persistent, "position": r.position, "size": r.size, "decor": r.decor,
        })).collect::<Vec<_>>(),
        "connections": cfg.connections,
        "rules": cfg.rules,
    })
}

impl Engine {
    /// The project's building (created from the project's real facts on first use).
    pub fn ai_world(&self) -> Result<WorldConfig> {
        hq::ensure_world(self.store.root(), &self.store.settings().ai_world_language, &facts(self))
    }

    /// Applies an operation (snapshot, validation, rollback) and journals it.
    /// `actor`: `central` (or another agent id) or `user`.
    pub fn apply_world_op(&mut self, actor: &str, op: &WorldOp) -> Result<String> {
        self.ai_world()?;
        let agents: Vec<String> = self.store.list_agents()?.into_iter().map(|a| a.id).collect();
        let store = HqStore::for_project(self.store.root());
        let who = if actor == "user" { "user" } else { "central" };
        match store.apply(op, &OpContext { actor: who, agents: &agents }) {
            Ok(applied) => {
                if let WorldOp::ChangeLanguage { language, .. } = op {
                    let mut s = self.store.settings();
                    if &s.ai_world_language != language {
                        s.ai_world_language = language.clone();
                        self.store.save_settings(s)?;
                    }
                }
                let warnings: Vec<&str> = applied.warnings.iter().map(|w| w.message.as_str()).collect();
                let mut e = Event::new(
                    EventKind::SystemNotice,
                    format!("AI World: {}", applied.message),
                    json!({
                        "op": op,
                        "actor": actor,
                        "message": applied.message,
                        "revision": applied.config.revision,
                        "snapshot": applied.snapshot,
                        "warnings": warnings,
                    }),
                )
                .named(format!("world.{}", op.name()))
                .with_source(if actor == "user" { "ui" } else { "engine" });
                if actor != "user" {
                    e.agent_id = Some(actor.to_string());
                }
                self.emit(e);
                let mut text = applied.message;
                if !warnings.is_empty() {
                    text.push_str(&format!(" Warnings: {}.", warnings.join("; ")));
                }
                Ok(text)
            }
            Err(err) => {
                self.emit(
                    Event::new(
                        EventKind::SystemNotice,
                        format!("AI World change refused: {err}"),
                        json!({"op": op, "actor": actor, "error": err.to_string()}),
                    )
                    .named("world.refused")
                    .with_severity(Severity::Warning)
                    .with_source(if actor == "user" { "ui" } else { "engine" }),
                );
                Err(err)
            }
        }
    }

    /// Validation issues of the current building.
    pub fn ai_world_issues(&self) -> Result<Vec<validate::Issue>> {
        Ok(validate::validate(&self.ai_world()?))
    }

    /// Domains and room suggestions from the project's real facts.
    pub fn ai_world_suggestions(&self) -> Result<Value> {
        let cfg = self.ai_world()?;
        let domains = detect::detect(self.store.root(), &facts(self));
        Ok(json!({"domains": domains, "suggestions": detect::suggestions(&cfg, &domains)}))
    }

    /// Puts a snapshot back (journaled).
    pub fn restore_world_snapshot(&mut self, id: &str) -> Result<WorldConfig> {
        let cfg = HqStore::for_project(self.store.root()).restore(id)?;
        self.emit(
            Event::new(
                EventKind::SystemNotice,
                format!("AI World restored from snapshot {id}"),
                json!({"snapshot": id, "revision": cfg.revision}),
            )
            .named("world.rollback")
            .with_source("ui"),
        );
        Ok(cfg)
    }

    /// A character the world view had to repair or hide (journal warning).
    pub fn record_world_warning(&mut self, code: &str, agent: &str, detail: &str, repair: &str) {
        let code: String = code.chars().filter(|c| c.is_ascii_uppercase() || *c == '_').take(64).collect();
        let mut e = Event::new(
            EventKind::SystemNotice,
            format!("{code}: {repair}"),
            json!({"code": code, "agentId": agent, "detail": detail, "repair": repair}),
        )
        .named("world.repair")
        .with_severity(Severity::Warning)
        .with_source("ui");
        if !agent.is_empty() {
            e.agent_id = Some(agent.chars().take(80).collect());
        }
        self.emit(e);
    }

    /// The world view crashed: its context becomes a crash report (Diagnostics).
    pub fn report_world_crash(&mut self, context: &Value) -> Option<String> {
        let mut r = world_crash_report(context);
        r.project = Some(self.store.root().display().to_string());
        self.file_report(r)
    }
}

/// A world-view crash as a crash report. Context fields: see ai-town/src/nexus/trace.ts `CrashContext`.
pub fn world_crash_report(c: &Value) -> CrashReport {
    let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").chars().take(500).collect::<String>();
    let mut r = CrashReport::new("ai-world", "The AI World view crashed");
    r.severity = pcc_recovery::Severity::Warning;
    r.what_happened = format!("AI World encountered a rendering error: {}", s("message"));
    r.possible_cause = if s("renderer").contains("lost") {
        "The graphics context was lost (GPU driver reset or out of memory).".into()
    } else if !s("characterId").is_empty() && s("lastRenderOp").starts_with("draw character") {
        "A character's appearance or sprite could not be drawn.".into()
    } else {
        "A world element could not be drawn.".into()
    };
    r.preserved = vec![
        "AI Town engine (local Convex backend) kept running".into(),
        "Agents, missions and their sessions untouched".into(),
    ];
    r.agent_id = c.get("characterId").and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    for (label, key) in [
        ("Last render operation", "lastRenderOp"),
        ("Character", "characterId"),
        ("Room", "roomId"),
        ("Last event", "lastEvent"),
        ("Sprite", "sprite"),
        ("Asset", "asset"),
        ("Renderer", "renderer"),
        ("At", "at"),
    ] {
        let v = s(key);
        if !v.is_empty() {
            r.details.push(format!("{label}: {v}"));
        }
    }
    for (label, key) in [("Appearance", "appearance"), ("Camera", "camera"), ("World", "world")] {
        if let Some(v) = c.get(key).filter(|v| !v.is_null()) {
            r.details.push(format!("{label}: {}", v.to_string().chars().take(500).collect::<String>()));
        }
    }
    if c.get("safeMode").and_then(Value::as_bool) == Some(true) {
        r.details.push("Safe Mode was on".into());
    }
    let stack = s("stack");
    if !stack.is_empty() {
        r.details.push(format!("Stack: {}", stack.lines().take(6).collect::<Vec<_>>().join(" | ")));
    }
    r.acknowledged = true;
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_context_becomes_a_report() {
        let r = world_crash_report(&json!({
            "message": "Cannot read properties of undefined (reading 'frames')",
            "lastRenderOp": "draw character w1",
            "characterId": "w1",
            "roomId": "server_room",
            "sprite": "nexus-skin:broken",
            "appearance": {"character": "nexus-skin:broken"},
            "camera": {"mode": "follow"},
            "renderer": "webgl",
            "world": {"agents": 3, "rooms": 6},
            "safeMode": false
        }));
        assert_eq!(r.component, "ai-world");
        assert_eq!(r.agent_id.as_deref(), Some("w1"));
        assert!(r.possible_cause.contains("appearance"));
        let d = r.details.join("\n");
        for needle in ["draw character w1", "server_room", "nexus-skin:broken", "\"follow\"", "webgl"] {
            assert!(d.contains(needle), "{needle} in {d}");
        }
        let lost = world_crash_report(&json!({"message": "x", "renderer": "webgl context lost"}));
        assert!(lost.possible_cause.contains("graphics context"));
    }

    #[test]
    fn the_tool_schema_lists_every_operation() {
        let d = definition();
        let ops = d["inputSchema"]["properties"]["op"]["enum"].as_array().unwrap();
        for op in [
            "create_room",
            "delete_room",
            "rename_room",
            "move_room",
            "resize_room",
            "connect_rooms",
            "assign_room",
            "decorate_room",
            "change_language",
            "repair_world",
        ] {
            assert!(ops.iter().any(|o| o == op), "{op}");
        }
        // Every mutating op parses from the flat tool arguments.
        for args in [
            json!({"op": "create_room", "type": "api_lab", "temporary": true}),
            json!({"op": "move_room", "room": "api_lab", "x": 3, "y": 4}),
            json!({"op": "resize_room", "room": "api_lab", "w": 9, "h": 6}),
            json!({"op": "assign_room", "room": "api_lab", "add_agents": ["w1"]}),
            json!({"op": "decorate_room", "room": "api_lab", "decor": ["workstation"]}),
            json!({"op": "change_language", "language": "fr"}),
            json!({"op": "set_layout", "mode": "manual"}),
            json!({"op": "repair_world"}),
        ] {
            serde_json::from_value::<WorldOp>(args.clone()).unwrap_or_else(|e| panic!("{args}: {e}"));
        }
    }
}
