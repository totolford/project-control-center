// Platform section and Platform Capability Matrix of the Environment view: what NEXUS supports on
// Windows, Ubuntu, WSL and Docker, and what is actually available on this machine now.

import { Monitor, SquareTerminal } from "lucide-react";
import type { Capability, CapabilityCell, CapabilityMatrix, LiveState, MatrixColumn, PlatformInfo, Support } from "../../lib/platform";
import { platformApi } from "../../lib/platform";
import { attempt } from "../../lib/toast";
import { Loading, Section } from "../../components/Common";
import { lazyLabels, useT, type TFunction } from "../../i18n";

const COLUMNS: { key: MatrixColumn; label: string }[] = [
  { key: "windows", label: "Windows" },
  { key: "ubuntu", label: "Ubuntu" },
  { key: "wsl", label: "WSL" },
  { key: "docker", label: "Docker" },
];

const SUPPORT_LABEL = lazyLabels<Support>({ supported: "platform.support.supported", partial: "platform.support.partial", unavailable: "platform.support.unavailable" });
const SUPPORT_TONE: Record<Support, string> = { supported: "green", partial: "amber", unavailable: "dim" };

const LIVE_LABEL = lazyLabels<LiveState>({ available: "platform.live.available", missing: "platform.live.missing", notApplicable: "platform.live.notApplicable", unknown: "platform.live.unknown" });
const LIVE_TONE: Record<LiveState, string> = { available: "green", missing: "red", notApplicable: "dim", unknown: "grey" };

/** Row name in the interface language; the backend's English name otherwise. */
function rowName(t: TFunction, row: Capability): string {
  return t.locale === "en" ? row.name : t.dynamic(`platform.cap.${row.id}`, undefined, row.name);
}

function SupportCell({ cell, current }: { cell: CapabilityCell; current: boolean }) {
  return (
    <td className={current ? "cap-current" : undefined} title={cell.note ?? undefined}>
      <span className={`chip tone-${SUPPORT_TONE[cell.support]}`}>{SUPPORT_LABEL[cell.support]}</span>
      {cell.note && <div className="tiny muted cap-note">{cell.note}</div>}
    </td>
  );
}

function Row({ row, current }: { row: Capability; current: MatrixColumn | "other" }) {
  const t = useT();
  return (
    <tr>
      <th scope="row">{rowName(t, row)}</th>
      {COLUMNS.map((c) => (
        <SupportCell key={c.key} cell={row[c.key]} current={c.key === current} />
      ))}
      <td>
        <span className={`chip tone-${LIVE_TONE[row.live.state]}`}>{LIVE_LABEL[row.live.state]}</span>
        <div className="tiny muted mono cap-note" title={row.live.detail}>
          {row.live.detail}
        </div>
      </td>
    </tr>
  );
}

/** Platform Capability Matrix (spec §91): support per platform plus the live status here. */
export function CapabilityMatrixSection({ matrix, loading, error }: { matrix: CapabilityMatrix | null; loading: boolean; error: string | null }) {
  const t = useT();
  const current = matrix?.environment ?? "other";
  return (
    <Section title={t("platform.matrix.title")}>
      {matrix ? (
        <div className="table-wrap">
          <table className="table cap-matrix">
            <thead>
              <tr>
                <th>{t("platform.matrix.component")}</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.key === current ? "cap-current" : undefined}>
                    {c.label}
                    {c.key === current && <span className="chip tone-accent cap-here">{t("platform.matrix.here")}</span>}
                  </th>
                ))}
                <th>{t("platform.matrix.live")}</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((r) => (
                <Row key={r.id} row={r} current={current} />
              ))}
            </tbody>
          </table>
        </div>
      ) : error ? (
        <div className="notice notice-error small">{t("platform.unavailable", { error })}</div>
      ) : loading ? (
        <Loading text={t("platform.matrix.checking")} />
      ) : null}
    </Section>
  );
}

/** The OS NEXUS runs on, its shells, terminals, credential store and service manager. */
export function PlatformSection({ info, loading, error }: { info: PlatformInfo | null; loading: boolean; error: string | null }) {
  const t = useT();
  const shells = info?.shells.filter((s) => s.available) ?? [];
  const terminals = info?.terminals.filter((t) => t.available) ?? [];
  return (
    <Section
      title={
        <>
          <Monitor size={13} aria-hidden="true" /> {t("platform.title")}
        </>
      }
      actions={
        <button className="btn btn-sm" disabled={!info || terminals.length === 0} title={terminals.length === 0 ? t("platform.noTerminal") : t("platform.openTerminalHint", { name: terminals[0]?.name ?? "" })} onClick={() => void attempt(() => platformApi.openSystemTerminal(), t("platform.terminalOpened"))}>
          <SquareTerminal size={12} /> {t("platform.openTerminal")}
        </button>
      }
    >
      {info ? (
        <dl className="kv">
          <dt>{t("platform.system")}</dt>
          <dd>
            {info.label} · {info.arch}
            {info.wsl && <span className="chip tone-blue">WSL</span>}
          </dd>
          <dt>{t("platform.shells")}</dt>
          <dd className="small">{shells.length ? shells.map((s) => (s.default ? t("platform.isDefault", { name: s.name }) : s.name)).join(", ") : t("platform.noneFound")}</dd>
          <dt>{t("platform.terminals")}</dt>
          <dd className="small">{terminals.length ? terminals.map((term) => term.name).join(", ") : t("platform.noneFound")}</dd>
          <dt>{t("platform.credentials")}</dt>
          <dd className="small">{info.credentialStore}</dd>
          <dt>{t("platform.services")}</dt>
          <dd className="small">{info.serviceManager ?? t("platform.noServices")}</dd>
          <dt>{t("platform.installers")}</dt>
          <dd className="small">{info.packageManager ?? "—"}</dd>
          <dt>{t("platform.appData")}</dt>
          <dd className="mono small ellipsis" title={info.localDataDir ?? undefined}>
            {info.localDataDir ?? "—"}
          </dd>
        </dl>
      ) : error ? (
        <div className="notice notice-error small">{t("platform.unavailable", { error })}</div>
      ) : loading ? (
        <Loading />
      ) : null}
    </Section>
  );
}
