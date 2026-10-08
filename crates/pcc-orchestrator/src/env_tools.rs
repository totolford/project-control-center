//! Central's environment tools: capability discovery, connections, MCP from
//! a command line, grants, user requests, GitHub discovery, command
//! interpretation. Slow ones (tests, probes, GitHub) answer later so they never
//! block the other agents.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use serde_json::{json, Value};

use pcc_claude::protocol;
use pcc_connections::{environment, github, kinds};
use pcc_core::interpreter;
use pcc_core::{ConnectionKind, Error, Result};

use crate::admin::{connection_from_args, connection_from_intent, UserRequestKind};
use crate::engine::Engine;
use crate::tools::Reply;

/// Produces the tool's text with engine access once the slow part is done.
type Finish = Box<dyn FnOnce(&mut Engine) -> Result<String> + Send>;
type Later = Pin<Box<dyn Future<Output = Result<Finish>> + Send>>;

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({"name": name, "description": description,
           "inputSchema": {"type": "object", "properties": props, "required": required, "additionalProperties": false}})
}

pub fn definitions() -> Vec<Value> {
    let kinds = "ssh, sftp, mcp, roblox_studio, http, gitlab, terminal, github, docker";
    vec![
        tool("list_capabilities", "What you can use right now: Claude Code, connections (status, granted), MCP servers, skills, GitHub login, local tools. Call it before planning work that needs external resources.", json!({}), &[]),
        tool(
            "find_or_create_connection",
            &format!("Reuse an equivalent connection or create one (kinds: {kinds}). Never pass secrets: use request_secret. Without MASTER CONTROL the user approves the creation."),
            json!({
                "kind": {"type": "string"}, "name": {"type": "string"}, "host": {"type": "string"}, "user": {"type": "string"},
                "port": {"type": "integer"}, "key_path": {"type": "string"}, "auth": {"type": "string", "enum": ["key", "agent"]},
                "url": {"type": "string"}, "transport": {"type": "string", "enum": ["stdio", "http", "sse"]}, "command": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}}, "shell": {"type": "string"}, "distro": {"type": "string"},
                "repo": {"type": "string"}, "project": {"type": "string"}, "health_path": {"type": "string"}, "auth_header": {"type": "string"}
            }),
            &["kind"],
        ),
        tool(
            "add_mcp_from_command",
            "Register an MCP server from a `claude mcp add ...` command line (as the user gave it). Values after -e / -H are stored in the OS credential store (Windows Credential Manager, or the Secret Service on Linux). Reuses an equivalent server.",
            json!({"command": {"type": "string"}}),
            &["command"],
        ),
        tool("grant_connection", "Give an agent access to a connection (applies at its next session start).", json!({"agent": {"type": "string"}, "connection": {"type": "string"}}), &["agent", "connection"]),
        tool("test_connection", "Health-check a connection now (SSH reachability, MCP tools, HTTP status...). Takes a few seconds.", json!({"connection": {"type": "string"}}), &["connection"]),
        tool(
            "request_secret",
            "Ask the user to enter a secret (password, token, API key) for a connection. You never see the value; you are told when it is stored.",
            json!({"connection": {"type": "string"}, "key": {"type": "string", "description": "e.g. token, password, API_KEY"}, "reason": {"type": "string"}}),
            &["connection", "key", "reason"],
        ),
        tool(
            "request_user_action",
            "Ask the user for a step only a human can do: ssh_key_setup (install an SSH key once, the user types the remote password), github_login (gh auth login), or action (anything else).",
            json!({"kind": {"type": "string", "enum": ["ssh_key_setup", "github_login", "action"]}, "title": {"type": "string"}, "reason": {"type": "string"}, "connection": {"type": "string"}}),
            &["kind", "title", "reason"],
        ),
        tool("github_repositories", "List the user's GitHub repositories (or an owner's), filtered by search words. Uses the user's gh login.", json!({"query": {"type": "string"}, "owner": {"type": "string"}}), &[]),
        tool("interpret_command", "Parse a command line (claude, ssh, git, gh, npm, docker...) into intent, target and required permission, without running it.", json!({"command": {"type": "string"}}), &["command"]),
    ]
}

fn s<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn req<'a>(args: &'a Value, k: &str) -> Result<&'a str> {
    s(args, k).ok_or_else(|| Error::invalid(format!("missing `{k}`")))
}

/// Answers environment tools; `None` when `name` is not one of them.
pub fn call(e: &mut Engine, me: &str, request_id: &str, rpc_id: Value, name: &str, args: &Value) -> Option<Reply> {
    let now = |r: Result<String>| Some(Reply::text(rpc_id.clone(), r));
    match name {
        "find_or_create_connection" => {
            now(connection_from_args(args).and_then(|input| e.request_connection(me, input)))
        }
        "add_mcp_from_command" => now((|| {
            let i = interpreter::interpret(req(args, "command")?).map_err(Error::invalid)?;
            let input = connection_from_intent(&i)
                .filter(|c| matches!(c.kind, ConnectionKind::Mcp | ConnectionKind::RobloxStudio))
                .ok_or_else(|| Error::invalid("not a `claude mcp add` command"))?;
            e.request_connection(me, input)
        })()),
        "grant_connection" => now((|| e.request_grant(me, req(args, "agent")?, req(args, "connection")?))()),
        "request_secret" => now((|| {
            let conn = req(args, "connection")?.to_string();
            let key = req(args, "key")?.to_string();
            let r = e.request_from_user(
                me,
                UserRequestKind::Secret,
                format!("Enter `{key}` for {conn}"),
                req(args, "reason")?.into(),
                Some(conn),
                Some(key),
            )?;
            Ok(format!(
                "Request {} shown to the user. End your turn; you will be notified when the secret is stored.",
                r.id
            ))
        })()),
        "request_user_action" => now((|| {
            let kind = match req(args, "kind")? {
                "ssh_key_setup" => UserRequestKind::SshKeySetup,
                "github_login" => UserRequestKind::GithubLogin,
                _ => UserRequestKind::Action,
            };
            let r = e.request_from_user(
                me,
                kind,
                req(args, "title")?.into(),
                req(args, "reason")?.into(),
                s(args, "connection").map(str::to_string),
                None,
            )?;
            Ok(format!("Request {} shown to the user. End your turn; you will be notified when it is done.", r.id))
        })()),
        "interpret_command" => now((|| {
            let i = interpreter::interpret(req(args, "command")?).map_err(Error::invalid)?;
            let mut v = json!(i);
            v["intent"] = crate::admin::redacted_intent(&i);
            Ok(serde_json::to_string_pretty(&v)?)
        })()),
        "test_connection" => later(e, me, request_id, rpc_id, test_connection(e, args)),
        "github_repositories" => later(e, me, request_id, rpc_id, github_repositories(e, args)),
        "list_capabilities" => later(e, me, request_id, rpc_id, capabilities(e, me)),
        _ => None,
    }
}

/// Runs the slow part in the background and answers the tool call afterwards.
fn later(e: &Engine, agent: &str, request_id: &str, rpc_id: Value, work: Result<Later>) -> Option<Reply> {
    let work = match work {
        Ok(w) => w,
        Err(err) => return Some(Reply::text(rpc_id, Err(err))),
    };
    let tx = e.jobs_tx.clone();
    let (agent, request_id) = (agent.to_string(), request_id.to_string());
    tokio::spawn(async move {
        let outcome = work.await;
        let _ = tx.send(Box::new(move |e: &mut Engine| {
            let text = outcome.and_then(|finish| finish(e));
            let rpc = Reply::text(rpc_id, text).into_value();
            e.write(&agent, protocol::mcp_reply(&request_id, rpc))
        }));
    });
    Some(Reply::Later)
}

fn test_connection(e: &Engine, args: &Value) -> Result<Later> {
    let id = req(args, "connection")?.to_string();
    let c = e.store.get_connection(&id)?.ok_or_else(|| Error::not_found(format!("connection {id}")))?;
    let root = e.store.root().to_path_buf();
    Ok(Box::pin(async move {
        let result = kinds::check_connection(&c, &root).await;
        let finish: Finish = Box::new(move |e: &mut Engine| {
            let c = e.record_check(&id, result)?;
            Ok(format!("`{}`: {:?} — {}", c.id, c.status, c.status_detail.unwrap_or_default()))
        });
        Ok(finish)
    }))
}

fn github_repositories(e: &Engine, args: &Value) -> Result<Later> {
    let root = e.store.root().to_path_buf();
    let query = s(args, "query").map(str::to_string);
    let owner = s(args, "owner").map(str::to_string);
    Ok(Box::pin(async move {
        let repos =
            tokio::task::spawn_blocking(move || github::repositories(&root, owner.as_deref(), query.as_deref(), 100))
                .await
                .map_err(|e| Error::Process(e.to_string()))??;
        let rows: Vec<Value> = repos
            .iter()
            .map(|r| json!({"repo": r["nameWithOwner"], "description": r["description"], "visibility": r["visibility"], "updatedAt": r["updatedAt"], "url": r["url"]}))
            .collect();
        let text =
            if rows.is_empty() { "No repository matches.".to_string() } else { serde_json::to_string_pretty(&rows)? };
        let finish: Finish = Box::new(move |_| Ok(text));
        Ok(finish)
    }))
}

fn capabilities(e: &Engine, me: &str) -> Result<Later> {
    let root: PathBuf = e.store.root().to_path_buf();
    let claude = e.claude.clone();
    let me = me.to_string();
    Ok(Box::pin(async move {
        let r2 = root.clone();
        let (tools, gh) = tokio::task::spawn_blocking(move || (environment::detect_tools(), github::status(&r2, None)))
            .await
            .map_err(|e| Error::Process(e.to_string()))?;
        let skills = match claude {
            Some(exe) => {
                let r3 = root.clone();
                tokio::task::spawn_blocking(move || {
                    let plugins: Vec<Value> = pcc_claude::process::std_command(&exe)
                        .args(["plugin", "list", "--json"])
                        .output()
                        .ok()
                        .and_then(|o| serde_json::from_slice(&o.stdout).ok())
                        .unwrap_or_default();
                    let roots = pcc_claude::skills::SkillRoots::new(Some(&r3), &plugins);
                    pcc_claude::skills::list(&roots)
                        .into_iter()
                        .filter(|s| s.enabled)
                        .map(|s| s.name)
                        .collect::<Vec<_>>()
                })
                .await
                .unwrap_or_default()
            }
            None => vec![],
        };
        let finish: Finish = Box::new(move |e: &mut Engine| {
            let me_agent = e.store.agent(&me)?;
            let settings = e.store.settings();
            let mastered = crate::policy::mastered(&me_agent, &settings.master_control);
            let connections: Vec<Value> = e
                .store
                .list_connections()?
                .into_iter()
                .map(|c| {
                    let usable = c.enabled
                        && (me_agent.connections.contains(&c.id)
                            || (mastered && crate::policy::master_covers_connection(&settings.master_control, c.kind)));
                    json!({"id": c.id, "name": c.name, "kind": c.kind, "status": c.status, "detail": c.status_detail,
                           "enabled": c.enabled, "usableByYou": usable})
                })
                .collect();
            let perms = crate::policy::effective_permissions(&me_agent, &settings.autonomy, &settings.master_control);
            let report = json!({
                "claudeCode": {"available": e.claude.is_some()},
                "masterControl": settings.master_control,
                "unlocked": settings.autonomy.unlocked,
                "yourPermissions": perms,
                "connections": connections,
                "skillsEnabled": skills,
                "github": {"cli": gh.cli_installed, "signedIn": gh.authenticated, "account": gh.account},
                "localTools": tools.iter().map(|t| json!({"tool": t.label, "found": t.detected, "version": t.detail})).collect::<Vec<_>>(),
                "notes": [
                    "Connections marked usableByYou=false need grant_connection (or MASTER CONTROL).",
                    "Claude Code's own MCP servers are not available to NEXUS agents unless added as NEXUS connections."
                ]
            });
            Ok(serde_json::to_string_pretty(&report)?)
        });
        Ok(finish)
    }))
}
