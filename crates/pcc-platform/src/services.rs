//! Optional background components as `systemd --user` units (Ubuntu). Units
//! live in `~/.config/systemd/user`, run as the user and never need root:
//! NEXUS refuses to manage services when it runs as root. Windows has no
//! equivalent NEXUS uses (components run as NEXUS's own children there).

use std::path::PathBuf;

use serde::Serialize;

use crate::paths::find_program;
use crate::{platform, Os};

/// A background component NEXUS can register.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserService {
    /// Unit name without `.service`; always prefixed with `nexus-`.
    pub name: String,
    pub description: String,
    /// Program (absolute path) and arguments.
    pub exec: Vec<String>,
    pub working_dir: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub restart_on_failure: bool,
}

/// Whether the user service manager can be used here.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceManagerStatus {
    pub available: bool,
    /// `systemd --user`, or `None` on Windows.
    pub manager: Option<String>,
    /// `running`, `degraded`… as reported by `systemctl --user is-system-running`.
    pub state: Option<String>,
    pub reason: Option<String>,
}

/// One `ExecStart=` word: quoted, with `\`, `"`, `%` and `$` escaped.
pub fn quote_exec_arg(arg: &str) -> String {
    let mut out = String::from("\"");
    for ch in arg.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            '\n' | '\r' => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn valid_name(name: &str) -> bool {
    name.starts_with("nexus-")
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The unit file text.
pub fn unit_file(s: &UserService) -> Result<String, String> {
    if !valid_name(&s.name) {
        return Err(format!("invalid service name `{}` (must start with nexus-)", s.name));
    }
    let program = s.exec.first().ok_or("a service needs a program")?;
    if !program.starts_with('/') {
        return Err("the service program must be an absolute path".into());
    }
    let one_line = |t: &str| t.replace(['\n', '\r'], " ");
    let mut u = String::new();
    u.push_str("# Created by NEXUS. Remove it from NEXUS or with `systemctl --user disable --now ");
    u.push_str(&s.name);
    u.push_str("`.\n[Unit]\n");
    u.push_str(&format!("Description={}\n", one_line(&s.description)));
    u.push_str("\n[Service]\nType=simple\n");
    u.push_str(&format!("ExecStart={}\n", s.exec.iter().map(|a| quote_exec_arg(a)).collect::<Vec<_>>().join(" ")));
    if let Some(dir) = &s.working_dir {
        u.push_str(&format!("WorkingDirectory={}\n", quote_exec_arg(&dir.to_string_lossy())));
    }
    for (k, v) in &s.env {
        if !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || k.is_empty() {
            return Err(format!("invalid environment variable name `{k}`"));
        }
        u.push_str(&format!("Environment={}\n", quote_exec_arg(&format!("{k}={v}"))));
    }
    if s.restart_on_failure {
        u.push_str("Restart=on-failure\nRestartSec=5\n");
    }
    u.push_str("\n[Install]\nWantedBy=default.target\n");
    Ok(u)
}

/// `~/.config/systemd/user`.
pub fn unit_dir() -> Option<PathBuf> {
    platform().config_dir().map(|c| c.join("systemd").join("user"))
}

pub fn unit_path(name: &str) -> Option<PathBuf> {
    unit_dir().map(|d| d.join(format!("{name}.service")))
}

fn systemctl(args: &[&str]) -> Result<String, String> {
    let program = find_program("systemctl").ok_or("systemctl is not installed")?;
    let mut c = std::process::Command::new(program);
    c.arg("--user").args(args);
    crate::process::prepare_std(&mut c);
    let out = c.stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { text } else { err })
    }
}

/// Blocking: asks systemd for the state of the user manager.
pub fn status() -> ServiceManagerStatus {
    if Os::current() != Os::Linux {
        return ServiceManagerStatus {
            available: false,
            manager: None,
            state: None,
            reason: Some("No user service manager on this OS; NEXUS runs components as its own child processes".into()),
        };
    }
    let manager = Some("systemd --user".to_string());
    if crate::process::is_root() {
        return ServiceManagerStatus {
            available: false,
            manager,
            state: None,
            reason: Some("NEXUS is running as root: user services are disabled".into()),
        };
    }
    if find_program("systemctl").is_none() {
        return ServiceManagerStatus {
            available: false,
            manager,
            state: None,
            reason: Some("systemctl not found (not a systemd system)".into()),
        };
    }
    // Exit code is non-zero for `degraded` too: read the word itself.
    let mut c = std::process::Command::new("systemctl");
    c.args(["--user", "is-system-running"]);
    crate::process::prepare_std(&mut c);
    match c.stdin(std::process::Stdio::null()).output() {
        Ok(o) => {
            let state = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let usable = matches!(state.as_str(), "running" | "degraded" | "starting" | "initializing");
            ServiceManagerStatus {
                available: usable,
                manager,
                reason: (!usable).then(|| {
                    let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    format!(
                        "systemd user manager not reachable{}",
                        if err.is_empty() { String::new() } else { format!(": {err}") }
                    )
                }),
                state: (!state.is_empty()).then_some(state),
            }
        }
        Err(e) => ServiceManagerStatus { available: false, manager, state: None, reason: Some(e.to_string()) },
    }
}

fn ensure_usable() -> Result<(), String> {
    let s = status();
    if s.available {
        Ok(())
    } else {
        Err(s.reason.unwrap_or_else(|| "user services unavailable".into()))
    }
}

/// Writes the unit, reloads systemd and (optionally) enables and starts it.
pub fn install(s: &UserService, start: bool) -> Result<PathBuf, String> {
    ensure_usable()?;
    let text = unit_file(s)?;
    let path = unit_path(&s.name).ok_or("no configuration folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    systemctl(&["daemon-reload"])?;
    if start {
        systemctl(&["enable", "--now", &format!("{}.service", s.name)])?;
    }
    Ok(path)
}

pub fn start(name: &str) -> Result<(), String> {
    ensure_usable()?;
    if !valid_name(name) {
        return Err(format!("not a NEXUS service: {name}"));
    }
    systemctl(&["start", &format!("{name}.service")]).map(|_| ())
}

pub fn stop(name: &str) -> Result<(), String> {
    ensure_usable()?;
    if !valid_name(name) {
        return Err(format!("not a NEXUS service: {name}"));
    }
    systemctl(&["stop", &format!("{name}.service")]).map(|_| ())
}

/// `active`, `inactive`, `failed`… (`unknown` when systemd cannot tell).
pub fn unit_state(name: &str) -> String {
    systemctl(&["is-active", &format!("{name}.service")]).unwrap_or_else(|e| {
        let w = e.split_whitespace().next().unwrap_or("unknown");
        if matches!(w, "inactive" | "failed" | "activating" | "deactivating") {
            w.to_string()
        } else {
            "unknown".into()
        }
    })
}

/// Disables, stops and deletes a NEXUS unit.
pub fn remove(name: &str) -> Result<(), String> {
    ensure_usable()?;
    if !valid_name(name) {
        return Err(format!("not a NEXUS service: {name}"));
    }
    let _ = systemctl(&["disable", "--now", &format!("{name}.service")]);
    if let Some(p) = unit_path(name).filter(|p| p.is_file()) {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    systemctl(&["daemon-reload"]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc() -> UserService {
        UserService {
            name: "nexus-ollama".into(),
            description: "Ollama for NEXUS".into(),
            exec: vec!["/usr/local/bin/ollama".into(), "serve".into()],
            working_dir: Some(PathBuf::from("/home/ada/my dir")),
            env: vec![("OLLAMA_MODELS".into(), "/home/ada/.ollama/models".into())],
            restart_on_failure: true,
        }
    }

    #[test]
    fn writes_a_user_unit() {
        let u = unit_file(&svc()).unwrap();
        assert!(u.contains("ExecStart=\"/usr/local/bin/ollama\" \"serve\"\n"));
        assert!(u.contains("WorkingDirectory=\"/home/ada/my dir\"\n"));
        assert!(u.contains("Environment=\"OLLAMA_MODELS=/home/ada/.ollama/models\"\n"));
        assert!(u.contains("Restart=on-failure"));
        assert!(u.contains("WantedBy=default.target"));
        assert!(!u.contains("User="), "user units never switch user");
    }

    #[test]
    fn escapes_and_rejects() {
        assert_eq!(quote_exec_arg(r#"a "b" $HOME 100%"#), r#""a \"b\" $$HOME 100%%""#);
        let mut bad = svc();
        bad.name = "ollama".into();
        assert!(unit_file(&bad).is_err());
        let mut rel = svc();
        rel.exec = vec!["ollama".into()];
        assert!(unit_file(&rel).is_err());
        let mut env = svc();
        env.env = vec![("A B".into(), "x".into())];
        assert!(unit_file(&env).is_err());
    }

    #[test]
    fn status_explains_itself() {
        let s = status();
        assert!(s.available || s.reason.is_some());
        if cfg!(windows) {
            assert!(!s.available && s.manager.is_none());
        }
    }
}
