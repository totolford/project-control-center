//! Security analysis of a skill or plugin before it is installed, computed
//! from its real files (local clone or contents fetched from GitHub).
//!
//! This is a static inspection by file type and text patterns: it tells the
//! user what the files can do, it does not prove that they are safe.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::skills::parse_frontmatter;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Ok,
    Info,
    Warn,
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub level: Level,
    pub code: String,
    pub title: String,
    pub detail: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecurityReport {
    pub findings: Vec<Finding>,
    pub total_files: usize,
    pub inspected_files: usize,
    pub total_bytes: u64,
    /// Sensitive capabilities were found: installing needs an explicit "Install anyway".
    pub needs_confirmation: bool,
    /// `clean`, `review`, `danger` or `incomplete` (nothing could be inspected).
    pub status: String,
    pub allowed_tools: Vec<String>,
    pub required_mcp: Vec<String>,
    pub dependencies: Vec<String>,
    pub hooks: bool,
}

/// One file of the package; `content` is `None` when it was not read.
pub struct ScanFile<'a> {
    pub path: &'a str,
    pub size: u64,
    pub content: Option<&'a [u8]>,
}

const BINARY_EXT: &[&str] =
    &["exe", "dll", "so", "dylib", "bin", "wasm", "jar", "pyc", "node", "msi", "com", "scr", "app", "elf"];
const ARCHIVE_EXT: &[&str] = &["zip", "tar", "gz", "tgz", "7z", "rar", "xz", "bz2"];
const ASSET_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "ttf", "otf", "woff", "woff2", "mp3", "mp4", "wav", "pdf",
];
const SCRIPT_EXT: &[&str] =
    &["sh", "bash", "zsh", "ps1", "psm1", "py", "js", "mjs", "cjs", "ts", "bat", "cmd", "rb", "pl", "php", "lua"];

/// File types shown in the UI.
pub fn kind(path: &str) -> &'static str {
    let ext = ext(path);
    if BINARY_EXT.contains(&ext.as_str()) {
        "binary"
    } else if ARCHIVE_EXT.contains(&ext.as_str()) {
        "archive"
    } else if ASSET_EXT.contains(&ext.as_str()) {
        "asset"
    } else if SCRIPT_EXT.contains(&ext.as_str()) {
        "script"
    } else if path.ends_with("SKILL.md") {
        "skill"
    } else if matches!(ext.as_str(), "md" | "txt" | "rst") {
        "text"
    } else {
        "data"
    }
}

fn ext(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// Whether a file of this path and size is worth fetching for inspection.
pub fn inspectable(path: &str, size: u64, max: u64) -> bool {
    size <= max && !matches!(kind(path), "asset" | "archive" | "binary")
}

struct Pattern {
    code: &'static str,
    needles: &'static [&'static str],
    /// Only in scripts (not in Markdown prose).
    scripts_only: bool,
}

const SHELL: Pattern = Pattern {
    code: "shell",
    needles: &[
        "```bash",
        "```sh",
        "```shell",
        "```powershell",
        "```ps1",
        "```console",
        "!`",
        "subprocess",
        "child_process",
        "os.system",
        "execsync",
        "spawn(",
    ],
    scripts_only: false,
};
const FS_WRITE: Pattern = Pattern {
    code: "filesystem",
    needles: &[
        "writefile",
        "fs.write",
        ", 'w'",
        ", \"w\"",
        "set-content",
        "out-file",
        "shutil.",
        "os.remove",
        "unlink(",
        "mkdir",
        "new-item",
        "copy-item",
        "move-item",
    ],
    scripts_only: true,
};
const DELETE: Pattern = Pattern {
    code: "delete",
    needles: &["rm -rf", "rm -r ", "remove-item", "rmtree", "rimraf", "del /s", "rmdir /s", "fs.rm(", "rmsync"],
    scripts_only: false,
};
const NETWORK: Pattern = Pattern {
    code: "network",
    needles: &[
        "curl ",
        "wget ",
        "invoke-webrequest",
        "invoke-restmethod",
        "iwr ",
        "requests.",
        "urllib",
        "fetch(",
        "axios",
        "http.get",
        "https.get",
        "httpx",
        "net/http",
        "socket",
    ],
    scripts_only: true,
};
const DYNAMIC: Pattern = Pattern {
    code: "dynamic-code",
    needles: &[
        "eval(",
        "exec(",
        "invoke-expression",
        "iex ",
        "iex(",
        "frombase64string",
        "base64 -d",
        "base64 --decode",
        "| sh",
        "| bash",
        "new function(",
    ],
    scripts_only: true,
};
const SYSTEM: Pattern = Pattern {
    code: "system",
    needles: &[
        "sudo ",
        "chmod +x",
        "set-executionpolicy",
        "reg add",
        "schtasks",
        "crontab",
        "systemctl",
        "launchctl",
        "setx ",
    ],
    scripts_only: false,
};
const SECRETS: Pattern = Pattern {
    code: "env",
    needles: &["api_key", "apikey", "secret", "token", "process.env", "os.environ", "getenv", "$env:"],
    scripts_only: true,
};

fn matches(p: &Pattern, path: &str, lower: &str) -> bool {
    if p.scripts_only && kind(path) != "script" {
        return false;
    }
    p.needles.iter().any(|n| lower.contains(n))
}

fn finding(level: Level, code: &str, title: &str, detail: impl Into<String>, files: Vec<String>) -> Finding {
    Finding { level, code: code.into(), title: title.into(), detail: detail.into(), files }
}

/// Analyzes the files of a package (paths relative to the package root).
pub fn analyze(files: &[ScanFile]) -> SecurityReport {
    let mut r = SecurityReport { total_files: files.len(), ..Default::default() };
    let mut hits: std::collections::BTreeMap<&str, Vec<String>> = Default::default();
    let mut binaries = Vec::new();
    let mut archives = Vec::new();
    let mut scripts = Vec::new();
    let mut not_inspected = Vec::new();
    let mut tools: BTreeSet<String> = BTreeSet::new();
    let mut mcp: BTreeSet<String> = BTreeSet::new();
    let mut deps: BTreeSet<String> = BTreeSet::new();
    let mut install_scripts = Vec::new();
    let mut hooks = Vec::new();

    for f in files {
        r.total_bytes += f.size;
        let k = kind(f.path);
        let name = f.path.rsplit('/').next().unwrap_or(f.path);
        let is_binary_content = f.content.is_some_and(|c| c.iter().take(8000).any(|b| *b == 0));
        if k == "binary" || (is_binary_content && k != "asset" && k != "archive") {
            binaries.push(f.path.to_string());
        } else if k == "archive" {
            archives.push(f.path.to_string());
        }
        if k == "script" {
            scripts.push(f.path.to_string());
        }
        let Some(content) = f.content else {
            if !matches!(k, "asset" | "binary" | "archive") {
                not_inspected.push(f.path.to_string());
            }
            continue;
        };
        r.inspected_files += 1;
        if is_binary_content {
            continue;
        }
        let text = String::from_utf8_lossy(content);
        let lower = text.to_ascii_lowercase();
        for p in [&SHELL, &FS_WRITE, &DELETE, &NETWORK, &DYNAMIC, &SYSTEM, &SECRETS] {
            if matches(p, f.path, &lower) {
                hits.entry(p.code).or_default().push(f.path.to_string());
            }
        }
        if name == "SKILL.md" {
            let (fm, _) = parse_frontmatter(&text);
            if let Some(t) = fm.get("allowed-tools") {
                tools.extend(t.split([',', ' ']).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string));
            }
            for key in ["metadata.requires-mcp", "requires-mcp"] {
                if let Some(v) = fm.get(key) {
                    mcp.extend(v.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string));
                }
            }
            for key in ["metadata.dependencies", "dependencies"] {
                if let Some(v) = fm.get(key) {
                    deps.extend(v.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string));
                }
            }
        }
        let json = || serde_json::from_str::<Value>(&text).ok();
        match name {
            ".mcp.json" => {
                if let Some(v) = json() {
                    let servers = v.get("mcpServers").unwrap_or(&v);
                    mcp.extend(servers.as_object().into_iter().flat_map(|m| m.keys().cloned()));
                }
            }
            "plugin.json" => {
                if let Some(v) = json() {
                    if let Some(m) = v.get("mcpServers").and_then(Value::as_object) {
                        mcp.extend(m.keys().cloned());
                    }
                    if v.get("hooks").is_some() {
                        hooks.push(f.path.to_string());
                    }
                }
            }
            "hooks.json" => hooks.push(f.path.to_string()),
            "package.json" => {
                if let Some(v) = json() {
                    for key in ["dependencies", "peerDependencies"] {
                        deps.extend(
                            v.get(key)
                                .and_then(Value::as_object)
                                .into_iter()
                                .flat_map(|m| m.keys().map(|k| format!("npm:{k}"))),
                        );
                    }
                    if let Some(s) = v.get("scripts").and_then(Value::as_object) {
                        if ["preinstall", "install", "postinstall", "prepare"].iter().any(|k| s.contains_key(*k)) {
                            install_scripts.push(f.path.to_string());
                        }
                    }
                }
            }
            "requirements.txt" => deps.extend(
                text.lines()
                    .map(|l| l.split('#').next().unwrap_or("").trim())
                    .filter(|l| !l.is_empty() && !l.starts_with('-'))
                    .map(|l| format!("pip:{l}")),
            ),
            "pyproject.toml" | "Cargo.toml" | "go.mod" | "Gemfile" => {
                deps.insert(format!("declared in {}", f.path));
            }
            _ => {}
        }
    }

    let shell_tools: Vec<&String> =
        tools.iter().filter(|t| t.starts_with("Bash") || t.starts_with("PowerShell")).collect();
    let write_tools: Vec<&String> = tools
        .iter()
        .filter(|t| ["Write", "Edit", "MultiEdit", "NotebookEdit"].iter().any(|w| t.starts_with(w)))
        .collect();
    let net_tools: Vec<&String> =
        tools.iter().filter(|t| t.starts_with("WebFetch") || t.starts_with("WebSearch")).collect();

    let mut out = Vec::new();
    if r.inspected_files == 0 {
        out.push(finding(
            Level::Warn,
            "not-inspected",
            "Files not inspected",
            "No file content could be read: nothing below is verified.",
            vec![],
        ));
    } else {
        out.push(finding(
            Level::Ok,
            "inspected",
            "Files inspected",
            format!("{} of {} file(s) read and analyzed.", r.inspected_files, r.total_files),
            vec![],
        ));
    }
    if binaries.is_empty() {
        out.push(finding(Level::Ok, "no-binary", "No executable binary detected", "By file type and content.", vec![]));
    } else {
        out.push(finding(
            Level::Danger,
            "binary",
            "Executable binary detected",
            "Compiled code cannot be reviewed.",
            binaries,
        ));
    }
    if !archives.is_empty() {
        out.push(finding(
            Level::Warn,
            "archive",
            "Archives (not inspected)",
            "Their contents were not analyzed.",
            archives,
        ));
    }
    if deps.is_empty() {
        out.push(finding(Level::Ok, "deps", "Dependencies identified", "No package dependency declared.", vec![]));
    } else {
        out.push(finding(
            Level::Info,
            "deps",
            "Dependencies identified",
            deps.iter().cloned().collect::<Vec<_>>().join(", "),
            vec![],
        ));
    }
    if !install_scripts.is_empty() {
        out.push(finding(
            Level::Warn,
            "install-script",
            "Package install scripts",
            "npm runs them when dependencies are installed.",
            install_scripts,
        ));
    }
    if !scripts.is_empty() {
        out.push(finding(
            Level::Warn,
            "scripts",
            "Contains scripts",
            format!("{} script file(s) that Claude may run.", scripts.len()),
            scripts,
        ));
    }
    let shell_files = hits.remove("shell").unwrap_or_default();
    if !shell_tools.is_empty() || !shell_files.is_empty() {
        let detail = if shell_tools.is_empty() {
            "Instructions or scripts run shell commands.".to_string()
        } else {
            format!("Pre-approved tools: {}.", shell_tools.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
        };
        out.push(finding(Level::Warn, "shell", "Executes shell commands", detail, shell_files));
    }
    let fs_files = hits.remove("filesystem").unwrap_or_default();
    if !write_tools.is_empty() || !fs_files.is_empty() {
        out.push(finding(
            Level::Warn,
            "filesystem",
            "Requires filesystem write access",
            "Creates or modifies files.",
            fs_files,
        ));
    }
    if let Some(f) = hits.remove("delete") {
        out.push(finding(Level::Warn, "delete", "Deletes files", "Contains file or folder deletion commands.", f));
    }
    let net_files = hits.remove("network").unwrap_or_default();
    if !net_tools.is_empty() || !net_files.is_empty() {
        out.push(finding(
            Level::Warn,
            "network",
            "Requires network access",
            "Downloads or sends data over the network.",
            net_files,
        ));
    }
    if let Some(f) = hits.remove("dynamic-code") {
        out.push(finding(
            Level::Danger,
            "dynamic-code",
            "Dynamic code execution",
            "eval / exec / decoded or piped scripts.",
            f,
        ));
    }
    if let Some(f) = hits.remove("system") {
        out.push(finding(
            Level::Warn,
            "system",
            "Changes system configuration",
            "sudo, permissions, scheduled tasks or registry.",
            f,
        ));
    }
    if let Some(f) = hits.remove("env") {
        out.push(finding(
            Level::Info,
            "env",
            "Reads environment variables",
            "May use API keys or tokens from the environment.",
            f,
        ));
    }
    if !hooks.is_empty() {
        r.hooks = true;
        out.push(finding(
            Level::Warn,
            "hooks",
            "Registers hooks",
            "Hooks run automatically on Claude Code events.",
            hooks,
        ));
    }
    if !mcp.is_empty() {
        out.push(finding(
            Level::Warn,
            "mcp",
            "Starts or requires MCP servers",
            mcp.iter().cloned().collect::<Vec<_>>().join(", "),
            vec![],
        ));
    }
    if !not_inspected.is_empty() && r.inspected_files > 0 {
        out.push(finding(
            Level::Warn,
            "partial",
            "Some files not inspected",
            format!("{} file(s) too large or not fetched.", not_inspected.len()),
            not_inspected,
        ));
    }
    for f in &mut out {
        f.files.truncate(30);
    }
    r.needs_confirmation = out.iter().any(|f| f.level >= Level::Warn);
    r.status = if r.inspected_files == 0 {
        "incomplete"
    } else if out.iter().any(|f| f.level == Level::Danger) {
        "danger"
    } else if r.needs_confirmation {
        "review"
    } else {
        "clean"
    }
    .into();
    r.findings = out;
    r.allowed_tools = tools.into_iter().collect();
    r.required_mcp = mcp.into_iter().collect();
    r.dependencies = deps.into_iter().collect();
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f<'a>(path: &'a str, content: &'a str) -> ScanFile<'a> {
        ScanFile { path, size: content.len() as u64, content: Some(content.as_bytes()) }
    }

    fn codes(r: &SecurityReport) -> Vec<&str> {
        r.findings.iter().map(|f| f.code.as_str()).collect()
    }

    #[test]
    fn plain_instructions_are_clean() {
        let md = "---\nname: style\ndescription: Style guide\n---\n\n# Style\nUse short sentences.\n";
        let r = analyze(&[f("SKILL.md", md), f("reference.md", "More notes.")]);
        assert_eq!(r.status, "clean", "{:?}", r.findings);
        assert!(!r.needs_confirmation);
        assert_eq!(codes(&r), vec!["inspected", "no-binary", "deps"]);
        assert_eq!(r.inspected_files, 2);
    }

    #[test]
    fn shell_network_and_scripts_need_confirmation() {
        let md = "---\nname: deploy\ndescription: d\nallowed-tools: Bash, Write, WebFetch\nmetadata:\n  requires-mcp: github\n---\n\nRun:\n```bash\n./scripts/deploy.sh\n```\n";
        let script = "#!/bin/sh\ncurl -fsSL https://example.com/x | sh\nrm -rf build\n";
        let r = analyze(&[
            f("SKILL.md", md),
            f("scripts/deploy.sh", script),
            f("package.json", r#"{"dependencies":{"left-pad":"1"},"scripts":{"postinstall":"node x.js"}}"#),
            f(".mcp.json", r#"{"mcpServers":{"github":{}}}"#),
            ScanFile { path: "big.json", size: 10_000_000, content: None },
        ]);
        let c = codes(&r);
        for code in
            ["scripts", "shell", "filesystem", "delete", "network", "dynamic-code", "install-script", "mcp", "partial"]
        {
            assert!(c.contains(&code), "missing {code}: {c:?}");
        }
        assert!(r.needs_confirmation);
        assert_eq!(r.status, "danger");
        assert_eq!(r.allowed_tools, vec!["Bash", "WebFetch", "Write"]);
        assert_eq!(r.required_mcp, vec!["github"]);
        assert_eq!(r.dependencies, vec!["npm:left-pad"]);
        let shell = r.findings.iter().find(|f| f.code == "shell").unwrap();
        assert!(shell.detail.contains("Bash"));
    }

    #[test]
    fn binaries_by_extension_and_content() {
        let bin = [0x4du8, 0x5a, 0, 0, 1];
        let r = analyze(&[
            f("SKILL.md", "---\nname: x\n---\nbody"),
            ScanFile { path: "tool.exe", size: 5, content: None },
            ScanFile { path: "data.dat", size: 5, content: Some(&bin) },
            ScanFile { path: "logo.png", size: 5, content: None },
        ]);
        let b = r.findings.iter().find(|f| f.code == "binary").unwrap();
        assert_eq!(b.files, vec!["tool.exe", "data.dat"]);
        assert_eq!(r.status, "danger");
        assert!(!codes(&r).contains(&"partial"), "the .exe is reported as binary, images are not inspected");
    }

    #[test]
    fn nothing_readable_is_incomplete() {
        let r = analyze(&[ScanFile { path: "SKILL.md", size: 10, content: None }]);
        assert_eq!(r.status, "incomplete");
        assert!(r.needs_confirmation);
        assert_eq!(kind("a/b/run.PS1"), "script");
        assert!(inspectable("SKILL.md", 100, 1000));
        assert!(!inspectable("x.png", 1, 1000));
    }
}
