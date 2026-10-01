//! Builds the Command Center from the installed Claude Code's own `--help`
//! output, so the interface always matches the installed version.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::process::std_command;
use pcc_core::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliOption {
    /// As written in the help, e.g. `-c, --continue` or `--model <model>`.
    pub flags: String,
    pub long: Option<String>,
    pub short: Option<String>,
    /// Value placeholder (`<model>`, `[value]`), if the option takes one.
    pub value: Option<String>,
    pub description: String,
    pub choices: Vec<String>,
    pub default: Option<String>,
    /// Category inferred from the option name (presentation only).
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliArgument {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliCommand {
    /// Words after `claude`, e.g. `["mcp", "add"]` (empty for the root).
    pub path: Vec<String>,
    pub aliases: Vec<String>,
    pub usage: String,
    /// Signature shown in the parent's command list, e.g. `add [options] <name> <commandOrUrl>`.
    pub signature: String,
    pub description: String,
    pub arguments: Vec<CliArgument>,
    pub options: Vec<CliOption>,
    pub subcommands: Vec<CliCommand>,
    pub category: String,
}

/// `(term, description)` pairs of one `Section:` block.
type Entries = Vec<(String, String)>;

/// Splits a help text into usage, description and `Section:` blocks.
fn sections(help: &str) -> (String, String, Vec<(String, Entries)>) {
    let mut usage = String::new();
    let mut description = Vec::new();
    let mut out: Vec<(String, Entries)> = Vec::new();
    let mut current: Option<(String, Entries)> = None;
    let mut in_header = true;
    for line in help.lines() {
        if let Some(u) = line.strip_prefix("Usage: ") {
            usage = u.trim().to_string();
            continue;
        }
        let trimmed = line.trim_end();
        if !trimmed.starts_with(' ') && trimmed.ends_with(':') && !trimmed.is_empty() {
            in_header = false;
            if let Some(c) = current.take() {
                out.push(c);
            }
            current = Some((trimmed.trim_end_matches(':').to_string(), Vec::new()));
            continue;
        }
        let Some((_, entries)) = current.as_mut() else {
            if in_header && !trimmed.trim().is_empty() {
                description.push(trimmed.trim().to_string());
            }
            continue;
        };
        if trimmed.trim().is_empty() {
            continue;
        }
        let indent = trimmed.len() - trimmed.trim_start().len();
        let body = trimmed.trim_start();
        // Sub-headings such as `Examples:` inside a description are not entries.
        let sub_heading = body.ends_with(':') && !body.contains("  ");
        if indent == 2 && !sub_heading {
            // Term and description are separated by a run of 2+ spaces.
            match body.find("  ") {
                Some(i) => entries.push((body[..i].trim().to_string(), body[i..].trim().to_string())),
                None => entries.push((body.to_string(), String::new())),
            }
        } else if let Some(last) = entries.last_mut() {
            if !last.1.is_empty() {
                last.1.push(' ');
            }
            last.1.push_str(trimmed.trim());
        }
    }
    if let Some(c) = current.take() {
        out.push(c);
    }
    (usage, description.join(" "), out)
}

fn extract_paren(desc: &str, key: &str) -> Option<String> {
    let start = desc.find(&format!("({key}: "))? + key.len() + 3;
    let end = desc[start..].find(')')? + start;
    Some(desc[start..end].to_string())
}

fn parse_option(term: &str, description: &str) -> CliOption {
    let mut o = CliOption { flags: term.to_string(), description: description.to_string(), ..Default::default() };
    for part in term.split(", ") {
        let mut words = part.split_whitespace();
        let flag = words.next().unwrap_or("");
        if let Some(v) = words.next() {
            o.value = Some(v.to_string());
        }
        if flag.starts_with("--") {
            if o.long.is_none() {
                o.long = Some(flag.to_string());
            }
        } else if flag.starts_with('-') {
            o.short = Some(flag.to_string());
        }
    }
    // Either `(choices: "a", "b")`, `(default: x)` or `(choices: "a", "b", default: "a")`.
    if let Some(c) = extract_paren(description, "choices") {
        for item in c.split(", ") {
            match item.strip_prefix("default: ") {
                Some(d) => o.default = Some(d.trim_matches('"').to_string()),
                None => o.choices.push(item.trim_matches('"').to_string()),
            }
        }
    }
    if o.default.is_none() {
        o.default = extract_paren(description, "default").map(|d| d.trim_matches('"').to_string());
    }
    o.category = categorize(o.long.as_deref().unwrap_or(term), description);
    o
}

/// Groups commands and options for the UI. Purely presentational.
pub fn categorize(name: &str, description: &str) -> String {
    let n = name.to_ascii_lowercase();
    let d = description.to_ascii_lowercase();
    // Short words must match a whole token (`pr` must not match `project`).
    let tokens: Vec<&str> = n.split(|c: char| !c.is_ascii_alphanumeric()).filter(|t| !t.is_empty()).collect();
    let has = |words: &[&str]| words.iter().any(|w| if w.len() <= 3 { tokens.contains(w) } else { n.contains(w) });
    let cat = if has(&["mcp"]) {
        "MCP"
    } else if has(&["model", "effort", "fallback", "betas", "fast"]) {
        "Model"
    } else if has(&["permission", "allow", "disallow", "dangerously", "restricted", "trust"]) {
        "Permission"
    } else if has(&[
        "resume",
        "continue",
        "session",
        "fork",
        "name",
        "teleport",
        "remote",
        "cloud",
        "background",
        "bg",
        "attach",
        "logs",
        "stop",
        "rm",
        "respawn",
    ]) {
        "Session"
    } else if has(&["agent"]) {
        "Agent"
    } else if has(&["tool"]) {
        "Tools"
    } else if has(&["add-dir", "file", "worktree", "tmux"]) {
        "Files"
    } else if has(&["pr", "git", "ultrareview"]) {
        "Git"
    } else if has(&["debug", "verbose", "doctor"]) {
        "Debug"
    } else if has(&["output", "format", "print", "json", "replay", "partial", "style", "brief", "screen-reader"]) {
        "Output"
    } else if has(&[
        "setting",
        "config",
        "plugin",
        "install",
        "update",
        "auth",
        "token",
        "import",
        "project",
        "system-prompt",
        "bare",
        "safe",
    ]) {
        "Configuration"
    } else if d.contains("schedule") || d.contains("automat") || has(&["budget", "hook"]) {
        "Automation"
    } else {
        "Advanced"
    };
    cat.to_string()
}

pub fn parse_help(path: &[String], help: &str) -> CliCommand {
    let (usage, description, secs) = sections(help);
    let mut cmd = CliCommand { path: path.to_vec(), usage, description, ..Default::default() };
    for (name, entries) in secs {
        match name.as_str() {
            "Arguments" => {
                cmd.arguments = entries.into_iter().map(|(n, d)| CliArgument { name: n, description: d }).collect()
            }
            "Options" => cmd.options = entries.iter().map(|(t, d)| parse_option(t, d)).collect(),
            "Commands" => {
                for (term, desc) in entries {
                    let first = term.split_whitespace().next().unwrap_or("").to_string();
                    let mut names = first.split('|').map(str::to_string);
                    let Some(name) = names.next().filter(|n| !n.is_empty() && n != "help") else { continue };
                    let mut sub_path = path.to_vec();
                    sub_path.push(name.clone());
                    // Multi-line examples follow the first sentence; keep the summary.
                    let summary = desc.split(" Examples:").next().unwrap_or(&desc).trim().to_string();
                    cmd.subcommands.push(CliCommand {
                        path: sub_path,
                        aliases: names.collect(),
                        signature: term.clone(),
                        category: categorize(&name, &summary),
                        description: summary,
                        ..Default::default()
                    });
                }
            }
            _ => {}
        }
    }
    cmd.category = categorize(path.last().map(String::as_str).unwrap_or("claude"), &cmd.description);
    cmd
}

fn help_text(claude: &Path, path: &[String]) -> Result<String> {
    let out = std_command(claude)
        .args(path)
        .arg("--help")
        .output()
        .map_err(|e| Error::Process(format!("cannot run claude --help: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.trim().is_empty() {
        return Err(Error::Process(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(text)
}

/// Reads the full command tree (root, sub-commands and their sub-commands).
/// Blocking: runs `claude ... --help` once per command.
pub fn command_tree(claude: &Path) -> Result<CliCommand> {
    let mut root = parse_help(&[], &help_text(claude, &[])?);
    for sub in root.subcommands.iter_mut() {
        let Ok(text) = help_text(claude, &sub.path) else { continue };
        let detailed = parse_help(&sub.path, &text);
        sub.usage = detailed.usage;
        sub.arguments = detailed.arguments;
        sub.options = detailed.options;
        if !detailed.description.is_empty() {
            sub.description = detailed.description;
        }
        sub.subcommands = detailed.subcommands;
        for leaf in sub.subcommands.iter_mut() {
            if let Ok(text) = help_text(claude, &leaf.path) {
                let d = parse_help(&leaf.path, &text);
                leaf.usage = d.usage;
                leaf.arguments = d.arguments;
                leaf.options = d.options;
            }
        }
    }
    Ok(root)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliRun {
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// Runs `claude <args>` without a terminal (stdin closed) and captures its output.
pub async fn run(claude: &Path, cwd: &Path, args: Vec<String>, timeout: std::time::Duration) -> Result<CliRun> {
    let started = std::time::Instant::now();
    let fut = crate::process::command(claude).args(&args).current_dir(cwd).output();
    let out = tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| {
            Error::Process(format!(
                "timed out after {}s (interactive commands need the Raw Terminal)",
                timeout.as_secs()
            ))
        })?
        .map_err(|e| Error::Process(e.to_string()))?;
    Ok(CliRun {
        args,
        exit_code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = r#"Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Arguments:
  prompt                                Your prompt

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  -c, --continue                        Continue the most recent conversation in
                                        the current directory
  --input-format <format>               Input format (only works with --print):
                                        "text" (default), or "stream-json"
                                        (realtime streaming input) (choices:
                                        "text", "stream-json")
  --permission-prompts <target>         Who answers (choices: "host", "none", default:
                                        "host")
  -h, --help                            Display help for command

Commands:
  agents [options]                      Manage background agents
  mcp                                   Configure and manage MCP servers
  plugin|plugins                        Manage Claude Code plugins
  help [command]                        display help for command
"#;

    const MCP: &str = r#"Usage: claude mcp [options] [command]

Configure and manage MCP servers

Options:
  -h, --help                            Display help for command

Commands:
  add [options] <name> <commandOrUrl> [args...]  Add an MCP server to Claude Code.

  Examples:
    # Add HTTP server:
    claude mcp add --transport http sentry https://mcp.sentry.dev/mcp
  get <name>                            Get details about an MCP server.
"#;

    #[test]
    fn parses_root_help() {
        let c = parse_help(&[], ROOT);
        assert_eq!(c.usage, "claude [options] [command] [prompt]");
        assert!(c.description.starts_with("Claude Code - starts"));
        assert_eq!(c.arguments[0].name, "prompt");
        let add_dir = &c.options[0];
        assert_eq!(add_dir.long.as_deref(), Some("--add-dir"));
        assert_eq!(add_dir.value.as_deref(), Some("<directories...>"));
        assert_eq!(add_dir.description, "Additional directories to allow tool access to");
        let allowed = &c.options[1];
        assert_eq!(allowed.long.as_deref(), Some("--allowedTools"));
        assert!(allowed.description.starts_with("Comma or space-separated"));
        let cont = &c.options[2];
        assert_eq!(
            (cont.short.as_deref(), cont.long.as_deref(), cont.value.as_deref()),
            (Some("-c"), Some("--continue"), None)
        );
        assert_eq!(c.options[3].choices, vec!["text", "stream-json"]);
        assert_eq!(c.options[4].default.as_deref(), Some("host"));
        assert_eq!(c.options[4].choices, vec!["host", "none"]);
        let names: Vec<_> = c.subcommands.iter().map(|s| s.path.join(" ")).collect();
        assert_eq!(names, ["agents", "mcp", "plugin"]);
        assert_eq!(c.subcommands[2].aliases, vec!["plugins"]);
        assert_eq!(c.subcommands[1].category, "MCP");
        assert_eq!(categorize("project", ""), "Configuration");
        assert_eq!(categorize("--from-pr", ""), "Git");
    }

    #[test]
    fn parses_subcommands_with_examples() {
        let c = parse_help(&["mcp".into()], MCP);
        assert_eq!(c.subcommands.len(), 2);
        assert_eq!(c.subcommands[0].path, vec!["mcp", "add"]);
        assert_eq!(c.subcommands[0].description, "Add an MCP server to Claude Code.");
        assert_eq!(c.subcommands[0].signature, "add [options] <name> <commandOrUrl> [args...]");
        assert_eq!(c.subcommands[1].description, "Get details about an MCP server.");
    }
}
