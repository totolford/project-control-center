import { useState } from "react";
import { Cable, Plus } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import type { Connection } from "../lib/types";
import { useConnections, useStore } from "../store";
import { EmptyState, PageHeader } from "../components/Common";
import { Modal } from "../components/Modal";
import { AddConnectionDialog } from "./connections/AddConnectionDialog";
import { ConnectionCard } from "./connections/ConnectionCard";
import { GithubPanel } from "./connections/GithubPanel";

export function Connections() {
  const connections = useConnections();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const hasGithub = connections.some((c) => c.kind === "github");

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    const ok = await run(() => api.deleteConnection(deleting.id), "Connection deleted");
    setBusy(false);
    if (ok) useStore.getState().removeConnection(deleting.id);
    setDeleting(null);
  };

  return (
    <div className="page">
      <PageHeader
        title="Connections"
        subtitle="External systems agents can use in this project. An agent only gets the connections granted to it."
        actions={
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add connection
          </button>
        }
      />
      {connections.length === 0 ? (
        <EmptyState icon={<Cable size={22} />} title="No connections">
          Add GitHub, GitLab, SSH / SFTP hosts, terminals, HTTP APIs, MCP servers, Roblox Studio or Docker.
        </EmptyState>
      ) : (
        <div className="panel conn-list">
          {connections.map((c) => (
            <ConnectionCard key={c.id} conn={c} onEdit={setEditing} onDelete={setDeleting} />
          ))}
        </div>
      )}
      {hasGithub && <GithubPanel />}
      {adding && <AddConnectionDialog onClose={() => setAdding(false)} />}
      {editing && <AddConnectionDialog editing={editing} onClose={() => setEditing(null)} />}
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
          <p>The connection, its stored secrets and every agent grant are removed.</p>
        </Modal>
      )}
    </div>
  );
}
