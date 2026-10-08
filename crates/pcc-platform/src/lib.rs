//! Platform layer. Windows and Ubuntu (24.04 LTS and later) are both
//! first-class targets: everything that differs between them (process
//! lifetime, paths and executable names, shells and terminals, the credential
//! store, background services, package managers, the capability matrix) goes
//! through this crate instead of `cfg!(windows)` checks spread across the code.
//!
//! [`PlatformManager`] describes the conventions of one OS; [`platform()`] is
//! the one this binary runs on. Both implementations are compiled on every
//! target so their conventions can be tested anywhere; native operations
//! (signals, job objects, `/proc`) live in [`process`].

use std::ffi::OsString;
use std::path::PathBuf;

use serde::Serialize;

pub mod capabilities;
pub mod install;
pub mod paths;
pub mod process;
pub mod services;
pub mod shells;

pub use paths::find_program;
pub use shells::{ShellInfo, TerminalInfo};

/// Operating-system family.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Windows,
    Linux,
    Macos,
    Other,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "linux") {
            Os::Linux
        } else if cfg!(target_os = "macos") {
            Os::Macos
        } else {
            Os::Other
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Os::Windows => "Windows",
            Os::Linux => "Linux",
            Os::Macos => "macOS",
            Os::Other => "Unknown OS",
        }
    }
}

/// `/etc/os-release` (Linux distributions).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OsRelease {
    /// `ubuntu`, `debian`, `fedora`…
    pub id: String,
    /// `24.04`
    pub version_id: String,
    /// `Ubuntu 24.04.1 LTS`
    pub pretty_name: String,
    /// `ID_LIKE` (`debian` for Ubuntu derivatives).
    pub id_like: Vec<String>,
}

impl OsRelease {
    /// Ubuntu or a derivative that uses apt.
    pub fn is_debian_like(&self) -> bool {
        self.id == "debian" || self.id == "ubuntu" || self.id_like.iter().any(|l| l == "debian" || l == "ubuntu")
    }
}

pub fn parse_os_release(text: &str) -> OsRelease {
    let mut r = OsRelease::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
        match k.trim() {
            "ID" => r.id = v.to_ascii_lowercase(),
            "VERSION_ID" => r.version_id = v,
            "PRETTY_NAME" => r.pretty_name = v,
            "ID_LIKE" => r.id_like = v.split_whitespace().map(str::to_ascii_lowercase).collect(),
            _ => {}
        }
    }
    r
}

/// The running distribution (`None` outside Linux or when unreadable).
pub fn os_release() -> Option<OsRelease> {
    if Os::current() != Os::Linux {
        return None;
    }
    ["/etc/os-release", "/usr/lib/os-release"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .map(|t| parse_os_release(&t))
}

/// Running inside Windows Subsystem for Linux.
pub fn is_wsl() -> bool {
    if Os::current() != Os::Linux {
        return false;
    }
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|r| r.to_ascii_lowercase().contains("microsoft"))
}

/// Conventions of one operating system.
pub trait PlatformManager: Send + Sync {
    fn os(&self) -> Os;
    /// `Windows`, `Ubuntu 24.04.1 LTS`…
    fn label(&self) -> String;
    /// `claude` → `claude.exe` on Windows.
    fn executable_name(&self, base: &str) -> String;
    /// Launcher scripts of npm and friends: `npm` → `npm.cmd` on Windows.
    fn script_name(&self, base: &str) -> String;
    /// Extensions tried when looking a bare program name up on PATH.
    fn path_extensions(&self) -> Vec<String>;
    fn home_dir(&self) -> Option<PathBuf>;
    /// Per-user application data that is not roamed: `%LOCALAPPDATA%`, `$XDG_DATA_HOME`.
    fn local_data_dir(&self) -> Option<PathBuf>;
    /// Per-user configuration: `%APPDATA%`, `$XDG_CONFIG_HOME`.
    fn config_dir(&self) -> Option<PathBuf>;
    /// Where secrets go, as shown to the user.
    fn credential_store(&self) -> &'static str;
    /// User-level service manager, if the OS has one NEXUS can use without admin rights.
    fn service_manager(&self) -> Option<&'static str>;
    /// Package manager used for the installers NEXUS offers.
    fn package_manager(&self) -> Option<&'static str>;
}

type EnvFn = fn(&str) -> Option<OsString>;

fn real_env(k: &str) -> Option<OsString> {
    std::env::var_os(k).filter(|v| !v.is_empty())
}

pub struct WindowsPlatform {
    env: EnvFn,
}

pub struct LinuxPlatform {
    env: EnvFn,
}

impl WindowsPlatform {
    pub const fn new() -> Self {
        Self { env: real_env }
    }
    /// With a custom environment (tests).
    pub const fn with_env(env: EnvFn) -> Self {
        Self { env }
    }
}

impl LinuxPlatform {
    pub const fn new() -> Self {
        Self { env: real_env }
    }
    pub const fn with_env(env: EnvFn) -> Self {
        Self { env }
    }
}

impl Default for WindowsPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for LinuxPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformManager for WindowsPlatform {
    fn os(&self) -> Os {
        Os::Windows
    }
    fn label(&self) -> String {
        "Windows".into()
    }
    fn executable_name(&self, base: &str) -> String {
        if base.to_ascii_lowercase().ends_with(".exe") {
            base.into()
        } else {
            format!("{base}.exe")
        }
    }
    fn script_name(&self, base: &str) -> String {
        if base.contains('.') {
            base.into()
        } else {
            format!("{base}.cmd")
        }
    }
    fn path_extensions(&self) -> Vec<String> {
        let exts = (self.env)("PATHEXT").map(|v| v.to_string_lossy().into_owned());
        let exts = exts.unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
        exts.split(';').filter(|e| !e.is_empty()).map(|e| e.to_ascii_lowercase()).collect()
    }
    fn home_dir(&self) -> Option<PathBuf> {
        (self.env)("USERPROFILE").or_else(|| (self.env)("HOME")).map(PathBuf::from)
    }
    fn local_data_dir(&self) -> Option<PathBuf> {
        (self.env)("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| self.home_dir().map(|h| h.join("AppData").join("Local")))
    }
    fn config_dir(&self) -> Option<PathBuf> {
        (self.env)("APPDATA").map(PathBuf::from).or_else(|| self.home_dir().map(|h| h.join("AppData").join("Roaming")))
    }
    fn credential_store(&self) -> &'static str {
        "Windows Credential Manager"
    }
    fn service_manager(&self) -> Option<&'static str> {
        None
    }
    fn package_manager(&self) -> Option<&'static str> {
        Some("winget")
    }
}

impl PlatformManager for LinuxPlatform {
    fn os(&self) -> Os {
        Os::Linux
    }
    fn label(&self) -> String {
        match os_release() {
            Some(r) if !r.pretty_name.is_empty() => r.pretty_name,
            _ => "Linux".into(),
        }
    }
    fn executable_name(&self, base: &str) -> String {
        base.into()
    }
    fn script_name(&self, base: &str) -> String {
        base.into()
    }
    fn path_extensions(&self) -> Vec<String> {
        Vec::new()
    }
    fn home_dir(&self) -> Option<PathBuf> {
        (self.env)("HOME").map(PathBuf::from)
    }
    fn local_data_dir(&self) -> Option<PathBuf> {
        (self.env)("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| self.home_dir().map(|h| h.join(".local").join("share")))
    }
    fn config_dir(&self) -> Option<PathBuf> {
        (self.env)("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| self.home_dir().map(|h| h.join(".config")))
    }
    fn credential_store(&self) -> &'static str {
        "Secret Service (GNOME Keyring / KWallet)"
    }
    fn service_manager(&self) -> Option<&'static str> {
        Some("systemd --user")
    }
    fn package_manager(&self) -> Option<&'static str> {
        Some("apt")
    }
}

static WINDOWS: WindowsPlatform = WindowsPlatform::new();
static LINUX: LinuxPlatform = LinuxPlatform::new();

/// The platform this binary runs on (macOS and others use the Unix conventions).
pub fn platform() -> &'static dyn PlatformManager {
    if cfg!(windows) {
        &WINDOWS
    } else {
        &LINUX
    }
}

/// The implementation for a given OS (tests, the capability matrix).
pub fn platform_for(os: Os) -> &'static dyn PlatformManager {
    match os {
        Os::Windows => &WINDOWS,
        _ => &LINUX,
    }
}

/// Where secrets are kept on this machine, for messages ("stored in …").
pub fn credential_store_name() -> &'static str {
    platform().credential_store()
}

/// How a process is usually killed from outside on this OS, for crash
/// explanations.
pub fn external_kill_examples() -> &'static str {
    if cfg!(windows) {
        "Task Manager, taskkill, antivirus"
    } else {
        "kill, a system monitor, the out-of-memory killer"
    }
}

/// "Windows restarted" / "the computer restarted", for crash explanations.
pub fn os_restart_phrase() -> &'static str {
    if cfg!(windows) {
        "Windows restarted"
    } else {
        "the computer restarted"
    }
}

/// What the UI shows about the current machine.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: Os,
    pub label: String,
    pub arch: String,
    pub wsl: bool,
    pub distro: Option<OsRelease>,
    pub credential_store: String,
    pub service_manager: Option<String>,
    pub package_manager: Option<String>,
    pub shells: Vec<ShellInfo>,
    pub terminals: Vec<TerminalInfo>,
    pub home_dir: Option<String>,
    pub local_data_dir: Option<String>,
}

/// Blocking: looks shells and terminals up on PATH.
pub fn info() -> PlatformInfo {
    let p = platform();
    PlatformInfo {
        os: p.os(),
        label: p.label(),
        arch: std::env::consts::ARCH.into(),
        wsl: is_wsl(),
        distro: os_release(),
        credential_store: p.credential_store().into(),
        service_manager: p.service_manager().map(str::to_string),
        package_manager: p.package_manager().map(str::to_string),
        shells: shells::detect_shells(),
        terminals: shells::detect_terminals(),
        home_dir: p.home_dir().map(|d| d.display().to_string()),
        local_data_dir: p.local_data_dir().map(|d| d.display().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win_env(k: &str) -> Option<OsString> {
        match k {
            "USERPROFILE" => Some(r"C:\Users\ada".into()),
            "LOCALAPPDATA" => Some(r"C:\Users\ada\AppData\Local".into()),
            "PATHEXT" => Some(".COM;.EXE;.BAT;.CMD;.PS1".into()),
            _ => None,
        }
    }

    fn linux_env(k: &str) -> Option<OsString> {
        match k {
            "HOME" => Some("/home/ada".into()),
            "XDG_CONFIG_HOME" => Some("relative/ignored".into()),
            _ => None,
        }
    }

    #[test]
    fn windows_conventions() {
        let w = WindowsPlatform::with_env(win_env);
        assert_eq!(w.executable_name("claude"), "claude.exe");
        assert_eq!(w.executable_name("claude.EXE"), "claude.EXE");
        assert_eq!(w.script_name("npm"), "npm.cmd");
        assert_eq!(w.local_data_dir(), Some(PathBuf::from(r"C:\Users\ada\AppData\Local")));
        assert_eq!(w.config_dir(), Some(PathBuf::from(r"C:\Users\ada").join("AppData").join("Roaming")));
        assert!(w.path_extensions().contains(&".ps1".to_string()));
        assert_eq!(w.package_manager(), Some("winget"));
        assert_eq!(w.service_manager(), None);
    }

    #[test]
    fn linux_conventions_follow_xdg() {
        let l = LinuxPlatform::with_env(linux_env);
        assert_eq!(l.executable_name("claude"), "claude");
        assert_eq!(l.script_name("npm"), "npm");
        assert_eq!(l.home_dir(), Some(PathBuf::from("/home/ada")));
        assert_eq!(l.local_data_dir(), Some(PathBuf::from("/home/ada").join(".local").join("share")));
        // A relative XDG value is invalid per the spec and ignored.
        assert_eq!(l.config_dir(), Some(PathBuf::from("/home/ada").join(".config")));
        assert!(l.path_extensions().is_empty());
        assert_eq!(l.service_manager(), Some("systemd --user"));
    }

    #[test]
    fn parses_os_release() {
        let r = parse_os_release(
            "PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\nID_LIKE=debian\n",
        );
        assert_eq!(r.id, "ubuntu");
        assert_eq!(r.version_id, "24.04");
        assert_eq!(r.pretty_name, "Ubuntu 24.04.1 LTS");
        assert!(r.is_debian_like());
        let mint = parse_os_release("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n");
        assert!(mint.is_debian_like());
        assert!(!parse_os_release("ID=fedora\n").is_debian_like());
    }

    #[test]
    fn current_platform_matches_the_target() {
        assert_eq!(platform().os(), if cfg!(windows) { Os::Windows } else { Os::Linux });
        let i = info();
        assert!(!i.label.is_empty());
        assert_eq!(i.wsl, is_wsl());
    }
}
