import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FlaskConical, FolderOpen } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { CAPABILITIES } from "../../lib/labels";
import type { NewSkill, SkillTest } from "../../lib/types";
import { useConnections } from "../../store";
import { Field, Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { Segmented } from "../../components/Tabs";
import { COMMON_TOOLS, EMPTY_SKILL, splitList, toggle, validateNewSkill, validateSkillName } from "./skillModel";

const STEPS = ["Basics", "Instructions & tools", "Requirements"] as const;

function Checks({ options, value, onChange }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  if (options.length === 0) return <div className="muted small">None in this project.</div>;
  return (
    <div className="tools-checks">
      {options.map((o) => (
        <label key={o.value} className="checkbox">
          <input type="checkbox" checked={value.includes(o.value)} onChange={() => onChange(toggle(value, o.value))} /> {o.label}
        </label>
      ))}
    </div>
  );
}

export function SkillWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (dir: string) => void }) {
  const connections = useConnections();
  const [spec, setSpec] = useState<NewSkill>(EMPTY_SKILL);
  const [scope, setScope] = useState<"project" | "user">("project");
  const [step, setStep] = useState(0);
  const [extraTools, setExtraTools] = useState("");
  const [deps, setDeps] = useState("");
  const [preview, setPreview] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ dir: string; test: SkillTest | null } | null>(null);

  const full: NewSkill = {
    ...spec,
    allowedTools: [...spec.allowedTools, ...splitList(extraTools).filter((t) => !spec.allowedTools.includes(t))],
    dependencies: splitList(deps),
  };
  const fullKey = JSON.stringify(full);
  const problem = validateNewSkill(full);
  const set = (patch: Partial<NewSkill>) => setSpec((s) => ({ ...s, ...patch }));

  useEffect(() => {
    const t = window.setTimeout(() => {
      api
        .skillPreview(JSON.parse(fullKey) as NewSkill)
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e) => setPreviewError(errorMessage(e)));
    }, 250);
    return () => window.clearTimeout(t);
  }, [fullKey]);

  const create = async () => {
    setBusy(true);
    const dir = await attempt(() => api.skillCreate(scope, full), "Skill created");
    if (!dir) {
      setBusy(false);
      return;
    }
    onCreated(dir);
    const test = (await attempt(() => api.skillTest(dir))) ?? null;
    setBusy(false);
    setCreated({ dir, test });
  };

  const mcpConns = connections.filter((c) => c.kind === "mcp" || c.kind === "roblox_studio");
  const otherConns = connections.filter((c) => c.kind !== "mcp" && c.kind !== "roblox_studio");

  const footer = created ? (
    <button className="btn primary" onClick={onClose}>
      Close
    </button>
  ) : (
    <>
      <button className="btn" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <span className="spacer" />
      <button className="btn" onClick={() => setStep((s) => s - 1)} disabled={busy || step === 0}>
        <ChevronLeft size={14} /> Back
      </button>
      {step < STEPS.length - 1 ? (
        <button className="btn primary" onClick={() => setStep((s) => s + 1)} disabled={step === 0 && problem !== null}>
          Next <ChevronRight size={14} />
        </button>
      ) : (
        <button className="btn primary" onClick={() => void create()} disabled={busy || problem !== null}>
          {busy ? <Spinner size={12} /> : <Check size={14} />} Create skill
        </button>
      )}
    </>
  );

  return (
    <Modal title="New skill" onClose={onClose} locked={busy} width={980} footer={footer}>
      {created ? (
        <div>
          <div className="notice">
            Created in <code className="tools-path">{created.dir}</code>
          </div>
          {created.test && (
            <div className={`notice ${created.test.discovered ? "" : "notice-warn"}`}>
              <FlaskConical size={14} />
              {created.test.discovered ? `Claude Code discovers it as /${created.test.commandName}.` : `Not discovered yet: ${created.test.problems.join("; ") || "no detail"}`}
            </div>
          )}
          <p>Add supporting files (scripts, references, templates) directly in the skill folder.</p>
          <button className="btn" onClick={() => void attempt(() => api.openPath(created.dir))}>
            <FolderOpen size={14} /> Open folder
          </button>
          <span className="muted small"> Only folders inside the project can be opened from NEXUS; for user skills use the path above.</span>
        </div>
      ) : (
        <div className="tools-wizard-split">
          <div className="grow">
            <ol className="tools-stepper">
              {STEPS.map((s, i) => (
                <li key={s} className={i === step ? "active" : i < step ? "done" : ""}>
                  <button className="link-btn" onClick={() => setStep(i)} disabled={i > 0 && problem !== null}>
                    {i + 1}. {s}
                  </button>
                </li>
              ))}
            </ol>
            {step === 0 && (
              <>
                <Field label="Name" hint={validateSkillName(spec.name) ?? "Becomes the folder name and the /command."}>
                  <input className="mono" value={spec.name} onChange={(e) => set({ name: e.target.value.trim().toLowerCase() })} placeholder="my-skill" autoFocus />
                </Field>
                <Field label="Description" hint="What the skill does. Claude Code reads it to decide when to load the skill.">
                  <input value={spec.description} onChange={(e) => set({ description: e.target.value })} />
                </Field>
                <Field label="When to use it" hint='Appended to the description as "Use when …".'>
                  <input value={spec.trigger} onChange={(e) => set({ trigger: e.target.value })} placeholder="the user asks to deploy the staging server" />
                </Field>
                <Field label="Argument hint (optional)">
                  <input value={spec.argumentHint} onChange={(e) => set({ argumentHint: e.target.value })} placeholder="[environment]" />
                </Field>
                <Field group label="Scope">
                  <Segmented
                    options={[
                      { value: "project", label: "Project (.claude/skills)" },
                      { value: "user", label: "User (~/.claude/skills)" },
                    ]}
                    value={scope}
                    onChange={setScope}
                    label="Scope"
                  />
                </Field>
              </>
            )}
            {step === 1 && (
              <>
                <Field label="Instructions (Markdown)">
                  <textarea className="mono" rows={10} value={spec.instructions} onChange={(e) => set({ instructions: e.target.value })} />
                </Field>
                <Field group label="Allowed tools" hint="Tools the skill may use without asking. Leave empty to not restrict.">
                  <Checks options={COMMON_TOOLS.map((t) => ({ value: t, label: t }))} value={spec.allowedTools} onChange={(allowedTools) => set({ allowedTools })} />
                </Field>
                <Field label="Other tools" hint="Comma separated, e.g. Bash(git status:*), mcp__server__tool">
                  <input className="mono" value={extraTools} onChange={(e) => setExtraTools(e.target.value)} />
                </Field>
              </>
            )}
            {step === 2 && (
              <>
                <Field group label="Required MCP servers">
                  <Checks options={mcpConns.map((c) => ({ value: c.id, label: c.name }))} value={spec.requiredMcp} onChange={(requiredMcp) => set({ requiredMcp })} />
                </Field>
                <Field group label="Required connections">
                  <Checks options={otherConns.map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` }))} value={spec.requiredConnections} onChange={(requiredConnections) => set({ requiredConnections })} />
                </Field>
                <Field group label="Required permissions">
                  <Checks options={CAPABILITIES.map((c) => ({ value: c.key, label: c.label }))} value={spec.requiredPermissions} onChange={(requiredPermissions) => set({ requiredPermissions })} />
                </Field>
                <Field label="Dependencies" hint="Comma separated (programs, packages). Recorded as metadata; NEXUS shows them, Claude Code ignores them.">
                  <input value={deps} onChange={(e) => setDeps(e.target.value)} placeholder="node, python" />
                </Field>
                <p className="muted small">Files: after creation, add supporting files in the skill folder.</p>
              </>
            )}
            {problem && step === 0 && <div className="small tone-amber-fg">{problem}</div>}
          </div>
          <div className="tools-preview">
            <div className="section-label">SKILL.md preview</div>
            {previewError ? <div className="small tone-red-fg">{previewError}</div> : <pre className="tools-file">{preview}</pre>}
          </div>
        </div>
      )}
    </Modal>
  );
}
