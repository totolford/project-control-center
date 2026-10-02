import { useState } from "react";
import { FolderGit2 } from "lucide-react";
import { useLoad } from "../../lib/useLoad";
import { EmptyState, PageHeader, Section } from "../../components/Common";
import { GithubPanel } from "../connections/GithubPanel";
import { GithubAccountSection, loadGithubAccount } from "./GithubAccountSection";
import { RepoBrowser } from "./RepoBrowser";
import { RepoDetail } from "./RepoDetail";

/** GitHub: the account behind `gh`, what agents may do with it, the project's repository and every repository of the account. */
export function GithubView() {
  const { data, error, loading, reload } = useLoad(loadGithubAccount);
  const [repo, setRepo] = useState<string | null>(null);
  const account = data?.account ?? null;
  return (
    <div className="page">
      <PageHeader title="GitHub" subtitle="Everything goes through the official GitHub CLI (gh) with your account; nothing is cached or simulated." />
      {error && <div className="notice notice-error">GitHub status unavailable: {error}</div>}
      <GithubAccountSection status={data?.status ?? null} account={account} accountError={data?.accountError ?? null} loading={loading} onReload={() => void reload()} />
      <GithubPanel title="Project repository" />
      <Section title="Repositories">
        {account ? (
          <div className="gh-repos">
            <RepoBrowser account={account} selected={repo} onSelect={setRepo} />
            {repo ? (
              <RepoDetail key={repo} repo={repo} />
            ) : (
              <EmptyState icon={<FolderGit2 size={22} />} title="Pick a repository">
                Issues, pull requests, Actions runs, releases, branches and commits load from GitHub.
              </EmptyState>
            )}
          </div>
        ) : (
          <div className="muted small">Unavailable until GitHub is connected (see Account).</div>
        )}
      </Section>
    </div>
  );
}
