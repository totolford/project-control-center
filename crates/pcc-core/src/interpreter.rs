//! Command Interpreter: turns a command line given by the user or an agent
//! (`claude mcp add ...`, `ssh pi@host`, `git clone ...`) into a structured
//! intent NEXUS can act on. Pure: no I/O.

use serde::{Deserialize, Serialize};

use crate::permissions::{classify_command, Capability};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Intent {
    /// `claude mcp add [...] <name> [--] <commandOrUrl> [args...]`
    AddMcp {
        name: String,
        transport: String,
        scope: Option<String>,
        command: Option<String>,
        args: Vec<String>,
        url: Option<String>,
        /// `-e KEY=VALUE` pairs. Values are treated as secrets.
        env: Vec<(String, String)>,
        /// `-H "Name: value"` pairs. Values are treated as secrets.
        headers: Vec<(String, String)>,
    },
    /// `ssh [-p port] [-i key] user@host [command]`
    Ssh {
        user: Option<String>,
        host: String,
        port: Option<u16>,
        key_path: Option<String>,
        remote_command: Option<String>,
    },
    /// `git clone <url> [dir]` or `gh repo clone <owner/repo> [dir]`
    Clone { url: String, directory: Option<String> },
    /// `gh auth login ...`
    GithubLogin,
    /// Any other `claude ...` command.
    ClaudeCli { args: Vec<String> },
    /// Anything else: run by an agent or in a terminal.
    Shell,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Interpretation {
    pub raw: String,
    pub program: String,
    pub tokens: Vec<String>,
    pub intent: Intent,
    pub summary: String,
    pub capability: Capability,
    pub destructive: bool,
}

/// Splits a command line like a shell: spaces separate words, `"..."` and
/// `'...'` group them; backslashes are literal (Windows paths).
pub fn tokenize(line: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    for c in line.trim().chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                has = true;
            }
            (None, c) if c.is_whitespace() => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if quote.is_some() {
        return Err("unterminated quote".into());
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

fn program_name(token: &str) -> String {
    let base = token.rsplit(['/', '\\']).next().unwrap_or(token).to_ascii_lowercase();
    base.trim_end_matches(".exe").trim_end_matches(".cmd").trim_end_matches(".ps1").to_string()
}

fn parse_mcp_add(rest: &[String]) -> Result<Intent, String> {
    let mut transport = "stdio".to_string();
    let mut scope = None;
    let mut env = Vec::new();
    let mut headers = Vec::new();
    let mut positional: Vec<String> = Vec::new();
    let mut i = 0;
    let mut after_dashes = false;
    while i < rest.len() {
        let t = &rest[i];
        if after_dashes {
            positional.push(t.clone());
            i += 1;
            continue;
        }
        let value = |i: usize| rest.get(i + 1).cloned().ok_or_else(|| format!("{t} needs a value"));
        match t.as_str() {
            "--" => after_dashes = true,
            "-t" | "--transport" => {
                transport = value(i)?;
                i += 1;
            }
            "-s" | "--scope" => {
                scope = Some(value(i)?);
                i += 1;
            }
            "-e" | "--env" => {
                // Variadic: KEY=VALUE tokens until the next flag.
                while let Some(kv) = rest.get(i + 1).filter(|x| !x.starts_with('-') && x.contains('=')) {
                    let (k, v) = kv.split_once('=').expect("contains =");
                    env.push((k.to_string(), v.to_string()));
                    i += 1;
                }
            }
            "-H" | "--header" => {
                while let Some(h) = rest.get(i + 1).filter(|x| !x.starts_with('-') && x.contains(':')) {
                    let (k, v) = h.split_once(':').expect("contains :");
                    headers.push((k.trim().to_string(), v.trim().to_string()));
                    i += 1;
                }
            }
            "--client-id" | "--callback-port" => i += 1,
            "--client-secret" => {}
            f if f.starts_with("--transport=") => transport = f["--transport=".len()..].to_string(),
            f if f.starts_with("--scope=") => scope = Some(f["--scope=".len()..].to_string()),
            _ => positional.push(t.clone()),
        }
        i += 1;
    }
    let mut it = positional.into_iter();
    let name = it.next().ok_or("missing server name")?;
    let target = it.next().ok_or("missing command or URL")?;
    let args: Vec<String> = it.collect();
    let remote = matches!(transport.as_str(), "http" | "sse");
    if !matches!(transport.as_str(), "stdio" | "http" | "sse") {
        return Err(format!("unknown transport `{transport}`"));
    }
    Ok(Intent::AddMcp {
        name,
        transport,
        scope,
        command: (!remote).then(|| target.clone()),
        args,
        url: remote.then_some(target),
        env,
        headers,
    })
}

fn parse_ssh(rest: &[String]) -> Result<Intent, String> {
    const WITH_VALUE: &[&str] = &[
        "-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-E", "-b", "-c", "-m", "-O", "-Q", "-S", "-W", "-w",
        "-B",
    ];
    let mut port = None;
    let mut key_path = None;
    let mut user = None;
    let mut i = 0;
    while i < rest.len() && rest[i].starts_with('-') {
        let f = rest[i].as_str();
        if WITH_VALUE.contains(&f) {
            let v = rest.get(i + 1).ok_or_else(|| format!("{f} needs a value"))?.clone();
            match f {
                "-p" => port = Some(v.parse::<u16>().map_err(|_| format!("invalid port `{v}`"))?),
                "-i" => key_path = Some(v),
                "-l" => user = Some(v),
                _ => {}
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    let dest = rest.get(i).ok_or("missing destination (user@host)")?;
    let dest = dest.trim_start_matches("ssh://");
    let (u, host_port) = match dest.rsplit_once('@') {
        Some((u, h)) => (Some(u.to_string()), h),
        None => (None, dest),
    };
    let (host, p) = match host_port.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h.to_string(), p.parse().ok()),
        _ => (host_port.to_string(), None),
    };
    if host.is_empty() {
        return Err("missing host".into());
    }
    let remote: Vec<String> = rest[i + 1..].to_vec();
    Ok(Intent::Ssh {
        user: u.or(user),
        host,
        port: port.or(p),
        key_path,
        remote_command: (!remote.is_empty()).then(|| remote.join(" ")),
    })
}

pub fn interpret(line: &str) -> Result<Interpretation, String> {
    let tokens = tokenize(line)?;
    let first = tokens.first().ok_or("empty command")?;
    let program = program_name(first);
    let rest = &tokens[1..];
    let words: Vec<&str> = rest.iter().map(String::as_str).collect();
    let intent = match (program.as_str(), words.as_slice()) {
        ("claude", ["mcp", "add", ..]) => parse_mcp_add(&rest[2..])?,
        ("claude", _) => Intent::ClaudeCli { args: rest.to_vec() },
        ("ssh", _) => parse_ssh(rest)?,
        ("git", ["clone", ..]) => {
            let pos: Vec<&String> = rest[1..].iter().filter(|t| !t.starts_with('-')).collect();
            Intent::Clone {
                url: pos.first().map(|s| s.to_string()).ok_or("missing repository URL")?,
                directory: pos.get(1).map(|s| s.to_string()),
            }
        }
        ("gh", ["repo", "clone", repo, ..]) => Intent::Clone {
            url: format!("https://github.com/{repo}.git"),
            directory: rest.get(3).filter(|d| !d.starts_with('-')).cloned(),
        },
        ("gh", ["auth", "login", ..]) => Intent::GithubLogin,
        _ => Intent::Shell,
    };
    let class = classify_command(line);
    let summary = match &intent {
        Intent::AddMcp { name, transport, command, url, args, .. } => format!(
            "Add MCP server `{name}` ({transport}): {}",
            url.clone().unwrap_or_else(|| format!("{} {}", command.clone().unwrap_or_default(), args.join(" ")))
        ),
        Intent::Ssh { user, host, port, remote_command, .. } => format!(
            "SSH to {}{host}{}{}",
            user.as_ref().map(|u| format!("{u}@")).unwrap_or_default(),
            port.map(|p| format!(":{p}")).unwrap_or_default(),
            remote_command.as_ref().map(|c| format!(" and run `{c}`")).unwrap_or_default()
        ),
        Intent::Clone { url, .. } => format!("Clone {url}"),
        Intent::GithubLogin => "Sign in to GitHub with the official gh flow".into(),
        Intent::ClaudeCli { args } => format!("Claude Code CLI: claude {}", args.join(" ")),
        Intent::Shell => format!("Run `{program}` command"),
    };
    let capability = match &intent {
        Intent::AddMcp { .. } => Capability::Mcp,
        Intent::Ssh { remote_command: None, .. } => Capability::SshRead,
        Intent::Ssh { .. } => Capability::SshExecute,
        Intent::GithubLogin => Capability::GithubAdmin,
        _ => class.capability,
    };
    Ok(Interpretation {
        raw: line.trim().to_string(),
        program,
        tokens,
        intent,
        summary,
        capability,
        destructive: class.destructive,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_quotes_and_windows_paths() {
        assert_eq!(
            tokenize(r#"cmd.exe /c "cd /d %LOCALAPPDATA%\Roblox && .\mcp.bat" ''"#).unwrap(),
            vec!["cmd.exe", "/c", r"cd /d %LOCALAPPDATA%\Roblox && .\mcp.bat", ""]
        );
        assert!(tokenize("echo \"open").is_err());
    }

    #[test]
    fn roblox_mcp_command_from_the_user() {
        let i = interpret(r#"claude mcp add --transport stdio Roblox_Studio -- "cmd.exe" "/c" "cd /d %LOCALAPPDATA%\Roblox && .\mcp.bat""#).unwrap();
        match i.intent {
            Intent::AddMcp { name, transport, command, args, url, .. } => {
                assert_eq!(name, "Roblox_Studio");
                assert_eq!(transport, "stdio");
                assert_eq!(command.as_deref(), Some("cmd.exe"));
                assert_eq!(args, vec!["/c", r"cd /d %LOCALAPPDATA%\Roblox && .\mcp.bat"]);
                assert_eq!(url, None);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(i.capability, Capability::Mcp);
    }

    #[test]
    fn mcp_http_with_env_and_headers() {
        let i = interpret(
            r#"claude mcp add -s user -t http -H "Authorization: Bearer abc" sentry https://mcp.sentry.dev/mcp"#,
        )
        .unwrap();
        assert_eq!(
            i.intent,
            Intent::AddMcp {
                name: "sentry".into(),
                transport: "http".into(),
                scope: Some("user".into()),
                command: None,
                args: vec![],
                url: Some("https://mcp.sentry.dev/mcp".into()),
                env: vec![],
                headers: vec![("Authorization".into(), "Bearer abc".into())],
            }
        );
        let e = interpret("claude mcp add my-server -e API_KEY=xyz OTHER=1 -- npx my-mcp-server --flag").unwrap();
        match e.intent {
            Intent::AddMcp { env, command, args, .. } => {
                assert_eq!(env, vec![("API_KEY".into(), "xyz".into()), ("OTHER".into(), "1".into())]);
                assert_eq!(command.as_deref(), Some("npx"));
                assert_eq!(args, vec!["my-mcp-server", "--flag"]);
            }
            other => panic!("{other:?}"),
        }
        assert!(interpret("claude mcp add only-name").is_err());
    }

    #[test]
    fn ssh_variants() {
        let i = interpret("ssh pi@192.168.1.157").unwrap();
        assert_eq!(
            i.intent,
            Intent::Ssh {
                user: Some("pi".into()),
                host: "192.168.1.157".into(),
                port: None,
                key_path: None,
                remote_command: None
            }
        );
        assert_eq!(i.capability, Capability::SshRead);
        let j = interpret(r"ssh -p 2222 -i C:\keys\pi admin@srv docker ps").unwrap();
        assert_eq!(
            j.intent,
            Intent::Ssh {
                user: Some("admin".into()),
                host: "srv".into(),
                port: Some(2222),
                key_path: Some(r"C:\keys\pi".into()),
                remote_command: Some("docker ps".into())
            }
        );
        assert_eq!(j.capability, Capability::SshExecute);
        assert!(matches!(interpret("ssh ssh://u@h:2200").unwrap().intent, Intent::Ssh { port: Some(2200), .. }));
    }

    #[test]
    fn git_gh_and_generic() {
        assert_eq!(
            interpret("git clone https://github.com/a/b.git dest").unwrap().intent,
            Intent::Clone { url: "https://github.com/a/b.git".into(), directory: Some("dest".into()) }
        );
        assert_eq!(
            interpret("gh repo clone a/b").unwrap().intent,
            Intent::Clone { url: "https://github.com/a/b.git".into(), directory: None }
        );
        assert_eq!(interpret("gh auth login --web").unwrap().intent, Intent::GithubLogin);
        let n = interpret("npm run build").unwrap();
        assert_eq!(n.intent, Intent::Shell);
        assert_eq!(n.capability, Capability::FsExecute);
        assert!(interpret("rm -rf build").unwrap().destructive);
        assert_eq!(interpret("claude doctor").unwrap().intent, Intent::ClaudeCli { args: vec!["doctor".into()] });
    }
}
