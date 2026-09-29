//! Pure task-graph logic: dependency validation, readiness and state transitions.

use std::collections::{HashMap, HashSet};

use crate::model::{Task, TaskStatus};
use crate::{Error, Result};

/// Checks that adding `new_id` with `deps` keeps the graph acyclic and references existing tasks.
pub fn validate_dependencies(tasks: &[Task], new_id: &str, deps: &[String]) -> Result<()> {
    let by_id: HashMap<&str, &Task> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    for d in deps {
        if d == new_id {
            return Err(Error::invalid(format!("{new_id} cannot depend on itself")));
        }
        if !by_id.contains_key(d.as_str()) {
            return Err(Error::invalid(format!("unknown dependency {d}")));
        }
    }
    // DFS from each dependency: reaching `new_id` means a cycle.
    let mut stack: Vec<&str> = deps.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    while let Some(id) = stack.pop() {
        if id == new_id {
            return Err(Error::invalid(format!("dependency cycle through {new_id}")));
        }
        if !seen.insert(id) {
            continue;
        }
        if let Some(t) = by_id.get(id) {
            stack.extend(t.dependencies.iter().map(String::as_str));
        }
    }
    Ok(())
}

/// What the scheduler should do with a non-terminal task given its dependencies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Readiness {
    /// All dependencies completed.
    Ready,
    /// Some dependencies still open.
    Waiting,
    /// A dependency failed or was cancelled.
    DependencyFailed(String),
}

pub fn readiness(task: &Task, all: &HashMap<String, TaskStatus>) -> Readiness {
    for d in &task.dependencies {
        match all.get(d) {
            Some(TaskStatus::Completed) => {}
            Some(TaskStatus::Failed) | Some(TaskStatus::Cancelled) => return Readiness::DependencyFailed(d.clone()),
            None => return Readiness::DependencyFailed(d.clone()),
            Some(_) => return Readiness::Waiting,
        }
    }
    Readiness::Ready
}

/// Whether moving from `from` to `to` is legal.
pub fn can_transition(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    if from == to {
        return true;
    }
    match from {
        Completed | Cancelled => false,
        // A failed task may be retried.
        Failed => matches!(to, Pending | Queued | Cancelled),
        Pending => matches!(to, Queued | Blocked | Cancelled | InProgress | Failed),
        Queued => matches!(to, Pending | InProgress | Blocked | Cancelled | Failed),
        InProgress => matches!(to, Waiting | Blocked | Review | Completed | Failed | Cancelled | Queued),
        Waiting => matches!(to, InProgress | Blocked | Review | Completed | Failed | Cancelled | Queued),
        Blocked => matches!(to, Pending | Queued | InProgress | Cancelled | Failed),
        Review => matches!(to, Completed | InProgress | Queued | Failed | Cancelled),
    }
}

/// Picks the next task to hand to `agent`: highest priority, then oldest.
pub fn next_for_agent<'a>(tasks: &'a [Task], agent: &str) -> Option<&'a Task> {
    tasks
        .iter()
        .filter(|t| t.status == TaskStatus::Queued && t.agent.as_deref() == Some(agent))
        .max_by(|a, b| a.priority.cmp(&b.priority).then_with(|| b.created_at.cmp(&a.created_at)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Priority;

    fn task(id: &str, deps: &[&str], status: TaskStatus) -> Task {
        Task {
            id: id.into(),
            mission_id: None,
            title: id.into(),
            description: String::new(),
            status,
            priority: Priority::Normal,
            agent: Some("a".into()),
            dependencies: deps.iter().map(|s| s.to_string()).collect(),
            requires_review: false,
            progress: None,
            status_reason: None,
            result: None,
            created_by: "central".into(),
            created_at: format!("2026-01-01T00:00:0{}Z", id.len()),
            updated_at: String::new(),
            started_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn rejects_cycles_and_unknown() {
        let tasks = vec![task("A", &[], TaskStatus::Pending), task("B", &["A"], TaskStatus::Pending)];
        assert!(validate_dependencies(&tasks, "C", &["B".into()]).is_ok());
        assert!(validate_dependencies(&tasks, "C", &["Z".into()]).is_err());
        assert!(validate_dependencies(&tasks, "C", &["C".into()]).is_err());
        // Re-validating A with a dependency on B would create A -> B -> A.
        assert!(validate_dependencies(&tasks, "A", &["B".into()]).is_err());
    }

    #[test]
    fn chain_readiness() {
        let a = task("A", &[], TaskStatus::Completed);
        let b = task("B", &["A"], TaskStatus::InProgress);
        let c = task("C", &["B"], TaskStatus::Pending);
        let map: HashMap<_, _> = [&a, &b, &c].iter().map(|t| (t.id.clone(), t.status)).collect();
        assert_eq!(readiness(&b, &map), Readiness::Ready);
        assert_eq!(readiness(&c, &map), Readiness::Waiting);
        let mut map2 = map.clone();
        map2.insert("B".into(), TaskStatus::Failed);
        assert_eq!(readiness(&c, &map2), Readiness::DependencyFailed("B".into()));
    }

    #[test]
    fn transitions() {
        use TaskStatus::*;
        assert!(can_transition(Pending, Queued));
        assert!(can_transition(InProgress, Review));
        assert!(can_transition(Review, InProgress));
        assert!(can_transition(Failed, Queued));
        assert!(!can_transition(Completed, InProgress));
        assert!(!can_transition(Cancelled, Queued));
    }

    #[test]
    fn picks_highest_priority_then_oldest() {
        let mut a = task("A", &[], TaskStatus::Queued);
        let b = task("BB", &[], TaskStatus::Queued);
        let mut c = task("CCC", &[], TaskStatus::Queued);
        c.priority = Priority::High;
        assert_eq!(next_for_agent(&[a.clone(), b.clone(), c.clone()], "a").unwrap().id, "CCC");
        c.status = TaskStatus::InProgress;
        assert_eq!(next_for_agent(&[a.clone(), b.clone(), c.clone()], "a").unwrap().id, "A");
        a.agent = Some("other".into());
        assert_eq!(next_for_agent(&[a, b, c], "a").unwrap().id, "BB");
    }
}
