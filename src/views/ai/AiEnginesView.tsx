import { useState } from "react";
import { RefreshCw, WandSparkles } from "lucide-react";
import type { LocalCapacity } from "../../lib/aiTypes";
import { PageHeader, Loading } from "../../components/Common";
import { Tabs } from "../../components/Tabs";
import { engineLabel, runtimeName } from "./aiLogic";
import { EnginesPanel } from "./EnginesPanel";
import { ModelsPanel } from "./ModelsPanel";
import { RouterPanel } from "./RouterPanel";
import { RuntimesPanel } from "./RuntimesPanel";
import { TownPanel } from "./TownPanel";
import { LocalAiFallback, useAiOverview } from "./shared";
import { useAiSetup } from "./setupStore";

type Tab = "engines" | "runtimes" | "models" | "router" | "town";

/** AI Engines: Claude and local runtimes, models, the ModelRouter and AI Town's local townspeople. */
export function AiEnginesView() {
  const { data, error, loading, reload, setData } = useAiOverview();
  const [tab, setTab] = useState<Tab>("engines");
  const openSetup = useAiSetup((s) => s.setOpen);
  const central = data ? engineLabel(data.settings, "central", null, null) : null;
  return (
    <div className="page ai-engines">
      <PageHeader
        title="AI Engines"
        subtitle={
          data ? (
            <>
              Central · {central?.text} · Workers: {data.settings.workers} · Mode: {data.settings.mode} · Local: {runtimeName(data.settings.local.runtime)}{" "}
              {data.settings.local.model ?? "(no model)"}
            </>
          ) : (
            "Claude through Claude Code, or local models served by Ollama, LM Studio or llama.cpp."
          )
        }
        actions={
          <>
            <button className="btn btn-sm" onClick={() => openSetup(true)}>
              <WandSparkles size={12} /> AI Setup wizard
            </button>
            <button className="btn btn-sm ghost" onClick={() => void reload()} disabled={loading} aria-label="Refresh" title="Query the machine again">
              <RefreshCw size={12} className={loading ? "spin" : ""} />
            </button>
          </>
        }
      />
      {data && (
        <LocalAiFallback
          settings={data.settings}
          capacity={data.capacity}
          onChanged={(cap: LocalCapacity) => {
            setData({ ...data, capacity: cap });
            void reload();
          }}
        />
      )}
      {error && !data && <div className="notice notice-error">AI engines unavailable: {error}</div>}
      <Tabs<Tab>
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "engines", label: "Engines" },
          { key: "runtimes", label: "Runtimes" },
          { key: "models", label: "Models" },
          { key: "router", label: "Router" },
          { key: "town", label: "AI Town" },
        ]}
      />
      {!data ? (
        !error && <Loading text="Detecting runtimes and models…" />
      ) : tab === "engines" ? (
        <EnginesPanel data={data} onChanged={reload} />
      ) : tab === "runtimes" ? (
        <RuntimesPanel data={data} onChanged={reload} />
      ) : tab === "models" ? (
        <ModelsPanel data={data} onChanged={reload} />
      ) : tab === "router" ? (
        <RouterPanel data={data} />
      ) : (
        <TownPanel data={data} onChanged={reload} />
      )}
    </div>
  );
}
