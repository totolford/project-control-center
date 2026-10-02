//! World providers. NEXUS is never tied to one: the native engine runs inside
//! NEXUS; AI Town (a16z-infra/ai-town, MIT) is an optional fork; custom points
//! to any existing world project.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use pcc_claude::process::std_command;
use pcc_core::{Error, Result};

use crate::model::Character;

pub const AI_TOWN_REPO: &str = "https://github.com/a16z-infra/ai-town.git";

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

pub struct AiTownCompatible;

impl AIWorldProvider for AiTownCompatible {
    fn id(&self) -> &'static str {
        "ai_town_compatible"
    }
    fn name(&self) -> &'static str {
        "AI Town compatible"
    }
    fn description(&self) -> &'static str {
        "Native world plus an export of the characters in AI Town's format (data/characters.ts), ready to drop into an AI Town deployment."
    }
    fn prerequisites(&self, _root: &Path) -> Vec<Prerequisite> {
        vec![]
    }
}

pub struct AiTownFork;

impl AIWorldProvider for AiTownFork {
    fn id(&self) -> &'static str {
        "ai_town"
    }
    fn name(&self) -> &'static str {
        "AI Town fork"
    }
    fn description(&self) -> &'static str {
        "Clones a16z-infra/ai-town (MIT) and generates its characters from your world. AI Town runs on Convex (cloud or self-hosted with Docker) and an Ollama or OpenAI-compatible LLM with embeddings; Claude subscriptions cannot drive it directly."
    }
    fn prerequisites(&self, _root: &Path) -> Vec<Prerequisite> {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
        let convex_login = home
            .map(|h| h.join(".convex").join("config.json"))
            .filter(|p| p.is_file())
            .map(|_| "logged in (~/.convex)".to_string());
        vec![
            prereq("Git", version_of("git", &["--version"]), true, "not installed"),
            prereq(
                "Node.js 18+",
                version_of("node", &["--version"]).filter(|v| {
                    v.trim_start_matches('v')
                        .split('.')
                        .next()
                        .and_then(|m| m.parse::<u32>().ok())
                        .is_some_and(|m| m >= 18)
                }),
                true,
                "Node 18 or newer required",
            ),
            prereq(
                "npm",
                version_of("npm.cmd", &["--version"]).or_else(|| version_of("npm", &["--version"])),
                true,
                "not installed",
            ),
            prereq("Convex account", convex_login, false, "run `npx convex login` (or self-host with Docker)"),
            prereq(
                "Docker (self-hosted Convex)",
                version_of("docker", &["--version"]),
                false,
                "optional: needed only to self-host",
            ),
            prereq(
                "Ollama (local LLM)",
                version_of("ollama", &["--version"]),
                false,
                "optional: or set an OpenAI-compatible LLM in Convex env",
            ),
        ]
    }
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
    vec![Box::new(NexusNative), Box::new(AiTownCompatible), Box::new(AiTownFork), Box::new(CustomWorld)]
}

pub fn list(root: &Path) -> Vec<ProviderInfo> {
    registry().iter().map(|p| p.info(root)).collect()
}

// ------------------------------------------------------------ AI Town format

fn ts_string(s: &str) -> String {
    format!("`{}`", s.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${"))
}

/// The `Descriptions` array of AI Town's `data/characters.ts`.
pub fn ai_town_descriptions(characters: &[Character]) -> String {
    let mut out = String::from("export const Descriptions = [\n");
    for (i, c) in characters.iter().enumerate() {
        let sprite = if c.sprite.starts_with('f') { c.sprite.clone() } else { format!("f{}", i % 8 + 1) };
        let mut identity = format!("{} is {}.", c.name, c.personality.trim().trim_end_matches('.'));
        if !c.skills.is_empty() {
            identity.push_str(&format!(" Skills: {}.", c.skills.join(", ")));
        }
        if !c.relationships.is_empty() {
            let rel: Vec<String> = c.relationships.iter().map(|r| format!("{} ({})", r.with, r.kind)).collect();
            identity.push_str(&format!(" Works with {}.", rel.join(", ")));
        }
        let plan = c.goals.first().cloned().unwrap_or_else(|| "You want to help the team.".into());
        out.push_str(&format!(
            "  {{\n    name: {},\n    character: '{sprite}',\n    identity: {},\n    plan: {},\n  }},\n",
            ts_string(&c.name),
            ts_string(&identity),
            ts_string(&plan)
        ));
    }
    out.push_str("];");
    out
}

/// Replaces the `Descriptions` array in an AI Town `characters.ts`, keeping the rest.
pub fn patch_characters_ts(source: &str, characters: &[Character]) -> Result<String> {
    let start = source
        .find("export const Descriptions = [")
        .ok_or_else(|| Error::invalid("Descriptions array not found in characters.ts"))?;
    let rest = &source[start..];
    let end_rel = rest.find("\n];").ok_or_else(|| Error::invalid("end of Descriptions array not found"))? + 3;
    Ok(format!("{}{}{}", &source[..start], ai_town_descriptions(characters), &rest[end_rel..]))
}

/// Clones AI Town into `dest` and writes the characters. Blocking (network).
pub fn create_ai_town_fork(dest: &Path, characters: &[Character]) -> Result<Vec<String>> {
    let mut steps = Vec::new();
    if dest.join("package.json").is_file() {
        steps.push(format!("Reusing existing AI Town folder {}", dest.display()));
    } else {
        if dest.exists() && dest.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false) {
            return Err(Error::Conflict(format!("{} is not empty", dest.display())));
        }
        let out = std_command("git")
            .args(["clone", "--depth", "1", AI_TOWN_REPO, &dest.to_string_lossy()])
            .output()
            .map_err(|e| Error::Process(format!("git: {e}")))?;
        if !out.status.success() {
            return Err(Error::Process(format!("git clone failed: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
        steps.push(format!("Cloned {AI_TOWN_REPO} into {}", dest.display()));
    }
    let file = dest.join("data").join("characters.ts");
    let source = std::fs::read_to_string(&file)?;
    std::fs::write(&file, patch_characters_ts(&source, characters)?)?;
    steps.push(format!("Wrote {} characters to data/characters.ts", characters.len()));
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Relationship;

    #[test]
    fn patches_only_the_descriptions_array() {
        let src = "import x from './a';\n\nexport const Descriptions = [\n  {\n    name: 'Lucky',\n  },\n];\n\nexport const characters = [1];\n";
        let c = Character {
            name: "Roblox Agent".into(),
            personality: "technical and precise".into(),
            goals: vec!["Maintain Roblox systems".into()],
            skills: vec!["Roblox".into(), "Lua".into()],
            relationships: vec![Relationship { with: "Central".into(), kind: "reports to".into() }],
            ..Default::default()
        };
        let out = patch_characters_ts(src, &[c]).unwrap();
        assert!(out.starts_with("import x from './a';"));
        assert!(out.contains("name: `Roblox Agent`"));
        assert!(out.contains("character: 'f1'"));
        assert!(out.contains("Skills: Roblox, Lua."));
        assert!(out.contains("Works with Central (reports to)."));
        assert!(out.contains("plan: `Maintain Roblox systems`"));
        assert!(out.ends_with("export const characters = [1];\n"));
        assert!(!out.contains("Lucky"));
        assert!(patch_characters_ts("nothing", &[]).is_err());
        assert_eq!(ts_string("a`b${c}"), "`a\\`b\\${c}`");
    }

    #[test]
    fn registry_has_four_providers() {
        let ids: Vec<&str> = registry().iter().map(|p| p.id()).collect();
        assert_eq!(ids, ["nexus_native", "ai_town_compatible", "ai_town", "custom"]);
        assert!(NexusNative.info(Path::new(".")).ready);
    }
}
