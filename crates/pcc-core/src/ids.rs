//! Identifier helpers.

use crate::{Error, Result};

/// Formats a sequential identifier such as `TASK-0042`.
pub fn seq_id(prefix: &str, n: i64) -> String {
    format!("{prefix}-{n:04}")
}

/// Normalizes a human name into an agent slug (`Lighting Specialist` -> `lighting-specialist`).
pub fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut dash = false;
    for c in input.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(40);
    out
}

/// Validates an agent id: it is used in file paths and git branch names.
pub fn validate_agent_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 40
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
        && !id.ends_with('-');
    if ok {
        Ok(())
    } else {
        Err(Error::invalid(format!("invalid agent id `{id}`: use 1-40 lowercase letters, digits and dashes")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_names() {
        assert_eq!(slugify("Lighting Specialist"), "lighting-specialist");
        assert_eq!(slugify("  UI / UX -- Agent "), "ui-ux-agent");
        assert_eq!(slugify("Été"), "t");
    }

    #[test]
    fn agent_id_validation() {
        assert!(validate_agent_id("frontend").is_ok());
        assert!(validate_agent_id("db-2").is_ok());
        assert!(validate_agent_id("Front").is_err());
        assert!(validate_agent_id("-x").is_err());
        assert!(validate_agent_id("a/b").is_err());
        assert!(validate_agent_id("").is_err());
    }

    #[test]
    fn seq_ids() {
        assert_eq!(seq_id("TASK", 42), "TASK-0042");
        assert_eq!(seq_id("M", 12345), "M-12345");
    }
}
