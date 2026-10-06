//! Persistence for a project.
//!
//! * `compat`  – versions, migrations with backups, compatibility mode.
//! * `layout`  – creation of the `.agent-project` directory tree.
//! * `db`      – SQLite schema and migrations (structured, crash-safe state).
//! * `store`   – typed access to entities, mirrored to human-readable files.
//! * `memory`  – Markdown memory files of the project and of each agent.
//! * `recent`  – list of recently opened projects (application level).

pub mod compat;
pub mod db;
pub mod journal;
pub mod layout;
pub mod memory;
pub mod permissions;
pub mod recent;
pub mod store;

pub use journal::JournalFilter;
pub use layout::{Layout, AGENT_DIR};
pub use memory::{MemoryFile, MemoryScope};
pub use store::{EventFilter, ProjectStore, TaskFilter};
