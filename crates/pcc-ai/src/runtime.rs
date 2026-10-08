//! Local runtimes: Ollama, LM Studio and llama.cpp. Detection, install /
//! update / uninstall (winget on Windows; on Ubuntu the vendor's official
//! install script or apt, through `pkexec`), only when the user confirmed the
//! exact command in the UI; start / stop / restart, health and benchmark.
//! Nothing is assumed to be installed: every status comes from the machine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use pcc_claude::process::std_command;
use pcc_core::{Error, Result};
use pcc_platform::install::{self, InstallPlan};
use pcc_recovery::{ProcessKind, Registration};

use crate::provider::{self, ChatMessage, ChatRequest, Health, LocalAiProvider};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Ollama,
    Lmstudio,
    Llamacpp,
}

impl RuntimeKind {
    pub const ALL: [RuntimeKind; 3] = [RuntimeKind::Ollama, RuntimeKind::Lmstudio, RuntimeKind::Llamacpp];

    pub fn id(self) -> &'static str {
        match self {
            RuntimeKind::Ollama => "ollama",
            RuntimeKind::Lmstudio => "lmstudio",
            RuntimeKind::Llamacpp => "llamacpp",
        }
    }
    pub fn parse(id: &str) -> Result<Self> {
        Self::ALL.into_iter().find(|k| k.id() == id).ok_or_else(|| Error::invalid(format!("unknown runtime `{id}`")))
    }
    pub fn name(self) -> &'static str {
        match self {
            RuntimeKind::Ollama => "Ollama",
            RuntimeKind::Lmstudio => "LM Studio",
            RuntimeKind::Llamacpp => "llama.cpp",
        }
    }
    /// winget package id (verified with `winget show --id <id> -e`).
    pub fn winget_id(self) -> &'static str {
        match self {
            RuntimeKind::Ollama => "Ollama.Ollama",
            RuntimeKind::Lmstudio => "ElementLabs.LMStudio",
            RuntimeKind::Llamacpp => "ggml.llamacpp",
        }
    }
    pub fn default_base_url(self) -> &'static str {
        match self {
            RuntimeKind::Ollama => "http://127.0.0.1:11434",
            RuntimeKind::Lmstudio => "http://127.0.0.1:1234",
            RuntimeKind::Llamacpp => "http://127.0.0.1:8080",
        }
    }
    /// Where the runtime is installed from on this OS (shown in the UI).
    pub fn install_source(self) -> String {
        if cfg!(windows) {
            return format!("winget ({})", self.winget_id());
        }
        match self {
            RuntimeKind::Ollama => "official install script (ollama.com/install.sh)".into(),
            RuntimeKind::Lmstudio => "AppImage from lmstudio.ai (installed by hand)".into(),
            RuntimeKind::Llamacpp => format!("apt ({LLAMACPP_APT_PACKAGE}) where Ubuntu packages it"),
        }
    }
    pub fn description(self) -> &'static str {
        match self {
            RuntimeKind::Ollama => {
                "Model library, GPU acceleration, Anthropic-compatible API: can run Claude Code agents on a local model"
            }
            RuntimeKind::Lmstudio => "Desktop app with an OpenAI-compatible server (lms CLI)",
            RuntimeKind::Llamacpp => "Minimal inference server (llama-server) for GGUF files",
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    pub winget_id: String,
    /// `winget (Ollama.Ollama)`, `official install script (…)`, `apt (…)`.
    pub install_source: String,
    pub installed: bool,
    pub executable: Option<String>,
    pub version: Option<String>,
    /// Newer version offered by winget (checked on request).
    pub latest_version: Option<String>,
    pub base_url: String,
    pub health: Health,
    /// Started by NEXUS (process id); `None` when started elsewhere or stopped.
    pub managed_pid: Option<u32>,
    /// Answers the Anthropic Messages API (Claude Code agents can run on it).
    pub anthropic_api: bool,
    pub notes: Vec<String>,
}

/// Official install script of Ollama for Linux.
pub const OLLAMA_INSTALL_SCRIPT: &str = "https://ollama.com/install.sh";
/// Debian/Ubuntu package of llama.cpp (in the archive from Ubuntu 26.04).
pub const LLAMACPP_APT_PACKAGE: &str = "llama.cpp";

fn local_app_data() -> Option<PathBuf> {
    pcc_platform::paths::local_data_dir()
}

fn home() -> Option<PathBuf> {
    Some(pcc_platform::paths::home_dir())
}

/// First program found on PATH (`ollama` also finds `ollama.exe`).
fn on_path(program: &str) -> Option<PathBuf> {
    pcc_platform::find_program(program)
}

fn first_file(candidates: impl IntoIterator<Item = Option<PathBuf>>) -> Option<PathBuf> {
    candidates.into_iter().flatten().find(|p| p.is_file())
}

pub fn find_ollama() -> Option<PathBuf> {
    on_path("ollama")
        .or_else(|| first_file([local_app_data().map(|d| d.join("Programs").join("Ollama").join("ollama.exe"))]))
}

pub fn find_lms() -> Option<PathBuf> {
    let lms = pcc_platform::platform().executable_name("lms");
    on_path("lms").or_else(|| first_file([home().map(|h| h.join(".lmstudio").join("bin").join(&lms))]))
}

pub fn find_llama_server() -> Option<PathBuf> {
    on_path("llama-server").or_else(|| {
        first_file(
            [local_app_data().map(|d| d.join("Microsoft").join("WinGet").join("Links").join("llama-server.exe"))],
        )
    })
}

pub fn executable(kind: RuntimeKind) -> Option<PathBuf> {
    match kind {
        RuntimeKind::Ollama => find_ollama(),
        RuntimeKind::Lmstudio => find_lms(),
        RuntimeKind::Llamacpp => find_llama_server(),
    }
}

/// Extracts a version number from `--version` output
/// ("ollama version is 0.20.3", "version: 4567 (abc)", "0.4.25").
pub fn parse_version(text: &str) -> Option<String> {
    let re =
        regex::Regex::new(r"(?i)version(?: is)?:?\s*v?([0-9][0-9A-Za-z.+\-]*)|\bv?([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b")
            .ok()?;
    let c = re.captures(text)?;
    c.get(1).or(c.get(2)).map(|m| m.as_str().to_string())
}

fn version_of(exe: &Path, kind: RuntimeKind) -> Option<String> {
    let args: &[&str] = match kind {
        RuntimeKind::Lmstudio => &["version"],
        _ => &["--version"],
    };
    let out = std_command(exe).args(args).output().ok()?;
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    parse_version(&text)
}

/// Latest version from `winget show --id <id> -e` (the "Version" line; the
/// label is the same in English and French winget output).
pub fn parse_winget_show_version(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?m)^Version\s*:\s*(\S+)").ok()?;
    re.captures(text).map(|c| c[1].to_string())
}

pub fn winget_available() -> bool {
    cfg!(windows) && std_command("winget").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn check_action(action: &str) -> Result<()> {
    match action {
        "install" | "update" | "uninstall" => Ok(()),
        other => Err(Error::invalid(format!("unknown runtime action `{other}`"))),
    }
}

/// What NEXUS would run to install / update / uninstall a runtime on this
/// machine, shown to the user before anything runs. The plan is recomputed
/// when the user confirms ([`RuntimeManager::run_plan`]): the UI never sends
/// a command line.
pub fn install_plan(kind: RuntimeKind, action: &str) -> Result<InstallPlan> {
    check_action(action)?;
    if cfg!(windows) {
        let plan = install::winget_plan(action, winget_args(kind, action)?, kind.winget_id());
        return Ok(if winget_available() {
            plan
        } else {
            plan.unavailable("winget is not available on this PC: install the runtime from its website")
        });
    }
    let llamacpp = if kind == RuntimeKind::Llamacpp {
        install::apt_policy(LLAMACPP_APT_PACKAGE).and_then(|(_, candidate)| candidate)
    } else {
        None
    };
    Ok(linux_plan(kind, action, llamacpp))
}

/// Linux plans. `llamacpp_candidate` is the llama.cpp version apt offers, if any.
pub fn linux_plan(kind: RuntimeKind, action: &str, llamacpp_candidate: Option<String>) -> InstallPlan {
    const OLLAMA_DOCS: &str = "https://github.com/ollama/ollama/blob/main/docs/linux.md";
    const LLAMACPP_DOCS: &str = "https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md";
    match (kind, action) {
        (RuntimeKind::Ollama, "uninstall") => InstallPlan::manual(
            action,
            "The official script installs a system service: remove it by following Ollama's Linux guide",
            Some(OLLAMA_DOCS),
        ),
        (RuntimeKind::Ollama, _) => install::script_plan(action, OLLAMA_INSTALL_SCRIPT, "Ollama").docs(OLLAMA_DOCS),
        (RuntimeKind::Lmstudio, _) => InstallPlan::manual(
            action,
            "LM Studio for Linux is an AppImage: download it from lmstudio.ai and run it once to set up its `lms` CLI",
            Some("https://lmstudio.ai/download"),
        ),
        (RuntimeKind::Llamacpp, "install") if llamacpp_candidate.is_none() => InstallPlan::manual(
            action,
            "This Ubuntu release has no llama.cpp package: install a release build or build it from source",
            Some(LLAMACPP_DOCS),
        ),
        (RuntimeKind::Llamacpp, _) => install::apt_plan(action, &[LLAMACPP_APT_PACKAGE]).docs(LLAMACPP_DOCS),
    }
}

/// The exact winget command NEXUS runs for an action (shown to the user before confirming).
pub fn winget_args(kind: RuntimeKind, action: &str) -> Result<Vec<String>> {
    let verb = match action {
        "install" => "install",
        "update" => "upgrade",
        "uninstall" => "uninstall",
        other => return Err(Error::invalid(format!("unknown runtime action `{other}`"))),
    };
    let mut args = vec![verb.to_string(), "--id".into(), kind.winget_id().into(), "-e".into(), "--silent".into()];
    if verb != "uninstall" {
        args.extend(["--accept-package-agreements".into(), "--accept-source-agreements".into()]);
    }
    args.push("--disable-interactivity".into());
    Ok(args)
}

pub struct RuntimeManager {
    children: Mutex<HashMap<RuntimeKind, Child>>,
}

impl Default for RuntimeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeManager {
    pub fn new() -> Self {
        Self { children: Mutex::new(HashMap::new()) }
    }

    pub fn provider(kind: RuntimeKind, base_url: Option<&str>) -> Box<dyn LocalAiProvider> {
        provider::for_endpoint(kind.id(), base_url.unwrap_or(kind.default_base_url()))
    }

    /// Process ids of runtimes NEXUS started and still running.
    pub fn managed_pids(&self) -> Vec<(RuntimeKind, u32)> {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        map.iter_mut().filter_map(|(k, c)| matches!(c.try_wait(), Ok(None)).then(|| (*k, c.id()))).collect()
    }

    fn managed_pid(&self, kind: RuntimeKind) -> Option<u32> {
        self.managed_pids().into_iter().find(|(k, _)| *k == kind).map(|(_, p)| p)
    }

    /// Runtimes NEXUS started that exited without being asked to: they are
    /// removed, marked crashed in the process registry and returned once.
    pub fn take_exits(&self) -> Vec<RuntimeExit> {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        let mut exits = Vec::new();
        map.retain(|kind, c| match c.try_wait() {
            Ok(Some(status)) => {
                exits.push(RuntimeExit { kind: *kind, pid: c.id(), exit_code: status.code() });
                false
            }
            _ => true,
        });
        for e in &exits {
            let detail = format!("{} exited unexpectedly (code {:?})", e.kind.name(), e.exit_code);
            pcc_recovery::app().ended(&registry_key(e.kind), true, e.exit_code, Some(detail));
        }
        exits
    }

    /// Blocking: runs `--version` and a health request.
    pub fn status(&self, kind: RuntimeKind, base_url: Option<&str>) -> RuntimeStatus {
        let exe = executable(kind);
        let base = base_url.unwrap_or(kind.default_base_url()).to_string();
        let health = Self::provider(kind, Some(&base)).health();
        let mut notes = Vec::new();
        let version = exe.as_deref().and_then(|e| version_of(e, kind)).or_else(|| health.version.clone());
        if kind == RuntimeKind::Lmstudio && exe.is_none() {
            let app = local_app_data().map(|d| d.join("Programs").join("LM Studio").join("LM Studio.exe"));
            if app.as_ref().is_some_and(|a| a.is_file()) {
                notes.push("LM Studio is installed but its `lms` CLI is not bootstrapped: open LM Studio once".into());
            }
        }
        if kind == RuntimeKind::Llamacpp && exe.is_some() && !health.ok {
            notes.push("llama-server needs a GGUF model file to start".into());
        }
        let anthropic_api = health.ok && kind == RuntimeKind::Ollama && provider::supports_anthropic_messages(&base);
        RuntimeStatus {
            id: kind.id().into(),
            name: kind.name().into(),
            description: kind.description().into(),
            winget_id: kind.winget_id().into(),
            install_source: kind.install_source(),
            installed: exe.is_some() || health.ok,
            executable: exe.map(|e| e.display().to_string()),
            version,
            latest_version: None,
            base_url: base,
            managed_pid: self.managed_pid(kind),
            anthropic_api,
            health,
            notes,
        }
    }

    /// Blocking (network): the version winget would install; on Linux the
    /// latest Ollama release or the llama.cpp version apt offers.
    pub fn latest_version(kind: RuntimeKind) -> Option<String> {
        if !cfg!(windows) {
            return match kind {
                RuntimeKind::Ollama => latest_github_release("ollama/ollama"),
                RuntimeKind::Llamacpp => install::apt_policy(LLAMACPP_APT_PACKAGE).and_then(|(_, c)| c),
                RuntimeKind::Lmstudio => None,
            };
        }
        let out = std_command("winget")
            .args(["show", "--id", kind.winget_id(), "-e", "--accept-source-agreements", "--disable-interactivity"])
            .output()
            .ok()?;
        parse_winget_show_version(&String::from_utf8_lossy(&out.stdout))
    }

    /// Runs the plan for `action`, recomputed here. Only called after the
    /// user confirmed the exact command shown by [`install_plan`].
    pub fn run_plan(kind: RuntimeKind, action: &str) -> Result<String> {
        if cfg!(windows) {
            return Self::winget(kind, action);
        }
        let plan = install_plan(kind, action)?;
        install::run(&plan).map_err(Error::Process)
    }

    /// Runs winget. Only called after the user confirmed the exact command in the UI.
    pub fn winget(kind: RuntimeKind, action: &str) -> Result<String> {
        if !winget_available() {
            return Err(Error::invalid("winget is not available on this PC: install the runtime from its website"));
        }
        let args = winget_args(kind, action)?;
        let out = std_command("winget").args(&args).output()?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let tail: String = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        if out.status.success() {
            Ok(tail)
        } else {
            Err(Error::Process(format!("winget {} failed ({}):\n{tail}", args[0], out.status)))
        }
    }

    /// Starts the runtime's server. `model_path` is required by llama.cpp (a GGUF file).
    pub fn start(&self, kind: RuntimeKind, base_url: Option<&str>, model_path: Option<&str>) -> Result<Health> {
        let base = base_url.unwrap_or(kind.default_base_url()).to_string();
        let p = Self::provider(kind, Some(&base));
        let h = p.health();
        if h.ok {
            return Ok(h);
        }
        let exe = executable(kind).ok_or_else(|| Error::not_found(format!("{} is not installed", kind.name())))?;
        match kind {
            RuntimeKind::Lmstudio => {
                let out = std_command(&exe).args(["server", "start"]).output()?;
                if !out.status.success() {
                    return Err(Error::Process(String::from_utf8_lossy(&out.stderr).trim().to_string()));
                }
            }
            RuntimeKind::Ollama | RuntimeKind::Llamacpp => {
                let mut cmd = std_command(&exe);
                if kind == RuntimeKind::Ollama {
                    cmd.arg("serve");
                    if let Some(host) = base.strip_prefix("http://") {
                        cmd.env("OLLAMA_HOST", host);
                    }
                    // Same models folder as the Ollama app, or its models would be invisible.
                    cmd.env("OLLAMA_MODELS", crate::hardware::models_dir());
                } else {
                    let model = model_path
                        .filter(|m| Path::new(m).is_file())
                        .ok_or_else(|| Error::invalid("llama.cpp needs a GGUF model file to start"))?;
                    let port = base.rsplit(':').next().unwrap_or("8080").trim_end_matches('/').to_string();
                    cmd.args(["-m", model, "--host", "127.0.0.1", "--port", &port, "--jinja"]);
                }
                cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                // Dies with NEXUS: job object on Windows, parent-death signal on Linux.
                let child = pcc_platform::process::spawn_tied(cmd)?;
                pcc_claude::process::attach_pid_to_app_job(child.id());
                let what = if kind == RuntimeKind::Ollama { "ollama serve" } else { "llama-server" };
                pcc_recovery::app().register(
                    &registry_key(kind),
                    Registration::new(ProcessKind::LocalAi, kind.name())
                        .pid(Some(child.id()))
                        .image(exe.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default())
                        .command(format!("{what} on {base}")),
                );
                self.children.lock().unwrap_or_else(|e| e.into_inner()).insert(kind, child);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(if kind == RuntimeKind::Llamacpp { 120 } else { 30 });
        loop {
            let h = p.health();
            if h.ok {
                pcc_recovery::app().heartbeat(&registry_key(kind), "health check", Some("answering"));
                return Ok(h);
            }
            if kind != RuntimeKind::Lmstudio && self.managed_pid(kind).is_none() {
                self.take_exits();
                return Err(Error::Process(format!("{} exited during start-up", kind.name())));
            }
            if Instant::now() > deadline {
                return Err(Error::Process(format!(
                    "{} did not answer on {base}: {}",
                    kind.name(),
                    h.error.unwrap_or_default()
                )));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// Stops a server NEXUS started. A runtime started elsewhere (Ollama's tray
    /// app, LM Studio's window) is left alone unless it has its own stop command.
    pub fn stop(&self, kind: RuntimeKind) -> Result<String> {
        if let Some(mut child) = self.children.lock().unwrap_or_else(|e| e.into_inner()).remove(&kind) {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            pcc_recovery::app().ended(&registry_key(kind), false, None, Some("stopped from NEXUS".into()));
            return Ok(format!("{} (pid {pid}) stopped", kind.name()));
        }
        match kind {
            RuntimeKind::Lmstudio => {
                let exe = find_lms().ok_or_else(|| Error::not_found("lms CLI"))?;
                let out = std_command(exe).args(["server", "stop"]).output()?;
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            }
            _ => Err(Error::invalid(format!(
                "{} was not started by NEXUS; quit it from its own window or tray icon",
                kind.name()
            ))),
        }
    }

    /// Stops every runtime NEXUS started (application exit).
    pub fn stop_all(&self) {
        let kinds: Vec<RuntimeKind> = self.children.lock().unwrap_or_else(|e| e.into_inner()).keys().copied().collect();
        for k in kinds {
            let _ = self.stop(k);
        }
    }

    pub fn restart(&self, kind: RuntimeKind, base_url: Option<&str>, model_path: Option<&str>) -> Result<Health> {
        if self.managed_pid(kind).is_some() || kind == RuntimeKind::Lmstudio {
            let _ = self.stop(kind);
        }
        let r = self.start(kind, base_url, model_path);
        let outcome = match &r {
            Ok(_) => "answering".to_string(),
            Err(e) => format!("failed: {e}"),
        };
        pcc_recovery::app().record_restart(&registry_key(kind), "restart requested", &outcome);
        r
    }
}

/// A runtime NEXUS started that exited on its own.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExit {
    pub kind: RuntimeKind,
    pub pid: u32,
    pub exit_code: Option<i32>,
}

/// Version of a repository's latest GitHub release.
fn latest_github_release(repo: &str) -> Option<String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build();
    let v: serde_json::Value = agent.get(&url).set("User-Agent", "NEXUS").call().ok()?.into_json().ok()?;
    parse_release_tag(&v)
}

/// `tag_name` without its `v`.
pub fn parse_release_tag(v: &serde_json::Value) -> Option<String> {
    v["tag_name"].as_str().map(|t| t.trim_start_matches('v').to_string()).filter(|t| !t.is_empty())
}

/// Key of a runtime in the application process registry (`pcc_recovery::app()`).
pub fn registry_key(kind: RuntimeKind) -> String {
    format!("localai:{}", kind.id())
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Benchmark {
    pub model: String,
    pub tokens_per_second: Option<f64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    /// Wall-clock time including model load (ms).
    pub total_ms: u64,
    pub sample: String,
}

/// Tokens/s on a tiny prompt (the first call also measures the model load).
pub fn benchmark(p: &dyn LocalAiProvider, model: &str) -> Result<Benchmark> {
    let r = p.chat(&ChatRequest {
        model: model.into(),
        messages: vec![ChatMessage::user("In two sentences, describe a small town at sunrise.")],
        max_tokens: Some(64),
        temperature: Some(0.0),
        ..Default::default()
    })?;
    Ok(Benchmark {
        model: model.into(),
        tokens_per_second: r.tokens_per_second().map(|t| (t * 10.0).round() / 10.0),
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        total_ms: r.total_ms,
        sample: r.content.chars().take(240).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_runtime_versions() {
        assert_eq!(parse_version("ollama version is 0.20.3").as_deref(), Some("0.20.3"));
        assert_eq!(
            parse_version("Warning: could not connect to a running Ollama instance\nWarning: client version is 0.20.3")
                .as_deref(),
            Some("0.20.3")
        );
        assert_eq!(parse_version("version: 6512 (4b8560af)\nbuilt with clang").as_deref(), Some("6512"));
        assert_eq!(parse_version("lms 0.4.25").as_deref(), Some("0.4.25"));
        assert_eq!(parse_version("nothing"), None);
    }

    #[test]
    fn parses_winget_show_in_english_and_french() {
        let fr = "Trouvé Ollama [Ollama.Ollama]\nVersion : 0.35.1\nPublisher : Ollama\n";
        assert_eq!(parse_winget_show_version(fr).as_deref(), Some("0.35.1"));
        let en = "Found LM Studio [ElementLabs.LMStudio]\nVersion: 0.4.25+1\nPublisher: LM Studio\n";
        assert_eq!(parse_winget_show_version(en).as_deref(), Some("0.4.25+1"));
    }

    #[test]
    fn winget_commands_are_exact() {
        let a = winget_args(RuntimeKind::Ollama, "install").unwrap();
        assert_eq!(&a[..4], ["install", "--id", "Ollama.Ollama", "-e"]);
        assert!(a.contains(&"--accept-package-agreements".to_string()));
        let u = winget_args(RuntimeKind::Llamacpp, "uninstall").unwrap();
        assert_eq!(u[2], "ggml.llamacpp");
        assert!(!u.contains(&"--accept-package-agreements".to_string()));
        assert_eq!(winget_args(RuntimeKind::Lmstudio, "update").unwrap()[0], "upgrade");
        assert!(winget_args(RuntimeKind::Ollama, "rm -rf").is_err());
        assert_eq!(RuntimeKind::parse("lmstudio").unwrap(), RuntimeKind::Lmstudio);
        assert!(RuntimeKind::parse("x").is_err());
    }

    #[test]
    fn linux_plans_show_official_methods() {
        let p = linux_plan(RuntimeKind::Ollama, "install", None);
        assert_eq!(p.display, "pkexec sh -c 'curl -fsSL https://ollama.com/install.sh | sh'");
        assert!(p.elevated);
        let u = linux_plan(RuntimeKind::Ollama, "uninstall", None);
        assert!(!u.available && u.docs_url.is_some(), "Ollama's uninstall is done by hand");
        assert!(!linux_plan(RuntimeKind::Lmstudio, "install", None).available);
        let none = linux_plan(RuntimeKind::Llamacpp, "install", None);
        assert!(!none.available && none.reason.unwrap().contains("no llama.cpp package"));
        let apt = linux_plan(RuntimeKind::Llamacpp, "install", Some("8681+dfsg-1".into()));
        assert_eq!(apt.display, "pkexec apt-get install -y llama.cpp");
        assert!(install_plan(RuntimeKind::Ollama, "rm -rf").is_err());
    }

    #[test]
    fn plans_match_this_os() {
        let p = install_plan(RuntimeKind::Ollama, "install").unwrap();
        if cfg!(windows) {
            assert_eq!(p.program, "winget");
            assert!(p.display.starts_with("winget install --id Ollama.Ollama -e"));
        } else {
            assert_ne!(p.program, "winget");
        }
        assert!(p.available || p.reason.is_some());
        assert!(RuntimeKind::Ollama.install_source().contains(if cfg!(windows) { "winget" } else { "install script" }));
    }

    #[test]
    fn parses_release_tags() {
        assert_eq!(parse_release_tag(&serde_json::json!({"tag_name": "v0.12.3"})).as_deref(), Some("0.12.3"));
        assert_eq!(parse_release_tag(&serde_json::json!({})), None);
    }
}
