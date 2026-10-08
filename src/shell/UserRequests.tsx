import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Hand, KeyRound } from "lucide-react";
import { api } from "../lib/api";
import { formatClock } from "../lib/format";
import { attempt, run } from "../lib/toast";
import type { UserRequest } from "../lib/types";
import { orderRequests, requestHeadline } from "../lib/userRequests";
import { githubSignIn } from "../state/opsActions";
import { useUi } from "../state/ui";
import { showTerminal } from "../terminal/openInTerminal";
import { useAgents, useConnections, useStore, useUserRequests } from "../store";
import { Spinner } from "../components/Common";
import { t } from "../i18n";

const SHOWN = 3;

function useResolve(req: UserRequest) {
  const [busy, setBusy] = useState<string | null>(null);
  const remove = useStore((s) => s.removeUserRequest);
  const step = async (key: string, fn: () => Promise<unknown>, successText?: string, resolves = false) => {
    setBusy(key);
    const ok = await run(fn, successText);
    setBusy(null);
    if (ok && resolves) remove(req.id);
    return ok;
  };
  const complete = (note?: string) => step("done", () => api.completeUserRequest(req.id, note), t("bar.req.completed"), true);
  const decline = () => step("decline", () => api.dismissUserRequest(req.id, "Declined by the user"), t("bar.req.declined"), true);
  return { busy, setBusy, step, complete, decline };
}

function SecretForm({ req }: { req: UserRequest }) {
  const { busy, step, decline } = useResolve(req);
  const [value, setValue] = useState("");
  const submit = async () => {
    const secret = value;
    // The value only lives in this input; it is cleared before the call resolves.
    setValue("");
    await step("provide", () => api.provideSecret(req.id, secret), t("bar.req.stored"), true);
  };
  return (
    <form
      className="req-actions"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) void submit();
      }}
    >
      <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={req.key ?? "secret"} aria-label={t("bar.req.valueOf", { key: req.key ?? "secret" })} />
      <button type="submit" className="btn btn-sm primary" disabled={!value || busy !== null}>
        {busy === "provide" ? <Spinner size={11} /> : <KeyRound size={11} />} {t("bar.req.provide")}
      </button>
      <button type="button" className="btn btn-sm ghost" onClick={() => void decline()} disabled={busy !== null}>
        {t("bar.req.decline")}
      </button>
    </form>
  );
}

function SshKeyActions({ req }: { req: UserRequest }) {
  const { busy, setBusy, complete, decline } = useResolve(req);
  const [keyPath, setKeyPath] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const connectionId = req.connectionId;
  const setup = async () => {
    if (!connectionId) return;
    setBusy("setup");
    const result = await attempt(() => api.sshKeySetup(connectionId));
    setBusy(null);
    if (!result) return;
    setKeyPath(t(result.createdKey ? "bar.req.newKey" : "bar.req.existingKey", { path: result.keyPath }));
    showTerminal(result.terminal);
  };
  const test = async () => {
    if (!connectionId) return;
    setBusy("test");
    const conn = await attempt(() => api.checkConnection(connectionId));
    setBusy(null);
    if (!conn) return;
    useStore.getState().upsertConnection(conn);
    setStatus(`${conn.status}${conn.statusDetail ? ` · ${conn.statusDetail}` : ""}`);
  };
  return (
    <>
      <p className="small muted">
        {t("bar.req.sshExplain")}
      </p>
      {!connectionId && <p className="small tone-red-fg">{t("bar.req.noConnection")}</p>}
      {keyPath && <p className="small mono">{keyPath}</p>}
      {status && <p className="small">{t("bar.req.connection", { status })}</p>}
      <div className="req-actions">
        <button className="btn btn-sm primary" onClick={() => void setup()} disabled={!connectionId || busy !== null}>
          {busy === "setup" && <Spinner size={11} />} {t("bar.req.setupKey")}
        </button>
        <button className="btn btn-sm" onClick={() => void test()} disabled={!connectionId || busy !== null}>
          {busy === "test" && <Spinner size={11} />} {t("bar.req.testConnection")}
        </button>
        <button className="btn btn-sm" onClick={() => void complete("SSH key installed")} disabled={busy !== null}>
          {t("common.done")}
        </button>
        <button className="btn btn-sm ghost" onClick={() => void decline()} disabled={busy !== null}>
          {t("bar.req.decline")}
        </button>
      </div>
    </>
  );
}

function SimpleActions({ req }: { req: UserRequest }) {
  const { busy, setBusy, complete, decline } = useResolve(req);
  const signIn = async () => {
    setBusy("signin");
    await githubSignIn();
    setBusy(null);
  };
  return (
    <div className="req-actions">
      {req.kind === "github_login" && (
        <button className="btn btn-sm primary" onClick={() => void signIn()} disabled={busy !== null}>
          {busy === "signin" && <Spinner size={11} />} {t("bar.req.signIn")}
        </button>
      )}
      <button className="btn btn-sm" onClick={() => void complete(req.kind === "github_login" ? "Signed in to GitHub" : undefined)} disabled={busy !== null}>
        {req.kind === "github_login" ? t("bar.req.signedIn") : t("common.done")}
      </button>
      <button className="btn btn-sm ghost" onClick={() => void decline()} disabled={busy !== null}>
        {t("bar.req.decline")}
      </button>
    </div>
  );
}

function RequestCard({ req, agent, connection }: { req: UserRequest; agent: string; connection: string | null }) {
  return (
    <div className="req-card" role="group" aria-label={req.title}>
      <div className="req-head">
        <Hand size={13} className="tone-amber-fg" />
        <strong className="grow">{requestHeadline(req, agent, connection)}</strong>
        <span className="muted tiny mono">{formatClock(req.createdAt)}</span>
      </div>
      {req.kind !== "action" && req.title && <div className="small">{req.title}</div>}
      {req.reason && <p className="small muted req-reason">{req.reason}</p>}
      {req.kind === "secret" ? <SecretForm req={req} /> : req.kind === "ssh_key_setup" ? <SshKeyActions req={req} /> : <SimpleActions req={req} />}
    </div>
  );
}

/** Agents waiting for the user: a non-blocking card stack (oldest first), foldable into a pill. */
export function UserRequests() {
  const requests = useUserRequests();
  const agents = useAgents();
  const connections = useConnections();
  const collapsed = useUi((s) => s.requestsCollapsed);
  const setCollapsed = useUi((s) => s.setRequestsCollapsed);
  const ordered = useMemo(() => orderRequests(requests), [requests]);
  const newest = ordered[ordered.length - 1]?.id;

  // A new request unfolds the stack again.
  useEffect(() => {
    if (newest) setCollapsed(false);
  }, [newest, setCollapsed]);

  if (ordered.length === 0) return null;
  if (collapsed) {
    return (
      <button className="req-pill" onClick={() => setCollapsed(false)}>
        <Hand size={12} /> {t("bar.req.pill", { count: ordered.length })}
      </button>
    );
  }
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const conn = (id: string | null) => (id ? (connections.find((c) => c.id === id)?.name ?? null) : null);
  return (
    <div className="req-stack" aria-label={t("bar.req.stackAria")}>
      <div className="req-stack-head">
        <span className="rail-title">{t("bar.req.stackTitle", { count: ordered.length })}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setCollapsed(true)} aria-label={t("bar.req.fold")} title={t("bar.req.foldTitle")}>
          <ChevronDown size={13} />
        </button>
      </div>
      {ordered.slice(0, SHOWN).map((r) => (
        <RequestCard key={r.id} req={r} agent={name(r.agentId)} connection={conn(r.connectionId)} />
      ))}
      {ordered.length > SHOWN && <div className="muted small center">{t("bar.req.more", { count: ordered.length - SHOWN })}</div>}
    </div>
  );
}
