//! Installer plans: the exact command NEXUS would run to install, update or
//! remove a component, shown to the user before anything runs. Windows uses
//! winget; Ubuntu uses the vendor's official install script or apt, elevated
//! through `pkexec` (the desktop's own password prompt). NEXUS never runs an
//! installer without the user's confirmation and never runs one as root.

use serde::Serialize;

use crate::paths::find_program;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Winget,
    /// The vendor's official install script.
    Script,
    Apt,
    /// No automatic method: the user installs it themselves.
    Manual,
}

/// What NEXUS would run, exactly.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    /// `install`, `update` or `uninstall`.
    pub action: String,
    pub method: InstallMethod,
    pub program: String,
    pub args: Vec<String>,
    /// The command line as shown to the user.
    pub display: String,
    /// Asks for the administrator password (pkexec) or UAC (winget may).
    pub elevated: bool,
    /// Where the software comes from.
    pub source: String,
    /// The plan can be run here; otherwise `reason` says why.
    pub available: bool,
    pub reason: Option<String>,
    /// Official instructions for doing it by hand.
    pub docs_url: Option<String>,
}

impl InstallPlan {
    pub fn manual(action: &str, reason: impl Into<String>, docs_url: Option<&str>) -> Self {
        InstallPlan {
            action: action.into(),
            method: InstallMethod::Manual,
            program: String::new(),
            args: vec![],
            display: String::new(),
            elevated: false,
            source: String::new(),
            available: false,
            reason: Some(reason.into()),
            docs_url: docs_url.map(str::to_string),
        }
    }

    fn new(
        action: &str,
        method: InstallMethod,
        program: &str,
        args: Vec<String>,
        elevated: bool,
        source: String,
    ) -> Self {
        let display = display_command(program, &args);
        InstallPlan {
            action: action.into(),
            method,
            program: program.into(),
            args,
            display,
            elevated,
            source,
            available: true,
            reason: None,
            docs_url: None,
        }
    }

    pub fn unavailable(mut self, reason: impl Into<String>) -> Self {
        self.available = false;
        self.reason = Some(reason.into());
        self
    }

    pub fn docs(mut self, url: &str) -> Self {
        self.docs_url = Some(url.into());
        self
    }

    /// `winget`, `install script`, `apt`, `manual`: for event summaries.
    pub fn method_label(&self) -> &'static str {
        match self.method {
            InstallMethod::Winget => "winget",
            InstallMethod::Script => "install script",
            InstallMethod::Apt => "apt",
            InstallMethod::Manual => "manual",
        }
    }
}

/// POSIX shell quoting for display (and for `sh -c`).
pub fn sh_quote(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@+,%".contains(c)) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

pub fn display_command(program: &str, args: &[String]) -> String {
    std::iter::once(program.to_string()).chain(args.iter().map(|a| sh_quote(a))).collect::<Vec<_>>().join(" ")
}

/// `winget <args>`.
pub fn winget_plan(action: &str, args: Vec<String>, package_id: &str) -> InstallPlan {
    InstallPlan::new(action, InstallMethod::Winget, "winget", args, false, format!("winget repository ({package_id})"))
}

/// Downloads an official install script over HTTPS and runs it as
/// administrator: `pkexec sh -c 'curl -fsSL <url> | sh'`.
pub fn script_plan(action: &str, url: &str, vendor: &str) -> InstallPlan {
    let inner = format!("curl -fsSL {} | sh", sh_quote(url));
    let plan = InstallPlan::new(
        action,
        InstallMethod::Script,
        "pkexec",
        vec!["sh".into(), "-c".into(), inner],
        true,
        format!("official {vendor} install script ({url})"),
    );
    match (find_program("curl"), find_program("pkexec")) {
        (None, _) => {
            plan.unavailable("curl is required by the install script: install it with `sudo apt install curl`")
        }
        (_, None) => plan.unavailable("pkexec (polkit) is not available to ask for the administrator password"),
        _ => plan,
    }
}

/// `pkexec apt-get <verb> -y <packages>`.
pub fn apt_plan(action: &str, packages: &[&str]) -> InstallPlan {
    let mut args = vec!["apt-get".to_string()];
    match action {
        "install" => args.push("install".into()),
        "update" => args.extend(["install".into(), "--only-upgrade".into()]),
        _ => args.push("remove".into()),
    }
    args.push("-y".into());
    args.extend(packages.iter().map(|p| p.to_string()));
    let plan = InstallPlan::new(action, InstallMethod::Apt, "pkexec", args, true, "Ubuntu archive (apt)".into());
    if find_program("apt-get").is_none() {
        plan.unavailable("apt is not available: this is not a Debian/Ubuntu system")
    } else if find_program("pkexec").is_none() {
        plan.unavailable("pkexec (polkit) is not available to ask for the administrator password")
    } else {
        plan
    }
}

/// Installed and candidate versions from `apt-cache policy <pkg>`.
pub fn parse_apt_policy(text: &str) -> (Option<String>, Option<String>) {
    let field = |name: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(name))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty() && v != "(none)")
    };
    (field("Installed:"), field("Candidate:"))
}

/// Blocking: `apt-cache policy` for one package (`None` without apt).
pub fn apt_policy(package: &str) -> Option<(Option<String>, Option<String>)> {
    let program = find_program("apt-cache")?;
    let mut c = std::process::Command::new(program);
    c.args(["policy", package]).env("LC_ALL", "C");
    crate::process::prepare_std(&mut c);
    let out = c.stdin(std::process::Stdio::null()).output().ok()?;
    Some(parse_apt_policy(&String::from_utf8_lossy(&out.stdout)))
}

/// What a plan run printed (last lines).
fn tail(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Runs a plan the user confirmed. Blocking; returns the last lines of output.
pub fn run(plan: &InstallPlan) -> Result<String, String> {
    if !plan.available {
        return Err(plan.reason.clone().unwrap_or_else(|| "this action is not available here".into()));
    }
    if crate::process::is_root() {
        return Err("NEXUS does not run installers as root".into());
    }
    let program = find_program(&plan.program).ok_or_else(|| format!("{} is not installed", plan.program))?;
    let mut c = std::process::Command::new(program);
    c.args(&plan.args);
    crate::process::prepare_std(&mut c);
    let out = c.stdin(std::process::Stdio::null()).output().map_err(|e| format!("cannot run {}: {e}", plan.program))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        return Ok(tail(&text, 12));
    }
    let why = match (plan.program.as_str(), out.status.code()) {
        ("pkexec", Some(126)) => "the administrator password prompt was dismissed".to_string(),
        ("pkexec", Some(127)) => {
            "not authorized: no polkit agent answered (a desktop session is needed) or the password was refused"
                .to_string()
        }
        _ => format!("{} exited with {}", plan.program, out.status),
    };
    Err(format!("{why}\n{}", tail(&text, 12)).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_like_a_shell() {
        assert_eq!(sh_quote("llama.cpp"), "llama.cpp");
        assert_eq!(sh_quote("curl -fsSL x | sh"), "'curl -fsSL x | sh'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn script_plan_shows_the_exact_command() {
        let p = script_plan("install", "https://ollama.com/install.sh", "Ollama");
        assert_eq!(p.display, "pkexec sh -c 'curl -fsSL https://ollama.com/install.sh | sh'");
        assert_eq!(p.method, InstallMethod::Script);
        assert!(p.elevated);
        assert!(p.available || p.reason.is_some());
    }

    #[test]
    fn apt_plans() {
        let i = apt_plan("install", &["llama.cpp"]);
        assert_eq!(i.args, ["apt-get", "install", "-y", "llama.cpp"]);
        let u = apt_plan("update", &["llama.cpp"]);
        assert_eq!(u.display, "pkexec apt-get install --only-upgrade -y llama.cpp");
        assert_eq!(apt_plan("uninstall", &["a", "b"]).args, ["apt-get", "remove", "-y", "a", "b"]);
    }

    #[test]
    fn parses_apt_policy() {
        let t = "llama.cpp:\n  Installed: (none)\n  Candidate: 8681+dfsg-1\n  Version table:\n     8681+dfsg-1 500\n";
        assert_eq!(parse_apt_policy(t), (None, Some("8681+dfsg-1".into())));
        assert_eq!(parse_apt_policy(""), (None, None));
        let both = "x:\n  Installed: 1.0\n  Candidate: 1.1\n";
        assert_eq!(parse_apt_policy(both), (Some("1.0".into()), Some("1.1".into())));
    }

    #[test]
    fn manual_plans_never_run() {
        let m = InstallPlan::manual("uninstall", "do it by hand", Some("https://example.org"));
        assert!(!m.available);
        assert!(run(&m).unwrap_err().contains("by hand"));
    }
}
