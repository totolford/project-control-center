//! Platform Capability Matrix: what NEXUS supports on Windows, Ubuntu, WSL
//! and in Docker, plus the live status of each component on this machine.
//! The support columns are what NEXUS is built and tested for; the live
//! column is read from the machine (programs on PATH, service manager).

use serde::Serialize;

use crate::paths::find_program;
use crate::{is_wsl, Os};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    Supported,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub support: Support,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LiveState {
    Available,
    Missing,
    /// Not offered on this platform.
    NotApplicable,
    /// Not checked (or could not be).
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Live {
    pub state: LiveState,
    pub detail: String,
}

impl Live {
    pub fn new(state: LiveState, detail: impl Into<String>) -> Self {
        Live { state, detail: detail.into() }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub windows: Cell,
    pub ubuntu: Cell,
    pub wsl: Cell,
    pub docker: Cell,
    /// On this machine, now.
    pub live: Live,
}

/// Where NEXUS runs now, as a matrix column.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Windows,
    Ubuntu,
    Wsl,
    Docker,
    Other,
}

pub fn in_container() -> bool {
    Os::current() == Os::Linux
        && (std::path::Path::new("/.dockerenv").exists()
            || std::path::Path::new("/run/.containerenv").exists()
            || std::fs::read_to_string("/proc/1/cgroup")
                .is_ok_and(|c| c.contains("docker") || c.contains("containerd")))
}

pub fn environment() -> Environment {
    match Os::current() {
        Os::Windows => Environment::Windows,
        Os::Linux if in_container() => Environment::Docker,
        Os::Linux if is_wsl() => Environment::Wsl,
        Os::Linux => Environment::Ubuntu,
        _ => Environment::Other,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Matrix {
    pub environment: Environment,
    pub rows: Vec<Capability>,
}

type C = (Support, &'static str);
use Support::{Partial as P, Supported as S, Unavailable as U};

struct Row {
    id: &'static str,
    name: &'static str,
    cells: [C; 4],
}

const ROWS: &[Row] = &[
    Row {
        id: "claude",
        name: "Claude Code",
        cells: [(S, ""), (S, ""), (S, ""), (P, "Headless only; sign in inside the container")],
    },
    Row { id: "node", name: "Node.js (AI Town, npm MCP servers)", cells: [(S, ""), (S, ""), (S, ""), (S, "")] },
    Row { id: "git", name: "Git", cells: [(S, ""), (S, ""), (S, ""), (S, "")] },
    Row {
        id: "ollama",
        name: "Ollama",
        cells: [
            (S, "winget"),
            (S, "Official install script (systemd service)"),
            (P, "GPU through CUDA on WSL (NVIDIA only)"),
            (P, "ollama/ollama image; GPU needs the NVIDIA Container Toolkit"),
        ],
    },
    Row {
        id: "lmstudio",
        name: "LM Studio",
        cells: [
            (S, "winget"),
            (P, "AppImage, installed by hand from lmstudio.ai"),
            (U, "Desktop app"),
            (U, "Desktop app"),
        ],
    },
    Row {
        id: "llamacpp",
        name: "llama.cpp",
        cells: [
            (S, "winget"),
            (P, "apt where Ubuntu packages it (26.04), otherwise built by hand"),
            (P, "Same as Ubuntu"),
            (P, "Official server images"),
        ],
    },
    Row {
        id: "ssh",
        name: "SSH",
        cells: [(S, "Windows OpenSSH client"), (S, "OpenSSH"), (S, "OpenSSH"), (S, "OpenSSH")],
    },
    Row {
        id: "docker",
        name: "Docker",
        cells: [
            (P, "Docker Desktop (WSL 2 backend)"),
            (S, "Docker Engine"),
            (P, "Docker Desktop integration or Docker Engine in the distro"),
            (P, "Needs the host's Docker socket"),
        ],
    },
    Row {
        id: "mcp",
        name: "MCP servers (stdio, HTTP, SSE)",
        cells: [(S, ""), (S, ""), (S, ""), (P, "stdio servers must be installed in the container")],
    },
    Row {
        id: "roblox",
        name: "Roblox Studio + MCP",
        cells: [(S, ""), (U, "Roblox Studio has no Linux version"), (U, "Windows only"), (U, "Windows only")],
    },
    Row {
        id: "wsl",
        name: "WSL",
        cells: [(S, "wsl.exe"), (U, "Windows only"), (U, "This is WSL"), (U, "Windows only")],
    },
    Row {
        id: "powershell",
        name: "PowerShell",
        cells: [
            (S, "Windows PowerShell and PowerShell 7"),
            (P, "PowerShell 7 (pwsh) from Microsoft's repository only"),
            (P, "pwsh only"),
            (P, "pwsh only"),
        ],
    },
    Row {
        id: "systemd",
        name: "systemd user services",
        cells: [
            (U, "Components run as NEXUS child processes"),
            (S, "systemd --user, never root"),
            (P, "Needs systemd=true in /etc/wsl.conf"),
            (U, "No init system in containers"),
        ],
    },
    Row {
        id: "credentials",
        name: "Credential store",
        cells: [
            (S, "Windows Credential Manager"),
            (S, "Secret Service (GNOME Keyring, KWallet)"),
            (P, "Needs a Secret Service daemon in the distro"),
            (U, "No Secret Service in a headless container"),
        ],
    },
    Row {
        id: "gpu",
        name: "GPU acceleration (local AI)",
        cells: [
            (S, "NVIDIA CUDA, Vulkan"),
            (S, "NVIDIA CUDA, AMD ROCm, Vulkan"),
            (P, "NVIDIA CUDA only"),
            (P, "With the vendor's container runtime"),
        ],
    },
    Row {
        id: "terminal",
        name: "Raw Terminal",
        cells: [(S, "PowerShell, CMD, WSL (ConPTY)"), (S, "bash, zsh, fish (PTY)"), (S, "WSLg"), (U, "No desktop")],
    },
    Row {
        id: "aitown",
        name: "AI Town (local Convex backend)",
        cells: [(S, ""), (S, ""), (P, "Through WSLg"), (U, "No desktop")],
    },
    Row {
        id: "updates",
        name: "Automatic updates",
        cells: [
            (S, "NSIS installer"),
            (P, "AppImage updates itself; .deb through a new package"),
            (P, "AppImage"),
            (U, "Rebuild the image"),
        ],
    },
];

fn cell((support, note): C) -> Cell {
    Cell { support, note: (!note.is_empty()).then(|| note.to_string()) }
}

fn program_live(names: &[&str]) -> Live {
    match names.iter().find_map(|n| find_program(n)) {
        Some(p) => Live::new(LiveState::Available, p.display().to_string()),
        None => Live::new(LiveState::Missing, format!("{} not found on PATH", names.join(" / "))),
    }
}

fn os_only(os: Os, f: impl FnOnce() -> Live) -> Live {
    if Os::current() == os {
        f()
    } else {
        Live::new(LiveState::NotApplicable, format!("{} only", os.name()))
    }
}

/// Live status of one row (cheap: PATH lookups and file checks; the systemd
/// row asks `systemctl`).
fn live(id: &str) -> Live {
    match id {
        "claude" => program_live(&["claude"]),
        "node" => program_live(&["node"]),
        "git" => program_live(&["git"]),
        "ollama" => program_live(&["ollama"]),
        "lmstudio" => {
            let home_lms = crate::paths::home_dir().join(".lmstudio").join("bin").join(if cfg!(windows) {
                "lms.exe"
            } else {
                "lms"
            });
            if home_lms.is_file() {
                Live::new(LiveState::Available, home_lms.display().to_string())
            } else {
                program_live(&["lms"])
            }
        }
        "llamacpp" => program_live(&["llama-server"]),
        "ssh" => program_live(&["ssh"]),
        "docker" => program_live(&["docker"]),
        "mcp" => Live::new(LiveState::Available, "Built into NEXUS"),
        "roblox" => os_only(Os::Windows, || {
            let dir = crate::paths::local_data_dir().map(|d| d.join("Roblox").join("Versions"));
            match dir.filter(|d| d.is_dir()) {
                Some(d) => Live::new(LiveState::Available, d.display().to_string()),
                None => Live::new(LiveState::Missing, "Roblox Studio not found"),
            }
        }),
        "wsl" => os_only(Os::Windows, || program_live(&["wsl.exe"])),
        "powershell" => program_live(&["pwsh", "powershell"]),
        "systemd" => os_only(Os::Linux, || {
            let s = crate::services::status();
            if s.available {
                Live::new(LiveState::Available, format!("systemd --user {}", s.state.unwrap_or_default()))
            } else {
                Live::new(LiveState::Missing, s.reason.unwrap_or_default())
            }
        }),
        "gpu" => {
            let tools: Vec<&str> =
                ["nvidia-smi", "rocm-smi"].into_iter().filter(|t| find_program(t).is_some()).collect();
            if tools.is_empty() {
                Live::new(LiveState::Unknown, "No vendor tool on PATH (see AI Engines for the full detection)")
            } else {
                Live::new(LiveState::Available, format!("{} found", tools.join(", ")))
            }
        }
        "terminal" => {
            let shells: Vec<String> =
                crate::shells::detect_shells().into_iter().filter(|s| s.available).map(|s| s.name).collect();
            if shells.is_empty() {
                Live::new(LiveState::Missing, "No shell found")
            } else {
                Live::new(LiveState::Available, shells.join(", "))
            }
        }
        "aitown" => match find_program("node") {
            Some(_) => Live::new(LiveState::Available, "Node.js found"),
            None => Live::new(LiveState::Missing, "Needs Node.js 18+"),
        },
        _ => Live::new(LiveState::Unknown, "Not checked"),
    }
}

/// The matrix with live statuses. Blocking (a few PATH lookups, one
/// `systemctl` call on Linux). Rows the caller checks better (credential
/// store, Claude Code) can be replaced afterwards with [`Matrix::set_live`].
pub fn matrix() -> Matrix {
    Matrix {
        environment: environment(),
        rows: ROWS
            .iter()
            .map(|r| Capability {
                id: r.id.into(),
                name: r.name.into(),
                windows: cell(r.cells[0]),
                ubuntu: cell(r.cells[1]),
                wsl: cell(r.cells[2]),
                docker: cell(r.cells[3]),
                live: if r.id == "credentials" { Live::new(LiveState::Unknown, "Not checked") } else { live(r.id) },
            })
            .collect(),
    }
}

impl Matrix {
    pub fn set_live(&mut self, id: &str, live: Live) {
        if let Some(r) = self.rows.iter_mut().find(|r| r.id == id) {
            r.live = live;
        }
    }

    /// Support of a row in the column NEXUS runs in now.
    pub fn current_support(&self, id: &str) -> Option<Support> {
        let r = self.rows.iter().find(|r| r.id == id)?;
        Some(match self.environment {
            Environment::Windows => r.windows.support,
            Environment::Ubuntu | Environment::Other => r.ubuntu.support,
            Environment::Wsl => r.wsl.support,
            Environment::Docker => r.docker.support,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_only_rows_are_unavailable_on_ubuntu() {
        let m = matrix();
        for id in ["roblox", "wsl"] {
            let r = m.rows.iter().find(|r| r.id == id).unwrap();
            assert_eq!(r.windows.support, Support::Supported);
            assert_eq!(r.ubuntu.support, Support::Unavailable);
            assert!(r.ubuntu.note.is_some(), "{id} explains why");
        }
        let systemd = m.rows.iter().find(|r| r.id == "systemd").unwrap();
        assert_eq!(systemd.ubuntu.support, Support::Supported);
        assert_eq!(systemd.windows.support, Support::Unavailable);
    }

    #[test]
    fn every_row_has_a_live_status_and_unique_id() {
        let mut m = matrix();
        let mut ids: Vec<&str> = m.rows.iter().map(|r| r.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), m.rows.len());
        for id in ["claude", "ollama", "ssh", "docker", "roblox", "wsl", "systemd", "powershell", "credentials"] {
            assert!(m.rows.iter().any(|r| r.id == id), "missing {id}");
        }
        let roblox = m.rows.iter().find(|r| r.id == "roblox").unwrap();
        if cfg!(windows) {
            assert_ne!(roblox.live.state, LiveState::NotApplicable);
        } else {
            assert_eq!(roblox.live.state, LiveState::NotApplicable);
        }
        m.set_live("credentials", Live::new(LiveState::Available, "ok"));
        assert_eq!(m.rows.iter().find(|r| r.id == "credentials").unwrap().live.state, LiveState::Available);
        let expected = if m.environment == Environment::Docker { Support::Partial } else { Support::Supported };
        assert_eq!(m.current_support("mcp"), Some(expected));
    }

    #[test]
    fn environment_matches_the_os() {
        match Os::current() {
            Os::Windows => assert_eq!(environment(), Environment::Windows),
            Os::Linux => assert!(matches!(environment(), Environment::Ubuntu | Environment::Wsl | Environment::Docker)),
            _ => {}
        }
    }
}
