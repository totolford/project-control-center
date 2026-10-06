//! Event journal entries the engine writes about NEXUS itself.

use serde_json::json;

use pcc_core::{Event, EventKind, Severity};
use pcc_recovery::reports::PreviousRun;

use crate::engine::Engine;

impl Engine {
    /// First journal entry of this instance for the project: whether the
    /// Control Center was restarted and how the previous run ended.
    pub(crate) fn announce_open(&self) {
        let (name, severity) = match &self.rec.previous_run {
            PreviousRun::Unknown => ("controlCenter.started", Severity::Info),
            PreviousRun::Clean { .. } => ("controlCenter.restarted", Severity::Info),
            PreviousRun::Unexpected { .. } | PreviousRun::StillRunning { .. } => {
                ("controlCenter.restarted", Severity::Warning)
            }
        };
        let text = self.rec.previous_run_text();
        self.emit(
            Event::new(
                EventKind::SystemNotice,
                format!("Control Center opened the project: {text}"),
                json!({"previousRun": text}),
            )
            .named(name)
            .with_severity(severity)
            .with_pid(Some(std::process::id())),
        );
    }
}
