//! Agent-driven environment control: Central finds or creates connections,
//! adds MCP servers from a command line, grants access, asks the user for
//! secrets or manual steps, and discovers its capabilities.
//!
//! Without MASTER CONTROL (scope "manage connections"), every change goes
//! through a user approval. Secrets are never accepted from agents: they are
//! requested from the user and stored in Windows Credential Manager.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pcc_connections::kinds;
use pcc_core::interpreter::{self, Intent, Interpretation};
use pcc_core::{CommandRecord, Connection, ConnectionKind, Error, Event, EventKind, PermissionRequest, Result};

use crate::dto::ConnectionInput;
use crate::engine::{Engine, PendingKind};

/// A change Central asked for that waits for the user's approval.
#[derive(Debug, Clone)]
pub enum AdminAction {
    CreateConnection(ConnectionInput),
    Grant { agent: String, connection: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserRequestKind {
    /// A password, token or key value for a connection.
    Secret,
    /// One-time SSH key installation (the user types the remote password in a terminal).
    SshKeySetup,
    /// `gh auth login` in a terminal.
    GithubLogin,
    /// Any other manual step.
    Action,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserRequest {
    pub id: String,
    pub agent_id: String,
    pub kind: UserRequestKind,
    pub title: String,
    pub reason: String,
    pub connection_id: Option<String>,
    /// Secret name (e.g. `password`, `token`, `API_KEY`).
    pub key: Option<String>,
    pub created_at: String,
}

/// Result of applying an interpreted command from the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedCommand {
    pub connection: Option<Connection>,
    pub created: bool,
    pub message: String,
}

fn same(a: Option<&str>, b: Option<&str>) -> bool {
    a.unwrap_or("").trim().eq_ignore_ascii_case(b.unwrap_or("").trim())
}

/// Two configurations that reach the same resource.
pub fn equivalent(kind: ConnectionKind, a: &Value, b: &Value) -> bool {
    let g = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let port = |v: &Value| v.get("port").and_then(Value::as_u64).unwrap_or(22);
    match kind {
        ConnectionKind::Ssh | ConnectionKind::Sftp => {
            same(g(a, "host").as_deref(), g(b, "host").as_deref())
                && same(g(a, "user").as_deref(), g(b, "user").as_deref())
                && port(a) == port(b)
        }
        ConnectionKind::Mcp | ConnectionKind::RobloxStudio => {
            let remote = |v: &Value| matches!(g(v, "transport").as_deref(), Some("http" | "sse"));
            if remote(a) || remote(b) {
                same(g(a, "url").as_deref(), g(b, "url").as_deref())
            } else {
                same(g(a, "command").as_deref(), g(b, "command").as_deref()) && a.get("args") == b.get("args")
            }
        }
        ConnectionKind::Http => same(g(a, "baseUrl").as_deref(), g(b, "baseUrl").as_deref()),
        ConnectionKind::Gitlab => {
            same(g(a, "host").as_deref(), g(b, "host").as_deref())
                && same(g(a, "project").as_deref(), g(b, "project").as_deref())
        }
        ConnectionKind::Terminal => {
            same(g(a, "shell").as_deref(), g(b, "shell").as_deref())
                && same(g(a, "distro").as_deref(), g(b, "distro").as_deref())
        }
        ConnectionKind::Github | ConnectionKind::Git | ConnectionKind::Local | ConnectionKind::Docker => true,
    }
}

/// Connection input for an interpreted `claude mcp add` or `ssh` command.
pub fn connection_from_intent(i: &Interpretation) -> Option<ConnectionInput> {
    match &i.intent {
        Intent::AddMcp { name, transport, command, args, url, env, headers, .. } => {
            let roblox = name.to_ascii_lowercase().contains("roblox")
                || command.as_deref().unwrap_or("").to_ascii_lowercase().contains("rbx");
            let mut secrets = BTreeMap::new();
            secrets.extend(env.iter().cloned());
            secrets.extend(headers.iter().cloned());
            Some(ConnectionInput {
                name: name.clone(),
                kind: if roblox { ConnectionKind::RobloxStudio } else { ConnectionKind::Mcp },
                config: json!({
                    "transport": transport,
                    "command": command.clone().unwrap_or_default(),
                    "args": args,
                    "url": url.clone().unwrap_or_default(),
                    "secretEnv": env.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
                    "secretHeaders": headers.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
                }),
                secrets: (!secrets.is_empty()).then_some(secrets),
                enabled: None,
            })
        }
        Intent::Ssh { user, host, port, key_path, .. } => Some(ConnectionInput {
            name: match user {
                Some(u) => format!("{u}@{host}"),
                None => host.clone(),
            },
            kind: ConnectionKind::Ssh,
            config: json!({
                "host": host,
                "user": user.clone().unwrap_or_default(),
                "port": port,
                "keyPath": key_path,
                "auth": if key_path.is_some() { "key" } else { "agent" },
            }),
            secrets: None,
            enabled: None,
        }),
        _ => None,
    }
}

/// Connection input built from Central's `find_or_create_connection` arguments (no secrets).
pub fn connection_from_args(args: &Value) -> Result<ConnectionInput> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let kind: ConnectionKind =
        serde_json::from_value(json!(s("kind").ok_or_else(|| Error::invalid("missing `kind`"))?))
            .map_err(|_| Error::invalid("unknown connection kind"))?;
    let config = match kind {
        ConnectionKind::Ssh | ConnectionKind::Sftp => json!({
            "host": s("host").ok_or_else(|| Error::invalid("missing `host`"))?,
            "user": s("user").ok_or_else(|| Error::invalid("missing `user`"))?,
            "port": args.get("port").and_then(Value::as_u64),
            "keyPath": s("key_path"),
            "auth": s("auth").unwrap_or_else(|| if s("key_path").is_some() { "key".into() } else { "agent".into() }),
        }),
        ConnectionKind::Mcp | ConnectionKind::RobloxStudio => json!({
            "transport": s("transport").unwrap_or_else(|| "stdio".into()),
            "command": s("command").unwrap_or_default(),
            "args": args.get("args").cloned().unwrap_or(json!([])),
            "url": s("url").unwrap_or_default(),
        }),
        ConnectionKind::Http => {
            json!({"baseUrl": s("url"), "healthPath": s("health_path").unwrap_or_default(), "authHeader": s("auth_header").unwrap_or_default()})
        }
        ConnectionKind::Gitlab => {
            json!({"host": s("host").unwrap_or_default(), "project": s("project").unwrap_or_default()})
        }
        ConnectionKind::Terminal => {
            json!({"shell": s("shell").unwrap_or_else(|| "powershell".into()), "distro": s("distro").unwrap_or_default()})
        }
        ConnectionKind::Github => json!({"repo": s("repo")}),
        _ => json!({}),
    };
    kinds::validate(kind, &config)?;
    let name = s("name").unwrap_or_else(|| match kind {
        ConnectionKind::Ssh | ConnectionKind::Sftp => {
            format!("{}@{}", s("user").unwrap_or_default(), s("host").unwrap_or_default())
        }
        other => format!("{other:?}"),
    });
    Ok(ConnectionInput { name, kind, config, secrets: None, enabled: None })
}

/// The approval request shown for a connection, without secret values.
fn describe_input(input: &ConnectionInput) -> Value {
    json!({
        "name": input.name,
        "kind": input.kind,
        "config": input.config,
        "secretNames": input.secrets.as_ref().map(|s| s.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
    })
}

impl Engine {
    fn may_manage_connections(&self) -> bool {
        let m = self.store.settings().master_control;
        m.active && m.manage_connections && !self.emergency
    }

    pub fn find_equivalent_connection(&self, kind: ConnectionKind, config: &Value) -> Result<Option<Connection>> {
        Ok(self.store.list_connections()?.into_iter().find(|c| c.kind == kind && equivalent(kind, &c.config, config)))
    }

    /// Returns the existing equivalent connection or creates it (user action: no approval).
    pub fn find_or_add_connection(&mut self, input: ConnectionInput) -> Result<(Connection, bool)> {
        if let Some(c) = self.find_equivalent_connection(input.kind, &input.config)? {
            return Ok((c, false));
        }
        let c = self.add_connection(input)?;
        self.refresh_secret_values();
        Ok((c, true))
    }

    /// Central asks for a connection: reuse, create (MASTER CONTROL) or ask the user.
    pub(crate) fn request_connection(&mut self, requester: &str, input: ConnectionInput) -> Result<String> {
        if let Some(c) = self.find_equivalent_connection(input.kind, &input.config)? {
            return Ok(format!(
                "Using the existing connection `{}` ({}, status {:?}). No duplicate created.",
                c.id, c.name, c.status
            ));
        }
        kinds::validate(input.kind, &input.config)?;
        if self.may_manage_connections() {
            let (c, _) = self.find_or_add_connection(input)?;
            return Ok(format!("Connection `{}` created under MASTER CONTROL. Test it with test_connection.", c.id));
        }
        let summary = format!("Create {:?} connection `{}`", input.kind, input.name);
        self.ask_admin(
            requester,
            "create_connection",
            summary.clone(),
            describe_input(&input),
            AdminAction::CreateConnection(input),
        )?;
        Ok(format!("{summary}: submitted to the user for approval. You will be notified."))
    }

    pub(crate) fn request_grant(&mut self, requester: &str, agent: &str, connection: &str) -> Result<String> {
        let a = self.store.agent(agent)?;
        let c = self
            .store
            .get_connection(connection)?
            .ok_or_else(|| Error::not_found(format!("connection {connection}")))?;
        if a.connections.contains(&c.id) {
            return Ok(format!("{agent} already has `{}`.", c.id));
        }
        if self.may_manage_connections() {
            self.apply_admin(AdminAction::Grant { agent: agent.into(), connection: c.id.clone() })?;
            return Ok(format!(
                "`{}` granted to {agent} under MASTER CONTROL (applies at its next session start).",
                c.id
            ));
        }
        let summary = format!("Grant connection `{}` to {agent}", c.id);
        self.ask_admin(
            requester,
            "grant_connection",
            summary.clone(),
            json!({"agent": agent, "connection": c.id}),
            AdminAction::Grant { agent: agent.into(), connection: c.id },
        )?;
        Ok(format!("{summary}: submitted to the user for approval."))
    }

    fn ask_admin(
        &mut self,
        requester: &str,
        tool: &str,
        summary: String,
        input: Value,
        action: AdminAction,
    ) -> Result<()> {
        let req = PermissionRequest {
            id: format!("perm-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            agent_id: requester.into(),
            tool_name: tool.into(),
            capability: "connections".into(),
            summary,
            input,
            reason: "Central wants to change the project's connections".into(),
            rule_key: format!("admin:{tool}"),
            created_at: pcc_core::now(),
        };
        self.ask_user(req, PendingKind::Admin(Box::new(action)))
    }

    /// Executes an approved admin action; returns a note for Central.
    pub(crate) fn apply_admin(&mut self, action: AdminAction) -> Result<String> {
        match action {
            AdminAction::CreateConnection(input) => {
                let (c, created) = self.find_or_add_connection(input)?;
                Ok(if created {
                    format!("Connection `{}` ({}) created. Test it with test_connection before use.", c.id, c.name)
                } else {
                    format!("An equivalent connection already existed: `{}`.", c.id)
                })
            }
            AdminAction::Grant { agent, connection } => {
                let mut a = self.store.agent(&agent)?;
                if !a.connections.contains(&connection) {
                    a.connections.push(connection.clone());
                    self.save_agent(&mut a)?;
                }
                Ok(format!("`{connection}` granted to {agent}; it applies at the agent's next session start."))
            }
        }
    }

    // ------------------------------------------------------------ user requests

    pub(crate) fn request_from_user(
        &mut self,
        agent: &str,
        kind: UserRequestKind,
        title: String,
        reason: String,
        connection_id: Option<String>,
        key: Option<String>,
    ) -> Result<UserRequest> {
        if let Some(c) = &connection_id {
            self.store.get_connection(c)?.ok_or_else(|| Error::not_found(format!("connection {c}")))?;
        }
        let r = UserRequest {
            id: format!("ask-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            agent_id: agent.into(),
            kind,
            title,
            reason,
            connection_id,
            key,
            created_at: pcc_core::now(),
        };
        self.emit(
            Event::new(EventKind::UserRequested, format!("{agent} needs you: {}", r.title), json!(r)).agent(agent),
        );
        self.user_requests.insert(r.id.clone(), r.clone());
        Ok(r)
    }

    pub fn pending_user_requests(&self) -> Vec<UserRequest> {
        self.user_requests.values().cloned().collect()
    }

    /// Stores a secret the user typed for a request; the value never reaches agents' prompts or logs.
    pub fn provide_secret(&mut self, request_id: &str, value: &str) -> Result<()> {
        let r = self
            .user_requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| Error::not_found(format!("request {request_id}")))?;
        let (Some(conn), Some(key)) = (r.connection_id.clone(), r.key.clone()) else {
            return Err(Error::invalid("this request does not take a secret"));
        };
        if value.is_empty() {
            return Err(Error::invalid("empty value"));
        }
        let c = self.store.get_connection(&conn)?.ok_or_else(|| Error::not_found(format!("connection {conn}")))?;
        let mut secrets = BTreeMap::new();
        secrets.insert(key.clone(), value.to_string());
        self.update_connection(
            &conn,
            ConnectionInput { name: c.name, kind: c.kind, config: c.config, secrets: Some(secrets), enabled: None },
        )?;
        self.refresh_secret_values();
        self.finish_user_request(request_id, &format!("The user stored `{key}` for `{conn}` in Windows Credential Manager. It is available to sessions granted this connection (restart them to apply)."))
    }

    /// Marks a request done (or dismissed) and tells the requesting agent.
    pub fn finish_user_request(&mut self, request_id: &str, note: &str) -> Result<()> {
        let r =
            self.user_requests.remove(request_id).ok_or_else(|| Error::not_found(format!("request {request_id}")))?;
        self.emit(
            Event::new(EventKind::UserRequestResolved, format!("Request resolved: {}", r.title), json!({"id": r.id}))
                .agent(&r.agent_id),
        );
        self.post_message(pcc_core::SYSTEM_ID, &r.agent_id, pcc_core::MessageKind::System, note, None, None)?;
        Ok(())
    }

    // ------------------------------------------------------------ secrets in logs

    /// Reloads the secret values used to redact logs and command outputs.
    pub(crate) fn refresh_secret_values(&mut self) {
        let mut values = Vec::new();
        for c in self.store.list_connections().unwrap_or_default() {
            if let Some(r) = &c.credential_ref {
                if let Ok(map) = pcc_connections::secrets::get(r) {
                    values.extend(map.into_values().filter(|v| v.len() >= 4));
                }
            }
        }
        self.secret_values = values;
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        pcc_connections::secrets::redact(text, &self.secret_values)
    }

    // ------------------------------------------------------------ interpreter

    /// Applies an interpreted command for the user (the user is the approver).
    pub fn apply_command(&mut self, line: &str) -> Result<AppliedCommand> {
        let i = interpreter::interpret(line).map_err(Error::invalid)?;
        let input = connection_from_intent(&i).ok_or_else(|| {
            Error::invalid(format!(
                "`{}` does not describe a connection; run it in a terminal or give it to Central",
                i.program
            ))
        })?;
        let (c, created) = self.find_or_add_connection(input)?;
        self.record_user_command(line, &i, Some(c.id.clone()));
        Ok(AppliedCommand {
            message: if created {
                format!("Connection `{}` created; test it to see its capabilities.", c.id)
            } else {
                format!("Equivalent connection `{}` already exists; nothing duplicated.", c.id)
            },
            connection: Some(c),
            created,
        })
    }

    fn record_user_command(&self, line: &str, i: &Interpretation, target: Option<String>) {
        let now = pcc_core::now();
        let _ = self.store.insert_command(CommandRecord {
            id: 0,
            agent_id: pcc_core::USER_ID.into(),
            source: "interpreter".into(),
            tool_use_id: None,
            raw: self.redact(line),
            program: Some(i.program.clone()),
            parsed: redacted_intent(i),
            target,
            capability: Some(i.capability.as_str().into()),
            decision: Some("user".into()),
            started_at: now.clone(),
            ended_at: Some(now),
            exit_code: None,
            is_error: Some(false),
            output: Some(i.summary.clone()),
        });
    }

    /// Records a Bash/PowerShell call of an agent (completed from its tool result).
    pub(crate) fn record_agent_command(&self, agent: &str, tool_use_id: &str, command: &str) {
        let parsed = interpreter::interpret(command).ok();
        let class = pcc_core::permissions::classify_command(command);
        let _ = self.store.insert_command(CommandRecord {
            id: 0,
            agent_id: agent.into(),
            source: "agent".into(),
            tool_use_id: Some(tool_use_id.into()),
            raw: self.redact(command),
            program: parsed.as_ref().map(|p| p.program.clone()),
            parsed: parsed.as_ref().map(redacted_intent).unwrap_or(Value::Null),
            target: class.ssh_host,
            capability: Some(class.capability.as_str().into()),
            decision: None,
            started_at: pcc_core::now(),
            ended_at: None,
            exit_code: None,
            is_error: None,
            output: None,
        });
    }

    pub(crate) fn finish_agent_command(&self, tool_use_id: &str, is_error: bool, text: &str) {
        // Only an exit code Claude Code actually reports ("Exit code N") is recorded.
        let exit = parse_exit_code(text);
        let out: String = self.redact(text).chars().take(8000).collect();
        let _ = self.store.finish_command(tool_use_id, exit, is_error, &out);
    }

    /// For the UI: the interpretation of a command line.
    pub fn interpret(&self, line: &str) -> Result<Interpretation> {
        interpreter::interpret(line).map_err(Error::invalid)
    }
}

/// Interpretation as JSON with secret values (env / header values) removed.
pub fn redacted_intent(i: &Interpretation) -> Value {
    let mut v = json!(i.intent);
    for key in ["env", "headers"] {
        if let Some(Value::Array(pairs)) = v.get_mut(key) {
            for p in pairs.iter_mut() {
                if let Value::Array(kv) = p {
                    if kv.len() == 2 {
                        kv[1] = json!("••••••");
                    }
                }
            }
        }
    }
    v
}

pub fn parse_exit_code(text: &str) -> Option<i32> {
    let idx = text.find("Exit code ")?;
    text[idx + 10..].split(|c: char| !c.is_ascii_digit() && c != '-').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equivalence_rules() {
        assert!(equivalent(
            ConnectionKind::Ssh,
            &json!({"host": "192.168.1.157", "user": "pi"}),
            &json!({"host": "192.168.1.157", "user": "PI", "port": 22})
        ));
        assert!(!equivalent(
            ConnectionKind::Ssh,
            &json!({"host": "h", "user": "pi"}),
            &json!({"host": "h", "user": "root"})
        ));
        assert!(!equivalent(
            ConnectionKind::Ssh,
            &json!({"host": "h", "user": "pi"}),
            &json!({"host": "h", "user": "pi", "port": 2222})
        ));
        let a = json!({"transport": "stdio", "command": "cmd.exe", "args": ["/c", "x"]});
        assert!(equivalent(ConnectionKind::Mcp, &a, &a.clone()));
        assert!(!equivalent(
            ConnectionKind::Mcp,
            &a,
            &json!({"transport": "stdio", "command": "cmd.exe", "args": ["/c", "y"]})
        ));
        assert!(equivalent(
            ConnectionKind::Mcp,
            &json!({"transport": "http", "url": "https://u"}),
            &json!({"transport": "http", "url": "https://U"})
        ));
    }

    #[test]
    fn intents_become_connections_with_secret_values_separated() {
        let i = interpreter::interpret(r#"claude mcp add --transport stdio Roblox_Studio -- "cmd.exe" "/c" "cd /d %LOCALAPPDATA%\Roblox && .\mcp.bat""#).unwrap();
        let c = connection_from_intent(&i).unwrap();
        assert_eq!(c.kind, ConnectionKind::RobloxStudio);
        assert_eq!(c.config["command"], "cmd.exe");
        kinds::validate(c.kind, &c.config).unwrap();
        let e = interpreter::interpret("claude mcp add api -e TOKEN=s3cret -- npx srv").unwrap();
        let c = connection_from_intent(&e).unwrap();
        assert_eq!(c.config["secretEnv"], json!(["TOKEN"]));
        assert_eq!(c.secrets.unwrap()["TOKEN"], "s3cret");
        assert_eq!(redacted_intent(&e)["env"][0][1], "••••••");
        let s = connection_from_intent(&interpreter::interpret("ssh pi@192.168.1.157").unwrap()).unwrap();
        assert_eq!((s.name.as_str(), s.config["auth"].as_str()), ("pi@192.168.1.157", Some("agent")));
        assert!(connection_from_intent(&interpreter::interpret("npm test").unwrap()).is_none());
    }

    #[test]
    fn args_and_exit_codes() {
        let c = connection_from_args(&json!({"kind": "ssh", "host": "192.168.1.157", "user": "pi"})).unwrap();
        assert_eq!(c.name, "pi@192.168.1.157");
        assert!(connection_from_args(&json!({"kind": "ssh", "host": "h"})).is_err());
        assert!(connection_from_args(&json!({"kind": "teleport"})).is_err());
        assert_eq!(parse_exit_code("Error: Exit code 127\nnot found"), Some(127));
        assert_eq!(parse_exit_code("all good"), None);
    }
}
