//! Shared domain model for Project Control Center.
//!
//! Every other crate depends on this one; it deliberately has no I/O.

pub mod error;
pub mod events;
pub mod ids;
pub mod model;
pub mod permissions;
pub mod tasks;

pub use error::{Error, Result};
pub use events::{Event, EventBus, EventKind, LogEntry, LogKind};
pub use model::*;
pub use permissions::{Access, Capability, PermissionSet};

/// Current UTC timestamp in RFC 3339, the format used everywhere on disk.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
