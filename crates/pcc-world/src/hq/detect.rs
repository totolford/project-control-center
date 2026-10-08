//! Project domains detected from real facts (files, connections, MCP
//! servers): which rooms the building should have, and which rooms lost
//! their reason to exist.

use std::path::Path;

use serde::Serialize;

use super::config::WorldConfig;

/// What NEXUS knows besides the files.
#[derive(Debug, Clone, Default)]
pub struct ProjectFacts {
    /// `(kind, name)` of the project's connections, kind in snake_case (`ssh`, `mcp`, `roblox_studio`, `github`...).
    pub connections: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Domain {
    /// Room type.
    pub kind: String,
    /// The facts, e.g. "found .github/workflows/ci.yml".
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// `create` or `archive`.
    pub action: String,
    pub kind: String,
    /// Existing room (archive suggestions).
    pub room: Option<String>,
    pub reason: String,
}

const SKIP: &[&str] =
    &["node_modules", ".git", "target", ".agent-project", "dist", "build", ".venv", "venv", "__pycache__", ".next"];

/// Relative paths of files up to `depth` levels (bounded).
fn files(root: &Path, depth: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, d)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path();
            let rel = path.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            if is_dir {
                if d < depth && !SKIP.contains(&name.as_str()) {
                    stack.push((path, d + 1));
                }
                out.push(format!("{rel}/"));
            } else {
                out.push(rel);
            }
            if out.len() > 4000 {
                return out;
            }
        }
    }
    out
}

fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).map(|s| s.to_ascii_lowercase()).unwrap_or_default()
}

/// Domains of the project, each with the facts that show it.
pub fn detect(root: &Path, facts: &ProjectFacts) -> Vec<Domain> {
    let all = files(root, 3);
    let has = |pred: &dyn Fn(&str) -> bool| all.iter().find(|f| pred(f)).cloned();
    let manifests = format!(
        "{}\n{}\n{}\n{}",
        read(root, "package.json"),
        read(root, "Cargo.toml"),
        read(root, "requirements.txt"),
        read(root, "pyproject.toml")
    );
    let dep = |names: &[&str]| {
        names
            .iter()
            .find(|n| {
                manifests.contains(&format!("\"{n}\""))
                    || manifests.contains(&format!("\n{n} "))
                    || manifests.contains(&format!("\n{n}="))
            })
            .map(|n| n.to_string())
    };
    let conn = |kinds: &[&str]| {
        facts
            .connections
            .iter()
            .find(|(k, _)| kinds.contains(&k.as_str()))
            .map(|(k, n)| format!("{k} connection “{n}”"))
    };
    let mut out: Vec<Domain> = Vec::new();
    let mut add = |kind: &str, evidence: Vec<Option<String>>| {
        let ev: Vec<String> = evidence.into_iter().flatten().collect();
        if !ev.is_empty() {
            out.push(Domain { kind: kind.into(), evidence: ev });
        }
    };
    let found = |f: Option<String>| f.map(|f| format!("found {f}"));
    let dep_ev = |d: Option<String>| d.map(|d| format!("depends on {d}"));

    add(
        "web_dev",
        vec![
            dep_ev(dep(&["react", "vue", "svelte", "next", "nuxt", "astro", "@angular/core", "vite"])),
            found(has(&|f| f == "index.html" || f.ends_with("/index.html") && !f.contains("public/ai-town"))),
        ],
    );
    add(
        "api_lab",
        vec![
            dep_ev(dep(&[
                "express",
                "fastify",
                "koa",
                "@nestjs/core",
                "hono",
                "axum",
                "actix-web",
                "rocket",
                "flask",
                "fastapi",
                "django",
            ])),
            found(has(&|f| {
                f.ends_with("openapi.yaml")
                    || f.ends_with("openapi.json")
                    || f.ends_with("swagger.json")
                    || f == "api/"
                    || f.ends_with("/api/") && !f.contains("node_modules")
            })),
        ],
    );
    add(
        "database_room",
        vec![
            dep_ev(dep(&[
                "prisma",
                "@prisma/client",
                "pg",
                "mysql2",
                "sqlite3",
                "better-sqlite3",
                "mongoose",
                "mongodb",
                "typeorm",
                "sequelize",
                "drizzle-orm",
                "rusqlite",
                "sqlx",
                "diesel",
                "sqlalchemy",
                "psycopg2",
            ])),
            found(has(&|f| {
                f.ends_with(".sql") || f.ends_with("schema.prisma") || f == "migrations/" || f.ends_with("/migrations/")
            })),
        ],
    );
    add(
        "cicd_room",
        vec![found(has(&|f| {
            f.starts_with(".github/workflows/") && (f.ends_with(".yml") || f.ends_with(".yaml"))
                || f == ".gitlab-ci.yml"
                || f == "Jenkinsfile"
                || f == "azure-pipelines.yml"
                || f == ".circleci/"
        }))],
    );
    add(
        "roblox_studio",
        vec![
            found(has(&|f| {
                f == "default.project.json" || f.ends_with(".rbxl") || f.ends_with(".rbxlx") || f.ends_with(".luau")
            })),
            conn(&["roblox_studio"]),
        ],
    );
    add(
        "testing_lab",
        vec![
            dep_ev(dep(&["vitest", "jest", "mocha", "playwright", "@playwright/test", "cypress", "pytest"])),
            found(has(&|f| {
                f == "tests/"
                    || f == "test/"
                    || f.ends_with("/__tests__/")
                    || f.contains(".test.")
                    || f.contains(".spec.")
            })),
        ],
    );
    add("mcp_lab", vec![conn(&["mcp"]), found(has(&|f| f == ".mcp.json"))]);
    add(
        "server_room",
        vec![
            conn(&["ssh", "sftp", "docker"]),
            found(has(&|f| f == "Dockerfile" || f == "docker-compose.yml" || f == "compose.yaml")),
        ],
    );
    add("github_office", vec![found(has(&|f| f == ".git/")), conn(&["github", "gitlab"])]);
    add(
        "design_studio",
        vec![
            found(has(&|f| f.ends_with(".fig") || f == "design/" || f == "designs/")),
            dep_ev(dep(&["tailwindcss", "@figma/plugin-typings"])),
        ],
    );
    let docs = all.iter().filter(|f| f.starts_with("docs/") && f.ends_with(".md")).count();
    add("docs_room", vec![(docs >= 3).then(|| format!("{docs} Markdown files in docs/"))]);
    out
}

/// Rooms to create (domain without a room) and to archive (room of a domain
/// that is no longer detected; never persistent rooms nor rooms with agents).
pub fn suggestions(cfg: &WorldConfig, domains: &[Domain]) -> Vec<Suggestion> {
    let mut out = Vec::new();
    for d in domains {
        if !cfg.active_rooms().any(|r| r.kind == d.kind) {
            out.push(Suggestion {
                action: "create".into(),
                kind: d.kind.clone(),
                room: None,
                reason: d.evidence.join("; "),
            });
        }
    }
    let detected = |k: &str| domains.iter().any(|d| d.kind == k);
    for r in cfg.active_rooms() {
        let derived = matches!(
            r.kind.as_str(),
            "web_dev"
                | "api_lab"
                | "database_room"
                | "cicd_room"
                | "roblox_studio"
                | "testing_lab"
                | "mcp_lab"
                | "design_studio"
                | "docs_room"
        );
        if derived && !r.persistent && r.agents.is_empty() && !detected(&r.kind) {
            out.push(Suggestion {
                action: "archive".into(),
                kind: r.kind.clone(),
                room: Some(r.id.clone()),
                reason: "the project no longer shows this domain (files, dependencies or connections)".into(),
            });
        }
        if r.temporary && r.agents.is_empty() {
            out.push(Suggestion {
                action: "archive".into(),
                kind: r.kind.clone(),
                room: Some(r.id.clone()),
                reason: "temporary room with no agent assigned".into(),
            });
        }
    }
    out
}

/// The building of a new project: NEXUS HQ, Coding Office, GitHub Office,
/// Server Room, Skill Shop, Review Room, then one room per detected domain.
pub fn default_world(domains: &[Domain], language: &str, locale: &str) -> WorldConfig {
    use super::config::Room;
    let mut cfg = WorldConfig { language: language.into(), locale: locale.into(), ..Default::default() };
    for k in ["central_hq", "coding_office", "github_office", "server_room", "skill_shop", "review_room"] {
        cfg.rooms.push(Room::of_kind(k, locale));
    }
    for d in domains {
        if !cfg.rooms.iter().any(|r| r.kind == d.kind) {
            let mut r = Room::of_kind(&d.kind, locale);
            r.purpose = format!("{} ({})", r.purpose, d.evidence.join("; ")).chars().take(200).collect();
            cfg.rooms.push(r);
        }
    }
    cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_come_from_real_files_and_connections() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"react":"19","express":"5","prisma":"6"},"devDependencies":{"vitest":"3"}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        std::fs::write(root.join(".github/workflows/ci.yml"), "on: push").unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("node_modules/x/a.sql"), "").unwrap();
        let facts = ProjectFacts { connections: vec![("ssh".into(), "pi".into()), ("mcp".into(), "Figma".into())] };
        let d = detect(root, &facts);
        let kinds: Vec<&str> = d.iter().map(|d| d.kind.as_str()).collect();
        for k in ["web_dev", "api_lab", "database_room", "cicd_room", "testing_lab", "mcp_lab", "server_room"] {
            assert!(kinds.contains(&k), "{k} in {kinds:?}");
        }
        assert!(!kinds.contains(&"roblox_studio"));
        let ci = d.iter().find(|d| d.kind == "cicd_room").unwrap();
        assert_eq!(ci.evidence, vec!["found .github/workflows/ci.yml".to_string()]);

        let cfg = default_world(&d, "auto", "en");
        assert!(cfg.rooms.iter().any(|r| r.kind == "database_room"));
        assert_eq!(cfg.rooms.iter().filter(|r| r.kind == "server_room").count(), 1);
        assert!(suggestions(&cfg, &d).is_empty());
        // The database disappears: archive suggested; a Roblox project appears: create suggested.
        let fewer: Vec<Domain> = d.iter().filter(|x| x.kind != "database_room").cloned().collect();
        let mut more = fewer.clone();
        more.push(Domain { kind: "roblox_studio".into(), evidence: vec!["found default.project.json".into()] });
        let s = suggestions(&cfg, &more);
        assert!(s.iter().any(|s| s.action == "archive" && s.kind == "database_room"));
        assert!(s.iter().any(|s| s.action == "create" && s.kind == "roblox_studio"));
    }

    #[test]
    fn an_empty_project_gets_the_base_building() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = default_world(&detect(tmp.path(), &ProjectFacts::default()), "auto", "fr");
        assert_eq!(cfg.rooms.len(), 6);
        assert_eq!(cfg.rooms[0].name, "QG NEXUS");
    }
}
