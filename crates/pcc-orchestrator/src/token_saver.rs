//! Token saver (Settings → Token saver).
//!
//! Measured on a real project: ~88% of a week's spend came in the 15 minutes
//! after NEXUS (re)started. Every agent's Claude Code session was resumed with
//! `--resume` — re-caching its whole conversation, often several hundred
//! thousand tokens — and spent a turn on a recovery note, then Central re-briefed
//! every worker. Two rules remove that:
//!
//! * lazy wake: after a restart only Central is resumed, and only when a mission
//!   was running; other agents stay asleep and receive their recovery brief with
//!   their next real message or task;
//! * fresh sessions: an agent whose last context exceeded the threshold restarts
//!   in a new session with a compact handoff brief instead of its full history.

use serde_json::Value;

use pcc_core::{Agent, AgentKind, Event, EventKind, Severity};

use crate::engine::Engine;
use crate::recovery::{clock, file_list};

/// Context size of one API call: everything the model read for it.
pub(crate) fn context_of_call(usage: &Value) -> Option<u64> {
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    (total > 0).then_some(total)
}

/// `message.usage` of an `assistant` stream-json line.
pub(crate) fn assistant_usage(v: &Value) -> Option<&Value> {
    (v.get("type").and_then(Value::as_str) == Some("assistant")).then(|| v.get("message")?.get("usage")).flatten()
}

impl Engine {
    /// Resume this agent's previous conversation, or start fresh with a brief?
    pub(crate) fn keep_session(&self, a: &Agent) -> bool {
        let limit = self.store.settings().token_saver.fresh_session_above_tokens;
        limit == 0 || a.context_tokens.is_none_or(|t| t <= limit)
    }

    /// Text added in front of the next turn this agent receives.
    pub(crate) fn queue_note(&mut self, agent: &str, note: String) {
        let slot = self.pending_notes.entry(agent.to_string()).or_default();
        if !slot.is_empty() {
            slot.push_str("\n\n");
        }
        slot.push_str(&note);
    }

    pub(crate) fn take_note(&mut self, agent: &str) -> Option<String> {
        self.pending_notes.remove(agent).filter(|n| !n.trim().is_empty())
    }

    /// Compact replacement for a conversation that is not reloaded.
    pub(crate) fn handoff_brief(&self, a: &Agent) -> String {
        let tokens = a.context_tokens.unwrap_or(0);
        let mut s = format!(
            "[HANDOFF] To save tokens, your previous Claude Code conversation (~{}k tokens of context) was not reloaded: \
             this is a fresh session. Everything you need is in this brief, the project files, your memory notes and \
             the NEXUS tools (list_tasks, get_task, list_messages).\n",
            tokens / 1000
        );
        if a.kind == AgentKind::Central {
            s.push_str("You are Central. Use list_tasks / list_agents to see the current state before acting.\n");
        }
        match a.current_task.as_ref().and_then(|t| self.store.get_task(t).ok().flatten()) {
            Some(t) => {
                s.push_str(&format!("Your task: {} \"{}\" ({}).\n", t.id, t.title, t.status.as_str()));
                let desc: String = t.description.chars().take(1500).collect();
                if !desc.trim().is_empty() {
                    s.push_str(&format!("Task description:\n{desc}\n"));
                }
            }
            None if a.kind == AgentKind::Worker => s.push_str("You have no task in progress.\n"),
            None => {}
        }
        if let Some(l) = self.last_action_of(&a.id, "") {
            s.push_str(&format!("Your last recorded action: {} ({}, {}).\n", l.description, l.tool, clock(&l.at)));
        }
        let dirty: Vec<String> = self.agent_dirty_files(a);
        if dirty.is_empty() {
            s.push_str("Your workspace has no uncommitted file.\n");
        } else {
            s.push_str(&format!("Uncommitted files in your workspace: {}.\n", file_list(&dirty, 15)));
        }
        s.push_str("Inspect what already exists before redoing anything; continue from where the work really is.");
        s
    }

    /// Records the context size seen on an `assistant` line (kept in memory; saved at turn end).
    pub(crate) fn observe_context(&mut self, agent: &str, raw: &str) {
        if !raw.contains("\"assistant\"") || !raw.contains("\"usage\"") {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(raw) else { return };
        if let Some(t) = assistant_usage(&v).and_then(context_of_call) {
            self.context_seen.insert(agent.to_string(), t);
        }
    }

    /// Saves the last context size of `agent` (called when a turn ends).
    pub(crate) fn save_context(&mut self, agent: &str) {
        let Some(t) = self.context_seen.remove(agent) else { return };
        if self.store.read_only() {
            return;
        }
        if let Ok(mut a) = self.store.agent(agent) {
            if a.context_tokens != Some(t) {
                a.context_tokens = Some(t);
                let _ = self.store.upsert_agent(&a);
            }
        }
    }

    /// Journals a token-saver decision.
    pub(crate) fn note_saving(&self, agent: &str, name: &str, summary: String, details: Value) {
        self.emit(
            Event::new(EventKind::SystemNotice, summary, details)
                .agent(agent)
                .named(name)
                .with_severity(Severity::Info)
                .with_source("token_saver"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn context_counts_everything_the_model_read() {
        let line = json!({"type": "assistant", "message": {"usage": {
            "input_tokens": 12, "cache_read_input_tokens": 150_000, "cache_creation_input_tokens": 3_000, "output_tokens": 900
        }}});
        assert_eq!(assistant_usage(&line).and_then(context_of_call), Some(153_012));
        assert_eq!(assistant_usage(&json!({"type": "result"})), None);
        assert_eq!(context_of_call(&json!({})), None);
    }
}
