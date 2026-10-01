//! Project connections: resources an agent can be granted.
//!
//! * `environment` – what the project folder contains and which tools exist.
//! * `secrets`     – Windows Credential Manager storage (only references on disk).
//! * `kinds`       – typed configuration and health checks for each kind.
//! * `mcp`         – MCP stdio handshake used to verify MCP servers.
//! * `github`      – read-only GitHub overview through the user's `gh` login.
//! * `system`      – machine and project inspection (Environment Inspector).

pub mod environment;
pub mod github;
pub mod kinds;
pub mod mcp;
pub mod secrets;
pub mod system;

pub use environment::detect_environment;
pub use kinds::{check_connection, mcp_server_entry, CheckResult, McpServerEntry};
