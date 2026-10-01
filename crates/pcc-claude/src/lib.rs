//! Integration with the Claude Code CLI.
//!
//! Each agent runs `claude -p --input-format stream-json --output-format stream-json`.
//! The process stays alive between turns; we write user messages and control
//! responses to stdin and parse newline-delimited JSON from stdout. Tool
//! permission prompts (`can_use_tool`) and the app-provided MCP server
//! (`mcp_message`) arrive as control requests that the host answers.

pub mod cli_help;
pub mod control;
pub mod detect;
pub mod inspect;
pub mod process;
pub mod protocol;
pub mod session;
pub mod skills;

pub use detect::{detect, find_claude};
pub use protocol::{Block, ControlRequest, Inbound};
pub use session::{spawn, LaunchSpec, SessionHandle, SessionOutput};
