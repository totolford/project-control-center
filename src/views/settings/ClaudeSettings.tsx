import { useEffect, useState } from "react";
import { FolderOpen, LockOpen, LogIn, Save, UserRound } from "lucide-react";
import { api } from "../../lib/api";
import { useLoad } from "../../lib/useLoad";
import { saveAppSettings, useAppLanguages } from "../../i18n/prefs";
import { useT } from "../../i18n";
import { activeAccountLabel, useClaudeAccount } from "../../lib/claudeAccount";
import { attempt, run } from "../../lib/toast";
import { useStore } from "../../store";
import { openClaudeInTerminal } from "../../terminal/openInTerminal";
import { FONT_SIZES, useTerminalPrefs } from "../../terminal/terminalPrefs";
import { ClaudeStatus, useClaudeInfo } from "../../components/ClaudeStatus";
import { Field, Section, Spinner } from "../../components/Common";

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function ExecutableField({ onSaved }: { onSaved: () => void }) {
  const app = useLoad(() => api.appSettings());
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setPath(app.data?.claudePath ?? ""), [app.data]);
  const dirty = (app.data?.claudePath ?? "") !== path.trim();
  const save = async () => {
    setSaving(true);
    const saved = await attempt(() => saveAppSettings({ claudePath: path.trim() || null }), "Claude Code executable saved");
    setSaving(false);
    if (saved) onSaved();
  };
  return (
    <Field label="Claude Code executable" hint="Empty = auto-detect. Applies to every project on this machine.">
      <span className="row">
        <input className="mono grow" value={path} placeholder="auto-detect" onChange={(e) => setPath(e.target.value)} disabled={!app.data || saving} />
        <button className="btn" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? <Spinner size={12} /> : <Save size={13} />} Save
        </button>
      </span>
    </Field>
  );
}

/** Account (CLAUDE_CONFIG_DIR) of new sessions; saved at once, kept across restarts. */
function AccountField({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const app = useAppLanguages((s) => s.app);
  const status = useClaudeAccount();
  const [saving, setSaving] = useState(false);
  const selected = app?.claudeAccount ?? "";
  const missing = status?.accounts.find((a) => a.id === selected && !a.exists);
  const save = async (id: string) => {
    const label = status?.accounts.find((a) => a.id === id)?.label ?? t("settings.claude.accountDefault", { dir: status?.startupDir ?? "" });
    setSaving(true);
    const saved = await attempt(() => saveAppSettings({ claudeAccount: id || null }), t("settings.claude.accountSaved", { label }));
    setSaving(false);
    if (saved) onSaved();
  };
  return (
    <Field label={t("settings.claude.account")} hint={t("settings.claude.accountHint")}>
      <span className="row">
        <select aria-label={t("settings.claude.account")} value={selected} onChange={(e) => void save(e.target.value)} disabled={!app || !status || saving}>
          {status?.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} ({a.configDir})
            </option>
          ))}
          <option value="">{t("settings.claude.accountDefault", { dir: status?.startupDir ?? "…" })}</option>
        </select>
        {saving && <Spinner size={12} />}
      </span>
      {missing && <span className="muted small">{t("settings.claude.accountMissing", { label: missing.label })}</span>}
    </Field>
  );
}

/** Machine-level Claude Code settings: executable, login, terminal, logs, autonomy shortcut. */
export function ClaudeSettings() {
  const t = useT();
  const claude = useClaudeInfo();
  const account = useClaudeAccount();
  const info = useLoad(() => api.appInfo());
  const root = useStore((s) => s.project?.info.root ?? "");
  const navigate = useStore((s) => s.navigate);
  const fontSize = useTerminalPrefs((s) => s.fontSize);
  const setFontSize = useTerminalPrefs((s) => s.setFontSize);
  const logDir = info.data?.logDir ?? null;
  const logInProject = logDir !== null && root !== "" && normalize(logDir).startsWith(normalize(root));

  return (
    <Section title="Claude Code">
      <ClaudeStatus info={claude.info} loading={claude.loading} onRecheck={() => void claude.reload()} />
      <dl className="kv">
        <dt>{t("settings.claude.accountActive")}</dt>
        <dd>
          <span className="chip">
            <UserRound size={12} /> {activeAccountLabel(account) ?? t("settings.claude.accountOther")}
          </span>{" "}
          <span className="mono small">{account?.activeDir ?? "—"}</span>
        </dd>
        <dt>Detected path</dt>
        <dd className="mono small">{claude.info?.path ?? "—"}</dd>
        <dt>Version</dt>
        <dd className="mono">{claude.info?.version ?? "—"}</dd>
      </dl>
      <ExecutableField onSaved={() => void claude.reload()} />
      <AccountField onSaved={() => void claude.reload()} />
      <div className="row">
        <button className="btn" onClick={() => void openClaudeInTerminal(["auth", "login"], claude.info?.path ?? null)} disabled={!claude.info?.installed}>
          <LogIn size={13} /> Log in (claude auth login in Raw Terminal)
        </button>
        <button className="btn" onClick={() => navigate({ name: "autonomy" })}>
          <LockOpen size={13} /> Auto-approval & autonomous mode
        </button>
      </div>
      <div className="form-row">
        <Field label="Raw Terminal font size" hint="Stored on this machine.">
          <select value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}>
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
        </Field>
        <Field label="Logs" hint="Application logs of NEXUS.">
          <span className="row">
            <span className="mono small ellipsis">{logDir ?? "—"}</span>
            {logInProject && logDir && (
              <button className="btn btn-sm" onClick={() => void run(() => api.openPath(logDir))}>
                <FolderOpen size={12} /> Open
              </button>
            )}
          </span>
        </Field>
      </div>
    </Section>
  );
}
