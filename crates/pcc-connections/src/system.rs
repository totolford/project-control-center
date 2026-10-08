//! Machine and project inspection for the Environment Inspector.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use pcc_claude::process::std_command;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemReport {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu: String,
    pub cpu_cores: usize,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
    pub gpus: Vec<String>,
    pub disks: Vec<DiskInfo>,
}

pub fn system_report() -> SystemReport {
    use sysinfo::{Disks, System};
    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let cpu = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    let os = System::name().unwrap_or_else(|| std::env::consts::OS.into());
    // `long_os_version` repeats the name ("Windows 11 Pro"); keep only the version part.
    let long = System::long_os_version().or_else(System::os_version).unwrap_or_default();
    let os_version = long.strip_prefix(&os).map(|v| v.trim().to_string()).unwrap_or(long);
    SystemReport {
        os,
        os_version,
        arch: std::env::consts::ARCH.into(),
        cpu,
        cpu_cores: sys.cpus().len(),
        memory_total_bytes: sys.total_memory(),
        memory_used_bytes: sys.used_memory(),
        gpus: gpus(),
        disks: Disks::new_with_refreshed_list()
            .list()
            .iter()
            .map(|d| DiskInfo {
                mount: d.mount_point().to_string_lossy().into_owned(),
                total_bytes: d.total_space(),
                available_bytes: d.available_space(),
            })
            .collect(),
    }
}

fn gpus() -> Vec<String> {
    #[cfg(windows)]
    {
        let out = std_command("powershell")
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"])
            .output();
        if let Ok(o) = out {
            return String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect();
        }
    }
    #[cfg(not(windows))]
    {
        // `lspci -mm`: slot "class" "vendor" "device" …
        if let Ok(o) = std_command("lspci").arg("-mm").output() {
            return gpus_from_lspci(&String::from_utf8_lossy(&o.stdout));
        }
    }
    vec![]
}

/// Display controllers from `lspci -mm` output.
pub fn gpus_from_lspci(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let q: Vec<&str> = l.split('"').skip(1).step_by(2).collect();
            match q.as_slice() {
                [class, vendor, device, ..]
                    if class.contains("VGA") || class.contains("3D") || class.contains("Display") =>
                {
                    Some(format!("{vendor} {device}"))
                }
                _ => None,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanguageShare {
    pub language: String,
    pub files: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInsights {
    pub languages: Vec<LanguageShare>,
    pub frameworks: Vec<String>,
    /// Direct dependencies by manifest (`package.json`, `Cargo.toml`, ...).
    pub dependencies: BTreeMap<String, Vec<String>>,
    pub files_scanned: usize,
}

fn language_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "ts" | "tsx" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "rs" => "Rust",
        "lua" | "luau" => "Lua / Luau",
        "py" => "Python",
        "cs" => "C#",
        "go" => "Go",
        "java" | "kt" => "Java / Kotlin",
        "cpp" | "cc" | "c" | "h" | "hpp" => "C / C++",
        "rb" => "Ruby",
        "php" => "PHP",
        "swift" => "Swift",
        "ps1" | "psm1" => "PowerShell",
        "sh" | "bash" => "Shell",
        "html" | "htm" => "HTML",
        "css" | "scss" | "less" => "CSS",
        "sql" => "SQL",
        "gd" => "GDScript",
        _ => return None,
    })
}

const SKIP: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    ".agent-project",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    "Packages",
    ".next",
    "bin",
    "obj",
];

/// Counts source files per language (bounded scan) and reads manifests.
pub fn project_insights(root: &Path) -> ProjectInsights {
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut scanned = 0usize;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            scanned += 1;
            if scanned > 50_000 {
                break;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            if path.is_dir() {
                if depth < 8 && !SKIP.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push((path, depth + 1));
                }
            } else if let Some(lang) =
                path.extension().and_then(|x| x.to_str()).map(str::to_ascii_lowercase).and_then(|x| language_of(&x))
            {
                *counts.entry(lang).or_default() += 1;
            }
        }
    }
    let mut languages: Vec<LanguageShare> =
        counts.into_iter().map(|(l, n)| LanguageShare { language: l.into(), files: n }).collect();
    languages.sort_by_key(|l| std::cmp::Reverse(l.files));

    let mut dependencies = BTreeMap::new();
    let mut frameworks = Vec::new();
    if let Some(pkg) =
        fs::read_to_string(root.join("package.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
    {
        let mut deps: Vec<String> = ["dependencies", "devDependencies"]
            .iter()
            .filter_map(|k| pkg.get(*k).and_then(Value::as_object))
            .flat_map(|o| o.keys().cloned())
            .collect();
        deps.sort();
        for (dep, fw) in [
            ("react", "React"),
            ("next", "Next.js"),
            ("vue", "Vue"),
            ("svelte", "Svelte"),
            ("@angular/core", "Angular"),
            ("express", "Express"),
            ("@tauri-apps/api", "Tauri"),
            ("electron", "Electron"),
            ("vite", "Vite"),
            ("tailwindcss", "Tailwind CSS"),
            ("@nestjs/core", "NestJS"),
            ("vitest", "Vitest"),
            ("jest", "Jest"),
        ] {
            if deps.iter().any(|d| d == dep) {
                frameworks.push(fw.to_string());
            }
        }
        dependencies.insert("package.json".into(), deps);
    }
    if let Ok(cargo) = fs::read_to_string(root.join("Cargo.toml")) {
        let deps = toml_section_keys(&cargo, &["dependencies", "workspace.dependencies"]);
        for (dep, fw) in
            [("tauri", "Tauri"), ("tokio", "Tokio"), ("axum", "Axum"), ("actix-web", "Actix"), ("bevy", "Bevy")]
        {
            if deps.iter().any(|d| d == dep) && !frameworks.iter().any(|f| f == fw) {
                frameworks.push(fw.to_string());
            }
        }
        dependencies.insert("Cargo.toml".into(), deps);
    }
    if root.join("default.project.json").is_file() {
        frameworks.push("Rojo".into());
    }
    if let Ok(req) = fs::read_to_string(root.join("requirements.txt")) {
        let deps: Vec<String> = req
            .lines()
            .map(|l| l.split(['=', '<', '>', '~', ';', '[']).next().unwrap_or("").trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect();
        for (dep, fw) in [("django", "Django"), ("flask", "Flask"), ("fastapi", "FastAPI")] {
            if deps.iter().any(|d| d.eq_ignore_ascii_case(dep)) {
                frameworks.push(fw.to_string());
            }
        }
        dependencies.insert("requirements.txt".into(), deps);
    }
    ProjectInsights { languages, frameworks, dependencies, files_scanned: scanned }
}

/// Keys of `[section]` tables in a TOML file (enough for dependency names).
fn toml_section_keys(text: &str, sections: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut active = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            active = sections.iter().any(|s| l == format!("[{s}]"));
            continue;
        }
        if active {
            if let Some((k, _)) = l.split_once('=') {
                let k = k.trim().trim_matches('"');
                if !k.is_empty() && !k.starts_with('#') {
                    out.push(k.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpus_from_lspci_machine_output() {
        let t = "00:02.0 \"VGA compatible controller\" \"Intel Corporation\" \"Iris Xe\" -r0c \"Dell\" \"x\"\n\
                 00:14.0 \"USB controller\" \"Intel Corporation\" \"USB 3.2\"\n\
                 01:00.0 \"3D controller\" \"NVIDIA Corporation\" \"AD107M\"\n";
        assert_eq!(gpus_from_lspci(t), ["Intel Corporation Iris Xe", "NVIDIA Corporation AD107M"]);
    }

    #[test]
    fn insights_from_manifests() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        fs::write(r.join("package.json"), r#"{"dependencies":{"react":"19"},"devDependencies":{"vite":"8"}}"#).unwrap();
        fs::write(
            r.join("Cargo.toml"),
            "[package]\nname=\"x\"\n[dependencies]\ntokio = \"1\"\nserde = { version = \"1\" }\n",
        )
        .unwrap();
        fs::create_dir_all(r.join("src")).unwrap();
        fs::write(r.join("src/a.ts"), "").unwrap();
        fs::write(r.join("src/b.ts"), "").unwrap();
        fs::write(r.join("src/c.rs"), "").unwrap();
        fs::create_dir_all(r.join("node_modules/x")).unwrap();
        fs::write(r.join("node_modules/x/i.js"), "").unwrap();
        let p = project_insights(r);
        assert_eq!(p.languages[0], LanguageShare { language: "TypeScript".into(), files: 2 });
        assert!(!p.languages.iter().any(|l| l.language == "JavaScript"), "node_modules skipped");
        assert_eq!(p.frameworks, vec!["React", "Vite", "Tokio"]);
        assert_eq!(p.dependencies["Cargo.toml"], vec!["serde", "tokio"]);
    }

    #[test]
    fn system_report_has_basics() {
        let s = system_report();
        assert!(s.cpu_cores > 0);
        assert!(s.memory_total_bytes > 0);
        assert!(!s.disks.is_empty());
    }
}
