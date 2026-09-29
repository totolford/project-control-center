//! Live end-to-end test against the installed Claude Code CLI.
//! Costs real tokens, so it only runs when `PCC_E2E=1`:
//!
//!     PCC_E2E=1 cargo test -p pcc-orchestrator --test real_claude -- --nocapture

use std::time::{Duration, Instant};

use pcc_core::{EventBus, MissionStatus, TaskStatus};
use pcc_orchestrator::Orchestrator;
use pcc_store::{ProjectStore, TaskFilter};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_mission_creates_a_file() {
    if std::env::var("PCC_E2E").as_deref() != Ok("1") {
        eprintln!("skipped (set PCC_E2E=1 to run against the real Claude Code)");
        return;
    }
    let claude = pcc_claude::find_claude().expect("Claude Code installed");
    let tmp = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(tmp.path(), "E2E").unwrap();
    let mut settings = store.settings();
    settings.central_model = Some(std::env::var("PCC_E2E_MODEL").unwrap_or_else(|_| "haiku".into()));
    settings.worker_model = settings.central_model.clone();
    settings.max_budget_usd_per_session = Some(1.0);
    store.save_settings(settings).unwrap();
    let o = Orchestrator::open(store, EventBus::new(), Some(claude), vec!["generic".into()]).unwrap();
    let s = o.store.clone();
    let mut perms = o.bus.subscribe();

    o.lock()
        .await
        .create_mission(
            "Create a file named hello.txt at the project root containing exactly the text: Hello from agents. \
             Use one worker agent for it. Then complete the mission.",
            None,
        )
        .unwrap();

    let start = Instant::now();
    loop {
        // Approve anything the agents ask for during this test.
        while let Ok(e) = perms.try_recv() {
            if e.kind == pcc_core::EventKind::PermissionRequested {
                let id = e.payload["id"].as_str().unwrap().to_string();
                eprintln!("auto-approving: {}", e.summary);
                let _ = o.lock().await.resolve_permission(&id, pcc_core::PermissionDecision::AllowOnce);
            }
        }
        let m = s.get_mission("M-0001").unwrap().unwrap();
        if matches!(m.status, MissionStatus::Completed | MissionStatus::Failed) {
            eprintln!("mission {:?}: {}", m.status, m.summary.unwrap_or_default());
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(600), "mission did not finish in 10 minutes");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    for t in s.list_tasks(&TaskFilter::default()).unwrap() {
        eprintln!("{} [{}] {} -> {:?}", t.id, t.status.as_str(), t.title, t.result.map(|r| r.summary));
    }
    for a in s.list_agents().unwrap() {
        eprintln!("agent {} ({}) {:?} ${:.4}", a.id, a.role, a.status, a.total_cost_usd);
    }
    let content = std::fs::read_to_string(tmp.path().join("hello.txt")).expect("hello.txt created by an agent");
    assert_eq!(content.trim(), "Hello from agents");
    assert!(s.list_tasks(&TaskFilter::default()).unwrap().iter().any(|t| t.status == TaskStatus::Completed));
    assert!(s.list_agents().unwrap().len() >= 2, "Central created a worker");
    o.close().await;
}
