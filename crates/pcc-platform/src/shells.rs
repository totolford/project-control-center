//! Shells (for the embedded Raw Terminal) and terminal emulators (for "open a
//! terminal here"): PowerShell, CMD, Windows Terminal and WSL on Windows;
//! bash, zsh, fish, GNOME Terminal, Ptyxis, Konsole and `x-terminal-emulator`
//! on Ubuntu. Only what is found on this machine is offered.

use std::path::Path;

use serde::Serialize;

use crate::paths::find_program;
use crate::Os;

/// A shell the Raw Terminal can open.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// Terminal profile id (`powershell`, `cmd`, `wsl`, `bash`, `zsh`…).
    pub id: String,
    pub name: String,
    /// Full path when found.
    pub program: Option<String>,
    /// Arguments for an interactive session.
    pub args: Vec<String>,
    pub available: bool,
    /// The user's default shell (`$SHELL` on Linux, PowerShell on Windows).
    pub default: bool,
}

/// A terminal emulator NEXUS can open in a folder.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub name: String,
    pub program: Option<String>,
    pub available: bool,
}

struct ShellSpec {
    id: &'static str,
    name: &'static str,
    program: &'static str,
    args: &'static [&'static str],
}

const WINDOWS_SHELLS: &[ShellSpec] = &[
    ShellSpec { id: "powershell", name: "PowerShell", program: "powershell.exe", args: &["-NoLogo"] },
    ShellSpec { id: "pwsh", name: "PowerShell 7", program: "pwsh.exe", args: &["-NoLogo"] },
    ShellSpec { id: "cmd", name: "Command Prompt", program: "cmd.exe", args: &[] },
    ShellSpec { id: "wsl", name: "WSL", program: "wsl.exe", args: &[] },
];

const UNIX_SHELLS: &[ShellSpec] = &[
    ShellSpec { id: "bash", name: "Bash", program: "bash", args: &["-l"] },
    ShellSpec { id: "zsh", name: "Zsh", program: "zsh", args: &["-l"] },
    ShellSpec { id: "fish", name: "Fish", program: "fish", args: &["-l"] },
    ShellSpec { id: "pwsh", name: "PowerShell 7", program: "pwsh", args: &["-NoLogo"] },
    ShellSpec { id: "sh", name: "POSIX sh", program: "sh", args: &[] },
];

struct TerminalSpec {
    id: &'static str,
    name: &'static str,
    program: &'static str,
}

const WINDOWS_TERMINALS: &[TerminalSpec] = &[
    TerminalSpec { id: "wt", name: "Windows Terminal", program: "wt.exe" },
    TerminalSpec { id: "conhost", name: "Console Host", program: "conhost.exe" },
];

/// In preference order: the Debian alternative the user picked, then the
/// defaults of Ubuntu (Ptyxis since 25.10, GNOME Terminal before), then others.
const LINUX_TERMINALS: &[TerminalSpec] = &[
    TerminalSpec {
        id: "x-terminal-emulator",
        name: "Default terminal (x-terminal-emulator)",
        program: "x-terminal-emulator",
    },
    TerminalSpec { id: "ptyxis", name: "Ptyxis", program: "ptyxis" },
    TerminalSpec { id: "gnome-terminal", name: "GNOME Terminal", program: "gnome-terminal" },
    TerminalSpec { id: "konsole", name: "Konsole", program: "konsole" },
    TerminalSpec { id: "xfce4-terminal", name: "Xfce Terminal", program: "xfce4-terminal" },
    TerminalSpec { id: "tilix", name: "Tilix", program: "tilix" },
    TerminalSpec { id: "kitty", name: "kitty", program: "kitty" },
    TerminalSpec { id: "alacritty", name: "Alacritty", program: "alacritty" },
    TerminalSpec { id: "xterm", name: "XTerm", program: "xterm" },
];

fn shell_specs(os: Os) -> &'static [ShellSpec] {
    if os == Os::Windows {
        WINDOWS_SHELLS
    } else {
        UNIX_SHELLS
    }
}

/// Default shell id from `$SHELL` (`/usr/bin/zsh` → `zsh`).
pub fn default_shell_id(os: Os, shell_var: Option<&str>) -> &'static str {
    if os == Os::Windows {
        return "powershell";
    }
    let base = shell_var.and_then(|s| Path::new(s).file_name()).map(|n| n.to_string_lossy().into_owned());
    UNIX_SHELLS.iter().find(|s| Some(s.id) == base.as_deref()).map(|s| s.id).unwrap_or("bash")
}

/// Shells of this OS, each with whether it is installed.
pub fn detect_shells() -> Vec<ShellInfo> {
    let os = Os::current();
    let default = default_shell_id(os, std::env::var("SHELL").ok().as_deref());
    shell_specs(os)
        .iter()
        .map(|s| {
            let program = find_program(s.program);
            ShellInfo {
                id: s.id.into(),
                name: s.name.into(),
                available: program.is_some(),
                program: program.map(|p| p.display().to_string()),
                args: s.args.iter().map(|a| a.to_string()).collect(),
                default: s.id == default,
            }
        })
        .collect()
}

/// The program and arguments of an installed shell (Raw Terminal profile).
pub fn shell(id: &str) -> Option<ShellInfo> {
    detect_shells().into_iter().find(|s| s.id == id && s.available)
}

/// The user's default shell, or the first installed one.
pub fn default_shell() -> Option<ShellInfo> {
    let all = detect_shells();
    all.iter().find(|s| s.default && s.available).or_else(|| all.iter().find(|s| s.available)).cloned()
}

/// Program and arguments that run `command` in a visible shell and keep it
/// open afterwards (its output and prompts stay readable): PowerShell on
/// Windows, the default shell on Linux.
pub fn run_and_stay(command: &str) -> Option<(String, Vec<String>)> {
    if Os::current() == Os::Windows {
        let ps = shell("powershell")?;
        return Some((ps.program?, vec!["-NoLogo".into(), "-NoExit".into(), "-Command".into(), command.into()]));
    }
    let sh = default_shell()
        .filter(|s| s.id != "pwsh" && s.id != "fish")
        .or_else(|| shell("bash"))
        .or_else(|| shell("sh"))?;
    let program = sh.program?;
    Some((program.clone(), vec!["-c".into(), format!("{command}; exec \"{program}\" -i")]))
}

pub fn detect_terminals() -> Vec<TerminalInfo> {
    let list = if Os::current() == Os::Windows { WINDOWS_TERMINALS } else { LINUX_TERMINALS };
    list.iter()
        .map(|t| {
            let program = find_program(t.program);
            TerminalInfo {
                id: t.id.into(),
                name: t.name.into(),
                available: program.is_some(),
                program: program.map(|p| p.display().to_string()),
            }
        })
        .collect()
}

/// Arguments that open terminal `id` in `cwd` (the process is also started
/// with `cwd` as its working folder, for terminals without such an option).
pub fn terminal_args(id: &str, cwd: &str) -> Vec<String> {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match id {
        "wt" => v(&["-d", cwd]),
        "conhost" => v(&["powershell.exe", "-NoLogo"]),
        "ptyxis" => v(&["--new-window", "--working-directory", cwd]),
        "gnome-terminal" => vec![format!("--working-directory={cwd}")],
        "konsole" => v(&["--workdir", cwd]),
        "xfce4-terminal" => vec![format!("--working-directory={cwd}")],
        "tilix" => vec![format!("--working-directory={cwd}")],
        "kitty" => v(&["--directory", cwd]),
        "alacritty" => v(&["--working-directory", cwd]),
        _ => vec![],
    }
}

/// Opens the first installed terminal emulator in `cwd`.
pub fn open_terminal(cwd: &Path) -> Result<String, String> {
    let t = detect_terminals()
        .into_iter()
        .find(|t| t.available)
        .ok_or_else(|| "No terminal emulator found on PATH".to_string())?;
    let program = t.program.clone().unwrap_or_default();
    let mut c = std::process::Command::new(&program);
    c.args(terminal_args(&t.id, &cwd.to_string_lossy())).current_dir(cwd);
    c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    // A terminal window belongs to the user: it is not tied to NEXUS and keeps
    // no hidden-window flag.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    c.spawn().map_err(|e| format!("cannot start {}: {e}", t.name))?;
    Ok(t.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_comes_from_shell_var() {
        assert_eq!(default_shell_id(Os::Linux, Some("/usr/bin/zsh")), "zsh");
        assert_eq!(default_shell_id(Os::Linux, Some("/bin/bash")), "bash");
        assert_eq!(default_shell_id(Os::Linux, Some("/opt/weird/xonsh")), "bash");
        assert_eq!(default_shell_id(Os::Linux, None), "bash");
        assert_eq!(default_shell_id(Os::Windows, Some("/bin/zsh")), "powershell");
    }

    #[test]
    fn profiles_match_the_os() {
        let ids: Vec<&str> = shell_specs(Os::Windows).iter().map(|s| s.id).collect();
        assert_eq!(ids, ["powershell", "pwsh", "cmd", "wsl"]);
        assert!(shell_specs(Os::Linux).iter().any(|s| s.id == "bash"));
        assert!(!shell_specs(Os::Linux).iter().any(|s| s.id == "cmd"));
    }

    #[test]
    fn terminal_arguments_open_the_folder() {
        assert_eq!(terminal_args("gnome-terminal", "/home/a/p"), ["--working-directory=/home/a/p"]);
        assert_eq!(terminal_args("konsole", "/p"), ["--workdir", "/p"]);
        assert_eq!(terminal_args("wt", r"C:\p"), ["-d", r"C:\p"]);
        assert!(terminal_args("xterm", "/p").is_empty());
    }

    #[test]
    fn this_machine_has_a_shell() {
        let shells = detect_shells();
        assert!(shells.iter().any(|s| s.available), "{shells:?}");
        let (program, args) = run_and_stay("echo hi").unwrap();
        assert!(!program.is_empty());
        assert!(args.iter().any(|a| a.contains("echo hi")));
    }
}
