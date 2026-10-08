//! End-to-end orchestration against a scripted Claude Code double
//! (`examples/fake_claude.rs`): real processes, real stdin/stdout protocol,
//! real persistence.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use pcc_core::{AgentStatus, EventBus, LogKind, MissionStatus, PermissionDecision, TaskStatus};
use pcc_orchestrator::Orchestrator;
use pcc_store::{ProjectStore, TaskFilter};

fn fake_claude() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap().join("examples");
    let name = if cfg!(windows) { "fake_claude.exe" } else { "fake_claude" };
    let p = dir.join(name);
    assert!(p.is_file(), "build examples first: {}", p.display());
    p
}

/// Generous timeout: the fast path takes ~1 s, but the first run after a
/// rebuild can be slow on Windows (antivirus scan of the new fake_claude.exe,
/// parallel tests spawning processes and git worktrees).
async fn wait_for<F: FnMut() -> bool>(what: &str, mut f: F) {
    let start = Instant::now();
    while !f() {
        if start.elapsed() > Duration::from_secs(120) {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn open(tmp: &tempfile::TempDir) -> Orchestrator {
    let store = ProjectStore::create(tmp.path(), "Test").unwrap();
    Orchestrator::open(store, EventBus::new(), Some(fake_claude()), vec!["generic".into()]).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mission_runs_through_central_and_worker() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    let mut events = o.bus.subscribe();

    o.lock().await.create_mission("Build the thing", None).unwrap();

    wait_for("mission completion", || {
        store.get_mission("M-0001").unwrap().map(|m| m.status) == Some(MissionStatus::Completed)
    })
    .await;

    let tasks = store.list_tasks(&TaskFilter::default()).unwrap();
    assert_eq!(tasks.len(), 2);
    assert!(tasks.iter().all(|t| t.status == TaskStatus::Completed));
    assert_eq!(tasks[1].dependencies, vec!["TASK-0001".to_string()]);
    // The dependent task started only after the first one completed.
    assert!(tasks[1].started_at.as_deref().unwrap() >= tasks[0].completed_at.as_deref().unwrap());
    assert_eq!(tasks[0].result.as_ref().unwrap().summary, "done TASK-0001");
    assert_eq!(tasks[0].mission_id.as_deref(), Some("M-0001"));

    let builder = store.agent("builder").unwrap();
    assert_eq!(builder.created_by, "central");
    assert!(builder.total_cost_usd > 0.0);

    // Every turn was recorded as AI usage, attributed to agent, task and mission.
    let usage = store.usage(&pcc_store::UsageFilter::default()).unwrap();
    assert!(usage.iter().any(
        |r| r.agent_id.as_deref() == Some("central") && r.category == pcc_core::usage::UsageCategory::CentralAgent
    ));
    let work: Vec<_> = usage.iter().filter(|r| r.agent_id.as_deref() == Some("builder")).collect();
    assert!(work.iter().any(|r| r.mission_id.as_deref() == Some("M-0001") && r.task_id.is_some()));
    // Per-turn deltas of the cumulative counters: 10 input / 5 output tokens each.
    assert!(work.iter().all(|r| r.input_tokens == Some(10) && r.output_tokens == Some(5)));
    assert!(work.iter().all(|r| r.model.as_deref() == Some("claude-fake-1") && r.provider == "claude"));

    // Messages really went through the sessions.
    let msgs = store.list_messages(None, 100).unwrap();
    assert!(msgs.iter().any(|m| m.to == "central" && m.body.contains("TASK-0001") && m.delivered_at.is_some()));

    // The worker transcript contains what we sent and what it did.
    let logs = store.list_logs("builder", None, 500).unwrap();
    assert!(logs.iter().any(|l| l.kind == LogKind::Input && l.text.contains("[TASK TASK-0002]")));
    assert!(logs.iter().any(|l| l.kind == LogKind::AssistantText && l.text.contains("permission allow")));
    assert!(logs.iter().any(|l| l.kind == LogKind::ToolUse && l.text.contains("complete_task")));

    // Files mirrored in .agent-project.
    let dir = tmp.path().join(".agent-project");
    assert!(dir.join("tasks/completed/TASK-0002.md").is_file());
    assert!(std::fs::read_to_string(dir.join("plans/M-0001.md")).unwrap().contains("All done"));

    // Timeline events were published.
    let mut kinds = Vec::new();
    while let Ok(e) = events.try_recv() {
        kinds.push(e.kind);
    }
    for k in [
        pcc_core::EventKind::MissionCreated,
        pcc_core::EventKind::AgentCreated,
        pcc_core::EventKind::TaskCompleted,
        pcc_core::EventKind::MissionCompleted,
    ] {
        assert!(kinds.contains(&k), "missing {k:?}");
    }
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destructive_command_waits_for_user_and_stop_is_real() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    {
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
        e.send_user_message("ops", "DANGER: clean the build").unwrap();
    }
    // The session is really blocked on the permission prompt.
    let mut perm_id = None;
    let start = Instant::now();
    while perm_id.is_none() {
        assert!(start.elapsed() < Duration::from_secs(120), "no permission request");
        let snap = o.lock().await.snapshot().unwrap();
        perm_id = snap.pending_permissions.first().map(|p| {
            assert_eq!(p.agent_id, "ops");
            assert!(p.summary.contains("rm -rf build"));
            p.id.clone()
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(store.agent("ops").unwrap().status, AgentStatus::AwaitingPermission);
    o.lock().await.resolve_permission(&perm_id.unwrap(), PermissionDecision::Reject).unwrap();
    wait_for("decision reaches the session", || {
        store.list_logs("ops", None, 100).unwrap().iter().any(|l| l.text.contains("dangerous command deny"))
    })
    .await;
    wait_for("idle", || store.agent("ops").unwrap().status == AgentStatus::Waiting).await;

    o.lock().await.stop_agent("ops").unwrap();
    wait_for("stopped", || store.agent("ops").unwrap().status == AgentStatus::Stopped).await;
    let sessions = store.list_sessions("ops").unwrap();
    assert_eq!(sessions[0].state, "stopped");
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopening_after_crash_offers_recovery() {
    let tmp = tempfile::tempdir().unwrap();
    {
        let o = open(&tmp);
        o.lock().await.send_user_message("central", "hello").unwrap();
        let store = o.store.clone();
        wait_for("central idle", || store.agent("central").unwrap().status == AgentStatus::Waiting).await;
        // Simulate a crash: drop without shutdown, leaving the session marked running.
    }
    let store = ProjectStore::open(tmp.path()).unwrap();
    let o = Orchestrator::open(store, EventBus::new(), Some(fake_claude()), vec![]).unwrap();
    let snap = o.lock().await.snapshot().unwrap();
    let rec = snap.recovery.expect("recovery offered");
    assert_eq!(rec.agents[0].agent_id, "central");
    assert_eq!(o.store.agent("central").unwrap().status, AgentStatus::Disconnected);
    o.lock().await.recover().unwrap();
    let s = o.store.clone();
    wait_for("central resumed", || {
        s.list_logs("central", None, 200).unwrap().iter().any(|l| l.text.contains("Session resumed"))
    })
    .await;
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_slots_are_reclaimed_and_stopped_central_is_woken() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    let mut settings = store.settings();
    settings.max_parallel_workers = 1;
    store.save_settings(settings).unwrap();
    {
        let mut e = o.lock().await;
        for name in ["Alpha", "Beta"] {
            e.create_agent(
                pcc_orchestrator::dto::AgentSpec {
                    name: name.into(),
                    role: "worker".into(),
                    isolation: Some("shared".into()),
                    ..Default::default()
                },
                "user",
            )
            .unwrap();
        }
        for agent in ["alpha", "beta"] {
            e.create_task(
                pcc_orchestrator::dto::TaskSpec {
                    title: format!("work for {agent}"),
                    agent: Some(agent.into()),
                    ..Default::default()
                },
                "user",
            )
            .unwrap();
        }
    }
    // Only one worker may run at a time: the idle one must be stopped for the other to start.
    wait_for("both tasks completed", || {
        store.list_tasks(&TaskFilter::default()).unwrap().iter().all(|t| t.status == TaskStatus::Completed)
    })
    .await;
    let alpha = store.list_logs("alpha", None, 200).unwrap();
    let beta = store.list_logs("beta", None, 200).unwrap();
    assert!(alpha.iter().chain(beta.iter()).any(|l| l.text.contains("free a worker slot")));

    // A mission while Central is stopped starts Central again.
    wait_for("central idle", || {
        !store.agent("central").unwrap().status.is_live()
            || store.agent("central").unwrap().status == AgentStatus::Waiting
    })
    .await;
    o.lock().await.stop_agent("central").unwrap();
    wait_for("central stopped", || store.agent("central").unwrap().status == AgentStatus::Stopped).await;
    o.lock().await.create_mission("Build the thing", None).unwrap();
    wait_for("central restarted", || store.agent("central").unwrap().status.is_live()).await;
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unlocked_auto_approval_is_journaled_and_emergency_blocks_work() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    let mut settings = store.settings();
    settings.autonomy.unlocked = true;
    settings.autonomy.auto_approve = true;
    settings.autonomy.manual_for_destructive = false;
    store.save_settings(settings).unwrap();
    {
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
        e.send_user_message("ops", "DANGER: clean the build").unwrap();
    }
    // No prompt: the destructive command is answered automatically and journaled.
    wait_for("auto-approved decision reaches the session", || {
        store.list_logs("ops", None, 100).unwrap().iter().any(|l| l.text.contains("dangerous command allow"))
    })
    .await;
    assert!(o.lock().await.snapshot().unwrap().pending_permissions.is_empty());
    let journal = store.list_decisions(Some("ops"), None, 10).unwrap();
    assert!(journal
        .iter()
        .any(|d| d.decision == "auto_approved" && d.summary.contains("rm -rf build") && d.actor == "autonomy"));

    // Emergency stop: sessions stop and new work is refused until released.
    o.lock().await.emergency_stop().unwrap();
    wait_for("ops stopped", || store.agent("ops").unwrap().status == AgentStatus::Stopped).await;
    assert!(o.lock().await.create_mission("anything", None).is_err());
    assert!(o.lock().await.send_user_message("ops", "hi").is_err());
    o.lock().await.release_emergency().unwrap();
    assert!(o.lock().await.send_user_message("ops", "hi").is_ok());

    // Revoke all: everyone back to LOW, UNLOCKED off.
    o.lock().await.revoke_all_permissions().unwrap();
    assert_eq!(store.agent("ops").unwrap().permissions.power(), Some(pcc_core::PowerLevel::Low));
    assert!(!store.settings().autonomy.unlocked);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn central_requests_connections_with_approval_and_reuse() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    o.lock().await.send_user_message("central", "CONNECT PI").unwrap();
    // Without MASTER CONTROL the creation waits for the user.
    let mut perm = None;
    let start = Instant::now();
    while perm.is_none() {
        assert!(start.elapsed() < Duration::from_secs(120), "no approval request");
        perm = o
            .lock()
            .await
            .snapshot()
            .unwrap()
            .pending_permissions
            .into_iter()
            .find(|p| p.tool_name == "create_connection");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(store.list_connections().unwrap().iter().all(|c| c.kind != pcc_core::ConnectionKind::Ssh));
    // The deferred capability report reached the session.
    wait_for("capabilities answer", || {
        store.list_logs("central", None, 200).unwrap().iter().any(|l| l.text.contains("capabilities received: true"))
    })
    .await;
    o.lock().await.resolve_permission(&perm.unwrap().id, PermissionDecision::AllowOnce).unwrap();
    let ssh: Vec<_> =
        store.list_connections().unwrap().into_iter().filter(|c| c.kind == pcc_core::ConnectionKind::Ssh).collect();
    assert_eq!(ssh.len(), 1);
    assert_eq!(ssh[0].name, "pi@192.168.1.157");
    wait_for("central told", || {
        store
            .list_messages(Some("central"), 50)
            .unwrap()
            .iter()
            .any(|m| m.body.contains("The user approved") && m.delivered_at.is_some())
    })
    .await;
    // Asking again reuses it (case-insensitive user, default port).
    wait_for("central idle", || store.agent("central").unwrap().status == AgentStatus::Waiting).await;
    o.lock().await.send_user_message("central", "CONNECT AGAIN").unwrap();
    wait_for("reuse answer", || {
        store
            .list_logs("central", None, 300)
            .unwrap()
            .iter()
            .any(|l| l.text.contains("again: Using the existing connection"))
    })
    .await;
    assert_eq!(store.list_connections().unwrap().iter().filter(|c| c.kind == pcc_core::ConnectionKind::Ssh).count(), 1);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn second_mission_is_queued_then_started_with_its_skills() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();

    let first = o.lock().await.create_mission("Build the thing", None).unwrap();
    assert_eq!(first.status, MissionStatus::Planning);
    let second = o
        .lock()
        .await
        .create_mission_from(pcc_orchestrator::dto::MissionSpec {
            prompt: "Polish the UI".into(),
            priority: Some(pcc_core::Priority::High),
            skills: vec!["ui-ux-pro-max:ui-ux-pro-max".into()],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(second.status, MissionStatus::Queued);
    let sent_to_central = |id: &str| {
        store.list_messages(Some("central"), 500).unwrap().into_iter().any(|m| m.mission_id.as_deref() == Some(id))
    };
    assert!(!sent_to_central("M-0002"), "a queued mission is not sent to Central");
    // Archiving needs a finished mission.
    assert!(o.lock().await.archive_mission("M-0002", true).is_err());

    wait_for("first mission completion", || {
        store.get_mission("M-0001").unwrap().map(|m| m.status) == Some(MissionStatus::Completed)
    })
    .await;
    wait_for("second mission started", || {
        store.get_mission("M-0002").unwrap().is_some_and(|m| m.status.is_running() && m.started_at.is_some())
    })
    .await;
    let brief = store
        .list_messages(Some("central"), 500)
        .unwrap()
        .into_iter()
        .find(|m| m.mission_id.as_deref() == Some("M-0002"))
        .expect("brief sent");
    assert!(brief.body.contains("NEW MISSION M-0002 · priority High"));
    assert!(brief.body.contains("Skill tool"));

    let archived = o.lock().await.archive_mission("M-0001", true).unwrap();
    assert!(archived.archived_at.is_some());
    assert!(o.lock().await.archive_mission("M-0001", false).unwrap().archived_at.is_none());
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_queued_mission_does_not_disturb_central() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    o.lock().await.create_mission("Build the thing", None).unwrap();
    o.lock().await.create_mission("Later", None).unwrap();
    o.lock().await.create_mission("Even later", None).unwrap();
    o.lock().await.set_mission_priority("M-0003", pcc_core::Priority::Critical).unwrap();
    assert_eq!(store.queued_missions().unwrap()[0].id, "M-0003");
    o.lock().await.cancel_mission("M-0002").unwrap();
    assert_eq!(store.get_mission("M-0002").unwrap().unwrap().status, MissionStatus::Cancelled);
    assert!(!store
        .list_messages(Some("central"), 500)
        .unwrap()
        .iter()
        .any(|m| m.body.contains("cancelled mission M-0002")));
    // M-0001 still runs: the queue does not move.
    assert_eq!(store.get_mission("M-0003").unwrap().unwrap().status, MissionStatus::Queued);
    let started = o.lock().await.start_mission("M-0003").unwrap();
    assert_eq!(started.status, MissionStatus::Planning);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_now_runs_alongside_and_tick_starts_leftover_queue() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    o.lock().await.create_mission("Build the thing", None).unwrap();
    let urgent = o
        .lock()
        .await
        .create_mission_from(pcc_orchestrator::dto::MissionSpec {
            prompt: "Hotfix".into(),
            start_now: true,
            ..Default::default()
        })
        .unwrap();
    assert!(urgent.status.is_running(), "start_now bypasses the queue");
    // An unknown connection is refused before anything is stored.
    let bad = o.lock().await.create_mission_from(pcc_orchestrator::dto::MissionSpec {
        prompt: "x".into(),
        connections: vec!["nope".into()],
        ..Default::default()
    });
    assert!(bad.is_err());
    assert!(store.get_mission("M-0003").unwrap().is_none());

    // A queued mission left behind while nothing runs (e.g. the app closed) is started by the tick.
    o.lock().await.cancel_mission("M-0001").unwrap();
    o.lock().await.cancel_mission("M-0002").unwrap();
    let mut left = o.lock().await.create_mission("Leftover", None).unwrap();
    assert!(left.status.is_running());
    o.lock().await.cancel_mission(&left.id).unwrap();
    left.id = "M-0099".into();
    left.status = MissionStatus::Queued;
    left.started_at = None;
    store.upsert_mission(&left).unwrap();
    o.lock().await.tick().unwrap();
    assert!(store.get_mission("M-0099").unwrap().unwrap().status.is_running());
    o.close().await;
}
