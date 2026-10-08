//! World providers. NEXUS is never tied to one: AI Town (a16z-infra/ai-town,
//! MIT, bundled and run locally) is the main world; the native engine runs
//! inside NEXUS as a fallback when Node.js is missing; custom points to any
//! existing world project.

use std::path::Path;

use serde::{Deserialize, Serialize};

use pcc_claude::process::std_command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prerequisite {
    pub name: String,
    pub met: bool,
    pub detail: String,
    /// Required (vs. one option among several).
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prerequisites: Vec<Prerequisite>,
    pub ready: bool,
}

/// A world implementation NEXUS can create and drive.
pub trait AIWorldProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    /// Blocking: may run `--version` commands.
    fn prerequisites(&self, root: &Path) -> Vec<Prerequisite>;
    fn info(&self, root: &Path) -> ProviderInfo {
        let prerequisites = self.prerequisites(root);
        let ready = prerequisites.iter().filter(|p| p.required).all(|p| p.met);
        ProviderInfo {
            id: self.id().into(),
            name: self.name().into(),
            description: self.description().into(),
            prerequisites,
            ready,
        }
    }
}

fn version_of(program: &str, args: &[&str]) -> Option<String> {
    let out = std_command(program).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string())
}

fn prereq(name: &str, found: Option<String>, required: bool, missing: &str) -> Prerequisite {
    Prerequisite { name: name.into(), met: found.is_some(), detail: found.unwrap_or_else(|| missing.into()), required }
}

pub struct NexusNative;

impl AIWorldProvider for NexusNative {
    fn id(&self) -> &'static str {
        "nexus_native"
    }
    fn name(&self) -> &'static str {
        "NEXUS Native AI World"
    }
    fn description(&self) -> &'static str {
        "Built-in 2D world inside NEXUS. Characters can mirror your real agents (hybrid) or live a simulation. No extra infrastructure."
    }
    fn prerequisites(&self, _root: &Path) -> Vec<Prerequisite> {
        vec![]
    }
}

/// The real a16z-infra/ai-town bundled with NEXUS (`ai-town/`), run locally by
/// `crate::aitown` (Convex local backend, no account). It is not created by the
/// wizard: the AI World page installs (after consent) and starts it.
pub struct AiTown;

impl AIWorldProvider for AiTown {
    fn id(&self) -> &'static str {
        "ai_town"
    }
    fn name(&self) -> &'static str {
        "AI Town (integrated)"
    }
    fn description(&self) -> &'static str {
        "The real AI Town (a16z-infra/ai-town, MIT) bundled with NEXUS and run locally: pixel-art town, every NEXUS agent is a character. Needs Node.js; data stays on this PC, no Convex account."
    }
    fn prerequisites(&self, _root: &Path) -> Vec<Prerequisite> {
        vec![
            prereq(
                "Node.js 18+",
                version_of("node", &["--version"]).filter(|v| node_major(v).is_some_and(|m| m >= 18)),
                true,
                "Node 18 or newer required",
            ),
            prereq("npm", version_of(&pcc_platform::paths::script("npm"), &["--version"]), true, "not installed"),
        ]
    }
}

fn node_major(version: &str) -> Option<u32> {
    version.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

pub struct CustomWorld;

impl AIWorldProvider for CustomWorld {
    fn id(&self) -> &'static str {
        "custom"
    }
    fn name(&self) -> &'static str {
        "Custom world project"
    }
    fn description(&self) -> &'static str {
        "Any existing world/simulation project folder: NEXUS keeps the characters and links them to agents; you choose how it runs."
    }
    fn prerequisites(&self, _root: &Path) -> Vec<Prerequisite> {
        vec![]
    }
}

pub fn registry() -> Vec<Box<dyn AIWorldProvider>> {
    vec![Box::new(NexusNative), Box::new(AiTown), Box::new(CustomWorld)]
}

pub fn list(root: &Path) -> Vec<ProviderInfo> {
    registry().iter().map(|p| p.info(root)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_three_providers() {
        let ids: Vec<&str> = registry().iter().map(|p| p.id()).collect();
        assert_eq!(ids, ["nexus_native", "ai_town", "custom"]);
        assert!(NexusNative.info(Path::new(".")).ready);
    }

    #[test]
    fn reads_node_major_versions() {
        assert_eq!(node_major("v20.11.1"), Some(20));
        assert_eq!(
            node_major(
                "18.0.0
"
            ),
            Some(18)
        );
        assert_eq!(node_major("garbage"), None);
    }
}
