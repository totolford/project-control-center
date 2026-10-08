// Compact AI usage of one mission or one agent (mission detail, agent page).

import { useEffect, useState } from "react";
import { usageApi } from "../../lib/usageApi";
import type { UsageSummary } from "../../lib/usageTypes";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { formatLatency, formatMoney, formatPercent, formatTokens, isEmpty, tzOffsetMinutes } from "./usageLogic";
import "./usage.css";

const POLL_MS = 20_000;

export function UsageBlock({ missionId, agentId }: { missionId?: string; agentId?: string }) {
  const t = useT();
  const navigate = useStore((s) => s.navigate);
  const [s, setS] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      usageApi
        .summary({ mission: missionId ?? null, agent: agentId ?? null }, tzOffsetMinutes())
        .then((v) => alive && (setS(v), setError(null)))
        .catch((e) => alive && setError(String(e)));
    };
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [missionId, agentId]);

  if (error) return <div className="muted small">{t("usage.error", { error })}</div>;
  if (!s) return null;
  if (isEmpty(s)) return <div className="muted small">{t("usage.block.empty")}</div>;
  const cell = (label: string, value: string) => (
    <div>
      <div className="usage-block-label">{label}</div>
      <div className="usage-block-value">{value}</div>
    </div>
  );
  return (
    <div>
      <div className="usage-block">
        {cell(t("usage.tile.claudeTokens"), formatTokens(s.claudeTokens))}
        {cell(t("usage.tile.localTokens"), formatTokens(s.localTokens))}
        {cell(t("usage.tile.requests"), String(s.requests))}
        {cell(t("usage.tile.claudeCost"), formatMoney(s.claudeCostReportedUsd))}
        {cell(t("usage.tile.localShare"), formatPercent(s.localShare))}
        {cell(t("usage.tile.latency"), formatLatency(s.avgLatencyMs))}
      </div>
      <button className="btn-text small" onClick={() => navigate({ name: "usage" })}>
        {t("usage.block.open")}
      </button>
    </div>
  );
}
