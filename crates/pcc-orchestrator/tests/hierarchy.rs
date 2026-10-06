//! Agent pyramid end to end against the scripted Claude Code double
//! (`examples/fake_claude.rs`): real processes, real protocol, real persistence.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use pcc_core::{AgentRank, AgentStatus, EventBus, EventKind, LogKind, TaskStatus};
use pcc_orchestrator::dto::AgentSpec;
use pcc_orchestrator::Orchestrator;
use pcc_store::{EventFilter, ProjectStore, TaskFilter};

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

fn open(tmp: &tempfile::TempDir) -> Orchestrator {
    let store = ProjectStore::create(tmp.path(), "Test").unwrap();
    Orchestrator::open(store, EventBus::new(), Some(fake_claude()), vec!["generic".into()]).unwrap()
}

fn spec(name: &str, parent: Option<&str>, rank: AgentRank) -> AgentSpec {
    AgentSpec {
        name: name.into(),
        role: format!("{name} role"),
        isolation: Some("shared".into()),
        parent: parent.map(str::to_string),
        rank: Some(rank),
        ..Default::default()
    }
}

fn said(store: &ProjectStore, agent: &str, needle: &str) -> bool {
    store
        .list_logs(agent, None, 500)
        .unwrap()
        .iter()
        .any(|l| l.kind == LogKind::AssistantText && l.text.contains(needle))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lieutenant_creates_specialists_and_reports_a_synthesis() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    o.lock().await.send_user_message("central", "PLAN HIERARCHY").unwrap();

    wait_for("lieutenant task completed", || {
        store
            .list_tasks(&TaskFilter { agent: Some("lua-lead".into()), ..Default::default() })
            .unwrap()
            .first()
            .is_some_and(|t| t.status == TaskStatus::Completed)
    })
    .await;

    let lead = store.agent("lua-lead").unwrap();
    assert_eq!((lead.rank, lead.parent_agent.as_deref()), (AgentRank::Lieutenant, Some("central")));
    let files = store.agent("lua-files").unwrap();
    assert_eq!((files.rank, files.parent_agent.as_deref()), (AgentRank::Specialist, Some("lua-lead")));
    assert_eq!(files.created_by, "lua-lead");

    // The specialist's task was created by the lieutenant and its result went to it, not to Central.
    let sub = store.list_tasks(&TaskFilter { agent: Some("lua-files".into()), ..Default::default() }).unwrap();
    assert_eq!(sub[0].created_by, "lua-lead");
    assert_eq!(sub[0].status, TaskStatus::Completed);
    let msgs = store.list_messages(None, 200).unwrap();
    assert!(msgs.iter().any(|m| m.to == "lua-lead" && m.body.contains("completed by lua-files")));
    assert!(!msgs.iter().any(|m| m.to == "central" && m.body.contains("completed by lua-files")));
    // Central received the lieutenant's synthesis.
    wait_for("synthesis delivered to central", || {
        store.list_messages(None, 200).unwrap().iter().any(|m| {
            m.to == "central" && m.body.contains("completed by lua-lead") && m.body.contains("120 files analysed")
        })
    })
    .await;

    // Both delegation decisions are journaled.
    let e = o.lock().await;
    let decisions = e.delegation_decisions(None, 10).unwrap();
    let who: Vec<&str> = decisions.iter().map(|d| d.agent_id.as_str()).collect();
    assert!(who.contains(&"central") && who.contains(&"lua-lead"));
    assert!(decisions.iter().all(|d| d.decision.needs_sub_agents));
    drop(e);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn specialists_cannot_create_agents_and_depth_is_enforced() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    let mut settings = store.settings();
    settings.max_hierarchy_depth = 2;
    store.save_settings(settings).unwrap();
    {
        let mut e = o.lock().await;
        e.create_agent(spec("Lead", None, AgentRank::Lieutenant), "user").unwrap();
        e.create_agent(spec("Worker", Some("lead"), AgentRank::Specialist), "user").unwrap();
        e.send_user_message("worker", "TRY CREATE").unwrap();
        e.send_user_message("lead", "CREATE DEEP").unwrap();
    }
    wait_for("specialist refused", || said(&store, "worker", "specialists cannot create agents")).await;
    wait_for("depth refused", || said(&store, "lead", "could not have sub-agents")).await;
    assert!(store.get_agent("helper").unwrap().is_none());
    assert!(store.get_agent("deep-lead").unwrap().is_none());

    // The user is held to the same depth limit.
    let mut settings = store.settings();
    settings.max_hierarchy_depth = 1;
    store.save_settings(settings).unwrap();
    let err = o.lock().await.create_agent(spec("Too Deep", Some("lead"), AgentRank::Specialist), "user").unwrap_err();
    assert!(err.to_string().contains("maximum hierarchy depth"), "{err}");
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cross_branch_messages_go_through_the_parent() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    {
        let mut e = o.lock().await;
        e.create_agent(spec("Lead", None, AgentRank::Lieutenant), "user").unwrap();
        e.create_agent(spec("Alpha", Some("lead"), AgentRank::Specialist), "user").unwrap();
        e.create_agent(spec("Beta", Some("lead"), AgentRank::Specialist), "user").unwrap();
        e.send_user_message("alpha", "ROUTE TO beta").unwrap();
    }
    wait_for("routed", || said(&store, "alpha", "handed to lead to relay")).await;
    let msgs = store.list_messages(None, 100).unwrap();
    let hop = msgs.iter().find(|m| m.from == "alpha" && m.to == "lead").expect("message to the parent");
    assert!(hop.body.contains("[ROUTED by NEXUS · from alpha · for beta · path alpha → lead → beta]"));
    assert!(!msgs.iter().any(|m| m.from == "alpha" && m.to == "beta"));
    let routed =
        store.list_events(&EventFilter { kind: Some(EventKind::MessageRouted), ..Default::default() }).unwrap();
    assert_eq!(routed[0].payload["via"], "lead");
    // The parent really receives it in its session.
    wait_for("delivered to lead", || {
        store
            .list_logs("lead", None, 200)
            .unwrap()
            .iter()
            .any(|l| l.kind == LogKind::Input && l.text.contains("for beta"))
    })
    .await;
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promote_and_demote_reparent_children() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    let mut e = o.lock().await;
    e.create_agent(spec("Lead", None, AgentRank::Specialist), "user").unwrap();
    // A specialist cannot have sub-agents until promoted.
    assert!(e.create_agent(spec("Kid", Some("lead"), AgentRank::Specialist), "user").is_err());
    assert_eq!(e.promote_agent("lead").unwrap().rank, AgentRank::Lieutenant);
    e.create_agent(spec("Kid", Some("lead"), AgentRank::Specialist), "user").unwrap();
    e.create_agent(spec("Kid Two", Some("lead"), AgentRank::Specialist), "user").unwrap();

    let a = e.demote_agent("lead").unwrap();
    assert_eq!(a.rank, AgentRank::Specialist);
    assert_eq!(store.agent("kid").unwrap().parent_agent.as_deref(), Some("central"));
    assert_eq!(store.agent("kid-two").unwrap().parent_agent.as_deref(), Some("central"));
    assert!(e.demote_agent("lead").is_err());
    assert!(e.promote_agent("central").is_err());
    let changes = store.list_events(&EventFilter { kind: Some(EventKind::HierarchyChanged), ..Default::default() });
    assert_eq!(changes.unwrap().len(), 2);
    drop(e);
    o.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_agents_sleep_and_wake_on_message() {
    let tmp = tempfile::tempdir().unwrap();
    let o = open(&tmp);
    let store = o.store.clone();
    {
        let mut e = o.lock().await;
        e.create_agent(spec("Napper", None, AgentRank::Specialist), "user").unwrap();
        e.send_user_message("napper", "hello").unwrap();
    }
    wait_for("idle", || store.agent("napper").unwrap().status == AgentStatus::Waiting).await;
    let slept = o.lock().await.sleep_idle_agents(0).unwrap();
    assert_eq!(slept, ["napper"]);
    wait_for("sleeping", || store.agent("napper").unwrap().status == AgentStatus::Sleeping).await;
    let sessions = store.list_sessions("napper").unwrap();
    assert_eq!(sessions.last().unwrap().state, "stopped");
    let session_id = store.agent("napper").unwrap().claude_session_id.clone().unwrap();

    // Paused: a message is stored but not delivered, and nothing is started.
    o.lock().await.pause_agent("napper").unwrap();
    o.lock().await.send_user_message("napper", "are you there?").unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(store.agent("napper").unwrap().status, AgentStatus::Sleeping);
    assert_eq!(store.undelivered_for("napper").unwrap().len(), 1);

    // Resuming wakes it: the same Claude session is resumed and the message delivered.
    o.lock().await.resume_agent("napper").unwrap();
    wait_for("resumed session", || {
        store.list_logs("napper", None, 200).unwrap().iter().any(|l| l.text.contains("Session resumed"))
    })
    .await;
    wait_for("message delivered", || store.undelivered_for("napper").unwrap().is_empty()).await;
    assert_eq!(store.agent("napper").unwrap().claude_session_id.as_deref(), Some(session_id.as_str()));
    let dormancy = store.list_events(&EventFilter { kind: Some(EventKind::AgentDormancy), ..Default::default() });
    let summaries: Vec<String> = dormancy.unwrap().into_iter().map(|e| e.summary).collect();
    assert!(summaries.iter().any(|s| s.contains("is sleeping")));
    assert!(summaries.iter().any(|s| s.contains("woke up")));
    o.close().await;
}
