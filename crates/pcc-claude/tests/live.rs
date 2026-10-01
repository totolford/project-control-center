//! Checks against the installed Claude Code (no model call, no cost).
//! Run with: cargo test -p pcc-claude --test live -- --ignored --nocapture

#[test]
#[ignore = "needs Claude Code installed"]
fn live_command_tree() {
    let claude = pcc_claude::find_claude().expect("claude installed");
    let tree = pcc_claude::cli_help::command_tree(&claude).unwrap();
    let subs: usize = tree.subcommands.iter().map(|s| s.subcommands.len()).sum();
    eprintln!("root options {}, commands {}, leaf commands {}", tree.options.len(), tree.subcommands.len(), subs);
    for s in &tree.subcommands {
        eprintln!("  {:<14} [{}] {} opts, {} subs", s.path.join(" "), s.category, s.options.len(), s.subcommands.len());
    }
    assert!(tree.options.iter().any(|o| o.long.as_deref() == Some("--model")));
    assert!(tree
        .subcommands
        .iter()
        .any(|s| s.path == ["mcp"] && s.subcommands.iter().any(|x| x.path == ["mcp", "add"])));
}

#[tokio::test]
#[ignore = "needs Claude Code installed"]
async fn live_inspect() {
    let env = pcc_claude::inspect::inspect(&std::env::temp_dir()).await;
    eprintln!(
        "models {} commands {} agents {} mcp {} plugins {} unavailable {:?}",
        env.models.len(),
        env.commands.len(),
        env.agents.len(),
        env.mcp_servers.len(),
        env.plugins.len(),
        env.unavailable
    );
    eprintln!(
        "context {}%  usage keys {:?}",
        env.context["percentage"],
        env.usage.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );
    assert!(!env.models.is_empty());
    assert!(env.settings["effective"].is_object());
}
