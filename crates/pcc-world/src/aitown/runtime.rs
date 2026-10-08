//! Local runtime of the integrated AI Town: a copy of `ai-town/` (Convex
//! functions + data) under the user's app data, its npm dependencies, and the
//! local Convex backend started by `convex dev` in anonymous mode (no Convex
//! account needed; data stays on this machine).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pcc_core::{Error, Result};
use serde::Serialize;

use super::convex::ConvexClient;

/// Files and folders of `ai-town/` the backend needs.
const RUNTIME_ENTRIES: &[&str] =
    &["convex", "data", "package.json", "package-lock.json", "tsconfig.json", "nexus-upstream.json", "LICENSE"];

const INSTALL_MARKER: &str = ".nexus-install.json";

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// `node --version`, when Node.js is installed.
    pub node: Option<String>,
    pub npm: Option<String>,
    /// Bundled AI Town source (`ai-town/`), when found.
    pub source: Option<String>,
    /// Upstream a16z-infra/ai-town commit the source is based on.
    pub upstream_commit: Option<String>,
    pub runtime_dir: String,
    /// npm dependencies installed for the current package-lock.json.
    pub installed: bool,
    /// Installed, but for another package-lock.json (NEXUS was updated).
    pub needs_reinstall: bool,
    pub running: bool,
    pub url: Option<String>,
    pub last_error: Option<String>,
    /// Last lines printed by `convex dev`.
    pub log: Vec<String>,
}

/// `ai-town/` next to the executable (installed app resources) or in the source tree (dev).
pub fn locate_source(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(r) = resource_dir {
        candidates.push(r.join("ai-town"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ai-town"));
        }
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ai-town"));
    candidates.into_iter().find(|c| c.join("convex").join("nexus.ts").is_file()).map(|p| p.canonicalize().unwrap_or(p))
}

/// Fallback runtime folder when the app's data folder is unknown. Never the
/// install folder (`%LOCALAPPDATA%\NEXUS`, `/usr/lib/NEXUS`, the AppImage
/// mount), which holds the bundled source.
pub fn default_runtime_dir() -> PathBuf {
    let base = pcc_platform::paths::local_data_dir().unwrap_or_else(std::env::temp_dir);
    base.join("NEXUS-data").join("ai-town-runtime")
}

/// Canonical form even for a path that doesn't exist yet: canonicalize the
/// nearest existing ancestor (Windows adds `\\?\`) and re-append the rest.
fn canonical(p: &Path) -> PathBuf {
    let mut existing = p.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
    let mut out = existing.canonicalize().unwrap_or(existing);
    for name in rest.into_iter().rev() {
        out.push(name);
    }
    out
}

fn same_or_nested(a: &Path, b: &Path) -> bool {
    let (a, b) = (canonical(a), canonical(b));
    a.starts_with(&b) || b.starts_with(&a)
}

fn version(program: &str) -> Option<String> {
    let out = pcc_claude::process::std_command(program).arg("--version").output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn npm_program() -> String {
    pcc_platform::paths::script("npm")
}

fn lock_hash(dir: &Path) -> Option<String> {
    let bytes = std::fs::read(dir.join("package-lock.json")).ok()?;
    let mut h: u64 = 1469598103934665603;
    for b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    Some(format!("{h:016x}"))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Copies the bundled source over the runtime folder (NEXUS's own code, no
/// third-party download). node_modules and the backend data are kept.
pub fn sync_source(source: &Path, runtime: &Path) -> Result<()> {
    // The runtime copy is replaced on every start: it must never be (or
    // contain) the bundled source, or the source would delete itself.
    if same_or_nested(source, runtime) {
        return Err(Error::Invalid(format!(
            "AI Town runtime folder {} overlaps the bundled source {}",
            runtime.display(),
            source.display()
        )));
    }
    std::fs::create_dir_all(runtime)?;
    for entry in RUNTIME_ENTRIES {
        let from = source.join(entry);
        let to = runtime.join(entry);
        if from.is_dir() {
            if to.exists() {
                std::fs::remove_dir_all(&to)?;
            }
            copy_dir(&from, &to)?;
        } else if from.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    stamp_build(runtime)?;
    Ok(())
}

const BUILD_FILE: &str = "nexusBuild.ts";

/// Hash of the copied Convex functions and data (FNV-1a over paths and bytes).
fn source_fingerprint(runtime: &Path) -> String {
    let mut files = Vec::new();
    for dir in ["convex", "data"] {
        let mut stack = vec![runtime.join(dir)];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if path.is_dir() {
                    if name != "_generated" {
                        stack.push(path);
                    }
                } else if name != BUILD_FILE {
                    files.push(path);
                }
            }
        }
    }
    files.sort();
    let mut h: u64 = 1469598103934665603;
    for f in files {
        let rel = f.strip_prefix(runtime).unwrap_or(&f).to_string_lossy().replace('\\', "/");
        for b in rel.bytes().chain(std::fs::read(&f).unwrap_or_default()) {
            h ^= b as u64;
            h = h.wrapping_mul(1099511628211);
        }
    }
    format!("{h:016x}")
}

/// Writes the fingerprint `nexus:ping` reports once these functions are deployed.
fn stamp_build(runtime: &Path) -> Result<String> {
    let build = source_fingerprint(runtime);
    let file = runtime.join("convex").join(BUILD_FILE);
    if file.parent().is_some_and(Path::is_dir) {
        std::fs::write(
            &file,
            format!("// Written by NEXUS: fingerprint of this runtime copy.\nexport const NEXUS_BUILD = '{build}';\n"),
        )?;
    }
    Ok(build)
}

/// The build the runtime copy expects `nexus:ping` to report.
fn expected_build(runtime: &Path) -> Option<String> {
    let text = std::fs::read_to_string(runtime.join("convex").join(BUILD_FILE)).ok()?;
    text.split('\'').nth(1).map(str::to_string)
}

pub struct AiTownRuntime {
    pub source: Option<PathBuf>,
    pub runtime: PathBuf,
    backend: Option<Child>,
    url: Option<String>,
    last_error: Option<String>,
    log: Arc<Mutex<Vec<String>>>,
}

impl AiTownRuntime {
    pub fn new(source: Option<PathBuf>, runtime: PathBuf) -> Self {
        Self { source, runtime, backend: None, url: None, last_error: None, log: Arc::default() }
    }

    fn installed_hash(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.runtime.join(INSTALL_MARKER)).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        v["lockHash"].as_str().map(str::to_string)
    }

    pub fn status(&mut self) -> RuntimeStatus {
        let running = self.is_running();
        let upstream_commit = self
            .source
            .as_ref()
            .and_then(|s| std::fs::read_to_string(s.join("nexus-upstream.json")).ok())
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v["commit"].as_str().map(str::to_string));
        let has_modules = self.runtime.join("node_modules").join("convex").is_dir();
        let wanted = self.source.as_deref().and_then(lock_hash);
        let installed_hash = self.installed_hash();
        RuntimeStatus {
            node: version("node"),
            npm: version(&npm_program()),
            source: self.source.as_ref().map(|s| s.display().to_string()),
            upstream_commit,
            runtime_dir: self.runtime.display().to_string(),
            installed: has_modules && installed_hash.is_some() && installed_hash == wanted,
            needs_reinstall: has_modules && installed_hash.is_some() && installed_hash != wanted,
            running,
            url: if running { self.url.clone() } else { None },
            last_error: self.last_error.clone(),
            log: self.log.lock().map(|l| l.iter().rev().take(30).rev().cloned().collect()).unwrap_or_default(),
        }
    }

    /// Copies the source and runs `npm ci`. Only called after the user agreed:
    /// it downloads AI Town's npm dependencies (Convex, PixiJS...).
    pub fn install(&mut self, mut progress: impl FnMut(&str)) -> Result<()> {
        let source = self.source.clone().ok_or_else(|| Error::NotFound("bundled ai-town source".into()))?;
        if version("node").is_none() {
            return Err(Error::Invalid("Node.js 18 or newer is required (https://nodejs.org)".into()));
        }
        progress("Copying AI Town (Convex functions and data)...");
        sync_source(&source, &self.runtime)?;
        progress("Installing npm dependencies (npm ci)...");
        let out = pcc_claude::process::std_command(npm_program())
            .args(["ci", "--no-audit", "--no-fund", "--loglevel=error"])
            .current_dir(&self.runtime)
            .output()?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            self.last_error = Some(err.clone());
            return Err(Error::Invalid(format!("npm ci failed: {err}")));
        }
        let marker = serde_json::json!({ "lockHash": lock_hash(&source), "installedAt": pcc_core::now() });
        std::fs::write(self.runtime.join(INSTALL_MARKER), marker.to_string())?;
        progress("AI Town runtime installed.");
        Ok(())
    }

    pub fn is_running(&mut self) -> bool {
        match self.backend.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => true,
            Some(Ok(Some(status))) => {
                self.last_error.get_or_insert_with(|| format!("convex dev exited ({status})"));
                self.backend = None;
                pcc_recovery::app().ended(REC_KEY, true, status.code(), Some(format!("convex dev exited ({status})")));
                end_backend_records();
                false
            }
            _ => false,
        }
    }

    /// Starts the local Convex backend and deploys the functions.
    /// Returns the deployment URL once the NEXUS functions answer.
    pub fn start(&mut self) -> Result<String> {
        if self.is_running() {
            if let Some(url) = &self.url {
                return Ok(url.clone());
            }
        }
        let source = self.source.clone().ok_or_else(|| Error::NotFound("bundled ai-town source".into()))?;
        if !self.runtime.join("node_modules").join("convex").is_dir() {
            return Err(Error::Invalid("AI Town runtime is not installed yet".into()));
        }
        // Our own code may have changed with a NEXUS update: refresh it.
        sync_source(&source, &self.runtime)?;
        self.last_error = None;
        let cli = self.runtime.join("node_modules").join("convex").join("bin").join("main.js");
        let mut cmd = std::process::Command::new("node");
        cmd.arg(&cli)
            .args(["dev", "--tail-logs", "disable", "--typecheck", "disable"])
            .env("CONVEX_AGENT_MODE", "anonymous")
            .current_dir(&self.runtime)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = pcc_platform::process::spawn_tied(cmd)?;
        pcc_claude::process::attach_pid_to_app_job(child.id());
        pcc_recovery::app().register(
            REC_KEY,
            pcc_recovery::Registration::new(pcc_recovery::ProcessKind::AiTown, "AI Town (convex dev)")
                .pid(Some(child.id()))
                .image(pcc_platform::platform().executable_name("node"))
                .command("node convex/bin/main.js dev"),
        );
        for pipe in [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let log = self.log.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(|l| l.ok()) {
                    let clean = strip_ansi(&line);
                    if clean.trim().is_empty() {
                        continue;
                    }
                    pcc_recovery::app().heartbeat(REC_KEY, "output", None);
                    if let Ok(mut l) = log.lock() {
                        l.push(clean);
                        let excess = l.len().saturating_sub(200);
                        l.drain(..excess);
                    }
                }
            });
        }
        self.backend = Some(child);

        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if !self.is_running() {
                let tail = self.status().log.join("\n");
                return Err(Error::Invalid(format!("convex dev stopped:\n{tail}")));
            }
            if let Some(url) = read_env_url(&self.runtime) {
                let client = ConvexClient::new(&url);
                // Ready once THIS build of the functions is deployed: right after an
                // update the backend still answers with the previous version.
                let expected = expected_build(&self.runtime);
                let deployed = client
                    .query("nexus:ping", serde_json::json!({}))
                    .ok()
                    .map(|v| v["build"].as_str().map(str::to_string));
                let ready = match (deployed, &expected) {
                    (Some(build), Some(want)) => build.as_deref() == Some(want.as_str()),
                    (Some(_), None) => true,
                    (None, _) => false,
                };
                if ready {
                    self.url = Some(url.clone());
                    let pid = self.backend.as_ref().map(Child::id).unwrap_or(0);
                    pcc_recovery::app().heartbeat(REC_KEY, "nexus:ping", Some("functions deployed"));
                    pcc_recovery::app().set_state(REC_KEY, pcc_recovery::ProcessState::Running, None);
                    register_backend_children(pid);
                    return Ok(url);
                }
            }
            if Instant::now() > deadline {
                let msg = "AI Town backend did not become ready within 3 minutes".to_string();
                self.last_error = Some(msg.clone());
                self.stop();
                return Err(Error::Invalid(msg));
            }
            std::thread::sleep(Duration::from_millis(700));
        }
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.backend.take() {
            kill_tree(&mut child);
            pcc_recovery::app().ended(REC_KEY, false, None, Some("stopped by NEXUS".into()));
            end_backend_records();
        }
        self.url = None;
    }

    pub fn url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    /// Sets environment variables of the local deployment (`convex env set`),
    /// e.g. the LLM AI Town's townspeople use. Needs the backend running.
    pub fn set_env(&mut self, vars: &[(String, String)]) -> Result<()> {
        if !self.is_running() {
            return Err(Error::Invalid("AI Town is not running".into()));
        }
        let cli = self.runtime.join("node_modules").join("convex").join("bin").join("main.js");
        for (k, v) in vars {
            let out = pcc_claude::process::std_command("node")
                .arg(&cli)
                .args(["env", "set", k, v])
                .env("CONVEX_AGENT_MODE", "anonymous")
                .current_dir(&self.runtime)
                .stdin(Stdio::null())
                .output()?;
            if !out.status.success() {
                let err = strip_ansi(String::from_utf8_lossy(&out.stderr).trim());
                return Err(Error::Process(format!("convex env set {k} failed: {err}")));
            }
        }
        Ok(())
    }
}

impl Drop for AiTownRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Registry key of `convex dev` (application-wide process registry).
const REC_KEY: &str = "aitown:convex";

/// The local Convex backend `convex dev` started, registered as its children.
fn register_backend_children(pid: u32) {
    let table = pcc_recovery::sys::list_processes();
    for c in pcc_recovery::sys::descendants(&table, pid) {
        if c.name.to_ascii_lowercase().contains("convex") {
            pcc_recovery::app().register(
                &format!("aitown:backend:{}", c.pid),
                pcc_recovery::Registration::new(pcc_recovery::ProcessKind::AiTownBackend, "AI Town local backend")
                    .pid(Some(c.pid))
                    .parent(c.ppid)
                    .image(c.name.clone()),
            );
        }
    }
}

fn end_backend_records() {
    for r in pcc_recovery::app().list() {
        if r.key.starts_with("aitown:backend:") && !r.state.is_ended() {
            pcc_recovery::app().ended(&r.key, false, None, Some("convex dev stopped".into()));
        }
    }
}

fn kill_tree(child: &mut Child) {
    // `convex dev` starts the local backend as a child process.
    pcc_platform::process::kill_tree(child.id(), true);
    let _ = child.kill();
    let _ = child.wait();
}

fn read_env_url(runtime: &Path) -> Option<String> {
    let text = std::fs::read_to_string(runtime.join(".env.local")).ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix("VITE_CONVEX_URL=").or_else(|| l.strip_prefix("CONVEX_URL=")))
        .map(|u| u.trim().trim_matches('"').to_string())
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_source_tree_in_dev() {
        let src = locate_source(None).expect("ai-town/ in the repository");
        assert!(src.join("convex").join("nexus.ts").is_file());
    }

    #[test]
    fn never_syncs_onto_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("ai-town");
        std::fs::create_dir_all(src.join("convex")).unwrap();
        std::fs::write(src.join("convex").join("nexus.ts"), "x").unwrap();
        assert!(sync_source(&src, &src).is_err());
        assert!(sync_source(&src, &src.join("runtime")).is_err());
        assert!(sync_source(&src, dir.path()).is_err());
        assert!(src.join("convex").join("nexus.ts").is_file(), "source untouched");
        let rt = dir.path().join("runtime");
        sync_source(&src, &rt).unwrap();
        let build = expected_build(&rt).expect("build stamped");
        assert_eq!(build, source_fingerprint(&rt), "stamp matches the copied code");
        std::fs::write(src.join("convex").join("nexus.ts"), "changed").unwrap();
        sync_source(&src, &rt).unwrap();
        assert_ne!(expected_build(&rt).unwrap(), build, "a code change changes the build");
        assert!(rt.join("convex").join("nexus.ts").is_file());
    }

    #[test]
    fn strips_terminal_colors() {
        assert_eq!(strip_ansi("\u{1b}[32m✔\u{1b}[39m ready"), "✔ ready");
    }

    #[test]
    fn reads_the_deployment_url() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env.local"),
            "CONVEX_DEPLOYMENT=anonymous:x\n\nVITE_CONVEX_URL=http://127.0.0.1:3210\n",
        )
        .unwrap();
        assert_eq!(read_env_url(dir.path()).as_deref(), Some("http://127.0.0.1:3210"));
    }
}
