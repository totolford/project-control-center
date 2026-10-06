//! Recovery against the scripted Claude Code double (`examples/fake_claude.rs`):
//! real processes killed for real, watchdog decisions, mission checkpoints and
//! interrupted missions across an engine restart.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use pcc_core::{AgentStatus, EventBus, LogKind};
use pcc_orchestrator::Orchestrator;
use pcc_recovery::Verdict;
use pcc_store::ProjectStore;

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
    // The startup orphan scan queries every claude/node process: not in tests.
    std::env::set_var("NEXUS_ORPHAN_SCAN", "off");
    Orchestrator::open(store, EventBus::new(), Some(fake_claude()), vec!["generic".into()]).unwrap()
}

fn kill_pid(pid: u32) {
    if cfg!(windows) {
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    } else {
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

fn logged(store: &ProjectStore, agent: &str, kind: LogKind, needle: &str) -> bool {
    store.list_logs(agent, None, 500).unwrap().iter().any(|l| l.kind == kind && l.text.contains(needle))
}

async fn ops_agent(o: &Orchestrator, first: &str) {
    let mut e = o.lock().await;
    e.create_agent(
        pcc_orchestrator::dto::AgentSpec {
            name: "Ops".into(),
            role: "Operations".into(),
            isolation: Some("shared".into()),
            ..Default::default()
        },
        "user",
    )
    .unwrap();
    e.send_user_message("ops", first).unwrap();
}

async fn pid_of(o: &Orchestrator, agent: &str) -> u32 {
    o.lock().await.recovery_state().watch.iter().find(|w| w.agent_id == agent).map(|w| w.pid).expect("watched session")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn long_tool_call_is_never_killed_and_a_crash_mid_turn_is_resumed() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
    let store = o.store.clone();
    ops_agent(&o, "HANG: build the project").await;
    wait_for("the long Bash call", || logged(&store, "ops", LogKind::ToolUse, "npm run build")).await;
    let pid = pid_of(&o, "ops").await;

    // Six hours later the Bash call still runs: never treated as stuck.
    o.lock().await.watchdog_tick(Instant::now() + Duration::from_secs(6 * 3600)).unwrap();
    {
        let e = o.lock().await;
        let st = e.recovery_state();
        let w = st.watch.iter().find(|w| w.agent_id == "ops").unwrap();
        assert_eq!(w.verdict, Some(Verdict::LongToolCall));
        assert!(w.reason.as_deref().unwrap().contains("Bash"));
        assert!(!w.soft_recovery_sent);
        assert_eq!(w.last_action.as_ref().unwrap().description, "Running Long build");
    }
    assert!(pcc_recovery::sys::pid_alive(pid));
    assert!(store.agent("ops").unwrap().status.is_live());

    // The process dies mid-turn (killed from outside).
    kill_pid(pid);
    wait_for("crash detected", || store.agent("ops").unwrap().status == AgentStatus::Crashed).await;
    let reports = o.lock().await.crash_reports();
    let r = reports.iter().find(|r| r.agent_id.as_deref() == Some("ops")).expect("crash report");
    assert_eq!(r.component, "claude-session");
    assert!(r.what_happened.contains("while a turn was running"), "{}", r.what_happened);
    assert!(r.lost.iter().any(|l| l.contains("Bash")));
    assert!(!r.acknowledged);

    // The watchdog restarts it with --resume and a precise brief.
    o.lock().await.watchdog_tick(Instant::now()).unwrap();
    wait_for("resumed session", || store.agent("ops").unwrap().status.is_live()).await;
    wait_for("brief delivered", || logged(&store, "ops", LogKind::Input, "Your Bash call had not returned")).await;
    assert!(logged(&store, "ops", LogKind::Input, "Last action recorded: Running Long build"));
    let new_pid = pid_of(&o, "ops").await;
    assert_ne!(new_pid, pid);
    let r = o.lock().await.crash_reports().into_iter().find(|r| r.agent_id.as_deref() == Some("ops")).unwrap();
    assert!(r.restarted.iter().any(|x| x.contains("--resume")), "{:?}", r.restarted);
    let rec = o.lock().await.project_processes().into_iter().find(|p| p.key == "claude:ops").unwrap();
    assert_eq!(rec.pid, Some(new_pid));
    assert_eq!(rec.restart_count, 1);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn silent_turn_gets_soft_recovery_then_a_graceful_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
    let store = o.store.clone();
    ops_agent(&o, "SILENT please").await;
    wait_for("silent turn", || logged(&store, "ops", LogKind::AssistantText, "thinking")).await;
    let pid = pid_of(&o, "ops").await;
    let t0 = Instant::now();

    // A few minutes of silence is normal work.
    o.lock().await.watchdog_tick(t0 + Duration::from_secs(120)).unwrap();
    assert_eq!(o.lock().await.recovery_state().watch[0].verdict, Some(Verdict::Busy));

    // 20 minutes without output, no tool, no CPU: interrupt first.
    o.lock().await.watchdog_tick(t0 + Duration::from_secs(20 * 60)).unwrap();
    let st = o.lock().await.recovery_state();
    let w = st.watch.iter().find(|w| w.agent_id == "ops").unwrap();
    assert_eq!(w.verdict, Some(Verdict::Stalled));
    assert!(w.soft_recovery_sent);
    assert!(pcc_recovery::sys::pid_alive(pid), "a soft recovery never kills");
    assert!(logged(&store, "ops", LogKind::System, "soft recovery"));

    // Still silent after the grace period: graceful restart with --resume.
    o.lock().await.watchdog_tick(t0 + Duration::from_secs(24 * 60)).unwrap();
    wait_for("restart brief", || logged(&store, "ops", LogKind::Input, "stopped answering")).await;
    assert_ne!(pid_of(&o, "ops").await, pid);
    let reports = o.lock().await.crash_reports();
    let r = reports.iter().find(|r| r.title.contains("restarted by the watchdog")).expect("watchdog report");
    assert!(r.preserved.iter().any(|p| p.contains("Claude conversation")));
    let rec = o.lock().await.project_processes().into_iter().find(|p| p.key == "claude:ops").unwrap();
    assert!(rec.restarts.iter().any(|x| x.outcome == "interrupted"));
    assert!(rec.restarts.iter().any(|x| x.outcome.contains("--resume")));
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_mission_is_described_precisely_after_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let central_pid;
    {
        let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
        let store = o.store.clone();
        o.lock().await.create_mission("HANG while preparing the release", Some("Ship it".into())).unwrap();
        wait_for("Central's long call", || logged(&store, "central", LogKind::ToolUse, "npm run build")).await;
        central_pid = pid_of(&o, "central").await;
        // Checkpoint files of the mission.
        let dir = tmp.path().join(".agent-project/missions/M-0001");
        assert!(dir.join("mission.json").is_file());
        assert!(dir.join("checkpoints/checkpoint-001.json").is_file());
        assert!(dir.join("checkpoints/current.json").is_file());
        let cps = o.lock().await.mission_checkpoints("M-0001");
        assert_eq!(cps.last().unwrap().reason, "mission sent to Central");
        // A file written after the last checkpoint, then NEXUS dies (no shutdown).
        std::thread::sleep(Duration::from_millis(30));
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/release.txt"), "v1").unwrap();
    }
    kill_pid(central_pid);

    let o = open_store(ProjectStore::open(tmp.path()).unwrap());
    let store = o.store.clone();
    let snap = o.lock().await.snapshot().unwrap();
    let info = snap.recovery.expect("recovery offered");
    assert!(info.previous_run.unwrap().contains("unexpectedly"));
    let m = info.missions.iter().find(|m| m.mission_id == "M-0001").expect("interrupted mission");
    assert_eq!(m.title, "Ship it");
    let last = m.last_action.as_ref().expect("last action from the transcript");
    assert_eq!((last.agent_id.as_str(), last.description.as_str()), ("central", "Running Long build"));
    assert_eq!(m.files_since_checkpoint, vec!["src/release.txt".to_string()]);
    assert!(m.files_note.contains("1 file(s) written since the last checkpoint"), "{}", m.files_note);
    assert!(m.brief.contains("Last action: central — Running Long build"), "{}", m.brief);
    let report = o.lock().await.crash_reports().into_iter().find(|r| r.component == "nexus").expect("startup report");
    assert_eq!(report.title, "NEXUS recovered from an unexpected failure");
    assert!(report.details.iter().any(|d| d.contains("src/release.txt")));

    // Resume: Central gets the same precise brief.
    o.lock().await.resume_mission("M-0001").unwrap();
    wait_for("recovery brief", || logged(&store, "central", LogKind::Input, "[RECOVERY] Mission M-0001")).await;
    assert!(logged(&store, "central", LogKind::Input, "src/release.txt"));
    assert!(o.lock().await.recovery_state().interrupted_missions.is_empty());
    let cps = o.lock().await.mission_checkpoints("M-0001");
    assert_eq!(cps[0].reason, "resumed after interruption");
    let report = o.lock().await.crash_reports().into_iter().find(|r| r.component == "nexus").unwrap();
    assert!(report.restarted.iter().any(|r| r.contains("M-0001")), "{:?}", report.restarted);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clean_close_is_not_reported_as_a_crash() {
    let tmp = tempfile::tempdir().unwrap();
    {
        let o = open_store(ProjectStore::create(tmp.path(), "Test").unwrap());
        o.close().await;
    }
    let o = open_store(ProjectStore::open(tmp.path()).unwrap());
    let st = o.lock().await.recovery_state();
    assert!(matches!(st.previous_run, pcc_recovery::PreviousRun::Clean { .. }));
    assert!(o.lock().await.crash_reports().is_empty());
    o.close().await;
}
