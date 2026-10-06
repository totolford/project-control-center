//! Watchdog decisions, kept pure so they can be tested exhaustively.
//!
//! The escalation is always: diagnose → soft recovery → graceful restart (with
//! `--resume` and state restore). A session running a tool (a long Bash, a
//! build, an MCP call) is never considered stuck: Claude Code is executing it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Facts about one Claude Code session at one instant.
#[derive(Debug, Clone, Default)]
pub struct SessionObservation {
    /// The process exists (and is the one we started).
    pub alive: bool,
    /// A turn is in progress (between writing it and its `result`).
    pub busy: bool,
    /// A permission prompt waits for the user.
    pub awaiting_permission: bool,
    /// Time since the last stdout line.
    pub since_output: Duration,
    /// Oldest tool call without a result: (tool name, running for).
    pub inflight_tool: Option<(String, Duration)>,
    /// CPU time grew since the previous check (`None`: unknown).
    pub cpu_active: Option<bool>,
    /// A soft recovery (interrupt) was sent this long ago, without output since.
    pub soft_attempt_ago: Option<Duration>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Idle,
    Busy,
    WaitingForUser,
    LongToolCall,
    Stalled,
    Dead,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WatchAction {
    None,
    /// Soft recovery: `interrupt` control request (the turn ends, the agent is told to continue).
    Interrupt,
    /// Graceful restart with `--resume`, then the agent is briefed.
    Restart,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub verdict: Verdict,
    pub action: WatchAction,
    pub reason: String,
}

#[derive(Debug, Clone, Copy)]
pub struct WatchdogConfig {
    /// A busy session with no output and no tool running for this long is diagnosed.
    pub stall_after: Duration,
    /// After an interrupt with no output for this long, the session is restarted.
    pub soft_grace: Duration,
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        WatchdogConfig { stall_after: Duration::from_secs(15 * 60), soft_grace: Duration::from_secs(120) }
    }
}

fn mins(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 120 {
        format!("{} min", s / 60)
    } else {
        format!("{s}s")
    }
}

pub fn diagnose(o: &SessionObservation, cfg: &WatchdogConfig) -> Diagnosis {
    let d = |verdict, action, reason: String| Diagnosis { verdict, action, reason };
    if !o.alive {
        return d(Verdict::Dead, WatchAction::Restart, "the Claude Code process is gone".into());
    }
    if o.awaiting_permission {
        return d(Verdict::WaitingForUser, WatchAction::None, "waiting for a permission decision".into());
    }
    if !o.busy {
        return d(Verdict::Idle, WatchAction::None, "idle between turns".into());
    }
    if let Some((tool, age)) = &o.inflight_tool {
        return d(
            Verdict::LongToolCall,
            WatchAction::None,
            format!("running {tool} for {} (a running tool is never treated as stuck)", mins(*age)),
        );
    }
    if o.since_output < cfg.stall_after {
        return d(Verdict::Busy, WatchAction::None, format!("working, last output {} ago", mins(o.since_output)));
    }
    if o.cpu_active == Some(true) {
        return d(
            Verdict::Busy,
            WatchAction::None,
            format!("no output for {} but the process is using CPU", mins(o.since_output)),
        );
    }
    match o.soft_attempt_ago {
        None => d(
            Verdict::Stalled,
            WatchAction::Interrupt,
            format!("no output for {}, no tool running, no CPU activity", mins(o.since_output)),
        ),
        Some(ago) if ago >= cfg.soft_grace => d(
            Verdict::Stalled,
            WatchAction::Restart,
            format!("still silent {} after an interrupt (no output for {})", mins(ago), mins(o.since_output)),
        ),
        Some(ago) => d(Verdict::Stalled, WatchAction::None, format!("interrupt sent {} ago, waiting", mins(ago))),
    }
}

/// Restart budget: exponential backoff and a cap per window.
#[derive(Debug, Clone, Copy)]
pub struct RestartPolicy {
    pub max_in_window: usize,
    pub window: Duration,
    pub base_backoff: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        RestartPolicy { max_in_window: 3, window: Duration::from_secs(30 * 60), base_backoff: Duration::from_secs(20) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartDecision {
    Now,
    Wait(Duration),
    /// The cap was reached: the user decides.
    Capped,
}

impl RestartPolicy {
    /// `recent`: how long ago each previous automatic restart happened.
    pub fn decide(&self, recent: &[Duration]) -> RestartDecision {
        let in_window: Vec<Duration> = recent.iter().copied().filter(|a| *a < self.window).collect();
        if in_window.len() >= self.max_in_window {
            return RestartDecision::Capped;
        }
        let Some(last) = in_window.iter().min().copied() else { return RestartDecision::Now };
        // 1st restart immediately, then base, 2×base, 4×base...
        let backoff = self.base_backoff * 2u32.pow(in_window.len().saturating_sub(1) as u32);
        if last >= backoff {
            RestartDecision::Now
        } else {
            RestartDecision::Wait(backoff - last)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn busy(since: u64) -> SessionObservation {
        SessionObservation { alive: true, busy: true, since_output: Duration::from_secs(since), ..Default::default() }
    }

    #[test]
    fn dead_session_is_restarted() {
        let d = diagnose(&SessionObservation::default(), &WatchdogConfig::default());
        assert_eq!((d.verdict, d.action), (Verdict::Dead, WatchAction::Restart));
    }

    #[test]
    fn long_bash_is_never_stuck() {
        let cfg = WatchdogConfig::default();
        let mut o = busy(6 * 3600);
        o.inflight_tool = Some(("Bash".into(), Duration::from_secs(6 * 3600)));
        o.cpu_active = Some(false);
        o.soft_attempt_ago = Some(Duration::from_secs(3600));
        let d = diagnose(&o, &cfg);
        assert_eq!((d.verdict, d.action), (Verdict::LongToolCall, WatchAction::None));
        assert!(d.reason.contains("Bash"));
    }

    #[test]
    fn permission_wait_and_idle_are_healthy() {
        let cfg = WatchdogConfig::default();
        let mut o = busy(99_999);
        o.awaiting_permission = true;
        assert_eq!(diagnose(&o, &cfg).action, WatchAction::None);
        let idle = SessionObservation { alive: true, since_output: Duration::from_secs(99_999), ..Default::default() };
        assert_eq!(diagnose(&idle, &cfg).verdict, Verdict::Idle);
    }

    #[test]
    fn silent_turn_escalates_soft_then_restart() {
        let cfg = WatchdogConfig::default();
        assert_eq!(diagnose(&busy(60), &cfg).verdict, Verdict::Busy);
        let mut o = busy(20 * 60);
        o.cpu_active = Some(true);
        assert_eq!(diagnose(&o, &cfg).action, WatchAction::None, "CPU activity means it works");
        o.cpu_active = Some(false);
        assert_eq!(diagnose(&o, &cfg).action, WatchAction::Interrupt);
        o.soft_attempt_ago = Some(Duration::from_secs(30));
        assert_eq!(diagnose(&o, &cfg).action, WatchAction::None);
        o.soft_attempt_ago = Some(Duration::from_secs(150));
        assert_eq!(diagnose(&o, &cfg).action, WatchAction::Restart);
    }

    #[test]
    fn restart_backoff_and_cap() {
        let p = RestartPolicy::default();
        assert_eq!(p.decide(&[]), RestartDecision::Now);
        // One restart 5 s ago: wait for the base backoff.
        assert_eq!(p.decide(&[Duration::from_secs(5)]), RestartDecision::Wait(Duration::from_secs(15)));
        assert_eq!(p.decide(&[Duration::from_secs(25)]), RestartDecision::Now);
        // Two restarts: the backoff doubles.
        assert_eq!(
            p.decide(&[Duration::from_secs(30), Duration::from_secs(100)]),
            RestartDecision::Wait(Duration::from_secs(10))
        );
        let three = [Duration::from_secs(60), Duration::from_secs(120), Duration::from_secs(600)];
        assert_eq!(p.decide(&three), RestartDecision::Capped);
        // Old restarts leave the window.
        assert_eq!(p.decide(&[Duration::from_secs(3600); 5]), RestartDecision::Now);
    }
}
