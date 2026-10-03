// The market's sources (each identifiable) and the user-configured ones.

import { useEffect, useState } from "react";
import { BadgeCheck } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { attempt, toast } from "../../lib/toast";
import type { MarketSettings } from "../../lib/types";
import { Field, Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { Chip } from "../../components/StatusBadge";
import { OFFICIAL_LABEL, parseRepos } from "./marketModel";
import { useMarket } from "./marketStore";

const KIND_LABEL: Record<string, string> = {
  marketplace: "Claude Code marketplace",
  catalog: "NEXUS catalog",
  github_search: "GitHub search (cached)",
  user_repo: "Your repository",
  local: "On disk",
};

export function SourcesDialog({ onClose }: { onClose: () => void }) {
  const index = useMarket((s) => s.index);
  const reload = useMarket((s) => s.load);
  const [settings, setSettings] = useState<MarketSettings | null>(null);
  const [repos, setRepos] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.marketSettings().then(
      (s) => {
        setSettings(s);
        setRepos(s.userRepos.join("\n"));
      },
      (e) => setError(errorMessage(e)),
    );
  }, []);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    const s = await attempt(() => api.marketSaveSettings({ ...settings, userRepos: parseRepos(repos) }));
    setBusy(false);
    if (s) {
      toast.success("Sources saved. Refresh to scan new repositories.");
      await reload();
      onClose();
    }
  };

  return (
    <Modal
      title="Market sources"
      onClose={onClose}
      locked={busy}
      width={640}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy || !settings}>
            {busy && <Spinner size={12} />} Save
          </button>
        </>
      }
    >
      <table className="table mk-sources">
        <thead>
          <tr>
            <th>Source</th>
            <th>Kind</th>
            <th>Entries</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {(index?.sources ?? []).map((s) => (
            <tr key={s.id}>
              <td>
                <div className="row">
                  <strong>{s.label}</strong>
                  {s.official && (
                    <Chip tone="accent">
                      <BadgeCheck size={11} aria-hidden="true" /> {OFFICIAL_LABEL}
                    </Chip>
                  )}
                </div>
                {s.repo && <div className="muted small mono">{s.repo}</div>}
                {s.error && <div className="tone-red-fg small">{s.error}</div>}
              </td>
              <td className="small">{KIND_LABEL[s.kind] ?? s.kind}</td>
              <td>{s.entries}</td>
              <td className="small muted">{s.updatedAt ? s.updatedAt.slice(0, 16).replace("T", " ") : "unknown"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">
        Claude Code marketplaces are managed with <code>claude plugin marketplace add/remove</code>. Only Anthropic's own repositories are marked {OFFICIAL_LABEL}.
      </div>
      {error && <div className="notice notice-error">{error}</div>}
      {settings && (
        <>
          <Field label="Your GitHub repositories" hint="One owner/repo (or GitHub URL) per line. Every SKILL.md folder in them is listed after a refresh.">
            <textarea className="mono" rows={4} value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="owner/repo" />
          </Field>
          <label className="row">
            <input type="checkbox" checked={settings.autoRefresh} onChange={(e) => setSettings({ ...settings, autoRefresh: e.target.checked })} />
            <span>Refresh GitHub stars and your repositories once a day when the market opens (marketplaces are only updated when you ask)</span>
          </label>
        </>
      )}
    </Modal>
  );
}
