//! Central as an execution agent: the NEXUS-side pre-classifier for RESUME
//! commands, the Central autonomy level, the mission supervisor that runs
//! around Claude Code's own tool loop (AgentExecutionLoop) and the automatic
//! recovery of failed MCP tool calls.
//!
//! The behavioural contract itself (classify → act → verify → report) is in
//! `prompts/central.md`; this module is what NEXUS does on its own so that
//! contract holds whatever the engine.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use pcc_core::{
    Agent, AgentStatus, Event, EventKind, LogKind, MissionStatus, PowerLevel, Result, Severity, TaskStatus, CENTRAL_ID,
    SYSTEM_ID,
};
use pcc_store::TaskFilter;

use crate::engine::{first_line, Engine};
use crate::recovery::ControlPurpose;

// ---------------------------------------------------------------- RESUME pre-classifier

/// Verbs that mean "continue the work" (accents removed, lower case).
const RESUME_VERBS: &[&str] = &[
    // English
    "continue",
    "resume",
    "proceed",
    // French
    "reprends",
    "reprend",
    "reprendre",
    "reprenez",
    "reprenons",
    "continues",
    "continuer",
    "continuez",
    "continuons",
    "poursuis",
    "poursuivre",
    "poursuivez",
    "poursuivons",
    // German
    "weiter",
    "weitermachen",
    "fortsetzen",
    "fortfahren",
    // Spanish, Italian, Portuguese
    "continua",
    "continuar",
    "sigue",
    "seguir",
    "reanuda",
    "reanudar",
    "retoma",
    "retome",
    "retomar",
    "riprendi",
    "riprendere",
    "prossegue",
    "prossiga",
    "prosseguir",
];

/// Multi-word English forms.
const RESUME_PHRASES: &[&str] = &["go on", "carry on", "keep going", "pick up where", "pick it up"];

/// Words that may surround a resume verb without changing its meaning.
const RESUME_FILLERS: &[&str] = &[
    // English
    "please",
    "pls",
    "ok",
    "okay",
    "now",
    "the",
    "work",
    "working",
    "mission",
    "task",
    "tasks",
    "job",
    "where",
    "you",
    "we",
    "i",
    "it",
    "left",
    "off",
    "stopped",
    "from",
    "last",
    "point",
    "previous",
    "your",
    "our",
    "again",
    "go",
    "on",
    "ahead",
    "carry",
    "keep",
    "going",
    "pick",
    "up",
    "claude",
    "nexus",
    "central",
    "can",
    "could",
    "would",
    "just",
    "then",
    "so",
    "with",
    "were",
    "was",
    "interrupted",
    "what",
    "doing",
    "to",
    "that",
    "this",
    "all",
    "right",
    "and",
    "yes",
    // French
    "stp",
    "svp",
    "s",
    "il",
    "te",
    "vous",
    "plait",
    "alors",
    "bon",
    "maintenant",
    "le",
    "la",
    "les",
    "l",
    "travail",
    "tache",
    "taches",
    "ou",
    "tu",
    "t",
    "es",
    "etais",
    "etait",
    "arrete",
    "arretes",
    "arretee",
    "on",
    "en",
    "etions",
    "est",
    "ce",
    "que",
    "qu",
    "faisais",
    "faisait",
    "peux",
    "pouvez",
    "vas",
    "y",
    "donc",
    "a",
    "au",
    "dernier",
    "derniere",
    "depuis",
    "interrompu",
    "interrompue",
    "de",
    "du",
    "ta",
    "ton",
    "notre",
    "nos",
    "encore",
    "oui",
    "d",
    "accord",
    "mon",
    "ma",
    "ton",
    "son",
    "sa",
    // German
    "bitte",
    "mach",
    "macht",
    "die",
    "das",
    "der",
    "arbeit",
    "aufgabe",
    "wo",
    "du",
    "aufgehort",
    "aufgehoert",
    "hast",
    "jetzt",
    "fort",
    "fahre",
    "ja",
    "mit",
    // Spanish / Italian / Portuguese
    "por",
    "favor",
    "el",
    "trabajo",
    "mision",
    "donde",
    "lo",
    "dejaste",
    "quedaste",
    "ahora",
    "per",
    "favore",
    "lavoro",
    "missione",
    "dove",
    "eri",
    "rimasto",
    "hai",
    "interrotto",
    "ora",
    "vai",
    "avanti",
    "o",
    "trabalho",
    "missao",
    "onde",
    "parou",
    "paraste",
    "agora",
    "si",
    "sim",
];

/// CJK resume words (no spaces to split on).
const RESUME_CJK: &[&str] = &["継続", "続けて", "続行", "再開", "继续", "恢复"];

fn fold(c: char) -> char {
    match c {
        'à' | 'â' | 'ä' | 'á' | 'ã' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'î' | 'ï' | 'í' | 'ì' => 'i',
        'ô' | 'ö' | 'ó' | 'ò' | 'õ' => 'o',
        'û' | 'ü' | 'ú' | 'ù' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ß' => 's',
        c => c,
    }
}

/// Lower case, accents removed, every non-alphanumeric character a space.
fn normalize(text: &str) -> String {
    let s: String = text.to_lowercase().chars().map(fold).map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// An unambiguous "continue the work" command ("reprends", "continue",
/// "reprends le travail", "continue là où Claude s'est arrêté", "resume",
/// "mach weiter", "继续"…). NEXUS handles those itself: it runs the resume
/// flow instead of letting the model ask what to resume. Anything with other
/// content ("continue the explanation", "reprends le fichier X", "don't
/// continue") is left to Central.
pub fn is_resume_command(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 || trimmed.lines().count() > 2 {
        return false;
    }
    let n = normalize(trimmed);
    if n.is_empty() {
        return false;
    }
    let tokens: Vec<&str> = n.split(' ').collect();
    // CJK: the whole message is short and contains a resume word.
    if tokens.iter().any(|t| t.chars().any(|c| c as u32 > 0x2E80)) {
        return n.chars().filter(|c| !c.is_whitespace()).count() <= 12 && RESUME_CJK.iter().any(|w| n.contains(w));
    }
    if tokens.len() > 16 {
        return false;
    }
    let padded = format!(" {n} ");
    let has_phrase = RESUME_PHRASES.iter().any(|p| padded.contains(&format!(" {p} ")));
    let has_verb = tokens.iter().any(|t| RESUME_VERBS.contains(t));
    if !has_verb && !has_phrase {
        return false;
    }
    tokens.iter().all(|t| RESUME_VERBS.contains(t) || RESUME_FILLERS.contains(t))
}

// ---------------------------------------------------------------- autonomy

/// Central's autonomy level: the power preset its permissions match (`None` =
/// custom permissions). It is only a preset: MAXIMUM never bypasses the
/// protections (destructive commands, paths outside the workspace and
/// manual capabilities still ask).
pub fn autonomy_level(central: &Agent) -> Option<PowerLevel> {
    central.permissions.power()
}

/// How many times in a row the supervisor may push Central to continue a
/// mission whose state did not change. LOW: NEXUS never continues on its own.
pub fn nudge_limit(level: Option<PowerLevel>) -> u8 {
    match level {
        Some(PowerLevel::Low) => 0,
        None | Some(PowerLevel::Normal) => 2,
        Some(PowerLevel::High) => 4,
        Some(PowerLevel::Maximum) => 6,
    }
}

pub fn autonomy_label(level: Option<PowerLevel>) -> &'static str {
    match level {
        Some(PowerLevel::Low) => "LOW",
        Some(PowerLevel::Normal) => "NORMAL",
        Some(PowerLevel::High) => "HIGH",
        Some(PowerLevel::Maximum) => "MAXIMUM",
        None => "CUSTOM",
    }
}

// ---------------------------------------------------------------- supervisor

/// What the supervisor decided when Central ended a turn during a mission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorAction {
    /// Workers are on it, Central waits for their reports.
    Wait,
    /// The mission has no task yet: execute it (tools or delegation).
    Execute,
    /// Tasks wait for Central's review.
    Review,
    /// Tasks are blocked or parked.
    Unblock,
    /// Tasks failed and nothing else runs.
    Recover,
    /// Everything is done: verify, then close the mission.
    Finish,
}

/// Pure decision from the mission's task statuses.
pub fn decide(statuses: &[TaskStatus]) -> SupervisorAction {
    use TaskStatus::*;
    if statuses.iter().any(|s| matches!(s, InProgress | Queued | Pending)) {
        return SupervisorAction::Wait;
    }
    if statuses.is_empty() {
        return SupervisorAction::Execute;
    }
    if statuses.contains(&Review) {
        return SupervisorAction::Review;
    }
    if statuses.iter().any(|s| matches!(s, Blocked | Waiting)) {
        return SupervisorAction::Unblock;
    }
    if statuses.contains(&Failed) {
        return SupervisorAction::Recover;
    }
    SupervisorAction::Finish
}

#[derive(Debug, Clone, Default)]
struct MissionWatch {
    signature: String,
    nudges: u8,
    stopped: bool,
}

/// Mission blocked on something only the user can give (`report_mission_blocked`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionBlock {
    pub mission_id: String,
    pub reason: String,
    /// `user_decision`, `permission`, `external`, `fatal`.
    pub needs: String,
    pub at: String,
}

/// Outcome of the last automatic resume at open (notice for the UI).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoResumeNotice {
    pub mission_id: Option<String>,
    pub title: Option<String>,
    /// One line: "Verified progress 3/5 tasks · Next: …" or the failure.
    pub summary: String,
    pub ok: bool,
    pub at: String,
}

/// Central runtime state owned by the engine.
#[derive(Default)]
pub(crate) struct CentralRuntime {
    watch: HashMap<String, MissionWatch>,
    pub blocks: HashMap<String, MissionBlock>,
    pub auto_resume: Option<AutoResumeNotice>,
    /// (agent, MCP server) → last automatic check after a failed tool call.
    tool_checks: HashMap<(String, String), Instant>,
}

impl CentralRuntime {
    /// The user wrote to Central: whatever was blocked or exhausted gets a new chance.
    pub fn on_user_message(&mut self) {
        self.blocks.clear();
        self.watch.clear();
    }
}

const TOOL_CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Text of a supervisor nudge.
pub fn nudge_text(action: SupervisorAction, mission: &str, title: &str, details: &str) -> String {
    let what = match action {
        SupervisorAction::Wait => return String::new(),
        SupervisorAction::Execute => format!(
            "Mission {mission} \"{title}\" is still open and has no task. Execute it now: use your tools directly when they can do it, or create agents and tasks. If the work is already done, verify it (read the files back, git status, tool state) and call complete_mission."
        ),
        SupervisorAction::Review => format!(
            "Mission {mission} \"{title}\": tasks wait for your review: {details}. Inspect the results, then approve (update_task status completed) or request_changes."
        ),
        SupervisorAction::Unblock => format!(
            "Mission {mission} \"{title}\": tasks are blocked or parked: {details}. Resolve them now (answer the agent, retry with update_task status queued, reassign or re-plan)."
        ),
        SupervisorAction::Recover => format!(
            "Mission {mission} \"{title}\": tasks failed and nothing else runs: {details}. Retry, re-plan with new tasks, or call fail_mission if the goal cannot be reached."
        ),
        SupervisorAction::Finish => format!(
            "Mission {mission} \"{title}\": every task is finished ({details}). Verify the result (files, tests, git status), update memory, then call complete_mission."
        ),
    };
    format!(
        "[NEXUS SUPERVISOR] Your turn ended while the mission is still running and no completion or blocker was reported.\n{what}\nIf only the user can unblock you (a decision, a permission, a sign-in), call report_mission_blocked with the reason instead of stopping silently."
    )
}

impl Engine {
    /// Called when Central ends a turn (after scheduling). Pushes it to continue
    /// a mission that would otherwise stall, within the autonomy level's limit;
    /// every decision is journaled.
    pub(crate) fn supervise_central(&mut self, agent: &str) -> Result<()> {
        if agent != CENTRAL_ID || self.emergency || !self.autopilot || self.store.read_only() {
            return Ok(());
        }
        match self.sessions.get(CENTRAL_ID) {
            Some(l) if !l.busy && !l.stopping => {}
            _ => return Ok(()),
        }
        if self.permissions.any_for(CENTRAL_ID)
            || !self.store.undelivered_for(CENTRAL_ID)?.is_empty()
            || self.user_requests.values().any(|r| r.agent_id == CENTRAL_ID)
        {
            return Ok(());
        }
        let Some(mid) = self.store.active_mission_ids()?.into_iter().next() else { return Ok(()) };
        let Some(m) = self.store.get_mission(&mid)? else { return Ok(()) };
        if !m.status.is_running() || m.status == MissionStatus::Queued {
            return Ok(());
        }
        let tasks = self.store.list_tasks(&TaskFilter { mission_id: Some(mid.clone()), ..Default::default() })?;
        let statuses: Vec<TaskStatus> = tasks.iter().map(|t| t.status).collect();
        let action = decide(&statuses);
        if action == SupervisorAction::Wait {
            return Ok(());
        }
        let signature = format!(
            "{action:?}|{}",
            tasks.iter().map(|t| format!("{}:{}", t.id, t.status.as_str())).collect::<Vec<_>>().join(",")
        );
        // Blocked on the user (tool call or a question in the last answer): wait for the user.
        if self.central.blocks.contains_key(&mid) {
            return Ok(());
        }
        if self.central_asked_the_user() {
            self.journal_supervisor(&mid, action, "waiting for the user: Central's last answer is a question", None);
            return Ok(());
        }
        let level = self.store.get_agent(CENTRAL_ID)?.and_then(|a| autonomy_level(&a));
        let limit = nudge_limit(level);
        let w = self.central.watch.entry(mid.clone()).or_default();
        if w.signature != signature {
            w.signature = signature;
            w.nudges = 0;
            w.stopped = false;
        }
        if w.nudges >= limit {
            if !w.stopped {
                w.stopped = true;
                let why = if limit == 0 {
                    "autonomy LOW: NEXUS does not continue missions on its own; waiting for the user".to_string()
                } else {
                    format!("no progress after {limit} reminder(s) on the same state; waiting for the user")
                };
                self.journal_supervisor(&mid, action, &why, Some(Severity::Warning));
            }
            return Ok(());
        }
        w.nudges += 1;
        let n = w.nudges;
        let details: Vec<String> = tasks
            .iter()
            .filter(|t| match action {
                SupervisorAction::Review => t.status == TaskStatus::Review,
                SupervisorAction::Unblock => matches!(t.status, TaskStatus::Blocked | TaskStatus::Waiting),
                SupervisorAction::Recover => t.status == TaskStatus::Failed,
                _ => true,
            })
            .take(8)
            .map(|t| {
                format!(
                    "{} \"{}\" {}{}",
                    t.id,
                    t.title,
                    t.status.as_str(),
                    t.status_reason.as_deref().map(|r| format!(" ({})", first_line(r, 120))).unwrap_or_default()
                )
            })
            .collect();
        let text = nudge_text(action, &mid, &m.title, &details.join("; "));
        self.journal_supervisor(&mid, action, &format!("reminder {n}/{limit} sent to Central"), None);
        self.post_message(SYSTEM_ID, CENTRAL_ID, pcc_core::MessageKind::System, &text, None, Some(mid))?;
        Ok(())
    }

    fn journal_supervisor(&self, mission: &str, action: SupervisorAction, outcome: &str, severity: Option<Severity>) {
        let name = if severity.is_some() { "supervisor.stopped" } else { "supervisor.decision" };
        let mut e = Event::new(
            EventKind::SystemNotice,
            format!("Mission supervisor ({mission}): {outcome}"),
            json!({"missionId": mission, "action": action, "outcome": outcome}),
        )
        .agent(CENTRAL_ID)
        .mission(Some(mission.to_string()))
        .named(name)
        .with_source("supervisor");
        if let Some(s) = severity {
            e = e.with_severity(s);
        }
        self.emit(e);
    }

    /// Central's last answer ends with a question to the user.
    fn central_asked_the_user(&self) -> bool {
        let Ok(logs) = self.store.list_logs(CENTRAL_ID, None, 40) else { return false };
        let mut last_text = None;
        for l in logs.iter().rev() {
            match l.kind {
                LogKind::AssistantText if !l.text.starts_with("↳ ") => {
                    last_text = Some(l.text.trim().to_string());
                    break;
                }
                LogKind::Input => break,
                _ => {}
            }
        }
        last_text.is_some_and(|t| t.ends_with('?') || t.ends_with('？'))
    }

    /// `report_mission_blocked`: the supervisor stops pushing until the user acts.
    pub fn report_mission_blocked(&mut self, mission: Option<&str>, reason: &str, needs: &str) -> Result<MissionBlock> {
        let mid = match mission {
            Some(m) => m.to_string(),
            None => self
                .store
                .active_mission_ids()?
                .into_iter()
                .next()
                .ok_or_else(|| pcc_core::Error::invalid("no mission is running"))?,
        };
        if reason.trim().is_empty() {
            return Err(pcc_core::Error::invalid("give the reason the mission is blocked"));
        }
        let needs = match needs {
            "" => "user_decision",
            n @ ("user_decision" | "permission" | "external" | "fatal") => n,
            other => return Err(pcc_core::Error::invalid(format!("unknown need `{other}`"))),
        };
        let b = MissionBlock {
            mission_id: mid.clone(),
            reason: reason.trim().to_string(),
            needs: needs.to_string(),
            at: pcc_core::now(),
        };
        self.central.blocks.insert(mid.clone(), b.clone());
        self.emit(
            Event::new(
                EventKind::SystemNotice,
                format!("Mission {mid} waits for the user: {}", first_line(reason, 160)),
                json!(b),
            )
            .agent(CENTRAL_ID)
            .mission(Some(mid))
            .named("mission.blocked")
            .with_severity(Severity::Warning)
            .with_source("central"),
        );
        Ok(b)
    }

    pub fn mission_blocks(&self) -> Vec<MissionBlock> {
        self.central.blocks.values().cloned().collect()
    }

    // ------------------------------------------------------------ tool failure recovery

    /// An MCP tool call returned an error: before anybody involves the user,
    /// NEXUS asks the session for the server's status. A failed server is then
    /// reconnected (`mcp_reconnect`), its tools are listed again on the next
    /// status, and the agent is told it can retry (`update_mcp_health`).
    pub(crate) fn on_mcp_tool_failure(&mut self, agent: &str, tool: &str, error: &str) {
        let Some(server) = tool.strip_prefix("mcp__").and_then(|r| r.split("__").next()) else { return };
        if server == crate::launch::PCC_SERVER || server.is_empty() {
            return;
        }
        if !self.store.settings().mission_recovery.auto_reconnect_mcp {
            return;
        }
        let key = (agent.to_string(), server.to_string());
        let now = Instant::now();
        if self.central.tool_checks.get(&key).is_some_and(|t| now.duration_since(*t) < TOOL_CHECK_INTERVAL) {
            return;
        }
        if self.rec.pending.values().any(|p| p.agent == agent && matches!(p.purpose, ControlPurpose::McpStatus)) {
            return;
        }
        self.central.tool_checks.insert(key, now);
        let sent = self.send_tracked_control(agent, "mcp_status", json!({}), ControlPurpose::McpStatus, now);
        let row = self.sessions.get(agent).map(|l| l.session_row).unwrap_or(0);
        self.log(
            agent,
            row,
            LogKind::System,
            &format!(
                "NEXUS: {tool} failed — checking MCP server {server} (automatic recovery: status → reconnect → tools listed again → you are told when to retry){}",
                if sent { "" } else { "; the check could not be sent" }
            ),
        );
        self.emit(
            Event::new(
                EventKind::McpChanged,
                format!("{agent}: {tool} failed; NEXUS is checking {server}"),
                json!({"agentId": agent, "server": server, "tool": tool, "error": first_line(error, 300), "checkSent": sent}),
            )
            .agent(agent)
            .named("mcp.toolFailed")
            .with_severity(Severity::Warning)
            .with_source("recovery"),
        );
    }

    /// Whether an agent (by status) still needs NEXUS to bring it back.
    pub(crate) fn needs_restart(status: AgentStatus) -> bool {
        matches!(status, AgentStatus::Crashed | AgentStatus::Disconnected | AgentStatus::Offline | AgentStatus::Stopped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_commands_in_several_languages() {
        for s in [
            "reprends",
            "Reprends !",
            "continue",
            "Continue.",
            "reprends le travail",
            "continue là où Claude s'est arrêté",
            "Continue là où tu t'es arrêté stp",
            "reprends la mission s'il te plaît",
            "on reprend",
            "resume",
            "please continue where you left off",
            "go on",
            "carry on with the work",
            "keep going",
            "mach weiter",
            "bitte weiter",
            "continúa por favor",
            "riprendi il lavoro",
            "retome o trabalho",
            "继续",
            "続けて",
            "再開して",
            "ok continue",
            "tu peux reprendre ?",
        ] {
            assert!(is_resume_command(s), "{s} should be a resume command");
        }
    }

    #[test]
    fn other_requests_are_left_to_central() {
        for s in [
            "",
            "continue the explanation of the parser",
            "reprends le fichier main.rs",
            "don't continue",
            "ne continue pas",
            "stop",
            "what is a mission?",
            "continue to refactor the login module and add tests",
            "继续解释这个函数的作用是什么然后写测试代码吧",
            "resume.pdf is in the downloads folder",
        ] {
            assert!(!is_resume_command(s), "{s} should not be a resume command");
        }
    }

    #[test]
    fn supervisor_decisions() {
        use TaskStatus::*;
        assert_eq!(decide(&[]), SupervisorAction::Execute);
        assert_eq!(decide(&[Completed, InProgress]), SupervisorAction::Wait);
        assert_eq!(decide(&[Completed, Pending]), SupervisorAction::Wait);
        assert_eq!(decide(&[Completed, Review]), SupervisorAction::Review);
        assert_eq!(decide(&[Blocked, Failed]), SupervisorAction::Unblock);
        assert_eq!(decide(&[Completed, Failed]), SupervisorAction::Recover);
        assert_eq!(decide(&[Completed, Cancelled]), SupervisorAction::Finish);
        assert!(nudge_text(SupervisorAction::Finish, "M-1", "x", "").contains("complete_mission"));
        assert!(nudge_text(SupervisorAction::Wait, "M-1", "x", "").is_empty());
    }

    #[test]
    fn autonomy_maps_onto_the_power_presets() {
        let mut a = pcc_core::Agent {
            id: CENTRAL_ID.into(),
            name: "Central".into(),
            kind: pcc_core::AgentKind::Central,
            provider: pcc_core::CLAUDE_CODE_PROVIDER.into(),
            role: String::new(),
            instructions: String::new(),
            status: AgentStatus::Offline,
            model: None,
            permissions: pcc_core::PermissionSet::central(),
            connections: vec![],
            isolation: pcc_core::Isolation::Shared,
            workdir: String::new(),
            branch: None,
            current_task: None,
            current_action: None,
            progress: None,
            claude_session_id: None,
            total_cost_usd: 0.0,
            profile: Default::default(),
            created_by: SYSTEM_ID.into(),
            created_at: String::new(),
            updated_at: String::new(),
            parent_agent: None,
            rank: pcc_core::AgentRank::Commander,
            paused_at: None,
        };
        assert_eq!(autonomy_level(&a), None);
        assert_eq!(autonomy_label(autonomy_level(&a)), "CUSTOM");
        assert_eq!(nudge_limit(None), 2);
        for (level, limit) in
            [(PowerLevel::Low, 0), (PowerLevel::Normal, 2), (PowerLevel::High, 4), (PowerLevel::Maximum, 6)]
        {
            a.permissions = pcc_core::PermissionSet::preset(level);
            assert_eq!(autonomy_level(&a), Some(level));
            assert_eq!(nudge_limit(autonomy_level(&a)), limit);
        }
    }
}
