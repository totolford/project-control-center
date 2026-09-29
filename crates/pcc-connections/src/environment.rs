//! Detection of project markers and installed tools. Read-only: nothing is installed.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use pcc_claude::process::std_command;
use pcc_core::{Detection, EnvironmentReport};

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".agent-project",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    "Packages",
    "packages",
    ".next",
    "bin",
    "obj",
];

/// Collected file names (lowercase) and extensions, scanning at most `max_depth` levels.
struct Scan {
    names: BTreeSet<String>,
    exts: BTreeSet<String>,
    project_json: bool,
}

fn scan(root: &Path, max_depth: usize) -> Scan {
    let mut s = Scan { names: BTreeSet::new(), exts: BTreeSet::new(), project_json: false };
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            visited += 1;
            if visited > 20_000 {
                return s;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if depth == 0 {
                    s.names.insert(format!("{lower}/"));
                }
                if depth < max_depth && !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push((e.path(), depth + 1));
                }
            } else {
                if depth == 0 {
                    s.names.insert(lower.clone());
                }
                if lower.ends_with(".project.json") {
                    s.project_json = true;
                }
                if let Some(ext) = Path::new(&lower).extension() {
                    s.exts.insert(ext.to_string_lossy().into_owned());
                }
            }
        }
    }
    s
}

fn det(key: &str, label: &str, detected: bool, detail: Option<String>) -> Detection {
    Detection { key: key.into(), label: label.into(), detected, detail }
}

/// Runs `<tool> <args>` and returns the first output line when it succeeds.
fn tool_version(tool: &str, args: &[&str]) -> Option<String> {
    let out = std_command(tool).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    String::from_utf8_lossy(&text).lines().next().map(|l| l.trim().to_string())
}

pub fn detect_project(root: &Path) -> (Vec<Detection>, Vec<String>) {
    let s = scan(root, 3);
    let has = |n: &str| s.names.contains(n);
    let ext = |e: &str| s.exts.contains(e);
    let rojo = has("default.project.json") || s.project_json;
    let roblox = rojo
        || ext("rbxl")
        || ext("rbxlx")
        || ext("rbxm")
        || has("wally.toml")
        || has("rokit.toml")
        || has("aftman.toml")
        || has("selene.toml");
    let lua = ext("lua") || ext("luau");
    let node = has("package.json");
    let rust = has("cargo.toml");
    let dotnet = ext("sln") || ext("csproj");
    let python = has("pyproject.toml") || has("requirements.txt") || has("setup.py");
    let docker = has("dockerfile")
        || has("docker-compose.yml")
        || has("docker-compose.yaml")
        || has("compose.yaml")
        || has("compose.yml");
    let go = has("go.mod");
    let items = vec![
        det("git", "Git repository", has(".git/") || has(".git"), None),
        det("readme", "README", has("readme.md") || has("readme.txt") || has("readme"), None),
        det("node", "Node.js (package.json)", node, None),
        det("rust", "Rust (Cargo.toml)", rust, None),
        det("dotnet", ".NET (*.sln / *.csproj)", dotnet, None),
        det("python", "Python", python, None),
        det("go", "Go (go.mod)", go, None),
        det("lua", "Lua / Luau sources", lua, None),
        det("rojo", "Rojo (*.project.json)", rojo, None),
        det("roblox", "Roblox project", roblox, None),
        det("rokit", "Rokit / Aftman toolchain", has("rokit.toml") || has("aftman.toml"), None),
        det("docker", "Docker", docker, None),
        det("claude_md", "CLAUDE.md", has("claude.md"), None),
    ];
    let mut types = Vec::new();
    for (flag, name) in [
        (roblox, "roblox"),
        (node, "node"),
        (rust, "rust"),
        (dotnet, "dotnet"),
        (python, "python"),
        (go, "go"),
        (docker, "docker"),
    ] {
        if flag {
            types.push(name.to_string());
        }
    }
    if types.is_empty() {
        types.push("generic".into());
    }
    (items, types)
}

pub fn detect_tools() -> Vec<Detection> {
    let probe = |key: &str, label: &str, tool: &str, args: &[&str]| {
        let v = tool_version(tool, args);
        det(key, label, v.is_some(), v)
    };
    vec![
        probe("git", "Git", "git", &["--version"]),
        probe("gh", "GitHub CLI", "gh", &["--version"]),
        probe("node", "Node.js", "node", &["--version"]),
        probe("ssh", "OpenSSH client", "ssh", &["-V"]),
        probe("docker", "Docker", "docker", &["--version"]),
        probe("rojo", "Rojo", "rojo", &["--version"]),
        probe("rokit", "Rokit", "rokit", &["--version"]),
        probe("pwsh", "PowerShell 7", "pwsh", &["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
    ]
}

/// Full report. Blocking (spawns a few processes); call from a blocking task.
pub fn detect_environment(root: &Path) -> EnvironmentReport {
    let (project, project_types) = detect_project(root);
    EnvironmentReport { project, tools: detect_tools(), project_types }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_roblox_rojo_project() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        fs::write(r.join("default.project.json"), "{}").unwrap();
        fs::write(r.join("rokit.toml"), "").unwrap();
        fs::create_dir_all(r.join("src/server")).unwrap();
        fs::write(r.join("src/server/Drone.server.luau"), "").unwrap();
        fs::create_dir_all(r.join("node_modules/x")).unwrap();
        fs::write(r.join("node_modules/x/package.json"), "").unwrap();
        let (items, types) = detect_project(r);
        let get = |k: &str| items.iter().find(|d| d.key == k).unwrap().detected;
        assert!(get("rojo") && get("roblox") && get("lua") && get("rokit"));
        assert!(!get("node"), "nested node_modules must not count");
        assert_eq!(types, vec!["roblox"]);
    }

    #[test]
    fn generic_when_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(detect_project(tmp.path()).1, vec!["generic"]);
    }
}
