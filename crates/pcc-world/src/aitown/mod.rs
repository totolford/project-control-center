//! Integrated AI Town (a16z-infra/ai-town, MIT): runtime, Convex client,
//! agent → character bridge and upstream sync. The AI Town code itself lives in
//! `ai-town/` at the repository root.

pub mod bridge;
pub mod convex;
pub mod runtime;
pub mod upstream;

pub use bridge::{AgentFacts, NexusAgent};
pub use convex::ConvexClient;
pub use runtime::{AiTownRuntime, RuntimeStatus};
