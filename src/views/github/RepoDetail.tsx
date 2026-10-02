import { useState, type ReactNode } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { run } from "../../lib/toast";
import { useLoad } from "../../lib/useLoad";
import type { RepositoryDetail } from "../../lib/types";
import { Loading, Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { Tabs } from "../../components/Tabs";
import { field, firstField, runTone } from "./githubModel";
import { RepoActions } from "./RepoActions";

type Tab = "issues" | "pulls" | "runs" | "releases" | "branches" | "commits";
type Item = Record<string, unknown>;

function Open({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <button className="icon-btn" onClick={() => void run(() => openUrl(url))} aria-label="Open on GitHub">
      <ExternalLink size={12} />
    </button>
  );
}

function List({ items, empty, render }: { items: Item[]; empty: string; render: (it: Item) => ReactNode }) {
  if (items.length === 0) return <div className="muted small pad">{empty}</div>;
  return (
    <ul className="gh-list">
      {items.map((it, i) => (
        <li key={i}>{render(it)}</li>
      ))}
    </ul>
  );
}

function TabBody({ tab, d }: { tab: Tab; d: RepositoryDetail }) {
  switch (tab) {
    case "issues":
    case "pulls":
      return (
        <List
          items={tab === "issues" ? d.issues : d.pullRequests}
          empty={tab === "issues" ? "No open issues." : "No open pull requests."}
          render={(it) => (
            <>
              <span className="muted mono">#{field(it, "number") ?? "?"}</span>
              <span className="grow ellipsis">{field(it, "title") ?? "(untitled)"}</span>
              {field(it, "headRefName") && <code className="small">{field(it, "headRefName")}</code>}
              <span className="muted small">{firstField(it, "author.login", "user.login") ?? ""}</span>
              <Open url={firstField(it, "url", "html_url")} />
            </>
          )}
        />
      );
    case "runs":
      return (
        <List
          items={d.runs}
          empty="No workflow run."
          render={(it) => {
            const status = field(it, "status");
            const conclusion = field(it, "conclusion");
            return (
              <>
                <Chip tone={runTone(status, conclusion)}>{status === "completed" ? (conclusion ?? "completed") : (status ?? "unknown")}</Chip>
                <span className="grow ellipsis">{field(it, "name") ?? field(it, "databaseId") ?? "run"}</span>
                <code className="small">{field(it, "headBranch") ?? ""}</code>
                <span className="muted small">{field(it, "event") ?? ""}</span>
                <span className="muted small mono">{formatDateTime(field(it, "createdAt"))}</span>
                <Open url={field(it, "url")} />
              </>
            );
          }}
        />
      );
    case "releases":
      return (
        <List
          items={d.releases}
          empty="No release."
          render={(it) => (
            <>
              <code>{field(it, "tagName") ?? "?"}</code>
              <span className="grow ellipsis">{field(it, "name") ?? ""}</span>
              {field(it, "isLatest") === "true" && <Chip tone="green">latest</Chip>}
              {field(it, "isDraft") === "true" && <Chip tone="grey">draft</Chip>}
              {field(it, "isPrerelease") === "true" && <Chip tone="amber">pre-release</Chip>}
              <span className="muted small mono">{formatDateTime(field(it, "publishedAt"))}</span>
            </>
          )}
        />
      );
    case "branches":
      return <List items={d.branches.map((b) => ({ name: b }))} empty="No branch." render={(it) => <code>{field(it, "name")}</code>} />;
    case "commits":
      return (
        <List
          items={d.commits}
          empty="No commit."
          render={(it) => (
            <>
              <code className="small">{(field(it, "sha") ?? "").slice(0, 7)}</code>
              <span className="grow ellipsis">{(field(it, "message") ?? "").split("\n")[0]}</span>
              <span className="muted small">{field(it, "author") ?? ""}</span>
              <span className="muted small mono">{formatDateTime(field(it, "date"))}</span>
              <Open url={field(it, "url")} />
            </>
          )}
        />
      );
  }
}

/** One repository: header, actions and tabs (issues, PRs, Actions runs, releases, branches, commits). */
export function RepoDetail({ repo }: { repo: string }) {
  const { data, error, loading, reload } = useLoad(() => api.githubRepository(repo));
  const [tab, setTab] = useState<Tab>("issues");
  const info = data?.info ?? null;
  const defaultBranch = firstField(info, "default_branch", "defaultBranchRef.name");
  return (
    <div className="gh-detail">
      <div className="row">
        <h2 className="grow mono">{repo}</h2>
        {firstField(info, "visibility") && <Chip tone="grey">{firstField(info, "visibility")}</Chip>}
        {defaultBranch && <span className="muted small">default: {defaultBranch}</span>}
        <Open url={firstField(info, "html_url", "url")} />
        <button className="icon-btn" onClick={() => void reload()} disabled={loading} aria-label="Reload repository">
          {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
        </button>
      </div>
      {firstField(info, "description") && <p className="muted">{firstField(info, "description")}</p>}
      <RepoActions repo={repo} defaultBranch={defaultBranch} />
      {error && <div className="notice notice-error small">{error}</div>}
      {data && data.unavailable.length > 0 && (
        <div className="notice notice-warn small">
          <span>
            Unavailable: <strong>{data.unavailable.join(" · ")}</strong>
          </span>
        </div>
      )}
      {!data && loading && <Loading />}
      {data && (
        <>
          <Tabs
            tabs={[
              { key: "issues", label: `Issues (${data.issues.length})` },
              { key: "pulls", label: `Pull requests (${data.pullRequests.length})` },
              { key: "runs", label: `Actions (${data.runs.length})` },
              { key: "releases", label: `Releases (${data.releases.length})` },
              { key: "branches", label: `Branches (${data.branches.length})` },
              { key: "commits", label: `Commits (${data.commits.length})` },
            ]}
            active={tab}
            onChange={setTab}
          />
          <div className="gh-tab-body">
            <TabBody tab={tab} d={data} />
          </div>
        </>
      )}
    </div>
  );
}
