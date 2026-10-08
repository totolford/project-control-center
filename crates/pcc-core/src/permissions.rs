//! Capability based permission model and the policy that maps Claude Code tool
//! calls to capabilities.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    FsRead,
    FsWrite,
    FsExecute,
    Network,
    GitRead,
    GitWrite,
    GithubRead,
    GithubWrite,
    GithubAdmin,
    SshRead,
    SshExecute,
    Mcp,
}

impl Capability {
    pub const ALL: [Capability; 12] = [
        Capability::FsRead,
        Capability::FsWrite,
        Capability::FsExecute,
        Capability::Network,
        Capability::GitRead,
        Capability::GitWrite,
        Capability::GithubRead,
        Capability::GithubWrite,
        Capability::GithubAdmin,
        Capability::SshRead,
        Capability::SshExecute,
        Capability::Mcp,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Capability::FsRead => "fs_read",
            Capability::FsWrite => "fs_write",
            Capability::FsExecute => "fs_execute",
            Capability::Network => "network",
            Capability::GitRead => "git_read",
            Capability::GitWrite => "git_write",
            Capability::GithubRead => "github_read",
            Capability::GithubWrite => "github_write",
            Capability::GithubAdmin => "github_admin",
            Capability::SshRead => "ssh_read",
            Capability::SshExecute => "ssh_execute",
            Capability::Mcp => "mcp",
        }
    }
}

/// Power profile: a named permission preset.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PowerLevel {
    Low,
    Normal,
    High,
    Maximum,
}

impl PowerLevel {
    pub const ALL: [PowerLevel; 4] = [PowerLevel::Low, PowerLevel::Normal, PowerLevel::High, PowerLevel::Maximum];
}

/// What happens when an agent uses a capability.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Deny,
    Ask,
    Allow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct PermissionSet(pub BTreeMap<Capability, Access>);

impl PermissionSet {
    pub fn get(&self, c: Capability) -> Access {
        self.0.get(&c).copied().unwrap_or(Access::Deny)
    }

    pub fn set(&mut self, c: Capability, a: Access) {
        self.0.insert(c, a);
    }

    fn from_pairs(pairs: &[(Capability, Access)]) -> Self {
        let mut s = PermissionSet(BTreeMap::new());
        for c in Capability::ALL {
            s.set(c, Access::Deny);
        }
        for (c, a) in pairs {
            s.set(*c, *a);
        }
        s
    }

    /// Central plans and coordinates; it reads freely and asks before changing things.
    pub fn central() -> Self {
        use Access::*;
        use Capability::*;
        Self::from_pairs(&[
            (FsRead, Allow),
            (FsWrite, Ask),
            (FsExecute, Ask),
            (Network, Ask),
            (GitRead, Allow),
            (GitWrite, Ask),
            (GithubRead, Allow),
            (GithubWrite, Ask),
            (GithubAdmin, Deny),
            (SshRead, Ask),
            (SshExecute, Ask),
            (Mcp, Ask),
        ])
    }

    pub fn worker_default() -> Self {
        use Access::*;
        use Capability::*;
        Self::from_pairs(&[
            (FsRead, Allow),
            (FsWrite, Allow),
            (FsExecute, Allow),
            (Network, Ask),
            (GitRead, Allow),
            (GitWrite, Allow),
            (GithubRead, Allow),
            (GithubWrite, Ask),
            (GithubAdmin, Deny),
            (SshRead, Ask),
            (SshExecute, Ask),
            (Mcp, Allow),
        ])
    }

    /// The most Central can hand out without the user editing the agent.
    pub fn worker_ceiling() -> Self {
        use Access::*;
        use Capability::*;
        Self::from_pairs(&[
            (FsRead, Allow),
            (FsWrite, Allow),
            (FsExecute, Allow),
            (Network, Allow),
            (GitRead, Allow),
            (GitWrite, Allow),
            (GithubRead, Allow),
            (GithubWrite, Ask),
            (GithubAdmin, Ask),
            (SshRead, Ask),
            (SshExecute, Ask),
            (Mcp, Allow),
        ])
    }

    /// Permission preset of a power level. Power is only a preset: the
    /// resulting capabilities are what is enforced and displayed.
    pub fn preset(level: PowerLevel) -> Self {
        use Access::*;
        use Capability::*;
        match level {
            PowerLevel::Low => Self::from_pairs(&[(FsRead, Allow), (GitRead, Allow), (GithubRead, Allow)]),
            PowerLevel::Normal => Self::from_pairs(&[
                (FsRead, Allow),
                (FsWrite, Allow),
                (FsExecute, Allow),
                (GitRead, Allow),
                (GitWrite, Ask),
                (GithubRead, Allow),
                (Network, Ask),
                (Mcp, Ask),
            ]),
            PowerLevel::High => Self::from_pairs(&[
                (FsRead, Allow),
                (FsWrite, Allow),
                (FsExecute, Allow),
                (Network, Allow),
                (GitRead, Allow),
                (GitWrite, Allow),
                (GithubRead, Allow),
                (GithubWrite, Ask),
                (SshRead, Ask),
                (SshExecute, Ask),
                (Mcp, Allow),
            ]),
            PowerLevel::Maximum => Self::from_pairs(&Capability::ALL.map(|c| (c, Allow))),
        }
    }

    /// The power level whose preset equals this set, if any ("custom" otherwise).
    pub fn power(&self) -> Option<PowerLevel> {
        PowerLevel::ALL.into_iter().find(|l| &Self::preset(*l) == self)
    }

    /// Caps every capability at the ceiling (`Deny < Ask < Allow`).
    pub fn clamp_to(&self, ceiling: &PermissionSet) -> PermissionSet {
        let mut out = self.clone();
        for c in Capability::ALL {
            out.set(c, self.get(c).min(ceiling.get(c)));
        }
        out
    }
}

/// Classification of one tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolClassification {
    pub capability: Option<Capability>,
    /// Always ask the user, whatever the agent's permissions.
    pub destructive: bool,
    /// Path the call touches is outside the agent's workspace.
    pub outside_workspace: bool,
    /// For `mcp__<server>__tool` calls: the server name.
    pub mcp_server: Option<String>,
    /// For `ssh`/`scp` commands: the destination host.
    pub ssh_host: Option<String>,
    pub summary: String,
    /// Stable key for "allow for this agent" rules.
    pub rule_key: String,
}

/// Tools that never need a decision: they only touch Claude's own bookkeeping.
const INERT_TOOLS: &[&str] = &[
    "TodoWrite",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "ToolSearch",
    "Task",
    "Agent",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
];

pub fn classify_tool(tool: &str, input: &Value, workspaces: &[PathBuf]) -> ToolClassification {
    let mut c = ToolClassification {
        capability: None,
        destructive: false,
        outside_workspace: false,
        mcp_server: None,
        ssh_host: None,
        summary: tool.to_string(),
        rule_key: tool.to_string(),
    };
    let path_arg = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .or_else(|| input.get("notebook_path"))
        .and_then(Value::as_str);

    match tool {
        "Read" | "Glob" | "Grep" | "LSP" | "NotebookRead" => {
            c.capability = Some(Capability::FsRead);
            if let Some(p) = path_arg {
                c.summary = format!("{tool}: {p}");
                c.outside_workspace = !is_inside_any(p, workspaces);
            }
        }
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            c.capability = Some(Capability::FsWrite);
            if let Some(p) = path_arg {
                c.summary = format!("{tool}: {p}");
                c.outside_workspace = !is_inside_any(p, workspaces);
            }
        }
        "Bash" | "PowerShell" => {
            let cmd = input.get("command").and_then(Value::as_str).unwrap_or("");
            let sc = classify_command(cmd);
            c.capability = Some(sc.capability);
            c.destructive = sc.destructive;
            c.ssh_host = sc.ssh_host;
            c.summary = format!("{tool}: {}", truncate(cmd, 300));
            c.rule_key = format!("{tool}:{}", sc.prefix);
        }
        "WebFetch" | "WebSearch" => {
            c.capability = Some(Capability::Network);
            if let Some(u) = input.get("url").or_else(|| input.get("query")).and_then(Value::as_str) {
                c.summary = format!("{tool}: {}", truncate(u, 200));
            }
        }
        t if INERT_TOOLS.contains(&t) => {}
        t if t.starts_with("mcp__") => {
            let rest = &t[5..];
            let server = rest.split("__").next().unwrap_or("").to_string();
            c.capability = Some(Capability::Mcp);
            c.mcp_server = Some(server);
        }
        _ => {
            // Unknown tool: be conservative.
            c.capability = Some(Capability::FsExecute);
            c.destructive = true;
        }
    }
    c
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandClass {
    pub capability: Capability,
    pub destructive: bool,
    pub ssh_host: Option<String>,
    /// First words of the command, used as rule key.
    pub prefix: String,
}

fn destructive_patterns() -> &'static [Regex] {
    use std::sync::OnceLock;
    static RE: OnceLock<Vec<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        [
            r"(?i)\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r\b)",
            r"(?i)\bremove-item\b.*-recurse",
            r"(?i)\b(rd|rmdir)\s+/s",
            r"(?i)\bdel\s+/[sfq]",
            r"(?i)\bformat(-volume)?\s+[a-z]:",
            r"(?i)\bgit\s+push\b.*(--force|-f\b|--delete|--mirror)",
            r"(?i)\bgit\s+reset\s+--hard",
            r"(?i)\bgit\s+clean\s+-[a-z]*f",
            r"(?i)\bgit\s+(branch\s+-D|checkout\s+--\s|restore\s)",
            r"(?i)\bgit\s+filter-(branch|repo)",
            r"(?i)\bdrop\s+(table|database|schema)\b",
            r"(?i)\btruncate\s+table\b",
            r"(?i)\b(shutdown|reboot|halt|poweroff)\b",
            r"(?i)\bstop-computer|restart-computer\b",
            r"(?i)\bmkfs\b|\bdd\s+if=",
            r"(?i)\bchmod\s+-R\s+777\b",
            r"(?i)\bgh\s+repo\s+(delete|archive)",
            r"(?i)\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)",
            r"(?i)\breg\s+delete\b|\bremove-itemproperty\b",
            r"(?i)>\s*/dev/sd[a-z]",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("valid regex"))
        .collect()
    })
}

/// Classifies a shell command (Bash or PowerShell).
pub fn classify_command(cmd: &str) -> CommandClass {
    let trimmed = cmd.trim();
    let destructive = destructive_patterns().iter().any(|r| r.is_match(trimmed));
    // Classify on the first command of a pipeline/chain; the most privileged
    // segment wins.
    let mut best: Option<Capability> = None;
    let mut ssh_host = None;
    for seg in split_segments(trimmed) {
        let all: Vec<&str> = seg.split_whitespace().collect();
        let words = &all[program_index(&all).min(all.len())..];
        if let Some(inner) = nested_command(words) {
            // `powershell -Command "ssh ..."`: the inner command governs.
            let c = classify_command(&inner);
            if best.is_none_or(|b| rank(c.capability) > rank(b)) {
                best = Some(c.capability);
            }
            ssh_host = ssh_host.or(c.ssh_host);
            continue;
        }
        let Some(first) = words.first() else { continue };
        let first = program_name(first);
        let cap = match first.as_str() {
            "git" => git_capability(words),
            "gh" => {
                let sub = words.get(1).copied().unwrap_or("");
                let action = words.get(2).copied().unwrap_or("");
                let joined = seg.to_ascii_lowercase();
                let admin_repo_op = sub == "repo" && matches!(action, "delete" | "archive" | "rename" | "edit");
                if admin_repo_op || matches!(sub, "secret" | "variable" | "ruleset" | "auth") {
                    Capability::GithubAdmin
                } else if sub == "api" {
                    if joined.contains("-x delete") || joined.contains("--method delete") {
                        Capability::GithubAdmin
                    } else if joined.contains("-x post")
                        || joined.contains("-x put")
                        || joined.contains("-x patch")
                        || joined.contains("--method")
                        || joined.contains(" -f ")
                        || joined.contains(" --field")
                    {
                        Capability::GithubWrite
                    } else {
                        Capability::GithubRead
                    }
                } else if matches!(
                    action,
                    "create"
                        | "merge"
                        | "close"
                        | "reopen"
                        | "comment"
                        | "edit"
                        | "review"
                        | "delete"
                        | "ready"
                        | "fork"
                        | "clone"
                        | "upload"
                ) {
                    Capability::GithubWrite
                } else {
                    Capability::GithubRead
                }
            }
            "ssh" | "scp" | "sftp" | "rsync" => {
                ssh_host = extract_ssh_host(words);
                // `ssh host` with no remote command opens a shell; with one it runs it.
                if first == "ssh" && words.len() <= 2 {
                    Capability::SshRead
                } else {
                    Capability::SshExecute
                }
            }
            "curl" | "wget" | "invoke-webrequest" | "invoke-restmethod" | "iwr" | "irm" => Capability::Network,
            "ls" | "dir" | "cat" | "type" | "head" | "tail" | "pwd" | "echo" | "wc" | "find" | "grep" | "rg"
            | "get-childitem" | "get-content" | "select-string" | "tree" | "which" | "where" | "get-location"
            | "test-path" => Capability::FsRead,
            _ => Capability::FsExecute,
        };
        if best.is_none_or(|b| rank(cap) > rank(b)) {
            best = Some(cap);
        }
    }
    let prefix: String = trimmed.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    CommandClass { capability: best.unwrap_or(Capability::FsExecute), destructive, ssh_host, prefix }
}

/// `git <sub> ...`: read-only inspection vs. repository changes.
fn git_capability(words: &[&str]) -> Capability {
    let sub = words.get(1).copied().unwrap_or("");
    let arg = words.get(2).copied();
    let rest = words.get(2..).unwrap_or(&[]);
    let listing = |extra: &[&str]| {
        arg.is_none_or(|a| {
            ["-a", "-r", "-v", "-vv", "-l", "--list", "--all", "--show-current"].contains(&a) || extra.contains(&a)
        })
    };
    match sub {
        "push" => Capability::GithubWrite,
        "status" | "diff" | "log" | "show" | "blame" | "ls-files" | "rev-parse" | "describe" | "shortlog" | "grep"
        | "fetch" | "cat-file" | "ls-tree" | "reflog" | "merge-base" => Capability::GitRead,
        "branch" | "tag" | "remote" if listing(&["show", "get-url"]) => Capability::GitRead,
        // Bare `git stash` stashes changes: only listing forms are reads.
        "stash" | "worktree" if matches!(arg, Some("list" | "show")) => Capability::GitRead,
        "config" if rest.iter().any(|a| matches!(*a, "--get" | "--get-all" | "--list" | "-l")) => Capability::GitRead,
        _ => Capability::GitWrite,
    }
}

/// Wrapper programs that run another command (`timeout 15 ssh ...`).
const WRAPPERS: &[&str] = &["timeout", "env", "nohup", "time", "nice", "sudo", "stdbuf", "exec", "command", "ionice"];

fn program_name(word: &str) -> String {
    let w = word.trim_start_matches('&').trim_matches(['"', '\'']).to_ascii_lowercase();
    let base = w.rsplit(['/', '\\']).next().unwrap_or(&w).to_string();
    base.trim_end_matches(".exe").to_string()
}

/// Index of the real program in a segment, skipping wrappers and their options.
pub fn program_index(words: &[&str]) -> usize {
    let mut i = 0;
    while i < words.len() {
        let name = program_name(words[i]);
        if !WRAPPERS.contains(&name.as_str()) {
            return i;
        }
        i += 1;
        // Options and arguments of the wrapper itself.
        while i < words.len() {
            let w = words[i];
            let takes_value = matches!(w, "-s" | "-k" | "-n" | "-u" | "-g" | "-i" | "-o" | "-e" | "-c");
            if w.starts_with('-') {
                i += if takes_value { 2 } else { 1 };
            } else if w.contains('=') && name == "env" {
                i += 1;
            } else if name == "timeout" && w.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                i += 1;
                break;
            } else {
                break;
            }
        }
    }
    words.len().saturating_sub(1)
}

/// Command nested in `powershell -Command "..."` / `cmd /c "..."`, if any.
fn nested_command(words: &[&str]) -> Option<String> {
    let name = program_name(words.first()?);
    if !matches!(name.as_str(), "powershell" | "pwsh" | "cmd" | "bash" | "sh" | "wsl") {
        return None;
    }
    let at = words
        .iter()
        .position(|w| matches!(w.to_ascii_lowercase().as_str(), "-command" | "-c" | "/c" | "/k" | "-e" | "--"))?;
    let rest = words[at + 1..].join(" ");
    let rest = rest.trim().trim_matches(['"', '\'']).to_string();
    (!rest.is_empty()).then_some(rest)
}

/// Splits a command line into segments, keeping the separators (`|`, `||`, `&&`, `;`, newline).
fn split_keep(cmd: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let bytes = cmd.as_bytes();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        let two = &cmd[i..(i + 2).min(cmd.len())];
        let sep_len = if two == "&&" || two == "||" {
            2
        } else if matches!(bytes[i], b'|' | b';' | b'\n') {
            1
        } else {
            0
        };
        if sep_len > 0 {
            out.push((&cmd[start..i], &cmd[i..i + sep_len]));
            i += sep_len;
            start = i;
        } else {
            i += 1;
        }
    }
    out.push((&cmd[start..], ""));
    out
}

/// Makes agent `ssh`/`scp` invocations non-interactive so they fail fast
/// instead of waiting forever for a password or a host-key confirmation, and
/// adds the connection's key when the command has none. Wrappers (`timeout`,
/// `env`...) are seen through. Returns `None` when nothing changes.
pub fn harden_ssh_command(cmd: &str, key_path: Option<&str>) -> Option<String> {
    let mut out = String::with_capacity(cmd.len() + 64);
    let mut changed = false;
    for (segment, sep) in split_keep(cmd) {
        let words: Vec<&str> = segment.split_whitespace().collect();
        let idx = program_index(&words);
        let name = words.get(idx).map(|w| program_name(w)).unwrap_or_default();
        if name != "ssh" && name != "scp" {
            out.push_str(segment);
            out.push_str(sep);
            continue;
        }
        // Byte offset just after the program word.
        let mut offset = 0;
        for (n, w) in segment.split_whitespace().enumerate() {
            let pos = segment[offset..].find(w).expect("word from the same segment") + offset;
            offset = pos + w.len();
            if n == idx {
                break;
            }
        }
        let tail = &segment[offset..];
        let mut extra = String::new();
        if !tail.contains("BatchMode") {
            extra.push_str(" -o BatchMode=yes");
        }
        if !tail.contains("ConnectTimeout") {
            extra.push_str(" -o ConnectTimeout=15");
        }
        if let Some(k) = key_path.filter(|k| !k.is_empty()) {
            if !tail.split_whitespace().any(|w| w == "-i") {
                extra.push_str(&format!(" -i \"{k}\""));
            }
        }
        changed |= !extra.is_empty();
        out.push_str(&segment[..offset]);
        out.push_str(&extra);
        out.push_str(tail);
        out.push_str(sep);
    }
    changed.then_some(out)
}

/// Relative sensitivity used to pick the governing capability of a chained command.
fn rank(c: Capability) -> u8 {
    match c {
        Capability::FsRead | Capability::GitRead | Capability::GithubRead => 1,
        Capability::FsExecute => 2,
        Capability::Network | Capability::Mcp => 3,
        Capability::GitWrite | Capability::FsWrite => 4,
        Capability::SshRead => 5,
        Capability::GithubWrite => 6,
        Capability::SshExecute => 7,
        Capability::GithubAdmin => 8,
    }
}

fn split_segments(cmd: &str) -> Vec<&str> {
    cmd.split(['|', ';', '\n'])
        .flat_map(|s| s.split("&&"))
        .flat_map(|s| s.split("||"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

fn extract_ssh_host(words: &[&str]) -> Option<String> {
    let mut skip_next = false;
    for w in words.iter().skip(1) {
        if skip_next {
            skip_next = false;
            continue;
        }
        if w.starts_with('-') {
            // Options that take a value.
            if matches!(*w, "-p" | "-P" | "-i" | "-l" | "-o" | "-F" | "-J" | "-e") {
                skip_next = true;
            }
            continue;
        }
        let host = w.split(':').next().unwrap_or(w);
        let host = host.rsplit('@').next().unwrap_or(host);
        if !host.is_empty() {
            return Some(host.to_string());
        }
    }
    None
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

/// Lexically normalizes a path (resolves `.` and `..`) without touching the disk.
pub fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_inside_any(path: &str, roots: &[PathBuf]) -> bool {
    let p = Path::new(path);
    if p.is_relative() {
        // Relative paths are resolved against the session cwd, which is a workspace.
        return !normalize_path(p).starts_with("..") && !path.starts_with("..");
    }
    let np = normalize_path(p);
    let lower = |x: &Path| x.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    let npl = lower(&np);
    roots.iter().any(|r| {
        let rl = lower(&normalize_path(r));
        let rl = rl.trim_end_matches('\\').to_string();
        npl == rl || npl.starts_with(&(rl + "\\"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn power_presets_are_ordered_and_detected() {
        let caps = PermissionSet::preset;
        for c in Capability::ALL {
            assert!(caps(PowerLevel::Low).get(c) <= caps(PowerLevel::Normal).get(c), "{c:?}");
            assert!(caps(PowerLevel::Normal).get(c) <= caps(PowerLevel::High).get(c), "{c:?}");
            assert!(caps(PowerLevel::High).get(c) <= caps(PowerLevel::Maximum).get(c), "{c:?}");
            assert_eq!(caps(PowerLevel::Maximum).get(c), Access::Allow);
        }
        assert_eq!(caps(PowerLevel::Low).get(Capability::FsWrite), Access::Deny);
        assert_eq!(caps(PowerLevel::High).power(), Some(PowerLevel::High));
        assert_eq!(PermissionSet::worker_default().power(), None);
    }

    #[test]
    fn clamp_caps_permissions() {
        let mut want = PermissionSet::worker_default();
        want.set(Capability::GithubAdmin, Access::Allow);
        let clamped = want.clamp_to(&PermissionSet::worker_ceiling());
        assert_eq!(clamped.get(Capability::GithubAdmin), Access::Ask);
        assert_eq!(clamped.get(Capability::FsWrite), Access::Allow);
    }

    #[test]
    fn destructive_commands_detected() {
        for cmd in [
            "rm -rf build",
            "rm -fr /",
            "Remove-Item -Path x -Recurse -Force",
            "git push --force origin main",
            "git reset --hard HEAD~3",
            "git clean -fdx",
            "rd /s /q node_modules",
            "psql -c 'DROP TABLE users'",
            "gh repo delete me/x",
        ] {
            assert!(classify_command(cmd).destructive, "{cmd}");
        }
        for cmd in ["npm test", "git status", "cargo build", "rm file.txt", "ls -la"] {
            assert!(!classify_command(cmd).destructive, "{cmd}");
        }
    }

    #[test]
    fn command_capabilities() {
        assert_eq!(classify_command("git status").capability, Capability::GitRead);
        assert_eq!(classify_command("git commit -m x").capability, Capability::GitWrite);
        assert_eq!(classify_command("git branch").capability, Capability::GitRead);
        assert_eq!(classify_command("git branch -a").capability, Capability::GitRead);
        assert_eq!(classify_command("git branch feature").capability, Capability::GitWrite);
        assert_eq!(classify_command("git stash list").capability, Capability::GitRead);
        assert_eq!(classify_command("git stash").capability, Capability::GitWrite);
        assert_eq!(classify_command("git stash push").capability, Capability::GitWrite);
        assert_eq!(classify_command("git config user.name x").capability, Capability::GitWrite);
        assert_eq!(classify_command("git config --get user.name").capability, Capability::GitRead);
        assert_eq!(classify_command("git push origin agent/x").capability, Capability::GithubWrite);
        assert_eq!(classify_command("gh pr list").capability, Capability::GithubRead);
        assert_eq!(classify_command("gh pr create --fill").capability, Capability::GithubWrite);
        assert_eq!(classify_command("gh api repos/a/b -X DELETE").capability, Capability::GithubAdmin);
        assert_eq!(classify_command("npm run build").capability, Capability::FsExecute);
        assert_eq!(classify_command("cat a.txt | grep x").capability, Capability::FsRead);
        assert_eq!(classify_command("git status && git push").capability, Capability::GithubWrite);
        let ssh = classify_command("ssh -p 2222 admin@192.168.1.50 uptime");
        assert_eq!(ssh.capability, Capability::SshExecute);
        assert_eq!(ssh.ssh_host.as_deref(), Some("192.168.1.50"));
    }

    #[test]
    fn wrappers_and_nested_shells_do_not_hide_ssh() {
        let t = classify_command("timeout 15 ssh -o ConnectTimeout=5 pi@192.0.2.10 \"docker --version\" 2>&1");
        assert_eq!((t.capability, t.ssh_host.as_deref()), (Capability::SshExecute, Some("192.0.2.10")));
        let e = classify_command("env TERM=dumb nohup ssh admin@srv uptime");
        assert_eq!(e.ssh_host.as_deref(), Some("srv"));
        let p = classify_command("powershell -NoProfile -Command \"ssh pi@h uptime\"");
        assert_eq!((p.capability, p.ssh_host.as_deref()), (Capability::SshExecute, Some("h")));
        let c = classify_command("cmd /c git push --force origin main");
        assert_eq!(c.capability, Capability::GithubWrite);
        assert!(c.destructive);
        assert_eq!(classify_command("timeout 5 npm test").capability, Capability::FsExecute);
        assert_eq!(
            harden_ssh_command("timeout 15 ssh pi@h uptime 2>&1 && echo ok", None).unwrap(),
            "timeout 15 ssh -o BatchMode=yes -o ConnectTimeout=15 pi@h uptime 2>&1 && echo ok"
        );
    }

    #[test]
    fn ssh_commands_are_made_non_interactive() {
        assert_eq!(
            harden_ssh_command("ssh pi@192.168.1.157 docker --version", None).unwrap(),
            "ssh -o BatchMode=yes -o ConnectTimeout=15 pi@192.168.1.157 docker --version"
        );
        assert_eq!(
            harden_ssh_command("cd x && ssh -p 22 pi@h uptime | tail -1", Some(r"C:\k\id")).unwrap(),
            r#"cd x && ssh -o BatchMode=yes -o ConnectTimeout=15 -i "C:\k\id" -p 22 pi@h uptime | tail -1"#
        );
        assert_eq!(harden_ssh_command("ssh -o BatchMode=yes -o ConnectTimeout=5 -i k h", Some("x")), None);
        assert_eq!(harden_ssh_command("echo ssh is great", None), None);
        assert_eq!(harden_ssh_command("npm test", None), None);
    }

    #[test]
    fn tool_paths_checked_against_workspace() {
        // Absolute paths of this OS: `C:\Projects\…` on Windows, `/home/ada/Projects/…` on Linux.
        let p =
            |s: &str| if cfg!(windows) { format!(r"C:\{}", s.replace('/', r"\")) } else { format!("/home/ada/{s}") };
        let ws = vec![PathBuf::from(p("Projects/AERIS"))];
        let inside = classify_tool("Write", &json!({"file_path": p("Projects/AERIS/src/a.ts")}), &ws);
        assert_eq!(inside.capability, Some(Capability::FsWrite));
        assert!(!inside.outside_workspace);
        let outside = classify_tool("Edit", &json!({"file_path": p("Windows/system.ini")}), &ws);
        assert!(outside.outside_workspace);
        let sneaky = classify_tool("Write", &json!({"file_path": p("Projects/AERIS/../other/x")}), &ws);
        assert!(sneaky.outside_workspace);
        let prefix = classify_tool("Write", &json!({"file_path": p("Projects/AERIS2/x")}), &ws);
        assert!(prefix.outside_workspace);
        let rel = classify_tool("Read", &json!({"file_path": "src/a.ts"}), &ws);
        assert!(!rel.outside_workspace);
    }

    #[test]
    fn mcp_and_inert_tools() {
        let m = classify_tool("mcp__roblox__run_code", &json!({}), &[]);
        assert_eq!(m.capability, Some(Capability::Mcp));
        assert_eq!(m.mcp_server.as_deref(), Some("roblox"));
        assert_eq!(classify_tool("TodoWrite", &json!({}), &[]).capability, None);
        assert!(classify_tool("SomethingNew", &json!({}), &[]).destructive);
    }
}
