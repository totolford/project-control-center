import { useEffect, useState } from "react";
import { ChevronLeft, Eye, Save } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { attempt, run } from "../../lib/toast";
import type { Skill } from "../../lib/types";
import { Loading, Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { DiffView } from "./DiffView";

/** Edits SKILL.md; changes are reviewed as a diff before they are written. */
export function SkillEditor({ skill, onClose, onSaved }: { skill: Skill; onClose: () => void; onSaved: () => void }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .skillReadFile(skill.dir, "SKILL.md")
      .then((text) => {
        setOriginal(text);
        setContent(text);
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [skill.dir]);

  const review = async () => {
    setBusy(true);
    const d = await attempt(() => api.skillDiff(skill.dir, content));
    setBusy(false);
    if (d !== undefined) setDiff(d);
  };

  const save = async () => {
    setBusy(true);
    const ok = await run(() => api.skillSave(skill.dir, content), "SKILL.md saved");
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    }
  };

  const footer =
    diff === null ? (
      <>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void review()} disabled={busy || original === null || content === original}>
          {busy ? <Spinner size={12} /> : <Eye size={14} />} Review changes
        </button>
      </>
    ) : (
      <>
        <button className="btn" onClick={() => setDiff(null)} disabled={busy}>
          <ChevronLeft size={14} /> Back to editing
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !diff.trim()}>
          {busy ? <Spinner size={12} /> : <Save size={14} />} Save SKILL.md
        </button>
      </>
    );

  return (
    <Modal title={`${diff === null ? "Edit" : "Review"} ${skill.name}/SKILL.md`} onClose={onClose} locked={busy} width={860} footer={footer}>
      {loadError ? (
        <div className="notice notice-error">{loadError}</div>
      ) : original === null ? (
        <Loading />
      ) : diff === null ? (
        <>
          <textarea className="mono tools-editor" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} aria-label="SKILL.md" />
          <div className="muted small">Keep the frontmatter `name`; Claude Code reads the description to decide when to load the skill.</div>
        </>
      ) : (
        <DiffView diff={diff} />
      )}
    </Modal>
  );
}
