// One market entry: name, real signal (or none), description, version, source, requirements, actions.

import { memo } from "react";
import { BadgeCheck, Package } from "lucide-react";
import type { MarketEntry } from "../../lib/types";
import { Chip } from "../../components/StatusBadge";
import { useRightContext } from "../../state/context";
import { MarketActions } from "./MarketActions";
import { methodLabel, OFFICIAL_LABEL, signalText } from "./marketModel";

export const MarketCard = memo(function MarketCard({ entry, selected }: { entry: MarketEntry; selected: boolean }) {
  const openContext = useRightContext((s) => s.openContext);
  const open = () => openContext({ kind: "skill", marketId: entry.id });
  const signal = signalText(entry.signal);
  const requirements = [...entry.requiredMcp.map((m) => `MCP ${m}`), ...entry.dependencies];
  const version = entry.installedVersion ?? entry.version;
  return (
    <article className={`mk-card${selected ? " active" : ""}${entry.installed ? " is-installed" : ""}`} onClick={open}>
      <header className="mk-card-head">
        <Package size={16} className="mk-card-icon" aria-hidden="true" />
        <button className="mk-card-title" onClick={open} title="Show details">
          {entry.name}
        </button>
        {signal ? (
          <span className="mk-signal" title={`${entry.signal!.label}${entry.signal!.fetchedAt ? ` (as of ${entry.signal!.fetchedAt.slice(0, 10)})` : ""}`}>
            {signal}
          </span>
        ) : (
          <span className="mk-signal muted" title="No real popularity signal for this entry">
            no rating
          </span>
        )}
      </header>
      <div className="mk-card-badges">
        {entry.official ? (
          <Chip tone="accent">
            <BadgeCheck size={11} aria-hidden="true" /> {OFFICIAL_LABEL}
          </Chip>
        ) : entry.discovery === "discovered" ? (
          <Chip tone="grey">Discovered</Chip>
        ) : (
          <Chip tone="dim">Third-party</Chip>
        )}
        {entry.featured && <Chip tone="amber">Featured</Chip>}
        <span className="muted small">{methodLabel(entry)}</span>
      </div>
      <p className="mk-card-desc">{entry.description || <span className="muted">No description</span>}</p>
      <dl className="mk-card-meta small">
        <dt>Version</dt>
        <dd>{version ?? <span className="muted">not published</span>}</dd>
        <dt>Source</dt>
        <dd className="ellipsis" title={entry.sources.map((s) => s.label).join(", ")}>
          {entry.sources.map((s) => s.label).join(", ")}
        </dd>
        <dt>Requires</dt>
        <dd className="ellipsis">{requirements.length ? requirements.join(", ") : <span className="muted">nothing declared</span>}</dd>
      </dl>
      <MarketActions entry={entry} compact />
    </article>
  );
});
