//! Claude Code skills on disk.
//!
//! * user:    `~/.claude/skills/<name>/SKILL.md` (also synced claude.ai skills below it)
//! * project: `<project>/.claude/skills/<name>/SKILL.md`
//! * plugin:  `SKILL.md` files inside installed plugins (managed by the plugin)
//!
//! Claude Code has no per-skill on/off switch, so disabling a user or project
//! skill moves its folder to a sibling `skills-disabled/` directory, which
//! Claude Code does not read; enabling moves it back. Plugin skills are
//! enabled or disabled with their plugin. Deleted skills go to `skills-trash/`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use pcc_core::{Error, Result};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    User,
    Project,
    Plugin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// Stable id: `<scope>:<folder path>`.
    pub id: String,
    pub name: String,
    pub description: String,
    pub scope: SkillScope,
    /// Plugin id for plugin skills, `synced` for claude.ai synced skills.
    pub source: Option<String>,
    pub enabled: bool,
    /// Can be edited, disabled and deleted from NEXUS.
    pub editable: bool,
    pub dir: String,
    pub frontmatter: BTreeMap<String, String>,
    pub allowed_tools: Vec<String>,
    pub files: Vec<String>,
    /// Problems found in SKILL.md.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewSkill {
    pub name: String,
    pub description: String,
    /// When Claude should use it (added to the description).
    pub trigger: String,
    pub instructions: String,
    pub allowed_tools: Vec<String>,
    pub argument_hint: String,
    /// Requirements recorded as metadata (NEXUS shows them; Claude ignores unknown keys).
    pub required_mcp: Vec<String>,
    pub required_connections: Vec<String>,
    pub required_permissions: Vec<String>,
    pub dependencies: Vec<String>,
}

pub struct SkillRoots {
    pub user: Option<PathBuf>,
    pub project: Option<PathBuf>,
    /// (plugin id, install path, enabled)
    pub plugins: Vec<(String, PathBuf, bool)>,
}

impl SkillRoots {
    /// `plugins` is the output of `claude plugin list --json`.
    pub fn new(project_root: Option<&Path>, plugins: &[Value]) -> SkillRoots {
        let home = pcc_platform::platform().home_dir();
        SkillRoots {
            user: home.map(|h| h.join(".claude").join("skills")),
            project: project_root.map(|p| p.join(".claude").join("skills")),
            plugins: plugins
                .iter()
                .filter_map(|p| {
                    Some((
                        p.get("id")?.as_str()?.to_string(),
                        PathBuf::from(p.get("installPath")?.as_str()?),
                        p.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                    ))
                })
                .collect(),
        }
    }

    fn root(&self, scope: SkillScope) -> Result<&PathBuf> {
        match scope {
            SkillScope::User => self.user.as_ref(),
            SkillScope::Project => self.project.as_ref(),
            SkillScope::Plugin => None,
        }
        .ok_or_else(|| Error::invalid("this skill location is not available"))
    }
}

fn disabled_dir(root: &Path) -> PathBuf {
    root.with_file_name("skills-disabled")
}

fn trash_dir(root: &Path) -> PathBuf {
    root.with_file_name("skills-trash")
}

/// Parses YAML-like frontmatter (`key: value`, nested blocks flattened as `parent.key`).
pub fn parse_frontmatter(text: &str) -> (BTreeMap<String, String>, String) {
    let mut map = BTreeMap::new();
    let Some(rest) = text.strip_prefix("---") else {
        return (map, text.to_string());
    };
    let Some(end) = rest.find("\n---") else {
        return (map, text.to_string());
    };
    let (head, body) = (&rest[..end], &rest[end + 4..]);
    let mut parent: Option<String> = None;
    for line in head.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let l = line.trim();
        if let Some(item) = l.strip_prefix("- ") {
            if let Some(p) = &parent {
                let e = map.entry(p.clone()).or_insert_with(String::new);
                if !e.is_empty() {
                    e.push_str(", ");
                }
                e.push_str(item.trim().trim_matches('"'));
            }
            continue;
        }
        let Some((k, v)) = l.split_once(':') else { continue };
        let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
        if indented {
            if let Some(p) = &parent {
                map.insert(format!("{p}.{}", k.trim()), v);
            }
        } else {
            parent = Some(k.trim().to_string());
            if !v.is_empty() {
                map.insert(k.trim().to_string(), v);
            }
        }
    }
    (map, body.trim_start_matches(['\r', '\n']).to_string())
}

fn list_files(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(rel) = p.strip_prefix(dir) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
            if out.len() > 200 {
                return out;
            }
        }
    }
    out.sort();
    out
}

fn load(dir: &Path, scope: SkillScope, source: Option<String>, enabled: bool, editable: bool) -> Option<Skill> {
    let text = fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (fm, body) = parse_frontmatter(&text);
    let mut problems = Vec::new();
    let folder = dir.file_name()?.to_string_lossy().into_owned();
    let name = fm.get("name").cloned().unwrap_or_else(|| {
        problems.push("missing `name` in frontmatter".into());
        folder.clone()
    });
    let description = fm.get("description").cloned().unwrap_or_else(|| {
        problems.push("missing `description`: Claude cannot know when to use it".into());
        String::new()
    });
    if body.trim().is_empty() {
        problems.push("SKILL.md has no instructions".into());
    }
    if let Err(e) = validate_name(&name) {
        problems.push(e.to_string());
    }
    let allowed_tools = fm
        .get("allowed-tools")
        .map(|t| t.split([',', ' ']).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    Some(Skill {
        id: format!("{}:{}", serde_json::to_value(scope).ok()?.as_str()?, dir.to_string_lossy()),
        name,
        description,
        scope,
        source,
        enabled,
        editable,
        dir: dir.to_string_lossy().into_owned(),
        frontmatter: fm,
        allowed_tools,
        files: list_files(dir),
        problems,
    })
}

/// Folders containing a SKILL.md, up to `depth` levels below `root`.
fn skill_dirs(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0)];
    while let Some((d, level)) = stack.pop() {
        if d.join("SKILL.md").is_file() && d != root {
            out.push(d);
            continue;
        }
        if level >= depth {
            continue;
        }
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir()
                && !matches!(name.as_str(), "node_modules" | ".git" | "skills-disabled" | "skills-trash")
            {
                stack.push((e.path(), level + 1));
            }
        }
    }
    out.sort();
    out
}

pub fn list(roots: &SkillRoots) -> Vec<Skill> {
    let mut out = Vec::new();
    for (scope, root) in [(SkillScope::User, &roots.user), (SkillScope::Project, &roots.project)] {
        let Some(root) = root else { continue };
        for d in skill_dirs(root, 3) {
            let synced = d.strip_prefix(root).ok().is_some_and(|r| r.starts_with("synced"));
            let source = synced.then(|| "synced".to_string());
            out.extend(load(&d, scope, source, true, !synced));
        }
        for d in skill_dirs(&disabled_dir(root), 1) {
            out.extend(load(&d, scope, None, false, true));
        }
    }
    for (id, path, enabled) in &roots.plugins {
        for d in skill_dirs(path, 4) {
            out.extend(load(&d, SkillScope::Plugin, Some(id.clone()), *enabled, false));
        }
    }
    out
}

pub fn validate_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-');
    if ok {
        Ok(())
    } else {
        Err(Error::invalid(format!("skill name `{name}` must use 1-64 lowercase letters, digits and dashes")))
    }
}

fn yaml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " "))
}

/// Renders the SKILL.md of a new skill.
pub fn render(n: &NewSkill) -> String {
    let mut description = n.description.trim().to_string();
    if !n.trigger.trim().is_empty() {
        description.push_str(&format!(" Use when {}", n.trigger.trim()));
    }
    let mut fm = format!("---\nname: {}\ndescription: {}\n", n.name, yaml_str(&description));
    if !n.argument_hint.trim().is_empty() {
        fm.push_str(&format!("argument-hint: {}\n", yaml_str(n.argument_hint.trim())));
    }
    if !n.allowed_tools.is_empty() {
        fm.push_str(&format!("allowed-tools: {}\n", n.allowed_tools.join(", ")));
    }
    let meta: Vec<(&str, &Vec<String>)> = vec![
        ("requires-mcp", &n.required_mcp),
        ("requires-connections", &n.required_connections),
        ("requires-permissions", &n.required_permissions),
        ("dependencies", &n.dependencies),
    ];
    if meta.iter().any(|(_, v)| !v.is_empty()) {
        fm.push_str("metadata:\n  created-by: nexus\n");
        for (k, v) in meta.into_iter().filter(|(_, v)| !v.is_empty()) {
            fm.push_str(&format!("  {k}: {}\n", yaml_str(&v.join(", "))));
        }
    }
    fm.push_str("---\n\n");
    fm.push_str(&format!("# {}\n\n{}\n", n.name, n.instructions.trim()));
    fm
}

pub fn create(roots: &SkillRoots, scope: SkillScope, n: &NewSkill) -> Result<PathBuf> {
    validate_name(&n.name)?;
    if n.description.trim().is_empty() {
        return Err(Error::invalid("a skill needs a description so Claude knows when to use it"));
    }
    let root = roots.root(scope)?;
    let dir = root.join(&n.name);
    if dir.exists() || disabled_dir(root).join(&n.name).exists() {
        return Err(Error::Conflict(format!("a skill named `{}` already exists", n.name)));
    }
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("SKILL.md"), render(n))?;
    Ok(dir)
}

/// Resolves an editable skill folder and its root, refusing anything else.
fn editable(roots: &SkillRoots, dir: &str) -> Result<(PathBuf, PathBuf)> {
    let d = PathBuf::from(dir);
    for root in [roots.user.as_ref(), roots.project.as_ref()].into_iter().flatten() {
        for base in [root.clone(), disabled_dir(root)] {
            if d.parent() == Some(base.as_path()) && d.join("SKILL.md").is_file() {
                return Ok((d, root.clone()));
            }
        }
    }
    Err(Error::Denied("only user and project skills can be changed from NEXUS".into()))
}

pub fn read_file(roots: &SkillRoots, dir: &str, file: &str) -> Result<String> {
    let all = list(roots);
    let skill = all.iter().find(|s| s.dir == dir).ok_or_else(|| Error::not_found(format!("skill {dir}")))?;
    if !skill.files.iter().any(|f| f == file) {
        return Err(Error::not_found(format!("{file} in skill {}", skill.name)));
    }
    Ok(fs::read_to_string(Path::new(dir).join(file))?)
}

pub fn write_skill_md(roots: &SkillRoots, dir: &str, content: &str) -> Result<()> {
    let (d, _) = editable(roots, dir)?;
    let (fm, _) = parse_frontmatter(content);
    let name = fm.get("name").ok_or_else(|| Error::invalid("SKILL.md must keep a `name` in its frontmatter"))?;
    validate_name(name)?;
    fs::write(d.join("SKILL.md"), content)?;
    Ok(())
}

pub fn set_enabled(roots: &SkillRoots, dir: &str, enabled: bool) -> Result<PathBuf> {
    let (d, root) = editable(roots, dir)?;
    let name = d.file_name().ok_or_else(|| Error::invalid("bad skill folder"))?;
    let target = if enabled { root.join(name) } else { disabled_dir(&root).join(name) };
    if target == d {
        return Ok(d);
    }
    if target.exists() {
        return Err(Error::Conflict(format!("{} already exists", target.display())));
    }
    fs::create_dir_all(target.parent().expect("has parent"))?;
    fs::rename(&d, &target)?;
    Ok(target)
}

pub fn duplicate(roots: &SkillRoots, dir: &str, new_name: &str) -> Result<PathBuf> {
    validate_name(new_name)?;
    let src = PathBuf::from(dir);
    if !src.join("SKILL.md").is_file() {
        return Err(Error::not_found(format!("skill {dir}")));
    }
    let root = roots.root(SkillScope::User).or_else(|_| roots.root(SkillScope::Project))?;
    // Duplicates of editable skills stay next to the original; others go to the user scope.
    let target_root = editable(roots, dir).map(|(_, r)| r).unwrap_or_else(|_| root.clone());
    let target = target_root.join(new_name);
    if target.exists() {
        return Err(Error::Conflict(format!("a skill named `{new_name}` already exists")));
    }
    copy_dir(&src, &target)?;
    let md = fs::read_to_string(target.join("SKILL.md"))?;
    let renamed = rename_in_frontmatter(&md, new_name);
    fs::write(target.join("SKILL.md"), renamed)?;
    Ok(target)
}

fn rename_in_frontmatter(md: &str, new_name: &str) -> String {
    let mut done = false;
    md.lines()
        .map(|l| {
            if !done && l.starts_with("name:") {
                done = true;
                format!("name: {new_name}")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn delete(roots: &SkillRoots, dir: &str) -> Result<PathBuf> {
    let (d, root) = editable(roots, dir)?;
    let stamp: String = pcc_core::now().chars().filter(|c| c.is_ascii_digit()).take(14).collect();
    let name = d.file_name().expect("folder").to_string_lossy().into_owned();
    let target = trash_dir(&root).join(format!("{name}-{stamp}"));
    fs::create_dir_all(trash_dir(&root))?;
    fs::rename(&d, &target)?;
    Ok(target)
}

/// Copies the skill folder into `dest_dir/<folder>`.
pub fn export(dir: &str, dest_dir: &Path) -> Result<PathBuf> {
    let src = PathBuf::from(dir);
    let name = src.file_name().ok_or_else(|| Error::invalid("bad skill folder"))?;
    let target = dest_dir.join(name);
    if target.exists() {
        return Err(Error::Conflict(format!("{} already exists", target.display())));
    }
    copy_dir(&src, &target)?;
    Ok(target)
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let to = dst.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &to)?;
        } else {
            fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

/// Line diff for the review step before saving an edited skill.
pub fn diff(old: &str, new: &str) -> String {
    similar::TextDiff::from_lines(old, new).unified_diff().context_radius(3).header("current", "edited").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(tmp: &Path) -> SkillRoots {
        SkillRoots {
            user: Some(tmp.join("user/.claude/skills")),
            project: Some(tmp.join("proj/.claude/skills")),
            plugins: vec![],
        }
    }

    #[test]
    fn frontmatter_parsing() {
        let md = "---\nname: banner-design\ndescription: \"Design banners\"\nallowed-tools: Read, Bash\nmetadata:\n  author: x\n  version: \"1.0\"\ntags:\n  - a\n  - b\n---\n\n# Body\n";
        let (fm, body) = parse_frontmatter(md);
        assert_eq!(fm["name"], "banner-design");
        assert_eq!(fm["description"], "Design banners");
        assert_eq!(fm["metadata.author"], "x");
        assert_eq!(fm["tags"], "a, b");
        assert_eq!(body, "# Body\n");
    }

    #[test]
    fn lifecycle_create_disable_duplicate_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let r = roots(tmp.path());
        let n = NewSkill {
            name: "roblox-review".into(),
            description: "Reviews Luau code.".into(),
            trigger: "reviewing Roblox scripts".into(),
            instructions: "Check for deprecated APIs.".into(),
            allowed_tools: vec!["Read".into(), "Grep".into()],
            required_mcp: vec!["roblox-studio".into()],
            ..Default::default()
        };
        let dir = create(&r, SkillScope::Project, &n).unwrap();
        assert!(create(&r, SkillScope::Project, &n).is_err());
        let all = list(&r);
        assert_eq!(all.len(), 1);
        let s = &all[0];
        assert_eq!(s.scope, SkillScope::Project);
        assert_eq!(s.description, "Reviews Luau code. Use when reviewing Roblox scripts");
        assert_eq!(s.allowed_tools, vec!["Read", "Grep"]);
        assert_eq!(s.frontmatter["metadata.requires-mcp"], "roblox-studio");
        assert!(s.problems.is_empty(), "{:?}", s.problems);

        let off = set_enabled(&r, &dir.to_string_lossy(), false).unwrap();
        assert!(!list(&r)[0].enabled);
        let on = set_enabled(&r, &off.to_string_lossy(), true).unwrap();
        assert_eq!(on, dir);

        let copy = duplicate(&r, &dir.to_string_lossy(), "roblox-review-2").unwrap();
        assert!(fs::read_to_string(copy.join("SKILL.md")).unwrap().contains("name: roblox-review-2"));
        assert_eq!(list(&r).len(), 2);

        let edited = fs::read_to_string(dir.join("SKILL.md")).unwrap().replace("deprecated", "obsolete");
        assert!(diff(&fs::read_to_string(dir.join("SKILL.md")).unwrap(), &edited).contains("+Check for obsolete APIs."));
        write_skill_md(&r, &dir.to_string_lossy(), &edited).unwrap();
        assert!(write_skill_md(&r, &dir.to_string_lossy(), "no frontmatter").is_err());

        let trashed = delete(&r, &copy.to_string_lossy()).unwrap();
        assert!(trashed.starts_with(tmp.path().join("proj/.claude/skills-trash")));
        assert_eq!(list(&r).len(), 1);
    }

    #[test]
    fn plugin_and_foreign_paths_are_read_only() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = tmp.path().join("plugin/.claude/skills/x");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("SKILL.md"), "---\nname: x\ndescription: d\n---\nbody").unwrap();
        let mut r = roots(tmp.path());
        r.plugins.push(("p@m".into(), tmp.path().join("plugin"), true));
        let all = list(&r);
        assert_eq!(all[0].scope, SkillScope::Plugin);
        assert!(!all[0].editable);
        assert!(set_enabled(&r, &plugin.to_string_lossy(), false).is_err());
        assert!(delete(&r, &plugin.to_string_lossy()).is_err());
        assert!(validate_name("Bad Name").is_err());
    }
}
