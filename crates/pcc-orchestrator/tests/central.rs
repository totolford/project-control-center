//! Central as an execution agent, against the scripted Claude Code double
//! (`examples/fake_claude.rs`): the RESUME pre-classifier and resume service
//! with a verified report from a real git repository, the mission supervisor
//! (reminders, limits, blockers, autonomy LOW), automatic resume after an
//! engine restart and the automatic check of a failed MCP tool call.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use pcc_core::{
    AgentStatus, EventBus, LogKind, Mission, MissionStatus, PowerLevel, Priority, Task, TaskResult, TaskStatus,
};
use pcc_orchestrator::Orchestrator;
use pcc_store::{JournalFilter, ProjectStore};

fn fake_claude() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap().join("examples");
    let name = if cfg!(windows) { "fake_claude.exe" } else { "fake_claude" };
    let p = dir.join(name);
    assert!(p.is_file(), "build examples first: {}", p.display());
    p
}

async fn wait_for<F: FnMut() -> bool>(what: &str, mut f: F) {
    let start = Instant::now();
    while !f() {
        if start.elapsed() > Duration::from_secs(120) {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn open_store(store: ProjectStore) -> Orchestrator {
    std::env::set_var("NEXUS_ORPHAN_SCAN", "off");
    Orchestrator::open(store, EventBus::new(), Some(fake_claude()), vec!["generic".into()]).unwrap()
}

fn inputs(store: &ProjectStore, agent: &str, needle: &str) -> Vec<String> {
    store
        .list_logs(agent, None, 1000)
        .unwrap()
        .into_iter()
        .filter(|l| l.kind == LogKind::Input && l.text.contains(needle))
        .map(|l| l.text)
        .collect()
}

fn logged(store: &ProjectStore, agent: &str, kind: LogKind, needle: &str) -> bool {
    store.list_logs(agent, None, 1000).unwrap().iter().any(|l| l.kind == kind && l.text.contains(needle))
}

fn journal(store: &ProjectStore, name: &str) -> Vec<pcc_core::Event> {
    store.journal(&JournalFilter { name: Some(name.into()), ..Default::default() }).unwrap()
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(["-c", "user.name=NEXUS test", "-c", "user.email=test@nexus.invalid"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn mission(id: &str, title: &str, status: MissionStatus, updated: &str) -> Mission {
    Mission {
        id: id.into(),
        title: title.into(),
        prompt: title.into(),
        status,
        summary: None,
        created_at: updated.into(),
        updated_at: updated.into(),
        completed_at: None,
        priority: Priority::Normal,
        model: None,
        skills: vec![],
        mcp: vec![],
        connections: vec![],
        analysis: None,
        started_at: Some(updated.into()),
        archived_at: None,
    }
}

fn task(id: &str, mission: &str, status: TaskStatus, files: &[&str]) -> Task {
    let now = pcc_core::now();
    Task {
        id: id.into(),
        mission_id: Some(mission.into()),
        title: format!("Step {id}"),
        description: "Do it".into(),
        status,
        priority: Priority::Normal,
        agent: Some("builder".into()),
        dependencies: vec![],
        requires_review: false,
        progress: None,
        status_reason: None,
        result: (status == TaskStatus::Completed).then(|| TaskResult {
            summary: format!("done {id}"),
            files_changed: files.iter().map(|f| f.to_string()).collect(),
            ..Default::default()
        }),
        created_by: "central".into(),
        created_at: now.clone(),
        updated_at: now,
        started_at: None,
        completed_at: None,
        skills: vec![],
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_command_continues_the_running_mission_from_a_verified_report() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    git(root, &["init", "-q"]);
    std::fs::write(root.join("README.md"), "x").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "init"]);

    let store = ProjectStore::create(root, "Test").unwrap();
    let mut s = store.settings();
    s.use_worktrees = false;
    store.save_settings(s).unwrap();
    let o = open_store(store);
    let store = o.store.clone();
    // An older mission that finished, and the one that is running.
    store.upsert_mission(&mission("M-0001", "Old work", MissionStatus::Completed, "2026-01-01T10:00:00Z")).unwrap();
    store
        .upsert_mission(&mission("M-0002", "Port the scripts", MissionStatus::Active, "2026-01-02T10:00:00Z"))
        .unwrap();
    o.lock()
        .await
        .create_agent(
            pcc_orchestrator::dto::AgentSpec {
                id: Some("builder".into()),
                name: "Builder".into(),
                role: "Builds".into(),
                isolation: Some("shared".into()),
                ..Default::default()
            },
            "user",
        )
        .unwrap();
    // Two tasks completed (one of them reported a file that is not on disk), one
    // interrupted in progress, one waiting.
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/a.lua"), "a").unwrap();
    std::fs::write(root.join("src/c.lua"), "c").unwrap();
    store.upsert_task(&task("TASK-0001", "M-0002", TaskStatus::Completed, &["src/a.lua", "src/b.lua"])).unwrap();
    store.upsert_task(&task("TASK-0002", "M-0002", TaskStatus::Completed, &["src/c.lua"])).unwrap();
    let mut t3 = task("TASK-0003", "M-0002", TaskStatus::InProgress, &[]);
    t3.started_at = Some(pcc_core::now());
    store.upsert_task(&t3).unwrap();
    store.upsert_task(&task("TASK-0004", "M-0002", TaskStatus::Pending, &[])).unwrap();
    let mut b = store.agent("builder").unwrap();
    b.current_task = Some("TASK-0003".into());
    store.upsert_agent(&b).unwrap();

    // The report: the running mission (not the finished one), verified facts.
    {
        let e = o.lock().await;
        assert_eq!(e.resume_candidate().unwrap().as_deref(), Some("M-0002"));
        let r = e.resume_report("M-0002", "user").unwrap();
        assert_eq!((r.tasks_total, r.tasks_completed, r.tasks_verified), (4, 2, 1));
        assert_eq!((r.files_expected, r.files_present), (3, 2));
        assert_eq!(r.files_missing, vec!["src/b.lua (TASK-0001)".to_string()]);
        assert!(r.uncommitted.iter().any(|f| f == "src/a.lua"), "{:?}", r.uncommitted);
        assert!(r.branch.is_some() && r.head.is_some());
        assert!(r.next_action.contains("TASK-0001") && r.next_action.contains("missing"), "{}", r.next_action);
        assert_eq!(r.remaining.len(), 2);
        let text = r.render();
        assert!(text.starts_with("[NEXUS RESUME REPORT]\n"));
        assert!(text
            .contains("Verified progress: 1/4 tasks completed and verified (1 completed task(s) with missing files)"));
        assert!(text.contains("Mission: M-0002 \"Port the scripts\" (active)"));
        assert!(text.contains("Next action: Check the files reported by TASK-0001"));
    }

    // "reprends": NEXUS runs the resume flow itself; Central gets the user's
    // words and the verified report in the same turn.
    let msg = o.lock().await.send_user_message("central", "reprends").unwrap();
    assert_eq!(msg.body, "reprends");
    wait_for("report delivered to Central", || !inputs(&store, "central", "[NEXUS RESUME REPORT]").is_empty()).await;
    let turn = inputs(&store, "central", "[NEXUS RESUME REPORT]").remove(0);
    assert!(turn.contains("from user"), "{turn}");
    assert!(turn.contains("reprends"));
    assert!(turn.contains("Previous state: running"));
    assert!(turn.contains("Claude: Central session"), "{turn}");
    // The worker whose task was interrupted is brought back and briefed.
    wait_for("builder briefed", || !inputs(&store, "builder", "[RECOVERY]").is_empty()).await;
    assert!(turn.contains("Builder (specialist)"), "{turn}");
    let resumed = journal(&store, "mission.resumed");
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].mission_id.as_deref(), Some("M-0002"));
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_with_nothing_running_gives_central_the_facts() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
    let store = o.store.clone();
    o.lock().await.send_user_message("central", "continue là où Claude s'est arrêté").unwrap();
    wait_for("facts delivered", || !inputs(&store, "central", "Nothing to resume").is_empty()).await;
    let turn = inputs(&store, "central", "Nothing to resume").remove(0);
    assert!(turn.contains("continue là où Claude s'est arrêté"));
    assert!(turn.contains("Last mission: none in this project"));
    // An ordinary message is not intercepted.
    o.lock().await.send_user_message("central", "continue the explanation please").unwrap();
    wait_for("plain message", || !inputs(&store, "central", "continue the explanation").is_empty()).await;
    assert_eq!(inputs(&store, "central", "[NEXUS RESUME REPORT]").len(), 1);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn supervisor_reminds_central_within_limits_and_stops_on_a_blocker() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
    let store = o.store.clone();
    // Central (fake) acknowledges without doing anything: the mission would stall.
    o.lock().await.create_mission("IDLE: prepare the release notes", None).unwrap();
    wait_for("supervisor gives up after the NORMAL limit", || !journal(&store, "supervisor.stopped").is_empty()).await;
    let reminders = inputs(&store, "central", "[NEXUS SUPERVISOR]");
    assert_eq!(reminders.len(), 2, "custom/NORMAL autonomy allows 2 reminders on the same state");
    assert!(reminders[0].contains("has no task") && reminders[0].contains("report_mission_blocked"));
    assert!(journal(&store, "supervisor.stopped")[0].summary.contains("no progress after 2 reminder(s)"));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(inputs(&store, "central", "[NEXUS SUPERVISOR]").len(), 2, "no loop");

    // The user answers; Central reports a blocker: no more reminders.
    o.lock().await.send_user_message("central", "REPORT BLOCKED if you need me").unwrap();
    wait_for("blocker reported", || logged(&store, "central", LogKind::AssistantText, "blocked: Mission M-0001")).await;
    wait_for("Central idle", || store.agent("central").unwrap().status == AgentStatus::Waiting).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(inputs(&store, "central", "[NEXUS SUPERVISOR]").len(), 2);
    let blocks = o.lock().await.mission_blocks();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].needs, "user_decision");
    assert_eq!(journal(&store, "mission.blocked").len(), 1);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn low_autonomy_never_pushes_central() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
    let store = o.store.clone();
    o.lock().await.apply_power("central", PowerLevel::Low).unwrap();
    o.lock().await.create_mission("IDLE: prepare the release notes", None).unwrap();
    wait_for("supervisor decision", || !journal(&store, "supervisor.stopped").is_empty()).await;
    assert!(journal(&store, "supervisor.stopped")[0].summary.contains("autonomy LOW"));
    assert!(inputs(&store, "central", "[NEXUS SUPERVISOR]").is_empty());
    o.close().await;
}

fn kill_pid(pid: u32) {
    if cfg!(windows) {
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    } else {
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_mission_resumes_automatically_after_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let central_pid;
    {
        let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
        let store = o.store.clone();
        o.lock().await.create_mission("HANG while preparing the release", Some("Ship it".into())).unwrap();
        wait_for("Central's long call", || logged(&store, "central", LogKind::ToolUse, "npm run build")).await;
        central_pid = o.lock().await.session_pids().into_iter().find(|(a, _)| a == "central").unwrap().1;
        // NEXUS dies (no shutdown).
    }
    kill_pid(central_pid);

    // Auto-resume is on by default: no dialog, a notice and a briefed Central.
    let o = open_store(ProjectStore::open(tmp.path()).unwrap());
    let store = o.store.clone();
    let snap = o.lock().await.snapshot().unwrap();
    let info = snap.recovery.expect("notice");
    assert!(info.missions.is_empty() && info.agents.is_empty(), "{info:?}");
    let notice = info.auto_resumed.expect("auto-resume notice");
    assert!(notice.ok, "{notice:?}");
    assert_eq!(notice.mission_id.as_deref(), Some("M-0001"));
    assert!(notice.summary.contains("verified progress 0/0 tasks"), "{}", notice.summary);
    assert!(o.lock().await.recovery_state().interrupted_missions.is_empty());
    wait_for("report delivered", || !inputs(&store, "central", "[NEXUS RESUME REPORT]").is_empty()).await;
    let turn = inputs(&store, "central", "[NEXUS RESUME REPORT]").remove(0);
    assert!(turn.contains("Control Center recovered."), "{turn}");
    assert!(turn.contains("ended unexpectedly"), "{turn}");
    assert!(turn.contains("Claude: Central session recovered (--resume)"), "{turn}");
    assert!(turn.contains("Last action: central — Running Long build"), "{turn}");
    let report = o.lock().await.crash_reports().into_iter().find(|r| r.component == "nexus").unwrap();
    assert!(report.restarted.iter().any(|r| r.contains("M-0001: resumed (auto)")), "{:?}", report.restarted);
    // Dismissing the notice clears it.
    o.lock().await.discard_recovery().unwrap();
    assert!(o.lock().await.snapshot().unwrap().recovery.is_none());
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_mcp_tool_calls_trigger_an_automatic_server_check() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
    let store = o.store.clone();
    let agent = |id: &str| pcc_orchestrator::dto::AgentSpec {
        id: Some(id.into()),
        name: id.into(),
        role: "Operations".into(),
        isolation: Some("shared".into()),
        ..Default::default()
    };
    {
        let mut e = o.lock().await;
        e.create_agent(agent("ops"), "user").unwrap();
        e.send_user_message("ops", "MCP FAIL now").unwrap();
    }
    wait_for("check started", || logged(&store, "ops", LogKind::System, "checking MCP server roblox")).await;
    let ev = journal(&store, "mcp.toolFailed");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].agent_id.as_deref(), Some("ops"));

    // Settings → Missions → Recovery → auto-reconnect off: NEXUS leaves it alone.
    let mut s = store.settings();
    s.mission_recovery.auto_reconnect_mcp = false;
    store.save_settings(s).unwrap();
    {
        let mut e = o.lock().await;
        e.create_agent(agent("quiet"), "user").unwrap();
        e.send_user_message("quiet", "MCP FAIL later").unwrap();
    }
    wait_for("quiet turn", || logged(&store, "quiet", LogKind::AssistantText, "the MCP call failed")).await;
    assert!(!logged(&store, "quiet", LogKind::System, "checking MCP server"), "auto-reconnect off");
    o.close().await;
}
