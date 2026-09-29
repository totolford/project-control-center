//! Markdown memory files.
//!
//! Memory is what survives between sessions and gets injected into agent
//! prompts. Raw history (logs, messages) stays in the database; only curated
//! content lives here, so prompts stay small.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::layout::{Layout, PROJECT_MEMORY_FILES};
use pcc_core::{ids::validate_agent_id, Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", content = "name", rename_all = "snake_case")]
pub enum MemoryScope {
    /// `memory/<name>.md`
    Project(String),
    /// `agents/<id>/memory.md`
    Agent(String),
}

impl MemoryScope {
    /// Parses `project`, `architecture`, ... or `agent:<id>`.
    pub fn parse(s: &str) -> Result<Self> {
        let s = s.trim().trim_end_matches(".md");
        if let Some(id) = s.strip_prefix("agent:") {
            validate_agent_id(id)?;
            return Ok(MemoryScope::Agent(id.to_string()));
        }
        if PROJECT_MEMORY_FILES.iter().any(|(n, _)| *n == s) {
            Ok(MemoryScope::Project(s.to_string()))
        } else {
            Err(Error::invalid(format!(
                "unknown memory file `{s}`; use one of {} or agent:<id>",
                PROJECT_MEMORY_FILES.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ")
            )))
        }
    }

    pub fn key(&self) -> String {
        match self {
            MemoryScope::Project(n) => n.clone(),
            MemoryScope::Agent(id) => format!("agent:{id}"),
        }
    }

    pub fn path(&self, layout: &Layout) -> PathBuf {
        match self {
            MemoryScope::Project(n) => layout.memory_dir().join(format!("{n}.md")),
            MemoryScope::Agent(id) => layout.agent_dir(id).join("memory.md"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub key: String,
    pub path: String,
    pub content: String,
    pub bytes: u64,
    pub modified: Option<String>,
}

pub fn read(layout: &Layout, scope: &MemoryScope) -> Result<MemoryFile> {
    let path = scope.path(layout);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let meta = fs::metadata(&path).ok();
    Ok(MemoryFile {
        key: scope.key(),
        path: path.to_string_lossy().into_owned(),
        bytes: content.len() as u64,
        modified: meta.and_then(|m| m.modified().ok()).map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()),
        content,
    })
}

pub fn write(layout: &Layout, scope: &MemoryScope, content: &str) -> Result<()> {
    crate::layout::write_atomic(&scope.path(layout), content.as_bytes())
}

/// Appends a dated entry.
pub fn append(layout: &Layout, scope: &MemoryScope, author: &str, entry: &str) -> Result<()> {
    let mut current = read(layout, scope)?.content;
    if !current.is_empty() && !current.ends_with('\n') {
        current.push('\n');
    }
    let date = chrono::Utc::now().format("%Y-%m-%d %H:%M");
    current.push_str(&format!("\n- [{date} · {author}] {}\n", entry.trim()));
    write(layout, scope, &current)
}

/// Returns the file content limited to `max_chars`, keeping the end (most recent
/// entries) when it has to cut.
pub fn read_budgeted(layout: &Layout, scope: &MemoryScope, max_chars: usize) -> Result<String> {
    let c = read(layout, scope)?.content;
    let n = c.chars().count();
    if n <= max_chars {
        return Ok(c);
    }
    let tail: String = c.chars().skip(n - max_chars).collect();
    Ok(format!("[… {} earlier characters omitted; ask Central to consolidate this file …]\n{tail}", n - max_chars))
}

pub fn list(layout: &Layout, agents: &[String]) -> Result<Vec<MemoryFile>> {
    let mut out = Vec::new();
    for (n, _) in PROJECT_MEMORY_FILES {
        out.push(read(layout, &MemoryScope::Project(n.to_string()))?);
    }
    for a in agents {
        out.push(read(layout, &MemoryScope::Agent(a.clone()))?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_parsing_rejects_traversal() {
        assert_eq!(MemoryScope::parse("decisions.md").unwrap(), MemoryScope::Project("decisions".into()));
        assert_eq!(MemoryScope::parse("agent:frontend").unwrap(), MemoryScope::Agent("frontend".into()));
        assert!(MemoryScope::parse("../../etc").is_err());
        assert!(MemoryScope::parse("agent:../x").is_err());
    }

    #[test]
    fn append_and_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let l = Layout::new(tmp.path());
        l.ensure().unwrap();
        let s = MemoryScope::Project("discoveries".into());
        append(&l, &s, "movement", "CFrame reset breaks tweens").unwrap();
        let c = read(&l, &s).unwrap().content;
        assert!(c.contains("movement] CFrame reset breaks tweens"));
        let b = read_budgeted(&l, &s, 20).unwrap();
        assert!(b.starts_with("[…"));
        assert!(b.ends_with("breaks tweens\n"));
    }
}
