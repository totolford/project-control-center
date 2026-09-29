import { memo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Box, Cable, Gamepad2, GitBranch, GitPullRequest, HardDrive, KeyRound, Plug, Plus, Server, Trash2, Zap } from "lucide-react";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import { CONNECTION_STATUS } from "../lib/labels";
import { formatRelative } from "../lib/format";
import type { Connection, ConnectionKind } from "../lib/types";
import { useConnections, useStore } from "../store";
import { EmptyState, PageHeader, Spinner } from "../components/Common";
import { Chip } from "../components/StatusBadge";
import { Modal } from "../components/Modal";
import { AddConnectionDialog } from "./connections/AddConnectionDialog";
import { GithubPanel } from "./connections/GithubPanel";

const KIND_META: Record<ConnectionKind, { icon: LucideIcon; label: string }> = {
  local: { icon: HardDrive, label: "Local" },
  git: { icon: GitBranch, label: "Git" },
  github: { icon: GitPullRequest, label: "GitHub" },
  ssh: { icon: Server, label: "SSH" },
  mcp: { icon: Plug, label: "MCP server" },
  roblox_studio: { icon: Gamepad2, label: "Roblox Studio" },
  docker: { icon: Box, label: "Docker" },
};

function describe(c: Connection): string {
  const cfg = c.config;
  const str = (k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : "");
  switch (c.kind) {
    case "ssh":
      return `${str("user")}@${str("host")}${cfg.port ? `:${String(cfg.port)}` : ""}`;
    case "mcp":
    case "roblox_studio":
      return [str("command"), ...(Array.isArray(cfg.args) ? cfg.args.map(String) : [])].join(" ");
    case "github":
      return str("repo") || "repository from git remote";
    default:
      return "";
  }
}

const ConnectionRow = memo(function ConnectionRow({ conn, onDelete }: { conn: Connection; onDelete: (c: Connection) => void }) {
  const upsertConnection = useStore((s) => s.upsertConnection);
  const [testing, setTesting] = useState(false);
  const [secretKeys, setSecretKeys] = useState<string[] | null>(null);
  const meta = KIND_META[conn.kind] ?? { icon: Cable, label: conn.kind };
  const Icon = meta.icon;
  const status = CONNECTION_STATUS[conn.status];

  const test = async () => {
    setTesting(true);
    const updated = await attempt(() => api.checkConnection(conn.id));
    setTesting(false);
    if (updated) upsertConnection(updated);
  };

  const showSecrets = async () => {
    const keys = await attempt(() => api.connectionSecretKeys(conn.id));
    setSecretKeys(keys ?? []);
  };

  return (
    <div className="conn-row">
      <div className="conn-icon">
        <Icon size={18} />
      </div>
      <div className="grow conn-main">
        <div className="row">
          <strong>{conn.name}</strong>
          <span className="muted small">{meta.label}</span>
          <Chip tone={status.tone}>{status.label}</Chip>
        </div>
        {describe(conn) && <div className="mono small muted conn-desc">{describe(conn)}</div>}
        {conn.statusDetail && <div className={`small ${conn.status === "error" ? "tone-red-fg" : "muted"}`}>{conn.statusDetail}</div>}
        <div className="muted small">
          checked {formatRelative(conn.lastChecked)}
          {conn.credentialRef && (
            <>
              {" · "}
              {secretKeys === null ? (
                <button className="link-btn small" onClick={() => void showSecrets()}>
                  <KeyRound size={11} /> show stored secret names
                </button>
              ) : secretKeys.length === 0 ? (
                "no stored secrets"
              ) : (
                <>
                  <KeyRound size={11} /> secrets: {secretKeys.map((k) => <code key={k}>{k}</code>)}
                </>
              )}
            </>
          )}
        </div>
      </div>
      <button className="btn" onClick={() => void test()} disabled={testing}>
        {testing ? <Spinner size={12} /> : <Zap size={13} />} Test
      </button>
      <button className="icon-btn" onClick={() => onDelete(conn)} aria-label={`Delete ${conn.name}`} title="Delete connection">
        <Trash2 size={14} />
      </button>
    </div>
  );
});

export function Connections() {
  const connections = useConnections();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const hasGithub = connections.some((c) => c.kind === "github");

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    const ok = await run(() => api.deleteConnection(deleting.id), "Connection deleted");
    setBusy(false);
    if (ok) {
      useStore.getState().removeConnection(deleting.id);
    }
    setDeleting(null);
  };

  return (
    <div className="page">
      <PageHeader
        title="Connections"
        subtitle="External systems agents can use. Grant them per agent in the agent's Permissions tab."
        actions={
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add connection
          </button>
        }
      />
      {connections.length === 0 ? (
        <EmptyState icon={<Cable size={22} />} title="No connections">
          Add SSH hosts, MCP servers, Roblox Studio, GitHub or Docker.
        </EmptyState>
      ) : (
        <div className="panel conn-list">
          {connections.map((c) => (
            <ConnectionRow key={c.id} conn={c} onDelete={setDeleting} />
          ))}
        </div>
      )}
      {hasGithub && <GithubPanel />}
      {adding && <AddConnectionDialog onClose={() => setAdding(false)} />}
      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          onClose={() => setDeleting(null)}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void confirmDelete()} disabled={busy}>
                Delete
              </button>
            </>
          }
        >
          <p>The connection is removed from the project and agents lose access to it.</p>
        </Modal>
      )}
    </div>
  );
}
