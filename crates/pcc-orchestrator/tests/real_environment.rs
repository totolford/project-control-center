//! Live test: Central turns "connect to my Pi" into connections and tests.
//! Uses TEST-NET address 192.0.2.10 (never routable). Costs a few cents:
//!     PCC_E2E=1 cargo test -p pcc-orchestrator --test real_environment -- --nocapture

use std::time::{Duration, Instant};

use pcc_core::{ConnectionKind, EventBus, EventKind, MissionStatus, PermissionDecision};
use pcc_orchestrator::Orchestrator;
use pcc_store::ProjectStore;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn central_builds_the_connection_it_needs() {
    if std::env::var("PCC_E2E").as_deref() != Ok("1") {
        eprintln!("skipped (set PCC_E2E=1)");
        return;
    }
    let claude = pcc_claude::find_claude().expect("Claude Code installed");
    let tmp = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(tmp.path(), "Env").unwrap();
    let mut settings = store.settings();
    settings.central_model = Some(std::env::var("PCC_E2E_MODEL").unwrap_or_else(|_| "haiku".into()));
    settings.worker_model = settings.central_model.clone();
    settings.max_budget_usd_per_session = Some(1.0);
    store.save_settings(settings).unwrap();
    let o = Orchestrator::open(store, EventBus::new(), Some(claude), vec!["generic".into()]).unwrap();
    let s = o.store.clone();
    let mut events = o.bus.subscribe();
    o.lock()
        .await
        .create_mission(
            "Connect to my Raspberry Pi over SSH (ssh pi@192.0.2.10) and check whether Docker is installed. Report what you could and could not do.",
            None,
        )
        .unwrap();
    let start = Instant::now();
    let mut approvals = 0;
    let mut user_requests = 0;
    loop {
        while let Ok(e) = events.try_recv() {
            match e.kind {
                EventKind::PermissionRequested => {
                    approvals += 1;
                    eprintln!("approving: {}", e.summary);
                    let id = e.payload["id"].as_str().unwrap().to_string();
                    let _ = o.lock().await.resolve_permission(&id, PermissionDecision::AllowOnce);
                }
                EventKind::UserRequested => {
                    user_requests += 1;
                    eprintln!("user request: {}", e.summary);
                    let id = e.payload["id"].as_str().unwrap().to_string();
                    let _ = o
                        .lock()
                        .await
                        .finish_user_request(&id, "The user is not available in this test; report and finish.");
                }
                _ => {}
            }
        }
        let m = s.get_mission("M-0001").unwrap().unwrap();
        if matches!(m.status, MissionStatus::Completed | MissionStatus::Failed) {
            eprintln!("mission {:?}: {}", m.status, m.summary.unwrap_or_default());
            break;
        }
        if start.elapsed() > Duration::from_secs(420) {
            for a in s.list_agents().unwrap() {
                eprintln!("== agent {} {:?} task {:?} action {:?}", a.id, a.status, a.current_task, a.current_action);
                for l in s.list_logs(&a.id, None, 25).unwrap() {
                    let line: String = l.text.chars().take(220).collect();
                    eprintln!("   [{:?}] {}", l.kind, line.replace('\n', " "));
                }
            }
            for t in s.list_tasks(&Default::default()).unwrap() {
                eprintln!("== task {} {:?} {:?} {}", t.id, t.status, t.agent, t.title);
            }
            panic!("mission did not finish");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let ssh: Vec<_> = s.list_connections().unwrap().into_iter().filter(|c| c.kind == ConnectionKind::Ssh).collect();
    for c in &ssh {
        eprintln!("connection {} {:?} {:?}", c.id, c.status, c.status_detail);
    }
    for c in s.list_commands(None, None, 50).unwrap() {
        eprintln!("command [{}] {} -> exit {:?} decision {:?}", c.agent_id, c.raw, c.exit_code, c.decision);
    }
    for a in s.list_agents().unwrap() {
        for l in s
            .list_logs(&a.id, None, 500)
            .unwrap()
            .iter()
            .filter(|l| l.text.starts_with("Denied") || l.text.starts_with("NEXUS made"))
        {
            eprintln!("[{}] {}", a.id, l.text);
        }
    }
    eprintln!("approvals {approvals}, user requests {user_requests}");
    assert_eq!(ssh.len(), 1, "exactly one SSH connection, no duplicates");
    o.close().await;
}
