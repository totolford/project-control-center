//! Permission lifecycle against the scripted Claude Code double
//! (`examples/fake_claude.rs`): persistence across restarts, idempotent
//! decisions, lost/expired/recovered requests and the event journal.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use pcc_core::{AgentStatus, ConnectionKind, EventBus, PermissionDecision, PermissionRecord, PermissionStatus};
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

fn open_existing(tmp: &tempfile::TempDir) -> Orchestrator {
    let store = ProjectStore::open(tmp.path()).unwrap();
    Orchestrator::open(store, EventBus::new(), Some(fake_claude()), vec!["generic".into()]).unwrap()
}

fn open(tmp: &tempfile::TempDir) -> Orchestrator {
    ProjectStore::create(tmp.path(), "Test").unwrap();
    open_existing(tmp)
}

async fn create_ops(o: &Orchestrator) {
    o.lock()
        .await
        .create_agent(
            pcc_orchestrator::dto::AgentSpec {
                name: "Ops".into(),
                role: "Operations".into(),
                isolation: Some("shared".into()),
                ..Default::default()
            },
            "user",
        )
        .unwrap();
}

/// Waits for an open request matching `pred` and returns it.
async fn pending(o: &Orchestrator, pred: impl Fn(&PermissionRecord) -> bool) -> PermissionRecord {
    let start = Instant::now();
    loop {
        assert!(start.elapsed() < Duration::from_secs(120), "no permission request");
        if let Some(p) = o.lock().await.snapshot().unwrap().pending_permissions.into_iter().find(|p| pred(p)) {
            return p;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn log_contains(store: &ProjectStore, agent: &str, text: &str) -> bool {
    store.list_logs(agent, None, 300).unwrap().iter().any(|l| l.text.contains(text))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn double_decisions_are_idempotent_and_unknown_ids_are_explained() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    create_ops(&o).await;
    o.lock().await.send_user_message("ops", "DANGER: clean the build").unwrap();
    let p = pending(&o, |p| p.agent_id == "ops").await;
    assert_eq!(p.status, PermissionStatus::Pending);
    assert_eq!(p.risk, "destructive");
    assert_eq!(p.resource.as_deref(), Some("rm -rf build"));
    assert!(p.process_id.is_some());
    assert!(p.expires_at.is_some(), "default timeout applies");
    // Persisted before anyone answers.
    assert_eq!(store.get_permission(&p.id).unwrap().unwrap().status, PermissionStatus::Pending);

    let first = o.lock().await.resolve_permission(&p.id, PermissionDecision::AllowOnce).unwrap();
    assert!(first.applied);
    assert_eq!(first.status, Some(PermissionStatus::Consumed));
    wait_for("approval reaches the session", || log_contains(&store, "ops", "dangerous command allow")).await;

    // Double click: same decision.
    let again = o.lock().await.resolve_permission(&p.id, PermissionDecision::AllowOnce).unwrap();
    assert!(!again.applied);
    assert!(again.message.starts_with("Already approved at"), "{}", again.message);
    // Stale list: opposite decision.
    let late = o.lock().await.resolve_permission(&p.id, PermissionDecision::Reject).unwrap();
    assert!(!late.applied);
    assert!(late.message.contains("already approved"), "{}", late.message);
    // Unknown id: no raw "not found".
    let unknown = o.lock().await.resolve_permission("perm-1325d8236e24", PermissionDecision::AllowOnce).unwrap();
    assert!(unknown.status.is_none());
    assert!(unknown.message.contains("no longer available"));
    let report = o.lock().await.permission_status("perm-1325d8236e24").unwrap();
    assert!(!report.found);

    let report = o.lock().await.permission_status(&p.id).unwrap();
    assert!(report.found && report.session_alive && report.same_session);
    assert!(!report.can_rerequest);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_are_lost_with_their_session_and_can_be_requested_again() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    create_ops(&o).await;
    o.lock().await.send_user_message("ops", "DANGER: clean the build").unwrap();
    let p = pending(&o, |p| p.agent_id == "ops").await;
    o.lock().await.stop_agent("ops").unwrap();
    wait_for("stopped", || store.agent("ops").unwrap().status == AgentStatus::Stopped).await;

    let r = store.get_permission(&p.id).unwrap().unwrap();
    assert_eq!(r.status, PermissionStatus::Lost);
    assert!(r.resolution.unwrap().contains("stopped"));
    assert!(o.lock().await.snapshot().unwrap().pending_permissions.is_empty());

    let late = o.lock().await.resolve_permission(&p.id, PermissionDecision::AllowOnce).unwrap();
    assert!(!late.applied);
    assert!(late.message.starts_with("Lost: the agent's session ended"), "{}", late.message);
    assert!(late.message.contains("will ask again"));

    let report = o.lock().await.permission_status(&p.id).unwrap();
    assert!(report.found && !report.session_alive && report.can_rerequest);
    assert_eq!(report.executed, Some(false));

    // Re-request: the agent asks again and the same card comes back, re-linked.
    let note = o.lock().await.rerequest_permission(&p.id).unwrap();
    assert!(note.contains("ops"));
    wait_for("retry request delivered", || log_contains(&store, "ops", "retry this action if you still need it")).await;
    wait_for("idle", || store.agent("ops").unwrap().status == AgentStatus::Waiting).await;
    // The scripted agent asks again for the same command (a real agent does it on its own).
    o.lock().await.send_user_message("ops", "DANGER: clean the build").unwrap();
    let again = pending(&o, |q| q.agent_id == "ops").await;
    assert_eq!(again.id, p.id);
    assert_eq!(again.status, PermissionStatus::Recovered);
    assert_eq!(again.recoveries, 1);
    let ok = o.lock().await.resolve_permission(&p.id, PermissionDecision::Reject).unwrap();
    assert!(ok.applied);
    assert_eq!(ok.status, Some(PermissionStatus::Denied));
    wait_for("refusal reaches the session", || log_contains(&store, "ops", "dangerous command deny")).await;

    let names: Vec<String> = store
        .journal(&JournalFilter { name: Some("permission.".into()), ..Default::default() })
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    for n in ["permission.created", "permission.lost", "permission.recovered", "permission.denied"] {
        assert!(names.iter().any(|x| x == n), "missing {n} in {names:?}");
    }
    let started = store.journal(&JournalFilter { name: Some("agent.started".into()), ..Default::default() }).unwrap();
    assert!(started.iter().all(|e| e.pid.is_some() && e.agent_id.as_deref() == Some("ops")));
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unanswered_requests_expire_and_the_agent_is_told() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    create_ops(&o).await;
    o.lock().await.send_user_message("ops", "DANGER: clean the build").unwrap();
    let p = pending(&o, |p| p.agent_id == "ops").await;
    assert_eq!(o.lock().await.expire_permissions().unwrap(), 0, "not due yet");
    assert_eq!(o.lock().await.expire_permissions_at("2999-01-01T00:00:00.000Z").unwrap(), 1);
    wait_for("refusal reaches the session", || log_contains(&store, "ops", "dangerous command deny")).await;
    let r = store.get_permission(&p.id).unwrap().unwrap();
    assert_eq!(r.status, PermissionStatus::Expired);
    assert_eq!(r.decided_by.as_deref(), Some("timeout"));
    wait_for("idle", || store.agent("ops").unwrap().status == AgentStatus::Waiting).await;
    let late = o.lock().await.resolve_permission(&p.id, PermissionDecision::AllowOnce).unwrap();
    assert!(late.message.starts_with("Expired at"), "{}", late.message);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_marks_tool_requests_lost_and_keeps_admin_requests() {
    let tmp = tempfile::tempdir().unwrap();
    let (tool_id, admin_id) = {
        let o = open(&tmp);
        create_ops(&o).await;
        o.lock().await.send_user_message("ops", "DANGER: clean the build").unwrap();
        let tool = pending(&o, |p| p.agent_id == "ops").await;
        o.lock().await.send_user_message("central", "CONNECT PI").unwrap();
        let admin = pending(&o, |p| p.tool_name == "create_connection").await;
        // NEXUS dies: no shutdown, requests still open in the database.
        (tool.id, admin.id)
    };
    let o = open_existing(&tmp);
    let store = o.store.clone();
    let tool = store.get_permission(&tool_id).unwrap().unwrap();
    assert_eq!(tool.status, PermissionStatus::Lost);
    assert!(tool.resolution.unwrap().contains("NEXUS was closed or restarted"));
    let snap = o.lock().await.snapshot().unwrap();
    assert_eq!(snap.pending_permissions.len(), 1, "only the admin request survives");
    assert_eq!(snap.pending_permissions[0].id, admin_id);
    assert_eq!(snap.pending_permissions[0].status, PermissionStatus::Recovered);

    // The approval still works after the restart: the connection is created.
    let out = o.lock().await.resolve_permission(&admin_id, PermissionDecision::AllowOnce).unwrap();
    assert!(out.applied);
    assert_eq!(out.status, Some(PermissionStatus::Consumed));
    assert_eq!(store.list_connections().unwrap().iter().filter(|c| c.kind == ConnectionKind::Ssh).count(), 1);
    let twice = o.lock().await.resolve_permission(&admin_id, PermissionDecision::AllowOnce).unwrap();
    assert!(!twice.applied);
    assert_eq!(store.list_connections().unwrap().iter().filter(|c| c.kind == ConnectionKind::Ssh).count(), 1);

    // The journal of the previous instance is still there.
    let lost = store.journal(&JournalFilter { name: Some("permission.lost".into()), ..Default::default() }).unwrap();
    assert_eq!(lost.len(), 1);
    let opened = store.journal(&JournalFilter { name: Some("controlCenter.".into()), ..Default::default() }).unwrap();
    assert_eq!(opened.len(), 2, "one entry per instance");
    assert_eq!(opened[0].name, "controlCenter.restarted");
    assert!(opened[0].id < lost[0].id, "the restart is journaled before the requests it lost");
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_critical_operations_do_not_fail_or_duplicate() {
    use pcc_orchestrator::dto::{ConnectionInput, MissionSpec, TaskPatch, TaskSpec};
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    create_ops(&o).await;

    // Double submit of a mission with the same client key: one mission.
    let spec =
        MissionSpec { prompt: "Write the README".into(), idempotency_key: Some("ui-123".into()), ..Default::default() };
    let a = o.lock().await.create_mission_from(spec.clone()).unwrap();
    let b = o.lock().await.create_mission_from(spec).unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(store.list_missions().unwrap().len(), 1);
    // Survives a restart of the engine (key is persisted).
    assert_eq!(store.idempotency_get("mission:ui-123").unwrap().as_deref(), Some(a.id.as_str()));

    // Same connection twice: the first one is returned.
    let input = ConnectionInput {
        name: "Pi".into(),
        kind: ConnectionKind::Ssh,
        config: serde_json::json!({"host": "pi.local", "user": "pi", "auth": "agent"}),
        secrets: None,
        enabled: None,
    };
    let c1 = o.lock().await.add_connection(input.clone()).unwrap();
    let c2 = o.lock().await.add_connection(input).unwrap();
    assert_eq!(c1.id, c2.id);
    assert_eq!(store.list_connections().unwrap().iter().filter(|c| c.kind == ConnectionKind::Ssh).count(), 1);
    o.lock().await.delete_connection(&c1.id).unwrap();
    o.lock().await.delete_connection(&c1.id).unwrap();

    // Git init twice: the second returns the existing repository.
    let first = o.lock().await.git_init().unwrap();
    let second = o.lock().await.git_init().unwrap();
    assert_eq!(first.branch, second.branch);

    // Assigning a task to its current agent again is a no-op.
    let t = o.lock().await.create_task(TaskSpec { title: "Lint".into(), ..Default::default() }, "user").unwrap();
    let patch = TaskPatch { agent: Some(Some("ops".into())), ..Default::default() };
    o.lock().await.update_task(&t.id, patch.clone(), "user").unwrap();
    o.lock().await.update_task(&t.id, patch, "user").unwrap();

    // Start / stop twice.
    o.lock().await.start_agent_by_user("ops").unwrap();
    o.lock().await.start_agent_by_user("ops").unwrap();
    o.lock().await.stop_agent("ops").unwrap();
    o.lock().await.stop_agent("ops").unwrap();
    wait_for("stopped", || store.agent("ops").unwrap().status == AgentStatus::Stopped).await;
    o.lock().await.stop_agent("ops").unwrap();
    o.close().await;
}
