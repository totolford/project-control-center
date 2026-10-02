//! Read-only checks against the gh login of this machine.
//! cargo test -p pcc-connections --test live_github -- --ignored --nocapture

#[test]
#[ignore = "needs gh auth login"]
fn live_account_repos_detail() {
    let dir = std::env::temp_dir();
    let a = pcc_connections::github::account(&dir).unwrap();
    eprintln!("login ok: {}, scopes {:?}, orgs {}", !a.login.is_empty(), a.scopes, a.organizations.len());
    let repos = pcc_connections::github::repositories(&dir, None, Some("control center"), 50).unwrap();
    eprintln!("matching repos: {}", repos.len());
    let name = repos[0]["nameWithOwner"].as_str().unwrap().to_string();
    let d = pcc_connections::github::repository_detail(&dir, &name).unwrap();
    eprintln!(
        "{name}: {} runs, {} releases, {} branches, {} commits, unavailable {:?}",
        d.runs.len(),
        d.releases.len(),
        d.branches.len(),
        d.commits.len(),
        d.unavailable
    );
    assert!(!d.commits.is_empty());
}
