import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { parseKeyValueLines, parseLines } from "../../lib/format";
import type { ConnectionInput, McpCandidate, McpConfig, RobloxDetection } from "../../lib/types";
import { useStore } from "../../store";
import { Modal } from "../../components/Modal";
import { Field, Spinner } from "../../components/Common";
import { Segmented } from "../../components/Tabs";

type Kind = "ssh" | "mcp" | "roblox_studio" | "github" | "docker";

const KINDS: { value: Kind; label: string }[] = [
  { value: "ssh", label: "SSH" },
  { value: "mcp", label: "MCP server" },
  { value: "roblox_studio", label: "Roblox Studio" },
  { value: "github", label: "GitHub" },
  { value: "docker", label: "Docker" },
];

function SecretNotice() {
  return (
    <div className="notice">
      <KeyRound size={14} /> Secrets are stored in Windows Credential Manager. The project only keeps a reference, never the value.
    </div>
  );
}

interface McpForm {
  command: string;
  args: string;
  env: string;
  secretEnv: string;
}

const EMPTY_MCP: McpForm = { command: "", args: "", env: "", secretEnv: "" };

function mcpFromConfig(c: McpConfig): McpForm {
  return {
    command: c.command,
    args: c.args.join("\n"),
    env: Object.entries(c.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    secretEnv: c.secretEnv.map((k) => `${k}=`).join("\n"),
  };
}

function McpFields({ form, setForm }: { form: McpForm; setForm: (f: McpForm) => void }) {
  return (
    <>
      <Field label="Command">
        <input className="mono" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx, node, C:\path\server.exe…" />
      </Field>
      <Field label="Arguments" hint="One per line.">
        <textarea className="mono" rows={3} value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
      </Field>
      <Field label="Environment" hint="KEY=VALUE, one per line. Stored in the project.">
        <textarea className="mono" rows={2} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
      </Field>
      <Field label="Secret environment variables" hint="KEY=VALUE, one per line. Values go to Windows Credential Manager.">
        <textarea className="mono" rows={2} value={form.secretEnv} onChange={(e) => setForm({ ...form, secretEnv: e.target.value })} />
      </Field>
    </>
  );
}

function buildMcp(form: McpForm): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const declared = parseKeyValueLines(form.secretEnv);
  const secrets = Object.fromEntries(Object.entries(declared).filter(([, v]) => v.length > 0));
  const config: McpConfig = {
    command: form.command.trim(),
    args: parseLines(form.args),
    env: parseKeyValueLines(form.env),
    secretEnv: Object.keys(declared),
  };
  return { config: { ...config }, secrets };
}

function RobloxHelper({ onPick }: { onPick: (c: McpCandidate) => void }) {
  const [det, setDet] = useState<RobloxDetection | null | undefined>(undefined);
  useEffect(() => {
    void attempt(() => api.robloxDetect()).then((d) => setDet(d ?? null));
  }, []);
  if (det === undefined)
    return (
      <div className="muted small">
        <Spinner size={12} /> Detecting Roblox Studio…
      </div>
    );
  if (det === null) return null;
  return (
    <div className="detect-box">
      <div>
        Roblox Studio: {det.studioInstalled ? <strong>installed</strong> : <strong>not found</strong>}
        {det.studioInstalled && <span className="muted"> · {det.studioRunning ? "running" : "not running"}</span>}
        {det.studioPath && <div className="mono muted small">{det.studioPath}</div>}
      </div>
      {det.mcpCandidates.length > 0 ? (
        <div className="candidates">
          <span className="muted small">Detected MCP servers:</span>
          {det.mcpCandidates.map((c) => (
            <button key={`${c.source}-${c.name}`} className="btn" onClick={() => onPick(c)} title={c.source}>
              Use {c.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="muted small">
          No Roblox Studio MCP server detected. Enter its command manually (for example the Roblox Studio MCP server executable with the{" "}
          <code>--stdio</code> argument).
        </div>
      )}
    </div>
  );
}

function KnownMcpPicker({ onPick }: { onPick: (c: McpCandidate) => void }) {
  const [known, setKnown] = useState<McpCandidate[]>([]);
  useEffect(() => {
    void attempt(() => api.knownMcpServers()).then((k) => setKnown(k ?? []));
  }, []);
  if (known.length === 0) return null;
  return (
    <div className="candidates">
      <span className="muted small">Found on this machine:</span>
      {known.map((c) => (
        <button key={`${c.source}-${c.name}`} className="btn" onClick={() => onPick(c)} title={c.source}>
          {c.name}
        </button>
      ))}
    </div>
  );
}

export function AddConnectionDialog({ onClose }: { onClose: () => void }) {
  const upsertConnection = useStore((s) => s.upsertConnection);
  const [kind, setKind] = useState<Kind>("ssh");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // SSH
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<"key" | "agent" | "password">("key");
  const [keyPath, setKeyPath] = useState("");
  // MCP / Roblox
  const [mcp, setMcp] = useState<McpForm>(EMPTY_MCP);
  // GitHub
  const [repo, setRepo] = useState("");

  const pickCandidate = (c: McpCandidate) => {
    setMcp(mcpFromConfig(c.config));
    if (!name.trim()) setName(c.name);
  };

  const build = (): ConnectionInput | null => {
    const n = name.trim();
    if (!n) return null;
    switch (kind) {
      case "ssh": {
        if (!host.trim() || !user.trim()) return null;
        return {
          name: n,
          kind,
          config: { host: host.trim(), port: Number(port) || 22, user: user.trim(), auth, keyPath: auth === "key" ? keyPath.trim() || null : null },
        };
      }
      case "mcp":
      case "roblox_studio": {
        if (!mcp.command.trim()) return null;
        const { config, secrets } = buildMcp(mcp);
        return { name: n, kind, config, secrets };
      }
      case "github":
        return { name: n, kind, config: repo.trim() ? { repo: repo.trim() } : {} };
      case "docker":
        return { name: n, kind, config: {} };
    }
  };

  const input = build();

  const submit = async () => {
    if (!input) return;
    setBusy(true);
    const created = await attempt(() => api.addConnection(input), "Connection added");
    setBusy(false);
    if (created) {
      upsertConnection(created);
      onClose();
    }
  };

  return (
    <Modal
      title="Add connection"
      onClose={onClose}
      locked={busy}
      width={620}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !input}>
            {busy && <Spinner size={12} />} Add connection
          </button>
        </>
      }
    >
      <Field group label="Kind">
        <Segmented options={KINDS} value={kind} onChange={setKind} label="Connection kind" />
      </Field>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. staging-server" />
      </Field>

      {kind === "ssh" && (
        <>
          <div className="form-row">
            <Field label="Host">
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.example.com" />
            </Field>
            <Field label="Port">
              <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
            </Field>
            <Field label="User">
              <input value={user} onChange={(e) => setUser(e.target.value)} />
            </Field>
          </div>
          <Field group label="Authentication">
            <Segmented
              options={[
                { value: "key", label: "Key file" },
                { value: "agent", label: "SSH agent" },
                { value: "password", label: "Password" },
              ]}
              value={auth}
              onChange={setAuth}
              label="Authentication"
            />
          </Field>
          {auth === "key" && (
            <>
              <Field label="Key path">
                <input className="mono" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" />
              </Field>
              <p className="muted small">
                Agents connect non-interactively: use a key without passphrase, or load a protected key into ssh-agent
                and choose "SSH agent".
              </p>
            </>
          )}
          {auth === "password" && (
            <p className="muted small">
              Password authentication cannot be used by agents (SSH runs without a terminal). Configure an SSH key or
              ssh-agent instead; the connection test will report it as unavailable.
            </p>
          )}
        </>
      )}

      {kind === "mcp" && (
        <>
          <KnownMcpPicker onPick={pickCandidate} />
          <McpFields form={mcp} setForm={setMcp} />
          <SecretNotice />
        </>
      )}

      {kind === "roblox_studio" && (
        <>
          <RobloxHelper onPick={pickCandidate} />
          <McpFields form={mcp} setForm={setMcp} />
          <SecretNotice />
        </>
      )}

      {kind === "github" && (
        <>
          <Field label="Repository (optional)" hint="owner/name. Status comes from your GitHub CLI login (gh auth login).">
            <input className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
          </Field>
        </>
      )}

      {kind === "docker" && <p className="muted">Uses the local Docker installation. Test the connection after adding it to check Docker is running.</p>}
    </Modal>
  );
}
