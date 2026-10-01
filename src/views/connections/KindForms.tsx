// Per-kind fields of the Add / Edit connection dialog.

import { KeyRound } from "lucide-react";
import { Field } from "../../components/Common";
import { Segmented } from "../../components/Tabs";
import { SHELLS, type ConnForm, type FormKind } from "./connectionModel";

interface Props {
  kind: FormKind;
  form: ConnForm;
  set: (patch: Partial<ConnForm>) => void;
  /** A token is already stored (edit mode): blank keeps it. */
  hasStoredToken: boolean;
}

function TokenField({ form, set, hasStoredToken, hint }: Pick<Props, "form" | "set" | "hasStoredToken"> & { hint: string }) {
  return (
    <>
      <Field label="Token" hint={hint}>
        <input type="password" autoComplete="off" value={form.token} onChange={(e) => set({ token: e.target.value })} placeholder={hasStoredToken ? "stored — leave blank to keep" : ""} />
      </Field>
      <div className="notice">
        <KeyRound size={14} /> The token is stored in Windows Credential Manager; the project only keeps a reference.
      </div>
    </>
  );
}

export function KindForm({ kind, form, set, hasStoredToken }: Props) {
  switch (kind) {
    case "github":
      return (
        <Field label="Repository (optional)" hint="owner/name. Status comes from your GitHub CLI login (gh auth login).">
          <input className="mono" value={form.repo} onChange={(e) => set({ repo: e.target.value })} placeholder="owner/name" />
        </Field>
      );
    case "gitlab":
      return (
        <>
          <div className="form-row">
            <Field label="Host" hint="Empty = gitlab.com">
              <input className="mono" value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="gitlab.example.com" />
            </Field>
            <Field label="Project">
              <input className="mono" value={form.project} onChange={(e) => set({ project: e.target.value })} placeholder="group/project" />
            </Field>
          </div>
          <TokenField form={form} set={set} hasStoredToken={hasStoredToken} hint="Personal access token. Agents get it as GITLAB_TOKEN (glab)." />
        </>
      );
    case "ssh":
    case "sftp":
      return (
        <>
          <div className="form-row">
            <Field label="Host">
              <input value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="server.example.com" />
            </Field>
            <Field label="Port">
              <input value={form.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, "") })} inputMode="numeric" />
            </Field>
            <Field label="User">
              <input value={form.user} onChange={(e) => set({ user: e.target.value })} />
            </Field>
          </div>
          <Field group label="Authentication">
            <Segmented
              options={[
                { value: "key", label: "Key file" },
                { value: "agent", label: "SSH agent" },
                { value: "password", label: "Password" },
              ]}
              value={form.auth}
              onChange={(auth) => set({ auth })}
              label="Authentication"
            />
          </Field>
          {form.auth === "key" && (
            <>
              <Field label="Key path">
                <input className="mono" value={form.keyPath} onChange={(e) => set({ keyPath: e.target.value })} placeholder="C:\Users\you\.ssh\id_ed25519" />
              </Field>
              <p className="muted small">
                Agents connect non-interactively: use a key without passphrase, or load a protected key into ssh-agent and choose "SSH agent".
              </p>
            </>
          )}
          {form.auth === "password" && (
            <p className="muted small">
              Password authentication cannot be used by agents (SSH runs without a terminal). Configure an SSH key or ssh-agent instead; the
              connection test will report it as unavailable.
            </p>
          )}
        </>
      );
    case "terminal":
      return (
        <>
          <Field group label="Shell">
            <Segmented options={SHELLS.map((s) => ({ value: s, label: s }))} value={form.shell} onChange={(shell) => set({ shell })} label="Shell" />
          </Field>
          {form.shell === "wsl" && (
            <Field label="WSL distribution (optional)" hint="Empty = default distribution.">
              <input value={form.distro} onChange={(e) => set({ distro: e.target.value })} placeholder="Ubuntu" />
            </Field>
          )}
        </>
      );
    case "http":
      return (
        <>
          <Field label="Base URL">
            <input className="mono" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com" />
          </Field>
          <div className="form-row">
            <Field label="Health path" hint="Requested by Test (default /).">
              <input className="mono" value={form.healthPath} onChange={(e) => set({ healthPath: e.target.value })} placeholder="/health" />
            </Field>
            <Field label="Auth header" hint="Authorization sends Bearer <token>.">
              <input className="mono" value={form.authHeader} onChange={(e) => set({ authHeader: e.target.value })} />
            </Field>
          </div>
          <TokenField form={form} set={set} hasStoredToken={hasStoredToken} hint="Optional. Agents get it in the environment variable PCC_<ID>_TOKEN." />
        </>
      );
    case "docker":
      return <p className="muted">Uses the local Docker installation. Test the connection after adding it to check Docker is running.</p>;
  }
}
