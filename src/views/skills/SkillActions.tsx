import { useState } from "react";
import { Copy, Download, FlaskConical, FolderOpen, Pencil, Power, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../../lib/api";
import { attempt, toast } from "../../lib/toast";
import type { ClaudeEnvironment, CliRun, Skill, SkillTest } from "../../lib/types";
import { Field, Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { CliRunOutput } from "../mcp/CliRunOutput";
import { useClaudeEnvironment } from "../mcp/useClaudeEnvironment";
import { isSynced, validateSkillName } from "./skillModel";
import { SkillEditor } from "./SkillEditor";

type Dialog = "edit" | "duplicate" | "delete" | "plugin" | null;

interface Props {
  skill: Skill;
  env: ClaudeEnvironment | null;
  onChanged: (selectDir?: string) => Promise<void>;
}

export function SkillActions({ skill, env, onChanged }: Props) {
  const { refresh: refreshEnv } = useClaudeEnvironment();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<SkillTest | null>(null);
  const [note, setNote] = useState<{ text: string; path?: string } | null>(null);
  const [cli, setCli] = useState<CliRun | null>(null);
  const [copyName, setCopyName] = useState(`${skill.name}-copy`);
  const plugin = skill.scope === "plugin" ? env?.plugins.find((p) => p.id === skill.source) : undefined;
  const pluginEnabled = plugin ? plugin.enabled !== false : null;

  const act = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    const r = await attempt(fn);
    setBusy(null);
    return r;
  };

  const toggle = async () => {
    const dir = await act("toggle", () => api.skillSetEnabled(skill.dir, !skill.enabled));
    if (dir) {
      toast.success(skill.enabled ? `Moved to ${dir} (skills-disabled/ is ignored by Claude Code)` : `Moved back to ${dir}`);
      await onChanged(dir);
    }
  };

  const togglePlugin = async () => {
    if (!skill.source || pluginEnabled === null) return;
    const run = await act("plugin", () => api.claudePluginSetEnabled(skill.source!, !pluginEnabled));
    setDialog(null);
    if (run) {
      setCli(run);
      await Promise.all([onChanged(skill.dir), refreshEnv()]);
    }
  };

  const duplicate = async () => {
    const dir = await act("duplicate", () => api.skillDuplicate(skill.dir, copyName));
    if (dir) {
      setDialog(null);
      toast.success(`Duplicated to ${dir}`);
      await onChanged(dir);
    }
  };

  const remove = async () => {
    const trash = await act("delete", () => api.skillDelete(skill.dir));
    setDialog(null);
    if (trash) {
      toast.success(`${skill.name} moved to the trash folder: ${trash}`);
      await onChanged();
    }
  };

  const runTest = async () => {
    const r = await act("test", () => api.skillTest(skill.dir));
    if (r) setTest(r);
  };

  const openFolder = async () => {
    try {
      await api.openPath(skill.dir);
    } catch (e) {
      setNote({ text: `NEXUS only opens folders inside the project (${errorMessage(e)}). Folder:`, path: skill.dir });
    }
  };

  const exportSkill = async () => {
    const dest = await open({ directory: true, title: `Export ${skill.name} to…` });
    if (typeof dest !== "string") return;
    const out = await act("export", () => api.skillExport(skill.dir, dest));
    if (out) setNote({ text: "Exported to", path: out });
  };

  const nameProblem = validateSkillName(copyName);

  return (
    <>
      <div className="tools-actions">
        {skill.editable ? (
          <button className="btn" onClick={() => void toggle()} disabled={busy !== null}>
            {busy === "toggle" ? <Spinner size={12} /> : <Power size={14} />} {skill.enabled ? "Deactivate" : "Activate"}
          </button>
        ) : skill.scope === "plugin" ? (
          <button className="btn" onClick={() => setDialog("plugin")} disabled={busy !== null || pluginEnabled === null} title={pluginEnabled === null ? "Plugin state unavailable from Claude Code" : undefined}>
            <Power size={14} /> {pluginEnabled ? "Disable plugin" : "Enable plugin"}
          </button>
        ) : null}
        {skill.editable && (
          <button className="btn" onClick={() => setDialog("edit")} disabled={busy !== null}>
            <Pencil size={14} /> Edit SKILL.md
          </button>
        )}
        <button className="btn" onClick={() => void runTest()} disabled={busy !== null}>
          {busy === "test" ? <Spinner size={12} /> : <FlaskConical size={14} />} Test
        </button>
        <button className="btn" onClick={() => setDialog("duplicate")} disabled={busy !== null}>
          <Copy size={14} /> Duplicate
        </button>
        <button className="btn" onClick={() => void openFolder()}>
          <FolderOpen size={14} /> Open folder
        </button>
        <button className="btn" onClick={() => void exportSkill()} disabled={busy !== null}>
          {busy === "export" ? <Spinner size={12} /> : <Download size={14} />} Export
        </button>
        {skill.editable && (
          <button className="btn danger-ghost" onClick={() => setDialog("delete")} disabled={busy !== null} aria-label={`Delete ${skill.name}`}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {!skill.editable && (
        <div className="muted small">
          {isSynced(skill)
            ? "Synced from claude.ai: read-only here, managed in claude.ai."
            : skill.scope === "plugin"
              ? "Plugin skills are read-only; they are enabled or disabled with their whole plugin."
              : "Read-only."}
        </div>
      )}
      {note && (
        <div className="notice">
          {note.text} {note.path && <code className="tools-path">{note.path}</code>}
        </div>
      )}
      {cli && <CliRunOutput run={cli} />}
      {test && (
        <div className={`notice ${test.discovered && test.problems.length === 0 ? "" : "notice-warn"}`}>
          <div>
            <strong>{test.discovered ? `Discovered by Claude Code as /${test.commandName}` : "Not discovered by Claude Code"}</strong>
            {test.problems.length > 0 ? (
              <ul>
                {test.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <div className="small">No problem found.</div>
            )}
          </div>
        </div>
      )}

      {dialog === "edit" && <SkillEditor skill={skill} onClose={() => setDialog(null)} onSaved={() => void onChanged(skill.dir)} />}
      {dialog === "duplicate" && (
        <Modal
          title={`Duplicate ${skill.name}`}
          onClose={() => setDialog(null)}
          locked={busy === "duplicate"}
          footer={
            <>
              <button className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void duplicate()} disabled={busy !== null || nameProblem !== null}>
                Duplicate
              </button>
            </>
          }
        >
          <Field label="New name" hint={nameProblem ?? (skill.editable ? "The copy is created next to the original." : "Read-only skills are copied into your user skills.")}>
            <input className="mono" value={copyName} onChange={(e) => setCopyName(e.target.value.trim())} />
          </Field>
        </Modal>
      )}
      {dialog === "delete" && (
        <Modal
          title={`Delete ${skill.name}?`}
          onClose={() => setDialog(null)}
          locked={busy === "delete"}
          footer={
            <>
              <button className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void remove()} disabled={busy !== null}>
                Move to trash
              </button>
            </>
          }
        >
          <p>The folder is moved to skills-trash/ next to the skills folder (recoverable by moving it back).</p>
        </Modal>
      )}
      {dialog === "plugin" && (
        <Modal
          title={`${pluginEnabled ? "Disable" : "Enable"} plugin ${skill.source}?`}
          onClose={() => setDialog(null)}
          locked={busy === "plugin"}
          footer={
            <>
              <button className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void togglePlugin()} disabled={busy !== null}>
                {busy === "plugin" && <Spinner size={12} />} {pluginEnabled ? "Disable" : "Enable"} plugin
              </button>
            </>
          }
        >
          <p>
            Claude Code enables plugins as a whole: this affects every skill, command, agent and MCP server of <code>{skill.source}</code>. Runs{" "}
            <code>claude plugin {pluginEnabled ? "disable" : "enable"} {skill.source}</code>.
          </p>
        </Modal>
      )}
    </>
  );
}
