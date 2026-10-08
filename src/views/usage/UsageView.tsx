import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { errorMessage } from "../../lib/api";
import { usageApi } from "../../lib/usageApi";
import type { PriceTable, UsageRecord, UsageSummary } from "../../lib/usageTypes";
import { formatDateTime } from "../../lib/format";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { EmptyState, PageHeader, Section } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { Segmented } from "../../components/Tabs";
import { DayColumns, DayShareLine, GroupBars, Legend, SERIES } from "./UsageCharts";
import {
  CATEGORY_ORDER,
  NOT_MEASURED,
  PERIODS,
  USD,
  dayLocalShare,
  fillDays,
  formatLatency,
  formatMoney,
  formatPercent,
  formatTokens,
  isEmpty,
  parseRate,
  periodSince,
  tzOffsetMinutes,
  type Currency,
  type Period,
} from "./usageLogic";
import "./usage.css";

const POLL_MS = 15_000;
const CURRENCY_KEY = "nexus.usage.currency";

function loadCurrency(): Currency {
  try {
    const v = JSON.parse(localStorage.getItem(CURRENCY_KEY) ?? "null") as Currency | null;
    if (v && (v.code === "USD" || v.code === "EUR")) return { code: v.code, rate: typeof v.rate === "number" ? v.rate : null };
  } catch {
    // Storage unavailable: USD.
  }
  return USD;
}

function saveCurrency(c: Currency) {
  try {
    localStorage.setItem(CURRENCY_KEY, JSON.stringify(c));
  } catch {
    // Not persisted; the choice still applies to this view.
  }
}

function Tile({ label, value, sub, estimate }: { label: string; value: string; sub?: ReactNode; estimate?: boolean }) {
  return (
    <div className={`usage-tile${estimate ? " estimate" : ""}`}>
      <div className="usage-tile-label">{label}</div>
      <div className="usage-tile-value">{value}</div>
      {sub && <div className="usage-tile-sub">{sub}</div>}
    </div>
  );
}

export function UsageView() {
  const t = useT();
  const hasProject = useStore((s) => s.project !== null);
  const [period, setPeriod] = useState<Period>("week");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [prices, setPrices] = useState<PriceTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<Currency>(loadCurrency);
  const [rateText, setRateText] = useState(() => (currency.rate ? String(currency.rate) : ""));
  const [showTable, setShowTable] = useState(false);

  const load = useCallback(async () => {
    if (!hasProject || document.visibilityState === "hidden") return;
    const since = periodSince(period);
    try {
      const [s, r] = await Promise.all([
        usageApi.summary({ since }, tzOffsetMinutes()),
        usageApi.records({ since, limit: 50 }),
      ]);
      setSummary(s);
      setRecords(r.slice().reverse());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [hasProject, period]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    usageApi.prices().then(setPrices, () => setPrices(null));
  }, []);

  const days = useMemo(() => fillDays(summary?.days ?? [], period), [summary, period]);
  const money = (usd: number | null | undefined) => formatMoney(usd, currency);
  const setCode = (code: Currency["code"]) => {
    const c = { ...currency, code };
    setCurrency(c);
    saveCurrency(c);
  };
  const setRate = (text: string) => {
    setRateText(text);
    const c = { ...currency, rate: parseRate(text) };
    setCurrency(c);
    saveCurrency(c);
  };
  const catName = (key: string) => t.dynamic(`usage.cat.${key}`, undefined, key);

  if (!hasProject) {
    return (
      <div className="page usage">
        <PageHeader title={t("usage.title")} />
        <EmptyState title={t("usage.noProject")} />
      </div>
    );
  }

  const s = summary;
  const claude = t("usage.legend.claude");
  const local = t("usage.legend.local");
  return (
    <div className="page usage">
      <PageHeader
        title={t("usage.title")}
        subtitle={t("usage.subtitle")}
        actions={
          <>
            <Segmented
              label={t("usage.title")}
              options={PERIODS.map((p) => ({ value: p, label: t(`usage.period.${p}`) }))}
              value={period}
              onChange={setPeriod}
            />
            <button className="btn btn-sm ghost" onClick={() => void load()} title={t("usage.refresh")} aria-label={t("usage.refresh")}>
              <RefreshCw size={13} />
            </button>
          </>
        }
      />
      {error && <div className="usage-error">{t("usage.error", { error })}</div>}

      <div className="usage-toolbar">
        <span className="muted small">{t("usage.currency")}</span>
        <Segmented
          label={t("usage.currency")}
          options={[
            { value: "USD", label: "USD $" },
            { value: "EUR", label: "EUR €" },
          ]}
          value={currency.code}
          onChange={setCode}
        />
        {currency.code === "EUR" && (
          <label className="usage-rate">
            <span className="muted small">{t("usage.rate")}</span>
            <input value={rateText} onChange={(e) => setRate(e.target.value)} placeholder="0.92" inputMode="decimal" />
            <span className="muted small">{currency.rate ? t("usage.rateHint") : t("usage.rateMissing")}</span>
          </label>
        )}
      </div>

      {s && isEmpty(s) && !error && (
        <EmptyState title={t("usage.empty.title")}>
          <span className="muted">{t("usage.empty.body")}</span>
        </EmptyState>
      )}

      {s && !isEmpty(s) && (
        <>
          <div className="usage-tiles">
            <Tile label={t("usage.tile.claudeTokens")} value={formatTokens(s.claudeTokens)} />
            <Tile label={t("usage.tile.localTokens")} value={formatTokens(s.localTokens)} />
            <Tile label={t("usage.tile.totalTokens")} value={formatTokens(s.totalTokens)} />
            <Tile
              label={t("usage.tile.requests")}
              value={String(s.requests)}
              sub={t("usage.tile.requestsSub", { claude: s.claudeRequests, local: s.localRequests })}
            />
            <Tile label={t("usage.tile.claudeCost")} value={money(s.claudeCostReportedUsd)} sub={t("usage.tile.claudeCostSub")} />
            <Tile label={t("usage.tile.cloudCost")} value={money(s.cloudCostEstimatedUsd)} sub={t("usage.tile.cloudCostSub")} estimate />
            <Tile label={t("usage.tile.localCost")} value={money(0)} sub={t("usage.tile.localCostSub")} />
            <Tile label={t("usage.tile.latency")} value={formatLatency(s.avgLatencyMs)} />
            <Tile label={t("usage.tile.localShare")} value={formatPercent(s.localShare)} sub={t("usage.tile.localShareSub")} />
            <Tile
              label={t("usage.tile.avoidedTokens")}
              value={formatTokens(s.avoided.tokens)}
              sub={t("usage.tile.avoidedSub", { model: s.avoided.referenceModel })}
              estimate
            />
            <Tile
              label={t("usage.tile.avoidedMoney")}
              value={money(s.avoided.moneyUsd)}
              sub={t("usage.tile.avoidedSub", { model: s.avoided.referenceModel })}
              estimate
            />
          </div>
          {(s.requestsWithoutTokens > 0 || s.cloudRequestsWithoutCost > 0) && (
            <div className="usage-notes muted small">
              {s.requestsWithoutTokens > 0 && <div>{t("usage.withoutTokens", { count: s.requestsWithoutTokens })}</div>}
              {s.cloudRequestsWithoutCost > 0 && <div>{t("usage.withoutCost", { count: s.cloudRequestsWithoutCost })}</div>}
            </div>
          )}

          <div className="usage-grid">
            <Section title={t("usage.chart.tokens")} actions={<Legend items={[{ color: SERIES.claude, label: claude }, { color: SERIES.local, label: local }]} />}>
              <DayColumns
                days={days}
                label={t("usage.chart.tokens")}
                fmt={formatTokens}
                series={[
                  { label: claude, color: SERIES.claude, value: (d) => d.claudeTokens },
                  { label: local, color: SERIES.local, value: (d) => d.localTokens },
                ]}
              />
            </Section>
            <Section title={t("usage.chart.requests")} actions={<Legend items={[{ color: SERIES.claude, label: claude }, { color: SERIES.local, label: local }]} />}>
              <DayColumns
                days={days}
                label={t("usage.chart.requests")}
                fmt={(v) => String(Math.round(v))}
                series={[
                  { label: claude, color: SERIES.claude, value: (d) => d.claudeRequests },
                  { label: local, color: SERIES.local, value: (d) => d.localRequests },
                ]}
              />
            </Section>
            <Section title={t("usage.chart.ratio")}>
              <DayShareLine days={days} value={dayLocalShare} color={SERIES.local} label={t("usage.chart.ratio")} fmt={formatPercent} />
            </Section>
            <Section title={t("usage.chart.cost")}>
              <DayColumns
                days={days}
                label={t("usage.chart.cost")}
                fmt={(v) => money(v)}
                series={[{ label: t("usage.col.cost"), color: SERIES.cost, value: (d) => d.costUsd }]}
              />
            </Section>
          </div>
          <div className="usage-table-toggle">
            <button className="btn-text" onClick={() => setShowTable((v) => !v)}>
              {showTable ? t("usage.hideTable") : t("usage.showTable")}
            </button>
          </div>
          {showTable && (
            <div className="table-wrap">
              <table className="table usage-table">
                <thead>
                  <tr>
                    <th>{t("usage.col.day")}</th>
                    <th>{claude}</th>
                    <th>{local}</th>
                    <th>{t("usage.col.requests")}</th>
                    <th>{t("usage.tile.localShare")}</th>
                    <th>{t("usage.col.cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {days.filter((d) => d.requests > 0).map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td>{formatTokens(d.claudeTokens)}</td>
                      <td>{formatTokens(d.localTokens)}</td>
                      <td>{d.requests}</td>
                      <td>{formatPercent(dayLocalShare(d))}</td>
                      <td>{money(d.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="usage-grid">
            {(
              [
                ["usage.group.agent", s.byAgent],
                ["usage.group.mission", s.byMission],
                ["usage.group.model", s.byModel],
              ] as const
            ).map(([key, groups]) => (
              <Section key={key} title={t(key)}>
                {groups.length ? (
                  <GroupBars
                    groups={groups}
                    claudeLabel={claude}
                    localLabel={local}
                    otherLabel={t("usage.other")}
                    fmt={formatTokens}
                    extra={(g) => `${t("usage.requestsShort", { count: g.requests })} · ${money(g.costUsd)}`}
                  />
                ) : (
                  <div className="muted small">{t("usage.group.none")}</div>
                )}
              </Section>
            ))}
            <Section title={t("usage.group.category")}>
              <table className="table usage-table">
                <thead>
                  <tr>
                    <th>{t("usage.col.category")}</th>
                    <th>{t("usage.col.requests")}</th>
                    <th>{t("usage.col.tokens")}</th>
                    <th>{t("usage.col.cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {CATEGORY_ORDER.map((c) => {
                    const g = s.byCategory.find((x) => x.key === c);
                    return (
                      <tr key={c}>
                        <td>{catName(c)}</td>
                        {g ? (
                          <>
                            <td>{g.requests}</td>
                            <td>{formatTokens(g.tokens)}</td>
                            <td>{money(g.costUsd)}</td>
                          </>
                        ) : (
                          <td colSpan={3} className="muted">
                            {t("usage.noRequests")}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {NOT_MEASURED.map((c) => (
                    <tr key={c}>
                      <td>{catName(c)}</td>
                      <td colSpan={3}>
                        <Chip tone="grey">{t("usage.notMeasured")}</Chip>{" "}
                        <span className="muted small">{t.dynamic(`usage.notMeasured.${c}`)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </div>

          <Section title={t("usage.recent")}>
            <div className="table-wrap">
              <table className="table usage-table">
                <thead>
                  <tr>
                    <th>{t("usage.col.time")}</th>
                    <th>{t("usage.col.provider")}</th>
                    <th>{t("usage.col.model")}</th>
                    <th>{t("usage.col.agent")}</th>
                    <th>{t("usage.col.category")}</th>
                    <th>{t("usage.col.input")}</th>
                    <th>{t("usage.col.output")}</th>
                    <th>{t("usage.col.cached")}</th>
                    <th>{t("usage.col.reasoning")}</th>
                    <th>{t("usage.col.cost")}</th>
                    <th>{t("usage.col.latency")}</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDateTime(r.ts)}</td>
                      <td>
                        {r.provider}
                        {r.local && <span className="muted small"> · {t("usage.legend.local")}</span>}
                      </td>
                      <td className="mono small">{r.model ?? "N/A"}</td>
                      <td>{r.agentId ?? "—"}</td>
                      <td>{catName(r.category)}</td>
                      <td>{formatTokens(r.inputTokens)}</td>
                      <td>{formatTokens(r.outputTokens)}</td>
                      <td>{formatTokens(r.cachedTokens)}</td>
                      <td>{formatTokens(r.reasoningTokens)}</td>
                      <td>
                        {money(r.costUsd)} <span className="muted small">{t.dynamic(`usage.cost.${r.costSource}`)}</span>
                      </td>
                      <td>{formatLatency(r.latencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title={t("usage.method")}>
            <p className="small">{t("usage.methodText")}</p>
            <p className="muted small">{s.priceSource}</p>
            {prices && (
              <details>
                <summary className="small">{t("usage.prices")}</summary>
                <div className="muted small">{t("usage.priceCols")}</div>
                <table className="table usage-table">
                  <tbody>
                    {prices.prices.map((p) => (
                      <tr key={p.pattern}>
                        <td>{p.label}</td>
                        <td className="mono small">
                          ${p.input} / ${p.output} / ${p.cacheWrite} / ${p.cacheRead}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
