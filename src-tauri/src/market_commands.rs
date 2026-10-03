//! Skill Market commands (section "market" of `src/lib/api.ts`).
//!
//! Reads Claude Code's marketplaces and plugins through the `claude` CLI and
//! its plugin folder, GitHub through the user's `gh` CLI, and the bundled
//! NEXUS catalog. Nothing is installed without an explicit user action, and
//! sensitive packages need `confirmed` ("Install anyway") after the analysis
//! the user saw. Plugins are installed by `claude plugin`, standalone skills
//! by `pcc_claude::market::install`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use pcc_claude::cli_help::{self, CliRun};
use pcc_claude::market::github::{self, GhCli};
use pcc_claude::market::install::{self, Analysis, InstallRequest};
use pcc_claude::market::{
    self, IndexInput, InstallMethod, MarketCache, MarketEntry, MarketIndex, MarketSettings, SkillRecommendation,
};
use pcc_claude::skills::{self, SkillRoots};
use pcc_core::{Error, Event, EventKind};

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

/// Last index built (actions and details look entries up here).
static LAST_INDEX: Mutex<Option<MarketIndex>> = Mutex::new(None);

/// Search results kept in the cache.
const SEARCH_KEEP: usize = 200;
/// Hits whose SKILL.md is read per search.
const SEARCH_READ: usize = 15;
/// Repositories whose stars are refreshed per refresh.
const SIGNAL_REPOS: usize = 60;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

fn claude() -> CmdResult<PathBuf> {
    pcc_claude::find_claude().ok_or_else(|| Error::Process("Claude Code was not detected".into()))
}

fn gh() -> CmdResult<GhCli> {
    GhCli::find().ok_or_else(|| Error::Process("the GitHub CLI (gh) was not found on PATH".into()))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

async fn project_root(state: &AppState) -> Option<PathBuf> {
    state.orch().await.ok().map(|o| o.store.root().to_path_buf())
}

async fn workdir(state: &AppState) -> PathBuf {
    project_root(state).await.or_else(home).unwrap_or_else(std::env::temp_dir)
}

fn cache_file(state: &AppState) -> PathBuf {
    state.data_dir.join("market-cache.json")
}

fn settings_file(state: &AppState) -> PathBuf {
    state.data_dir.join("market-settings.json")
}

fn claude_json(exe: &Path, args: &[&str]) -> Option<Value> {
    let out = pcc_claude::process::std_command(exe).args(args).output().ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

/// Everything on disk and in the caches (no network).
fn gather(project: Option<PathBuf>, cache: MarketCache, settings: MarketSettings) -> (IndexInput, SkillRoots) {
    let exe = pcc_claude::find_claude();
    let plugin_list: Vec<Value> = exe
        .as_deref()
        .and_then(|e| claude_json(e, &["plugin", "list", "--json"]))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let mp_list = exe.as_deref().and_then(|e| claude_json(e, &["plugin", "marketplace", "list", "--json"]));
    let plugins_dir = market::plugins_dir();
    let read = |name: &str| -> Option<Value> {
        let p = plugins_dir.as_ref()?.join(name);
        serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
    };
    let known = read("known_marketplaces.json");
    let marketplaces = mp_list.map(|l| market::parse_marketplaces(&l, known.as_ref())).unwrap_or_default();
    let mut input = IndexInput { catalog: market::catalog(), ..Default::default() };
    for mp in &marketplaces {
        if let Some(m) = market::read_manifest(mp) {
            input.plugin_skills.extend(market::local_plugin_skills(mp, &m));
            input.manifests.insert(mp.name.clone(), m);
        }
    }
    if let Some(c) = read("plugin-catalog-cache.json") {
        (input.plugin_stats, input.plugin_stats_fetched_at) = market::parse_plugin_stats(&c);
    }
    let roots = SkillRoots::new(project.as_deref(), &plugin_list);
    input.marketplaces = marketplaces;
    input.plugins = market::parse_installed_plugins(&plugin_list);
    input.skills = skills::list(&roots);
    input.provenance = market::read_provenance(&input.skills);
    input.github = cache.github;
    input.signals = cache.signals;
    input.signals_fetched_at = cache.signals_fetched_at;
    input.user_repos = settings.user_repos;
    (input, roots)
}

async fn build_index(state: &AppState) -> CmdResult<(MarketIndex, IndexInput, SkillRoots)> {
    let project = project_root(state).await;
    let cache: MarketCache = market::read_json(&cache_file(state));
    let settings: MarketSettings = market::read_json(&settings_file(state));
    let (index, input, roots) = blocking(move || {
        let (input, roots) = gather(project, cache, settings);
        (market::build(&input), input, roots)
    })
    .await?;
    if let Ok(mut last) = LAST_INDEX.lock() {
        *last = Some(index.clone());
    }
    Ok((index, input, roots))
}

async fn entry(state: &AppState, id: &str) -> CmdResult<MarketEntry> {
    let cached = LAST_INDEX.lock().ok().and_then(|l| l.as_ref()?.entries.iter().find(|e| e.id == id).cloned());
    if let Some(e) = cached {
        return Ok(e);
    }
    let (index, ..) = build_index(state).await?;
    index.entries.into_iter().find(|e| e.id == id).ok_or_else(|| Error::not_found(format!("market entry {id}")))
}

async fn changed(state: &AppState, summary: String) {
    if let Ok(mut last) = LAST_INDEX.lock() {
        *last = None;
    }
    if let Ok(o) = state.orch().await {
        let mut e = o.lock().await;
        let _ = e.reload_plugins_everywhere();
        e.emit(Event::new(EventKind::SkillChanged, summary, Value::Null));
    }
}

// ---------------------------------------------------------------- index / refresh / search

#[tauri::command]
pub async fn market_index(state: State<'_, AppState>) -> CmdResult<MarketIndex> {
    Ok(build_index(&state).await?.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRefresh {
    pub index: MarketIndex,
    /// `claude plugin marketplace update` output, when requested.
    pub marketplace_run: Option<CliRun>,
    pub errors: Vec<String>,
}

/// Refreshes marketplaces (when `update_marketplaces`), user repositories and GitHub signals.
#[tauri::command]
pub async fn market_refresh(state: State<'_, AppState>, update_marketplaces: bool) -> CmdResult<MarketRefresh> {
    let mut errors = Vec::new();
    let marketplace_run = if update_marketplaces {
        let args = vec!["plugin".into(), "marketplace".into(), "update".into()];
        match cli_help::run(&claude()?, &workdir(&state).await, args, Duration::from_secs(300)).await {
            Ok(run) => Some(run),
            Err(e) => {
                errors.push(format!("marketplace update: {e}"));
                None
            }
        }
    } else {
        None
    };
    let (index, ..) = build_index(&state).await?;
    let settings: MarketSettings = market::read_json(&settings_file(&state));
    let path = cache_file(&state);
    let mut cache: MarketCache = market::read_json(&path);
    match gh() {
        Ok(gh) => {
            let repos = market::referenced_repos(&index);
            let (cache2, errs) = blocking(move || {
                let now = pcc_core::now();
                let mut errs = Vec::new();
                for repo in &settings.user_repos {
                    match github::scan_repo(&gh, repo, 100, &now) {
                        Ok(hits) => {
                            cache.github.retain(|g| !(g.origin == "user" && g.repo.eq_ignore_ascii_case(repo)));
                            cache.add_github(hits, SEARCH_KEEP);
                        }
                        Err(e) => errs.push(format!("{repo}: {e}")),
                    }
                }
                cache.github.retain(|g| {
                    g.origin != "user" || settings.user_repos.iter().any(|r| r.eq_ignore_ascii_case(&g.repo))
                });
                for repo in repos.iter().take(SIGNAL_REPOS) {
                    match github::signal(&gh, repo, &now) {
                        Ok(s) => {
                            cache.signals.insert(repo.clone(), s);
                        }
                        Err(e) => errs.push(format!("{repo}: {e}")),
                    }
                }
                cache.signals_fetched_at = Some(now.clone());
                cache.last_refresh = Some(now);
                (cache, errs)
            })
            .await?;
            market::write_json(&path, &cache2)?;
            errors.extend(errs);
        }
        Err(e) => errors.push(format!("GitHub signals unavailable: {e}")),
    }
    let (index, ..) = build_index(&state).await?;
    Ok(MarketRefresh { index, marketplace_run, errors })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSearch {
    pub index: MarketIndex,
    /// Entry ids of this search's hits.
    pub hits: Vec<String>,
}

/// GitHub code search for SKILL.md files (results cached with their timestamp).
#[tauri::command]
pub async fn market_search_github(state: State<'_, AppState>, query: String) -> CmdResult<MarketSearch> {
    let query = query.trim().to_string();
    if query.len() < 2 {
        return Err(Error::invalid("enter at least two characters"));
    }
    let gh = gh()?;
    let q = query.clone();
    let hits = blocking(move || github::search(&gh, &q, SEARCH_READ, &pcc_core::now())).await??;
    let path = cache_file(&state);
    let mut cache: MarketCache = market::read_json(&path);
    let keys: Vec<(String, String)> = hits.iter().map(|h| (h.repo.to_ascii_lowercase(), h.path.clone())).collect();
    cache.add_github(hits, SEARCH_KEEP);
    market::write_json(&path, &cache)?;
    let (index, ..) = build_index(&state).await?;
    let ids = index
        .entries
        .iter()
        .filter(|e| {
            let repo = e.repository.as_deref().unwrap_or_default().to_ascii_lowercase();
            keys.iter().any(|(r, p)| {
                *r == repo
                    && (e.path.as_deref() == Some(p.as_str())
                        || e.repo_skill_paths.iter().any(|x| x.trim_matches('/') == p))
            })
        })
        .map(|e| e.id.clone())
        .collect();
    Ok(MarketSearch { index, hits: ids })
}

// ---------------------------------------------------------------- details / analysis

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetails {
    pub entry: MarketEntry,
    pub analysis: Option<Analysis>,
    /// Why there is no analysis.
    pub analysis_error: Option<String>,
    /// For standalone skills installed by NEXUS: a newer commit touches the folder.
    pub update_available: Option<bool>,
    /// Analysis of the newer version (GitHub head) when an update is available.
    pub update_analysis: Option<Analysis>,
}

/// Files and security analysis of an entry, from its real files.
fn analyze(e: &MarketEntry) -> Result<Analysis, Error> {
    let local = e.local_path.as_deref().map(Path::new).filter(|p| p.is_dir());
    match (e.install_method, local) {
        (InstallMethod::GithubSkill, _) if !e.installed => {
            let repo = e.repository.as_deref().ok_or_else(|| Error::invalid("no repository"))?;
            let gh = gh()?;
            let head = github::head_commit(&gh, repo)?;
            install::analyze_github(&gh, repo, e.path.as_deref().unwrap_or_default(), &head)
        }
        (_, Some(dir)) => install::analyze_local(dir),
        (InstallMethod::Plugin, None) => {
            let remote = e.remote.as_ref();
            let repo = remote
                .and_then(|r| r.repo.clone())
                .or_else(|| e.repository.clone())
                .ok_or_else(|| Error::invalid("the plugin's files are not on GitHub: no analysis possible"))?;
            let gh = gh()?;
            let reference = match remote.and_then(|r| r.sha.clone()) {
                Some(sha) => sha,
                None => github::head_commit(&gh, &repo)?,
            };
            let path = remote.and_then(|r| r.path.clone()).or_else(|| e.path.clone()).unwrap_or_default();
            install::analyze_github(&gh, &repo, &path, &reference)
        }
        _ => Err(Error::invalid("no local folder or repository to inspect")),
    }
}

#[tauri::command]
pub async fn market_details(state: State<'_, AppState>, id: String) -> CmdResult<MarketDetails> {
    let e = entry(&state, &id).await?;
    let e2 = e.clone();
    blocking(move || {
        let (analysis, analysis_error) = match analyze(&e2) {
            Ok(a) => (Some(a), None),
            Err(err) => (None, Some(err.to_string())),
        };
        let mut update_analysis = None;
        let update_available = match (&e2.installed_ref, &e2.repository, gh()) {
            (Some(r), Some(repo), Ok(gh)) if e2.install_method == InstallMethod::GithubSkill => {
                let path = e2.path.clone().unwrap_or_default();
                let changed = github::folder_changed(&gh, repo, &path, r).ok();
                if changed == Some(true) {
                    update_analysis = github::head_commit(&gh, repo)
                        .and_then(|head| install::analyze_github(&gh, repo, &path, &head))
                        .ok();
                }
                changed
            }
            _ => None,
        };
        MarketDetails { entry: e2, analysis, analysis_error, update_available, update_analysis }
    })
    .await
}

// ---------------------------------------------------------------- actions

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarketAction {
    pub message: String,
    /// `claude plugin ...` runs, in order.
    pub runs: Vec<CliRun>,
    /// Folder written (standalone skills).
    pub dir: Option<String>,
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    /// `user` or `project` (plugins also accept `local`).
    pub scope: String,
    /// Commit analyzed and shown to the user (standalone skills).
    pub reference: Option<String>,
    /// The user confirmed "Install anyway" for a sensitive or not fully inspected package.
    pub confirmed: bool,
}

async fn skills_root(state: &AppState, scope: &str) -> CmdResult<PathBuf> {
    match scope {
        "user" => home().map(|h| h.join(".claude").join("skills")).ok_or_else(|| Error::invalid("home folder unknown")),
        "project" => project_root(state)
            .await
            .map(|p| p.join(".claude").join("skills"))
            .ok_or_else(|| Error::invalid("open a project to install into its .claude/skills")),
        other => Err(Error::invalid(format!("scope `{other}` is not available for standalone skills"))),
    }
}

async fn plugin_cli(state: &AppState, args: Vec<&str>) -> CmdResult<CliRun> {
    let args = args.into_iter().map(str::to_string).collect();
    cli_help::run(&claude()?, &workdir(state).await, args, Duration::from_secs(300)).await
}

fn needs_confirmation(a: &Result<Analysis, Error>) -> bool {
    a.as_ref().map(|a| a.security.needs_confirmation || a.truncated).unwrap_or(true)
}

fn refuse_unconfirmed() -> Error {
    Error::Denied("this package needs an explicit \"Install anyway\" after reviewing its analysis".into())
}

#[tauri::command]
pub async fn market_install(
    state: State<'_, AppState>,
    id: String,
    options: InstallOptions,
) -> CmdResult<MarketAction> {
    let e = entry(&state, &id).await?;
    if e.installed {
        return Err(Error::Conflict(format!("{} is already installed", e.name)));
    }
    let action = match e.install_method {
        InstallMethod::GithubSkill => {
            let repo = e.repository.clone().ok_or_else(|| Error::invalid("no repository"))?;
            let reference =
                options.reference.clone().ok_or_else(|| Error::invalid("analyze the skill before installing"))?;
            let root = skills_root(&state, &options.scope).await?;
            let path = e.path.clone().unwrap_or_default();
            let (id2, confirmed) = (e.id.clone(), options.confirmed);
            let (dir, prov) = blocking(move || {
                let gh = gh()?;
                // Same commit as the analysis the user saw.
                if !confirmed && needs_confirmation(&install::analyze_github(&gh, &repo, &path, &reference)) {
                    return Err(refuse_unconfirmed());
                }
                let req = InstallRequest {
                    market_id: &id2,
                    repo: &repo,
                    path: &path,
                    reference: &reference,
                    root: &root,
                    now: &pcc_core::now(),
                };
                install::install_github(&gh, &req)
            })
            .await??;
            MarketAction {
                message: format!(
                    "{} installed ({} files) from {} at {}",
                    e.name,
                    prov.files.len(),
                    prov.repository,
                    short(&prov.reference)
                ),
                dir: Some(dir.to_string_lossy().into_owned()),
                ok: true,
                ..Default::default()
            }
        }
        InstallMethod::Plugin => {
            if !matches!(options.scope.as_str(), "user" | "project" | "local") {
                return Err(Error::invalid("scope must be user, project or local"));
            }
            let plugin_id = e.plugin_id.clone().ok_or_else(|| Error::invalid("no plugin id"))?;
            if !options.confirmed {
                let e2 = e.clone();
                if blocking(move || needs_confirmation(&analyze(&e2))).await? {
                    return Err(refuse_unconfirmed());
                }
            }
            let mut runs = Vec::new();
            if !e.marketplace_configured {
                let repo =
                    e.marketplace_repo.clone().ok_or_else(|| Error::invalid("marketplace repository unknown"))?;
                let run = plugin_cli(&state, vec!["plugin", "marketplace", "add", &repo]).await?;
                let failed = run.exit_code != Some(0);
                runs.push(run);
                if failed {
                    return Ok(MarketAction {
                        message: format!("Adding the marketplace {repo} failed"),
                        runs,
                        ..Default::default()
                    });
                }
            }
            let run = plugin_cli(&state, vec!["plugin", "install", &plugin_id, "--scope", &options.scope]).await?;
            let ok = run.exit_code == Some(0);
            runs.push(run);
            MarketAction {
                message: if ok {
                    format!("Plugin {plugin_id} installed ({})", options.scope)
                } else {
                    format!("claude plugin install {plugin_id} failed")
                },
                runs,
                ok,
                dir: None,
            }
        }
        InstallMethod::Local => return Err(Error::invalid("already on disk: nothing to install")),
    };
    if action.ok {
        changed(&state, action.message.clone()).await;
    }
    Ok(action)
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

#[tauri::command]
pub async fn market_uninstall(state: State<'_, AppState>, id: String) -> CmdResult<MarketAction> {
    let e = entry(&state, &id).await?;
    if !e.installed {
        return Err(Error::invalid(format!("{} is not installed", e.name)));
    }
    let action = match e.install_method {
        InstallMethod::Plugin => {
            let pid = e.plugin_id.clone().ok_or_else(|| Error::invalid("no plugin id"))?;
            let scope = e.installed_scope.clone().unwrap_or_else(|| "user".into());
            let run = plugin_cli(&state, vec!["plugin", "uninstall", &pid, "--scope", &scope]).await?;
            let ok = run.exit_code == Some(0);
            MarketAction {
                message: if ok {
                    format!("Plugin {pid} uninstalled")
                } else {
                    format!("claude plugin uninstall {pid} failed")
                },
                runs: vec![run],
                ok,
                dir: None,
            }
        }
        InstallMethod::GithubSkill => {
            let project = project_root(&state).await;
            let dirs = e.installed_dirs.clone();
            let trashed = blocking(move || {
                let roots = SkillRoots::new(project.as_deref(), &[]);
                dirs.iter().map(|d| install::uninstall_github(&roots, Path::new(d))).collect::<Result<Vec<_>, _>>()
            })
            .await??;
            MarketAction {
                message: format!("{} moved to skills-trash (recoverable)", e.name),
                dir: trashed.first().map(|d| d.to_string_lossy().into_owned()),
                ok: true,
                ..Default::default()
            }
        }
        InstallMethod::Local => {
            return Err(Error::invalid("not installed by NEXUS or a plugin: delete it from the Skills view"))
        }
    };
    if action.ok {
        changed(&state, action.message.clone()).await;
    }
    Ok(action)
}

/// Plugins: `claude plugin update`. Standalone skills: re-download at `reference` (analyzed first).
#[tauri::command]
pub async fn market_update(state: State<'_, AppState>, id: String, options: InstallOptions) -> CmdResult<MarketAction> {
    let e = entry(&state, &id).await?;
    let action = match e.install_method {
        InstallMethod::Plugin => {
            let pid = e.plugin_id.clone().ok_or_else(|| Error::invalid("no plugin id"))?;
            let scope = e.installed_scope.clone().unwrap_or_else(|| "user".into());
            let run = plugin_cli(&state, vec!["plugin", "update", &pid, "--scope", &scope]).await?;
            let ok = run.exit_code == Some(0);
            MarketAction {
                message: if ok {
                    format!("Plugin {pid} updated (restart sessions to apply)")
                } else {
                    format!("claude plugin update {pid} failed")
                },
                runs: vec![run],
                ok,
                dir: None,
            }
        }
        InstallMethod::GithubSkill => {
            let repo = e.repository.clone().ok_or_else(|| Error::invalid("no repository"))?;
            let dir = e.installed_dirs.first().cloned().ok_or_else(|| Error::invalid("not installed"))?;
            let path = e.path.clone().unwrap_or_default();
            let project = project_root(&state).await;
            let (id2, confirmed) = (e.id.clone(), options.confirmed);
            let (dir, _) = blocking(move || {
                let gh = gh()?;
                let reference = match options.reference {
                    Some(r) => r,
                    None => github::head_commit(&gh, &repo)?,
                };
                if !confirmed && needs_confirmation(&install::analyze_github(&gh, &repo, &path, &reference)) {
                    return Err(refuse_unconfirmed());
                }
                let roots = SkillRoots::new(project.as_deref(), &[]);
                let dir = PathBuf::from(dir);
                let root = dir.parent().map(Path::to_path_buf).unwrap_or_default();
                let req = InstallRequest {
                    market_id: &id2,
                    repo: &repo,
                    path: &path,
                    reference: &reference,
                    root: &root,
                    now: &pcc_core::now(),
                };
                install::update_github(&gh, &roots, &dir, &req)
            })
            .await??;
            MarketAction {
                message: format!("{} updated; the previous version is in skills-trash", e.name),
                dir: Some(dir.to_string_lossy().into_owned()),
                ok: true,
                ..Default::default()
            }
        }
        InstallMethod::Local => return Err(Error::invalid("origin unknown: nothing to update from")),
    };
    if action.ok {
        changed(&state, action.message.clone()).await;
    }
    Ok(action)
}

/// Plugins: `claude plugin enable/disable`. Skills: the NEXUS skills-disabled mechanism.
#[tauri::command]
pub async fn market_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> CmdResult<MarketAction> {
    let e = entry(&state, &id).await?;
    let verb = if enabled { "enable" } else { "disable" };
    let action = match e.install_method {
        InstallMethod::Plugin => {
            let pid = e.plugin_id.clone().ok_or_else(|| Error::invalid("no plugin id"))?;
            let run = plugin_cli(&state, vec!["plugin", verb, &pid]).await?;
            let ok = run.exit_code == Some(0);
            MarketAction {
                message: if ok {
                    format!("Plugin {pid} {verb}d")
                } else {
                    format!("claude plugin {verb} {pid} failed")
                },
                runs: vec![run],
                ok,
                dir: None,
            }
        }
        _ => {
            let project = project_root(&state).await;
            let dirs = e.installed_dirs.clone();
            let moved = blocking(move || {
                let roots = SkillRoots::new(project.as_deref(), &[]);
                dirs.iter().map(|d| skills::set_enabled(&roots, d, enabled)).collect::<Result<Vec<_>, _>>()
            })
            .await??;
            MarketAction {
                message: format!("{} {verb}d", e.name),
                dir: moved.first().map(|d| d.to_string_lossy().into_owned()),
                ok: true,
                ..Default::default()
            }
        }
    };
    if action.ok {
        changed(&state, action.message.clone()).await;
    }
    Ok(action)
}

/// `claude plugin configure <id>`: the plugin's options and which are unset (read-only).
#[tauri::command]
pub async fn market_plugin_options(state: State<'_, AppState>, id: String) -> CmdResult<CliRun> {
    let e = entry(&state, &id).await?;
    let pid = e.plugin_id.ok_or_else(|| Error::invalid("not a plugin"))?;
    plugin_cli(&state, vec!["plugin", "configure", &pid]).await
}

// ---------------------------------------------------------------- settings / recommendations

#[tauri::command]
pub fn market_settings(state: State<'_, AppState>) -> MarketSettings {
    market::read_json(&settings_file(&state))
}

#[tauri::command]
pub fn market_save_settings(state: State<'_, AppState>, settings: MarketSettings) -> CmdResult<MarketSettings> {
    let mut repos = Vec::new();
    for r in &settings.user_repos {
        let repo = market::github_repo(r)
            .ok_or_else(|| Error::invalid(format!("`{r}` is not a GitHub repository (owner/repo)")))?;
        if !repos.iter().any(|x: &String| x.eq_ignore_ascii_case(&repo)) {
            repos.push(repo);
        }
    }
    let settings = MarketSettings { user_repos: repos, ..settings };
    market::write_json(&settings_file(&state), &settings)?;
    Ok(settings)
}

/// Deterministic recommendations for a text (installed skills + market, no network).
#[tauri::command]
pub async fn market_recommend(state: State<'_, AppState>, text: String) -> CmdResult<Vec<SkillRecommendation>> {
    let (index, input, _) = build_index(&state).await?;
    Ok(market::recommend(&text, &index, &input.skills, 12))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketStatus {
    pub last_refresh: Option<String>,
    /// The GitHub CLI is on PATH (search, signals, standalone installs).
    pub gh: bool,
    pub claude: bool,
    /// A project is open (project-scope installs).
    pub project: bool,
}

#[tauri::command]
pub async fn market_status(state: State<'_, AppState>) -> CmdResult<MarketStatus> {
    let cache: MarketCache = market::read_json(&cache_file(&state));
    Ok(MarketStatus {
        last_refresh: cache.last_refresh,
        gh: GhCli::find().is_some(),
        claude: pcc_claude::find_claude().is_some(),
        project: project_root(&state).await.is_some(),
    })
}
