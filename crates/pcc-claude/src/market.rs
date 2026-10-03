//! Skill Market: skills and plugins that can be installed, from real sources.
//!
//! Sources, each identifiable in the UI:
//! * Claude Code marketplaces configured by the user (`claude plugin marketplace list`),
//!   read from their local clones (`.claude-plugin/marketplace.json`);
//! * the NEXUS catalog (`skills/catalog.json`, entries verified against GitHub);
//! * GitHub code search results and user-configured GitHub repositories (cached);
//! * what is already on disk (installed plugins, user / project skills).
//!
//! Nothing is installed automatically: plugins go through `claude plugin install`,
//! standalone GitHub skills through [`install`], both after an explicit user action.
//! Only Anthropic's own repositories carry the `official` flag.

pub mod github;
pub mod install;
pub mod recommend;
pub mod security;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::skills::{self, Skill, SkillScope};
use pcc_core::Result;

pub use recommend::{recommend, SkillRecommendation};

/// The bundled NEXUS catalog.
pub const CATALOG_JSON: &str = include_str!("../../../skills/catalog.json");

/// Provenance file written into standalone skills installed by NEXUS.
pub const PROVENANCE_FILE: &str = ".nexus-source.json";

// ---------------------------------------------------------------- catalog

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogFile {
    pub schema: u32,
    pub description: String,
    pub generated_at: String,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    /// `github` (standalone skill folder) or `claude-plugin`.
    pub source: String,
    /// `owner/repo` on GitHub.
    pub repository: String,
    /// Folder inside the repository (empty = root).
    pub path: String,
    pub version: Option<String>,
    pub license: Option<String>,
    pub tags: Vec<String>,
    pub featured: bool,
    pub dependencies: Vec<String>,
    pub permissions: Vec<String>,
    pub required_mcp: Vec<String>,
    /// `plugin` or `github-skill`.
    pub install_method: String,
    pub plugin: Option<CatalogPlugin>,
    pub compatibility: String,
    pub security_metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogPlugin {
    pub name: String,
    pub marketplace: String,
    pub marketplace_repo: String,
    /// Skill folders, relative to the plugin folder.
    pub skills: Vec<String>,
}

pub fn catalog() -> CatalogFile {
    serde_json::from_str(CATALOG_JSON).unwrap_or_default()
}

// ---------------------------------------------------------------- inputs

/// A configured Claude Code marketplace (`claude plugin marketplace list --json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Marketplace {
    pub name: String,
    pub source: Option<String>,
    pub repo: Option<String>,
    pub url: Option<String>,
    pub install_location: Option<String>,
    /// From `known_marketplaces.json` when available.
    pub last_updated: Option<String>,
}

/// An installed plugin (`claude plugin list --json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InstalledPlugin {
    pub id: String,
    pub version: Option<String>,
    pub scope: Option<String>,
    pub enabled: bool,
    pub install_path: Option<String>,
    pub last_updated: Option<String>,
}

/// A skill folder found on GitHub (code search or a user-configured repository).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GithubSkill {
    pub repo: String,
    /// Folder of the SKILL.md (empty = repository root).
    pub path: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub license: Option<String>,
    pub allowed_tools: Vec<String>,
    /// `search` or `user`.
    pub origin: String,
    pub query: Option<String>,
    pub fetched_at: String,
}

/// Real popularity / freshness signals of a GitHub repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoSignal {
    pub stars: u64,
    pub pushed_at: Option<String>,
    pub license: Option<String>,
    pub archived: bool,
    pub fetched_at: String,
}

/// Install counts from Claude Code's own plugin catalog cache.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginStats {
    pub installs: u64,
    pub last_updated: Option<String>,
}

/// `.nexus-source.json` of a standalone skill installed by NEXUS.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Provenance {
    pub market_id: String,
    pub repository: String,
    pub path: String,
    /// Commit the files were downloaded from.
    #[serde(rename = "ref")]
    pub reference: String,
    pub installed_at: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct IndexInput {
    pub marketplaces: Vec<Marketplace>,
    /// Parsed `marketplace.json` per marketplace name.
    pub manifests: HashMap<String, Value>,
    pub plugins: Vec<InstalledPlugin>,
    pub skills: Vec<Skill>,
    pub catalog: CatalogFile,
    pub github: Vec<GithubSkill>,
    pub user_repos: Vec<String>,
    pub signals: HashMap<String, RepoSignal>,
    pub signals_fetched_at: Option<String>,
    pub plugin_stats: HashMap<String, PluginStats>,
    pub plugin_stats_fetched_at: Option<String>,
    /// Provenance per skill folder.
    pub provenance: HashMap<String, Provenance>,
    /// SKILL.md summaries of plugin skills available in local marketplace clones, per plugin id.
    pub plugin_skills: HashMap<String, Vec<SkillSummary>>,
}

// ---------------------------------------------------------------- index

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum InstallMethod {
    /// `claude plugin install <name>@<marketplace>`.
    Plugin,
    /// Download a skill folder from GitHub into a skills directory.
    GithubSkill,
    /// Already on disk without a known origin: nothing to install.
    Local,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Discovery {
    /// Installed through a known mechanism (plugin CLI, NEXUS with provenance).
    Installed,
    /// Found on disk without a known origin.
    Discovered,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Marketplace,
    Catalog,
    GithubSearch,
    UserRepo,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub id: String,
    pub kind: SourceKind,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    /// `installs` (Claude Code plugin catalog) or `github-stars`.
    pub kind: String,
    pub value: u64,
    pub label: String,
    pub fetched_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    /// Folder relative to the plugin / repository.
    pub path: String,
    pub allowed_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: Option<String>,
    pub version: Option<String>,
    pub license: Option<String>,
    /// `owner/repo` on GitHub, when known.
    pub repository: Option<String>,
    /// Folder inside the repository.
    pub path: Option<String>,
    pub homepage: Option<String>,
    pub tags: Vec<String>,
    /// Market categories (`ui-ux`, `coding`, `roblox`, ...).
    pub categories: Vec<String>,
    pub featured: bool,
    /// Every source listing this entry (duplicates are merged).
    pub sources: Vec<SourceRef>,
    /// Published by Anthropic in an Anthropic repository.
    pub official: bool,
    pub install_method: InstallMethod,
    /// `name@marketplace` for plugins.
    pub plugin_id: Option<String>,
    pub marketplace: Option<String>,
    pub marketplace_repo: Option<String>,
    /// The plugin's marketplace is configured in Claude Code.
    pub marketplace_configured: bool,
    /// Skills it provides.
    pub skills: Vec<SkillSummary>,
    pub permissions: Vec<String>,
    pub required_mcp: Vec<String>,
    pub dependencies: Vec<String>,
    pub compatibility: String,
    /// Real popularity signal; `None` when there is none.
    pub signal: Option<Signal>,
    pub last_updated: Option<String>,
    pub installed: bool,
    pub enabled: Option<bool>,
    pub discovery: Option<Discovery>,
    /// Installed skill folders (links to the Skills view).
    pub installed_skill_ids: Vec<String>,
    pub installed_dirs: Vec<String>,
    pub installed_version: Option<String>,
    /// `user`, `project` or `local` (plugin scope / skill location).
    pub installed_scope: Option<String>,
    /// Folder whose files can be inspected locally (marketplace clone or install).
    pub local_path: Option<String>,
    /// Commit recorded by NEXUS for standalone installs.
    pub installed_ref: Option<String>,
    /// Remote source of a plugin outside its marketplace repository.
    pub remote: Option<RemoteSource>,
    /// Repository-relative skill folders (dedup of GitHub skills against plugins).
    #[serde(skip)]
    pub repo_skill_paths: Vec<String>,
}

/// Where the files of a plugin hosted outside its marketplace come from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteSource {
    /// `git-subdir`, `url`, `github`, `npm`, ...
    pub kind: String,
    pub url: Option<String>,
    pub repo: Option<String>,
    pub path: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub id: String,
    pub kind: SourceKind,
    pub label: String,
    pub official: bool,
    pub repo: Option<String>,
    pub location: Option<String>,
    pub updated_at: Option<String>,
    pub entries: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarketIndex {
    pub entries: Vec<MarketEntry>,
    pub sources: Vec<SourceStatus>,
    pub signals_fetched_at: Option<String>,
    pub plugin_stats_fetched_at: Option<String>,
    pub catalog_generated_at: String,
}

fn is_anthropic_repo(repo: &str) -> bool {
    repo.to_ascii_lowercase().starts_with("anthropics/")
}

/// `owner/repo` from a GitHub URL or an `owner/repo` string.
pub fn github_repo(s: &str) -> Option<String> {
    let r = s.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = r
        .strip_prefix("https://github.com/")
        .or_else(|| r.strip_prefix("http://github.com/"))
        .or_else(|| r.strip_prefix("git@github.com:"))
        .unwrap_or(r);
    let parts: Vec<&str> = rest.split('/').collect();
    let valid = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (parts.len() == 2 && valid(parts[0]) && valid(parts[1])).then(|| format!("{}/{}", parts[0], parts[1]))
}

fn gh_key(repo: &str, path: &str) -> String {
    let path = path.trim_matches('/');
    if path.is_empty() {
        format!("gh:{}", repo.to_ascii_lowercase())
    } else {
        format!("gh:{}/{}", repo.to_ascii_lowercase(), path)
    }
}

fn join_path(a: &str, b: &str) -> String {
    let (a, b) = (a.trim_matches('/'), b.trim_start_matches("./").trim_matches('/'));
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}/{b}"),
    }
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => vec![],
    }
}

fn empty_entry(id: String, name: String, method: InstallMethod) -> MarketEntry {
    MarketEntry {
        id,
        name,
        description: String::new(),
        author: None,
        version: None,
        license: None,
        repository: None,
        path: None,
        homepage: None,
        tags: vec![],
        categories: vec![],
        featured: false,
        sources: vec![],
        official: false,
        install_method: method,
        plugin_id: None,
        marketplace: None,
        marketplace_repo: None,
        marketplace_configured: false,
        skills: vec![],
        permissions: vec![],
        required_mcp: vec![],
        dependencies: vec![],
        compatibility: String::new(),
        signal: None,
        last_updated: None,
        installed: false,
        enabled: None,
        discovery: None,
        installed_skill_ids: vec![],
        installed_dirs: vec![],
        installed_version: None,
        installed_scope: None,
        local_path: None,
        installed_ref: None,
        remote: None,
        repo_skill_paths: vec![],
    }
}

fn add_source(e: &mut MarketEntry, s: SourceRef) {
    if !e.sources.iter().any(|x| x.id == s.id) {
        e.sources.push(s);
    }
}

fn merge_tags(e: &mut MarketEntry, tags: &[String]) {
    for t in tags {
        let t = t.to_ascii_lowercase();
        if !e.tags.contains(&t) {
            e.tags.push(t);
        }
    }
}

/// Builds the plugin entry of one marketplace manifest item.
fn plugin_entry(mp: &Marketplace, p: &Value, summaries: Option<&Vec<SkillSummary>>) -> Option<MarketEntry> {
    let name = p.get("name")?.as_str()?.to_string();
    let id = format!("{name}@{}", mp.name);
    let mut e = empty_entry(format!("plugin:{id}"), name, InstallMethod::Plugin);
    e.description = p.get("description").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    e.author = p.pointer("/author/name").and_then(Value::as_str).map(str::to_string);
    e.version = p.get("version").and_then(Value::as_str).map(str::to_string);
    e.homepage = p.get("homepage").and_then(Value::as_str).map(str::to_string);
    e.license = p.get("license").and_then(Value::as_str).map(str::to_string);
    merge_tags(&mut e, &str_list(p.get("keywords")));
    merge_tags(&mut e, &str_list(p.get("tags")));
    if let Some(c) = p.get("category").and_then(Value::as_str) {
        merge_tags(&mut e, &[c.to_string()]);
    }
    e.plugin_id = Some(id.clone());
    e.marketplace = Some(mp.name.clone());
    e.marketplace_repo = mp.repo.clone();
    e.marketplace_configured = true;
    e.compatibility = "Claude Code plugin (claude plugin install)".into();
    add_source(
        &mut e,
        SourceRef { id: format!("marketplace:{}", mp.name), kind: SourceKind::Marketplace, label: mp.name.clone() },
    );
    match p.get("source") {
        Some(Value::String(rel)) => {
            // Files live in the marketplace repository itself.
            let rel = rel.trim_start_matches("./").trim_end_matches('/').to_string();
            e.repository = mp.repo.clone();
            e.path = Some(rel.clone());
            if let Some(loc) = &mp.install_location {
                e.local_path = Some(Path::new(loc).join(&rel).to_string_lossy().into_owned());
            }
            e.official = mp.repo.as_deref().is_some_and(is_anthropic_repo) && !rel.starts_with("external_plugins");
            let skills = str_list(p.get("skills"));
            e.repo_skill_paths = match summaries {
                Some(s) if skills.is_empty() => s.iter().map(|x| join_path(&rel, &x.path)).collect(),
                _ => skills.iter().map(|s| join_path(&rel, s)).collect(),
            };
        }
        Some(Value::Object(src)) => {
            let get = |k: &str| src.get(k).and_then(Value::as_str).map(str::to_string);
            let url = get("url");
            let repo = get("repo").or_else(|| url.as_deref().and_then(github_repo));
            e.repository = repo.clone();
            e.path = get("path");
            e.remote = Some(RemoteSource {
                kind: get("source").unwrap_or_default(),
                url,
                repo,
                path: get("path"),
                reference: get("ref"),
                sha: get("sha"),
            });
        }
        _ => {}
    }
    if let Some(s) = summaries {
        e.skills = s.clone();
    }
    Some(e)
}

/// Skill summaries of the plugins of a local marketplace clone (reads SKILL.md frontmatter).
pub fn local_plugin_skills(mp: &Marketplace, manifest: &Value) -> HashMap<String, Vec<SkillSummary>> {
    let mut out = HashMap::new();
    let Some(loc) = mp.install_location.as_deref() else { return out };
    for p in manifest.get("plugins").and_then(Value::as_array).into_iter().flatten() {
        let (Some(name), Some(Value::String(rel))) = (p.get("name").and_then(Value::as_str), p.get("source")) else {
            continue;
        };
        let root = Path::new(loc).join(rel.trim_start_matches("./"));
        let declared = str_list(p.get("skills"));
        let dirs: Vec<PathBuf> = if declared.is_empty() {
            plugin_skill_roots(&root).iter().flat_map(|r| skill_children(r)).collect()
        } else {
            declared.iter().map(|s| root.join(s.trim_start_matches("./"))).collect()
        };
        let list: Vec<SkillSummary> = dirs.iter().filter_map(|d| summarize(d, &root)).collect();
        out.insert(format!("{name}@{}", mp.name), list);
    }
    out
}

/// Skill roots of a plugin folder: `plugin.json` "skills" or `skills/`.
fn plugin_skill_roots(root: &Path) -> Vec<PathBuf> {
    let declared = fs::read_to_string(root.join(".claude-plugin/plugin.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| str_list(v.get("skills")))
        .unwrap_or_default();
    if declared.is_empty() {
        vec![root.join("skills")]
    } else {
        declared.iter().map(|d| root.join(d.trim_start_matches("./"))).collect()
    }
}

fn skill_children(dir: &Path) -> Vec<PathBuf> {
    if dir.join("SKILL.md").is_file() {
        return vec![dir.to_path_buf()];
    }
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("SKILL.md").is_file())
        .collect();
    out.sort();
    out
}

fn summarize(dir: &Path, base: &Path) -> Option<SkillSummary> {
    let text = fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (fm, _) = skills::parse_frontmatter(&text);
    let rel = dir.strip_prefix(base).ok()?.to_string_lossy().replace('\\', "/");
    Some(SkillSummary {
        name: fm
            .get("name")
            .cloned()
            .unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        description: fm.get("description").cloned().unwrap_or_default(),
        path: rel,
        allowed_tools: split_tools(fm.get("allowed-tools").map(String::as_str)),
    })
}

pub fn split_tools(v: Option<&str>) -> Vec<String> {
    v.map(|t| t.split([',', ' ']).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

fn catalog_source() -> SourceRef {
    SourceRef { id: "catalog".into(), kind: SourceKind::Catalog, label: "NEXUS catalog".into() }
}

fn apply_catalog(e: &mut MarketEntry, c: &CatalogEntry) {
    add_source(e, catalog_source());
    merge_tags(e, &c.tags);
    e.featured |= c.featured;
    if e.license.is_none() {
        e.license = c.license.clone();
    }
    if e.version.is_none() {
        e.version = c.version.clone();
    }
    if e.description.is_empty() {
        e.description = c.description.clone();
    }
    if e.author.is_none() && !c.author.is_empty() {
        e.author = Some(c.author.clone());
    }
    for p in &c.permissions {
        if !e.permissions.contains(p) {
            e.permissions.push(p.clone());
        }
    }
    e.required_mcp.extend(c.required_mcp.iter().filter(|m| !e.required_mcp.contains(m)).cloned().collect::<Vec<_>>());
    e.dependencies.extend(c.dependencies.iter().filter(|m| !e.dependencies.contains(m)).cloned().collect::<Vec<_>>());
}

fn github_entry(repo: &str, path: &str, name: &str) -> MarketEntry {
    let mut e = empty_entry(gh_key(repo, path), name.to_string(), InstallMethod::GithubSkill);
    e.repository = Some(repo.to_string());
    e.path = Some(path.to_string());
    e.official = is_anthropic_repo(repo);
    e.compatibility = "Claude Code (standalone skill folder in ~/.claude/skills or <project>/.claude/skills)".into();
    e.homepage = Some(if path.is_empty() {
        format!("https://github.com/{repo}")
    } else {
        format!("https://github.com/{repo}/tree/HEAD/{path}")
    });
    e
}

struct Builder {
    entries: Vec<MarketEntry>,
    by_id: HashMap<String, usize>,
}

impl Builder {
    fn find(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }
    fn push(&mut self, e: MarketEntry) -> usize {
        let i = self.entries.len();
        self.by_id.insert(e.id.clone(), i);
        self.entries.push(e);
        i
    }
    /// Plugin entry that already provides `repo/path` (same repository and skill folder).
    fn plugin_covering(&self, repo: &str, path: &str) -> Option<usize> {
        let path = path.trim_matches('/');
        self.entries.iter().position(|e| {
            e.install_method == InstallMethod::Plugin
                && e.repository.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(repo))
                && e.repo_skill_paths.iter().any(|p| p.trim_matches('/') == path)
        })
    }
    /// Entry for a standalone GitHub skill, merged into a plugin providing the same folder.
    fn github(&mut self, repo: &str, path: &str, name: &str) -> usize {
        if let Some(i) = self.plugin_covering(repo, path) {
            return i;
        }
        let key = gh_key(repo, path);
        match self.find(&key) {
            Some(i) => i,
            None => self.push(github_entry(repo, path, name)),
        }
    }
}

/// Merges every source into one deduplicated list.
pub fn build(input: &IndexInput) -> MarketIndex {
    let mut b = Builder { entries: vec![], by_id: HashMap::new() };
    let mut sources = Vec::new();

    // 1. Configured Claude Code marketplaces.
    for mp in &input.marketplaces {
        let manifest = input.manifests.get(&mp.name);
        let mut count = 0;
        for p in manifest.and_then(|m| m.get("plugins")).and_then(Value::as_array).into_iter().flatten() {
            let id = p.get("name").and_then(Value::as_str).map(|n| format!("{n}@{}", mp.name));
            let summaries = id.as_ref().and_then(|id| input.plugin_skills.get(id));
            if let Some(e) = plugin_entry(mp, p, summaries) {
                if b.find(&e.id).is_none() {
                    b.push(e);
                    count += 1;
                }
            }
        }
        sources.push(SourceStatus {
            id: format!("marketplace:{}", mp.name),
            kind: SourceKind::Marketplace,
            label: mp.name.clone(),
            official: mp.repo.as_deref().is_some_and(is_anthropic_repo),
            repo: mp.repo.clone().or_else(|| mp.url.clone()),
            location: mp.install_location.clone(),
            updated_at: mp.last_updated.clone(),
            entries: count,
            error: manifest.is_none().then(|| "marketplace.json not found in the local clone".to_string()),
        });
    }

    // 2. NEXUS catalog.
    for c in &input.catalog.entries {
        let i = match (c.install_method.as_str(), &c.plugin) {
            ("plugin", Some(p)) => {
                // Same marketplace configured under its own name?
                let mp_name = input
                    .marketplaces
                    .iter()
                    .find(|m| m.repo.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(&p.marketplace_repo)))
                    .map(|m| m.name.clone())
                    .unwrap_or_else(|| p.marketplace.clone());
                let id = format!("plugin:{}@{mp_name}", p.name);
                match b.find(&id) {
                    Some(i) => i,
                    None => {
                        let mut e = empty_entry(id, p.name.clone(), InstallMethod::Plugin);
                        e.plugin_id = Some(format!("{}@{mp_name}", p.name));
                        e.marketplace = Some(mp_name);
                        e.marketplace_repo = Some(p.marketplace_repo.clone());
                        e.repository = Some(c.repository.clone());
                        e.path = Some(c.path.clone());
                        e.official = is_anthropic_repo(&c.repository) && !c.path.starts_with("external_plugins");
                        e.compatibility = c.compatibility.clone();
                        e.repo_skill_paths = p.skills.iter().map(|s| join_path(&c.path, s)).collect();
                        e.skills = p
                            .skills
                            .iter()
                            .map(|s| SkillSummary {
                                name: s.rsplit('/').next().unwrap_or(s).to_string(),
                                path: s.clone(),
                                ..Default::default()
                            })
                            .collect();
                        b.push(e)
                    }
                }
            }
            _ => b.github(&c.repository, &c.path, &c.name),
        };
        apply_catalog(&mut b.entries[i], c);
    }
    sources.push(SourceStatus {
        id: "catalog".into(),
        kind: SourceKind::Catalog,
        label: "NEXUS catalog".into(),
        official: false,
        repo: None,
        location: Some("skills/catalog.json".into()),
        updated_at: Some(input.catalog.generated_at.clone()),
        entries: input.catalog.entries.len(),
        error: None,
    });

    // 3. GitHub search results and user repositories.
    let mut search_count = 0;
    let mut user_counts: BTreeMap<String, usize> =
        input.user_repos.iter().map(|r| (r.to_ascii_lowercase(), 0)).collect();
    for g in &input.github {
        let i = b.github(&g.repo, &g.path, &g.name);
        let e = &mut b.entries[i];
        let source = if g.origin == "user" {
            *user_counts.entry(g.repo.to_ascii_lowercase()).or_default() += 1;
            SourceRef {
                id: format!("user:{}", g.repo.to_ascii_lowercase()),
                kind: SourceKind::UserRepo,
                label: g.repo.clone(),
            }
        } else {
            search_count += 1;
            SourceRef { id: "github-search".into(), kind: SourceKind::GithubSearch, label: "GitHub search".into() }
        };
        add_source(e, source);
        if e.description.is_empty() {
            e.description = g.description.clone();
        }
        if e.version.is_none() {
            e.version = g.version.clone();
        }
        if e.license.is_none() {
            e.license = g.license.clone();
        }
        for t in &g.allowed_tools {
            if !e.permissions.contains(t) {
                e.permissions.push(t.clone());
            }
        }
    }
    if search_count > 0 {
        sources.push(SourceStatus {
            id: "github-search".into(),
            kind: SourceKind::GithubSearch,
            label: "GitHub search".into(),
            official: false,
            repo: None,
            location: None,
            updated_at: input.github.iter().filter(|g| g.origin != "user").map(|g| g.fetched_at.clone()).max(),
            entries: search_count,
            error: None,
        });
    }
    for (repo, count) in &user_counts {
        let label =
            input.user_repos.iter().find(|r| r.eq_ignore_ascii_case(repo)).cloned().unwrap_or_else(|| repo.clone());
        sources.push(SourceStatus {
            id: format!("user:{repo}"),
            kind: SourceKind::UserRepo,
            label: label.clone(),
            official: false,
            repo: Some(label),
            location: None,
            updated_at: input
                .github
                .iter()
                .filter(|g| g.origin == "user" && g.repo.eq_ignore_ascii_case(repo))
                .map(|g| g.fetched_at.clone())
                .max(),
            entries: *count,
            error: None,
        });
    }

    // 4. Installed plugins.
    for p in &input.plugins {
        let id = format!("plugin:{}", p.id);
        let i = match b.find(&id) {
            Some(i) => i,
            None => {
                let (name, mp) = p.id.split_once('@').unwrap_or((&p.id, ""));
                let mut e = empty_entry(id, name.to_string(), InstallMethod::Plugin);
                e.plugin_id = Some(p.id.clone());
                e.marketplace = (!mp.is_empty()).then(|| mp.to_string());
                e.compatibility = "Claude Code plugin".into();
                add_source(
                    &mut e,
                    SourceRef { id: "local".into(), kind: SourceKind::Local, label: "Installed plugin".into() },
                );
                b.push(e)
            }
        };
        let e = &mut b.entries[i];
        e.installed = true;
        e.enabled = Some(p.enabled);
        e.discovery = Some(Discovery::Installed);
        e.installed_version = p.version.clone();
        e.installed_scope = p.scope.clone();
        if e.local_path.is_none() {
            e.local_path = p.install_path.clone();
        }
    }

    // 5. Skills on disk.
    let mut local_count = 0;
    for s in &input.skills {
        match s.scope {
            SkillScope::Plugin => {
                let Some(pid) = &s.source else { continue };
                if let Some(i) = b.find(&format!("plugin:{pid}")) {
                    let e = &mut b.entries[i];
                    e.installed_skill_ids.push(s.id.clone());
                    e.installed_dirs.push(s.dir.clone());
                    if !e.skills.iter().any(|x| x.name == s.name) {
                        e.skills.push(SkillSummary {
                            name: s.name.clone(),
                            description: s.description.clone(),
                            path: String::new(),
                            allowed_tools: s.allowed_tools.clone(),
                        });
                    }
                    for t in &s.allowed_tools {
                        if !e.permissions.contains(t) {
                            e.permissions.push(t.clone());
                        }
                    }
                }
            }
            SkillScope::User | SkillScope::Project => {
                let scope = if s.scope == SkillScope::User { "user" } else { "project" };
                let i = match input.provenance.get(&s.dir) {
                    Some(prov) => {
                        let i = b.github(&prov.repository, &prov.path, &s.name);
                        let e = &mut b.entries[i];
                        e.discovery = Some(Discovery::Installed);
                        e.installed_ref = Some(prov.reference.clone());
                        i
                    }
                    None => {
                        local_count += 1;
                        let mut e = empty_entry(format!("local:{}", s.id), s.name.clone(), InstallMethod::Local);
                        e.description = s.description.clone();
                        e.discovery = Some(Discovery::Discovered);
                        e.compatibility = "Claude Code skill".into();
                        e.local_path = Some(s.dir.clone());
                        e.version =
                            s.frontmatter.get("version").or_else(|| s.frontmatter.get("metadata.version")).cloned();
                        e.author = s.frontmatter.get("metadata.author").cloned();
                        e.license = s.frontmatter.get("license").cloned();
                        let label = if s.source.as_deref() == Some("synced") {
                            "Synced (claude.ai)".to_string()
                        } else if scope == "user" {
                            "Local (~/.claude/skills)".to_string()
                        } else {
                            "Local (project .claude/skills)".to_string()
                        };
                        add_source(&mut e, SourceRef { id: format!("local:{scope}"), kind: SourceKind::Local, label });
                        e.skills.push(SkillSummary {
                            name: s.name.clone(),
                            description: s.description.clone(),
                            path: String::new(),
                            allowed_tools: s.allowed_tools.clone(),
                        });
                        b.push(e)
                    }
                };
                let e = &mut b.entries[i];
                e.installed = true;
                e.enabled = Some(e.enabled.unwrap_or(false) || s.enabled);
                e.installed_scope = Some(scope.into());
                e.installed_skill_ids.push(s.id.clone());
                e.installed_dirs.push(s.dir.clone());
                if e.local_path.is_none() || e.install_method == InstallMethod::GithubSkill {
                    e.local_path = Some(s.dir.clone());
                }
                for t in &s.allowed_tools {
                    if !e.permissions.contains(t) {
                        e.permissions.push(t.clone());
                    }
                }
            }
        }
    }
    if local_count > 0 {
        sources.push(SourceStatus {
            id: "local".into(),
            kind: SourceKind::Local,
            label: "Skills on disk".into(),
            official: false,
            repo: None,
            location: None,
            updated_at: None,
            entries: local_count,
            error: None,
        });
    }

    // 6. Signals, categories, final order.
    for e in &mut b.entries {
        let stats = e.plugin_id.as_ref().and_then(|id| input.plugin_stats.get(id));
        let repo_signal = e.repository.as_ref().and_then(|r| input.signals.get(&r.to_ascii_lowercase()));
        if let Some(st) = stats.filter(|s| s.installs > 0) {
            e.signal = Some(Signal {
                kind: "installs".into(),
                value: st.installs,
                label: "unique installs (Claude Code plugin catalog)".into(),
                fetched_at: input.plugin_stats_fetched_at.clone(),
            });
        } else if let (Some(sig), Some(repo)) = (repo_signal, &e.repository) {
            e.signal = Some(Signal {
                kind: "github-stars".into(),
                value: sig.stars,
                label: format!("GitHub stars of {repo}"),
                fetched_at: Some(sig.fetched_at.clone()),
            });
        }
        e.last_updated =
            stats.and_then(|s| s.last_updated.clone()).or_else(|| repo_signal.and_then(|s| s.pushed_at.clone()));
        if e.license.is_none() {
            e.license = repo_signal.and_then(|s| s.license.clone());
        }
        e.categories = categorize(e);
    }
    let mut entries = b.entries;
    entries.sort_by(|a, b| {
        b.installed.cmp(&a.installed).then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
    });
    MarketIndex {
        entries,
        sources,
        signals_fetched_at: input.signals_fetched_at.clone(),
        plugin_stats_fetched_at: input.plugin_stats_fetched_at.clone(),
        catalog_generated_at: input.catalog.generated_at.clone(),
    }
}

// ---------------------------------------------------------------- categories

/// Topic categories of the market and the words that select them.
pub const CATEGORIES: &[(&str, &[&str])] = &[
    (
        "ui-ux",
        &[
            "ui",
            "ux",
            "design",
            "designs",
            "styling",
            "css",
            "tailwind",
            "figma",
            "interface",
            "accessibility",
            "typography",
            "brand",
            "palette",
            "shadcn",
            "landing",
        ],
    ),
    (
        "coding",
        &[
            "code",
            "coding",
            "development",
            "refactor",
            "refactoring",
            "debugging",
            "programming",
            "typescript",
            "rust",
            "python",
            "lsp",
            "typing",
            "review",
            "code-review",
            "tdd",
        ],
    ),
    ("roblox", &["roblox", "luau"]),
    (
        "web",
        &["web", "react", "nextjs", "next.js", "html", "frontend", "vue", "svelte", "browser", "website", "webapp"],
    ),
    (
        "devops",
        &[
            "devops",
            "deploy",
            "deployment",
            "kubernetes",
            "docker",
            "terraform",
            "infrastructure",
            "monitoring",
            "aws",
            "azure",
            "gcp",
            "vercel",
            "ci",
            "helm",
            "cloud",
        ],
    ),
    (
        "git",
        &["git", "github", "gitlab", "commit", "commits", "branch", "worktree", "worktrees", "diff", "pull-request"],
    ),
    ("testing", &["test", "tests", "testing", "tdd", "qa", "playwright", "e2e", "unit-test"]),
    ("security", &["security", "vulnerability", "vulnerabilities", "audit", "secure", "owasp", "sast", "pentest"]),
    (
        "documentation",
        &["documentation", "docs", "pdf", "docx", "xlsx", "pptx", "documents", "writing", "readme", "office"],
    ),
    ("automation", &["automation", "automate", "workflow", "workflows", "mcp", "integration", "productivity"]),
    ("ai", &["ai", "llm", "claude", "ml", "agent", "agents", "prompt", "sdk", "anthropic"]),
    ("3d", &["3d", "three.js", "threejs", "blender", "shader", "shaders", "webgl", "mesh"]),
    (
        "game-development",
        &["game", "games", "gamedev", "game-development", "godot", "unity", "unreal", "roblox", "gameplay"],
    ),
];

/// Lowercase words of a text (keeps `.` inside words such as `next.js`).
pub fn words(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '+'))
        .map(|w| w.trim_matches('.'))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn categorize(e: &MarketEntry) -> Vec<String> {
    let mut bag: BTreeSet<String> = BTreeSet::new();
    let mut text = format!("{} {}", e.name.replace('-', " "), e.description);
    for s in &e.skills {
        text.push(' ');
        text.push_str(&s.name.replace('-', " "));
    }
    bag.extend(words(&text));
    for t in &e.tags {
        bag.insert(t.clone());
        bag.extend(words(&t.replace('-', " ")));
    }
    CATEGORIES.iter().filter(|(_, keys)| keys.iter().any(|k| bag.contains(*k))).map(|(c, _)| c.to_string()).collect()
}

// ---------------------------------------------------------------- local readers

/// Reads `.nexus-source.json` of every user / project skill.
pub fn read_provenance(skills: &[Skill]) -> HashMap<String, Provenance> {
    skills
        .iter()
        .filter(|s| s.scope != SkillScope::Plugin)
        .filter_map(|s| {
            let text = fs::read_to_string(Path::new(&s.dir).join(PROVENANCE_FILE)).ok()?;
            Some((s.dir.clone(), serde_json::from_str(&text).ok()?))
        })
        .collect()
}

/// `~/.claude/plugins` (Claude Code's plugin folder).
pub fn plugins_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".claude").join("plugins"))
}

/// Parses `claude plugin marketplace list --json`, adding `lastUpdated` from `known_marketplaces.json`.
pub fn parse_marketplaces(list: &Value, known: Option<&Value>) -> Vec<Marketplace> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let mut mp: Marketplace = serde_json::from_value(m.clone()).ok()?;
            if mp.name.is_empty() {
                return None;
            }
            if mp.last_updated.is_none() {
                mp.last_updated = known
                    .and_then(|k| k.get(&mp.name))
                    .and_then(|k| k.get("lastUpdated"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some(mp)
        })
        .collect()
}

pub fn read_manifest(mp: &Marketplace) -> Option<Value> {
    let loc = mp.install_location.as_deref()?;
    let text = fs::read_to_string(Path::new(loc).join(".claude-plugin").join("marketplace.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Install counts from Claude Code's `plugin-catalog-cache.json` (absent on some installs).
pub fn parse_plugin_stats(cache: &Value) -> (HashMap<String, PluginStats>, Option<String>) {
    let fetched = cache.get("fetchedAt").and_then(Value::as_str).map(str::to_string);
    let stats = cache
        .pointer("/catalog/plugins")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(id, v)| {
                    (
                        id.clone(),
                        PluginStats {
                            installs: v.get("unique_installs").and_then(Value::as_u64).unwrap_or(0),
                            last_updated: v.get("last_updated").and_then(Value::as_str).map(str::to_string),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    (stats, fetched)
}

pub fn parse_installed_plugins(list: &[Value]) -> Vec<InstalledPlugin> {
    list.iter()
        .filter_map(|p| serde_json::from_value(p.clone()).ok())
        .filter(|p: &InstalledPlugin| !p.id.is_empty())
        .collect()
}

/// Every GitHub repository referenced by the index (for star / freshness signals).
pub fn referenced_repos(index: &MarketIndex) -> Vec<String> {
    let set: BTreeSet<String> =
        index.entries.iter().filter_map(|e| e.repository.as_ref()).map(|r| r.to_ascii_lowercase()).collect();
    set.into_iter().collect()
}

/// Market data persisted between runs (GitHub results and signals, with timestamps).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MarketCache {
    pub github: Vec<GithubSkill>,
    pub signals: HashMap<String, RepoSignal>,
    pub signals_fetched_at: Option<String>,
    pub last_refresh: Option<String>,
}

impl MarketCache {
    /// Keeps the most recent search results (user repositories are always kept).
    pub fn add_github(&mut self, hits: Vec<GithubSkill>, limit: usize) {
        for h in hits {
            self.github.retain(|g| !(g.repo.eq_ignore_ascii_case(&h.repo) && g.path == h.path && g.origin == h.origin));
            self.github.push(h);
        }
        let searches = self.github.iter().filter(|g| g.origin != "user").count();
        if searches > limit {
            let mut drop = searches - limit;
            self.github.retain(|g| {
                if drop > 0 && g.origin != "user" {
                    drop -= 1;
                    false
                } else {
                    true
                }
            });
        }
    }
}

/// User settings of the market.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MarketSettings {
    /// GitHub repositories (`owner/repo`) scanned for SKILL.md folders.
    pub user_repos: Vec<String>,
    /// Refresh marketplaces and signals once a day when the market opens.
    pub auto_refresh: bool,
}

pub fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    fs::write(path, serde_json::to_string_pretty(value)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn skill(id: &str, name: &str, scope: SkillScope, source: Option<&str>, dir: &str) -> Skill {
        Skill {
            id: id.into(),
            name: name.into(),
            description: format!("{name} description"),
            scope,
            source: source.map(str::to_string),
            enabled: true,
            editable: scope != SkillScope::Plugin,
            dir: dir.into(),
            frontmatter: BTreeMap::new(),
            allowed_tools: vec![],
            files: vec!["SKILL.md".into()],
            problems: vec![],
        }
    }

    fn fixture_input() -> IndexInput {
        let mp = Marketplace {
            name: "ui-ux-pro-max-skill".into(),
            source: Some("github".into()),
            repo: Some("nextlevelbuilder/ui-ux-pro-max-skill".into()),
            install_location: Some("/m/ui".into()),
            ..Default::default()
        };
        let official = Marketplace {
            name: "claude-plugins-official".into(),
            repo: Some("anthropics/claude-plugins-official".into()),
            install_location: Some("/m/off".into()),
            ..Default::default()
        };
        let mut manifests = HashMap::new();
        manifests.insert(
            mp.name.clone(),
            json!({"name": "ui-ux-pro-max-skill", "plugins": [{
                "name": "ui-ux-pro-max", "source": "./", "version": "2.13.0",
                "description": "Professional UI/UX design intelligence", "author": {"name": "nextlevelbuilder"},
                "keywords": ["ui", "design"], "category": "design"
            }]}),
        );
        manifests.insert(
            official.name.clone(),
            json!({"plugins": [
                {"name": "frontend-design", "source": "./plugins/frontend-design", "author": {"name": "Anthropic"},
                 "description": "Create distinctive frontend interfaces", "category": "development"},
                {"name": "asana", "source": "./external_plugins/asana", "description": "Asana integration"},
                {"name": "aikido", "description": "Security scanning",
                 "source": {"source": "url", "url": "https://github.com/AikidoSec/aikido-claude-plugin.git", "sha": "02f0"}}
            ]}),
        );
        let mut plugin_skills = HashMap::new();
        plugin_skills.insert(
            "ui-ux-pro-max@ui-ux-pro-max-skill".to_string(),
            vec![
                SkillSummary {
                    name: "ui-ux-pro-max".into(),
                    path: ".claude/skills/ui-ux-pro-max".into(),
                    ..Default::default()
                },
                SkillSummary { name: "slides".into(), path: ".claude/skills/slides".into(), ..Default::default() },
            ],
        );
        let catalog: CatalogFile = serde_json::from_value(json!({
            "schema": 1, "generatedAt": "2026-10-02T00:00:00Z",
            "entries": [
                {"id": "ui-ux-pro-max", "name": "ui-ux-pro-max", "repository": "nextlevelbuilder/ui-ux-pro-max-skill",
                 "path": "", "installMethod": "plugin", "tags": ["accessibility"], "featured": true, "license": "MIT",
                 "plugin": {"name": "ui-ux-pro-max", "marketplace": "ui-ux-pro-max-skill",
                            "marketplaceRepo": "nextlevelbuilder/ui-ux-pro-max-skill", "skills": [".claude/skills/ui-ux-pro-max"]}},
                {"id": "roblox-luau", "name": "roblox-luau", "description": "Luau scripting for Roblox",
                 "repository": "gamedev-skills/awesome-gamedev-agent-skills", "path": "skills/other-engines/roblox-luau",
                 "installMethod": "github-skill", "tags": ["roblox", "game-development"]},
                {"id": "superpowers", "name": "superpowers", "repository": "obra/superpowers", "path": "",
                 "installMethod": "plugin", "description": "Core skills library: TDD, debugging",
                 "plugin": {"name": "superpowers", "marketplace": "superpowers-dev", "marketplaceRepo": "obra/superpowers",
                            "skills": ["skills/test-driven-development"]}}
            ]
        }))
        .unwrap();
        IndexInput {
            marketplaces: vec![mp, official],
            manifests,
            plugins: vec![InstalledPlugin {
                id: "ui-ux-pro-max@ui-ux-pro-max-skill".into(),
                version: Some("2.13.0".into()),
                scope: Some("user".into()),
                enabled: true,
                ..Default::default()
            }],
            skills: vec![
                skill(
                    "plugin:/c/ui-ux-pro-max",
                    "ui-ux-pro-max",
                    SkillScope::Plugin,
                    Some("ui-ux-pro-max@ui-ux-pro-max-skill"),
                    "/c/ui-ux-pro-max",
                ),
                skill(
                    "plugin:/c/slides",
                    "slides",
                    SkillScope::Plugin,
                    Some("ui-ux-pro-max@ui-ux-pro-max-skill"),
                    "/c/slides",
                ),
                skill("user:/h/deploy", "deploy", SkillScope::User, None, "/h/deploy"),
                skill("user:/h/roblox-luau", "roblox-luau", SkillScope::User, None, "/h/roblox-luau"),
            ],
            catalog,
            github: vec![
                GithubSkill {
                    repo: "gamedev-skills/awesome-gamedev-agent-skills".into(),
                    path: "skills/other-engines/roblox-luau".into(),
                    name: "roblox-luau".into(),
                    origin: "search".into(),
                    fetched_at: "2026-10-02T10:00:00Z".into(),
                    ..Default::default()
                },
                GithubSkill {
                    repo: "nextlevelbuilder/ui-ux-pro-max-skill".into(),
                    path: ".claude/skills/slides".into(),
                    name: "slides".into(),
                    origin: "search".into(),
                    fetched_at: "2026-10-02T10:00:00Z".into(),
                    ..Default::default()
                },
            ],
            provenance: HashMap::from([(
                "/h/roblox-luau".to_string(),
                Provenance {
                    repository: "gamedev-skills/awesome-gamedev-agent-skills".into(),
                    path: "skills/other-engines/roblox-luau".into(),
                    reference: "abc".into(),
                    ..Default::default()
                },
            )]),
            plugin_skills,
            plugin_stats: HashMap::from([(
                "frontend-design@claude-plugins-official".to_string(),
                PluginStats { installs: 1261339, last_updated: Some("2026-09-01".into()) },
            )]),
            signals: HashMap::from([(
                "nextlevelbuilder/ui-ux-pro-max-skill".to_string(),
                RepoSignal { stars: 132477, fetched_at: "t".into(), ..Default::default() },
            )]),
            ..Default::default()
        }
    }

    #[test]
    fn marketplace_json_parsing() {
        let list = json!([{"name": "anthropic-agent-skills", "source": "github", "repo": "anthropics/skills",
                           "installLocation": "C:\\m\\a"}, {"bad": 1}]);
        let known = json!({"anthropic-agent-skills": {"lastUpdated": "2026-10-02T13:24:09.746Z"}});
        let mps = parse_marketplaces(&list, Some(&known));
        assert_eq!(mps.len(), 1);
        assert_eq!(mps[0].repo.as_deref(), Some("anthropics/skills"));
        assert_eq!(mps[0].last_updated.as_deref(), Some("2026-10-02T13:24:09.746Z"));

        let installed =
            parse_installed_plugins(&[json!({"id": "x@y", "version": "1.0.0", "enabled": false, "installPath": "/p"})]);
        assert_eq!(installed[0].id, "x@y");
        assert!(!installed[0].enabled);

        let (stats, at) = parse_plugin_stats(&json!({"fetchedAt": "f", "catalog": {"plugins": {
            "a@b": {"unique_installs": 42, "last_updated": "2026-09-01"}}}}));
        assert_eq!(stats["a@b"].installs, 42);
        assert_eq!(at.as_deref(), Some("f"));
        assert_eq!(
            github_repo("https://github.com/AikidoSec/aikido-claude-plugin.git").as_deref(),
            Some("AikidoSec/aikido-claude-plugin")
        );
        assert_eq!(github_repo("not a repo"), None);
    }

    #[test]
    fn bundled_catalog_is_valid() {
        let c = catalog();
        assert!(c.entries.len() >= 10);
        for e in &c.entries {
            assert!(github_repo(&e.repository).is_some(), "{}", e.id);
            assert!(matches!(e.install_method.as_str(), "plugin" | "github-skill"), "{}", e.id);
            assert_eq!(e.install_method == "plugin", e.plugin.is_some(), "{}", e.id);
            assert!(e.security_metadata.get("verifiedCommit").and_then(Value::as_str).is_some_and(|s| s.len() == 40));
        }
        let ids: BTreeSet<_> = c.entries.iter().map(|e| &e.id).collect();
        assert_eq!(ids.len(), c.entries.len(), "duplicate catalog ids");
    }

    #[test]
    fn dedup_merges_sources_and_marks_installed() {
        let idx = build(&fixture_input());
        let ui: Vec<_> = idx.entries.iter().filter(|e| e.name == "ui-ux-pro-max").collect();
        assert_eq!(ui.len(), 1, "one entry for marketplace + catalog + installed plugin");
        let ui = ui[0];
        assert_eq!(ui.id, "plugin:ui-ux-pro-max@ui-ux-pro-max-skill");
        assert!(ui.installed && ui.enabled == Some(true));
        assert_eq!(ui.discovery, Some(Discovery::Installed));
        assert!(ui.featured);
        assert!(!ui.official, "third-party marketplace is never official");
        assert!(ui.sources.iter().any(|s| s.kind == SourceKind::Catalog));
        assert_eq!(ui.installed_dirs.len(), 2);
        assert_eq!(ui.signal.as_ref().unwrap().kind, "github-stars");
        assert!(ui.categories.contains(&"ui-ux".to_string()));

        // A GitHub hit for a folder the plugin already provides is not a second entry.
        assert!(!idx.entries.iter().any(|e| e.id.starts_with("gh:nextlevelbuilder")));
        let slides = idx.entries.iter().filter(|e| e.name == "slides").count();
        assert_eq!(slides, 0, "slides is a skill of the plugin entry, not an entry");
        assert_eq!(ui.sources.len(), 3, "marketplace, catalog and GitHub search");

        // Catalog + search + NEXUS install of the same folder: one entry, installed.
        let roblox: Vec<_> = idx.entries.iter().filter(|e| e.name == "roblox-luau").collect();
        assert_eq!(roblox.len(), 1);
        assert_eq!(roblox[0].discovery, Some(Discovery::Installed));
        assert_eq!(roblox[0].installed_ref.as_deref(), Some("abc"));
        assert!(roblox[0].categories.contains(&"roblox".to_string()));
        assert!(roblox[0].categories.contains(&"game-development".to_string()));

        // A skill without provenance is Discovered.
        let deploy = idx.entries.iter().find(|e| e.name == "deploy").unwrap();
        assert_eq!(deploy.discovery, Some(Discovery::Discovered));
        assert_eq!(deploy.install_method, InstallMethod::Local);
    }

    #[test]
    fn official_only_for_anthropic_content() {
        let idx = build(&fixture_input());
        let get = |n: &str| idx.entries.iter().find(|e| e.name == n).unwrap();
        assert!(get("frontend-design").official);
        assert!(!get("asana").official, "external plugin listed in Anthropic's directory");
        assert!(!get("aikido").official);
        assert_eq!(get("aikido").repository.as_deref(), Some("AikidoSec/aikido-claude-plugin"));
        assert_eq!(get("frontend-design").signal.as_ref().unwrap().value, 1261339);
        // Catalog plugin whose marketplace is not configured.
        let sp = get("superpowers");
        assert!(!sp.marketplace_configured && !sp.installed && !sp.official);
        assert_eq!(sp.plugin_id.as_deref(), Some("superpowers@superpowers-dev"));
    }

    /// Index of this machine's real marketplaces and skills: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_local_index() {
        let exe = crate::find_claude().expect("claude");
        let run = |args: &[&str]| -> Value {
            let out = crate::process::std_command(&exe).args(args).output().unwrap();
            serde_json::from_slice(&out.stdout).unwrap()
        };
        let plugins = run(&["plugin", "list", "--json"]);
        let known = read_json::<Value>(&plugins_dir().unwrap().join("known_marketplaces.json"));
        let mut input = IndexInput { catalog: catalog(), ..Default::default() };
        input.marketplaces = parse_marketplaces(&run(&["plugin", "marketplace", "list", "--json"]), Some(&known));
        for mp in &input.marketplaces {
            let m = read_manifest(mp).expect("manifest");
            input.plugin_skills.extend(local_plugin_skills(mp, &m));
            input.manifests.insert(mp.name.clone(), m);
        }
        let list = plugins.as_array().cloned().unwrap_or_default();
        input.plugins = parse_installed_plugins(&list);
        input.skills = skills::list(&skills::SkillRoots::new(None, &list));
        let idx = build(&input);
        for e in idx.entries.iter().filter(|e| e.installed) {
            println!(
                "{} | {:?} | {:?} | skills {}",
                e.id,
                e.discovery,
                e.sources.iter().map(|s| &s.label).collect::<Vec<_>>(),
                e.installed_skill_ids.len()
            );
        }
        println!(
            "{} entries, sources: {:?}",
            idx.entries.len(),
            idx.sources.iter().map(|s| (&s.label, s.entries)).collect::<Vec<_>>()
        );
        let ui = idx.entries.iter().find(|e| e.id == "plugin:ui-ux-pro-max@ui-ux-pro-max-skill").unwrap();
        assert!(ui.installed && !ui.official);
        assert_eq!(idx.entries.iter().filter(|e| e.name == "ui-ux-pro-max").count(), 1);
    }

    #[test]
    fn cache_keeps_user_repos_and_limits_searches() {
        let hit = |repo: &str, origin: &str| GithubSkill {
            repo: repo.into(),
            path: "s".into(),
            origin: origin.into(),
            ..Default::default()
        };
        let mut c = MarketCache::default();
        c.add_github(vec![hit("u/r", "user"), hit("a/1", "search"), hit("a/2", "search")], 10);
        c.add_github(vec![hit("a/3", "search"), hit("a/1", "search")], 2);
        let repos: Vec<_> = c.github.iter().map(|g| g.repo.as_str()).collect();
        assert_eq!(repos, vec!["u/r", "a/3", "a/1"]);
    }
}
