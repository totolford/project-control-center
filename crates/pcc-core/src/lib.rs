//! Shared domain model for Project Control Center.
//!
//! Every other crate depends on this one; it deliberately has no I/O.

pub mod ai;
pub mod error;
pub mod events;
pub mod ids;
pub mod interpreter;
pub mod model;
pub mod permission_records;
pub mod permissions;
pub mod tasks;

pub use ai::{AiEngineSettings, AiMode, EngineProvider, FallbackPolicy, LocalEndpoint};
pub use error::{Error, Result};
pub use events::{Event, EventBus, EventKind, LogEntry, LogKind, Severity};
pub use model::*;
pub use permission_records::*;
pub use permissions::{Access, Capability, PermissionSet, PowerLevel};

/// Current UTC timestamp in RFC 3339, the format used everywhere on disk.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
