import { useCallback, useEffect, useState } from "react";
import { Loading } from "../../components/Common";
import type { World } from "../../lib/types";
import { useUi } from "../../state/ui";
import { useAgents, useStore } from "../../store";
import { AboutAiTown } from "./AboutAiTown";
import { AddCharacterDialog } from "./AddCharacterDialog";
import { AiTownHost } from "./AiTownHost";
import { AiTownSetup, InstallConsent } from "./AiTownSetup";
import { hostPhase } from "./aitown";
import { useAiTown } from "./aiTownStore";
import { CharacterDetail } from "./CharacterDetail";
import { CustomizeCharacter } from "./CustomizeCharacter";
import { EditWorldDialog } from "./EditWorldDialog";
import { RoomLegend } from "./RoomLegend";
import { UpstreamSync } from "./UpstreamSync";
import { useWorld, type Update } from "./useWorld";
import { WorldCanvas } from "./WorldCanvas";
import { WorldFeed, type FeedTab } from "./WorldFeed";
import { WorldHero } from "./WorldHero";
import { WorldToolbar } from "./WorldToolbar";
import { ConversionWizard } from "./wizard/ConversionWizard";

type Tab = "town" | "native";
type TownDialog = { type: "consent" } | { type: "customize"; agentId: string } | { type: "sync" } | { type: "about" } | null;

/**
 * AI World page. Main: the integrated AI Town (setup, then the game itself).
 * Fallback: the NEXUS native 2D world, for PCs without Node.js.
 */
export function AiWorldView() {
  const projectId = useStore((s) => s.project?.info.id ?? null);
  const agents = useAgents();
  const town = useAiTown();
  const { status, world, busy } = town;
  const [tab, setTab] = useState<Tab | null>(null);
  const [dialog, setDialog] = useState<TownDialog>(null);
  const [nativeWizard, setNativeWizard] = useState(false);
  const wizardRequested = useUi((s) => s.aiWorldWizard);
  const setWizardRequested = useUi((s) => s.setAiWorldWizard);

  useEffect(() => {
    useAiTown.getState().forProject(projectId);
    void useAiTown.getState().refresh();
  }, [projectId]);

  // Backend already running (other view, earlier session): attach this project's world.
  useEffect(() => {
    if (status?.running && !world && !busy && projectId && !town.error) void useAiTown.getState().start(projectId);
  }, [status?.running, world, busy, projectId, town.error]);

  const phase = status ? hostPhase(status) : null;
  const active: Tab = tab ?? (phase === "no-node" ? "native" : "town");

  /** MAKE THIS PROJECT AN AI TOWN: consent if needed → install → start → world. */
  const oneClick = useCallback(() => {
    const s = useAiTown.getState();
    if (!s.status || !projectId || s.busy) return;
    const p = hostPhase(s.status);
    if (p === "consent") setDialog({ type: "consent" });
    else if (p === "stopped" || p === "running") void s.start(projectId);
  }, [projectId]);

  const installAndStart = async () => {
    setDialog(null);
    if (!projectId) return;
    const ok = await useAiTown.getState().install();
    if (ok) await useAiTown.getState().start(projectId);
  };

  // Command bar / nav ask for the one-click conversion.
  useEffect(() => {
    if (!wizardRequested || !status) return;
    setWizardRequested(false);
    if (active === "town") oneClick();
    else setNativeWizard(true);
  }, [wizardRequested, setWizardRequested, status, active, oneClick]);

  let content: React.ReactNode;
  if (active === "native") {
    content = <NativeWorld wizardRequested={nativeWizard} onWizardShown={() => setNativeWizard(false)} />;
  } else if (!status) {
    content = <Loading text="Checking AI Town…" />;
  } else if (status.running && world && town.frontendBuilt !== false) {
    content = (
      <AiTownHost
        world={world}
        onCustomize={(agentId) => setDialog({ type: "customize", agentId })}
        onSync={() => setDialog({ type: "sync" })}
        onAbout={() => setDialog({ type: "about" })}
        onStop={() => void town.stop()}
      />
    );
  } else {
    content = (
      <AiTownSetup
        status={status}
        busy={busy}
        progress={town.progress}
        error={town.error}
        frontendBuilt={town.frontendBuilt}
        onOneClick={oneClick}
        onRefresh={() => void town.refresh()}
        onUseNative={() => setTab("native")}
        onAbout={() => setDialog({ type: "about" })}
      />
    );
  }

  const customizing = dialog?.type === "customize" ? agents.find((a) => a.id === dialog.agentId) : undefined;

  return (
    <div className="page page-fill world-page">
      <div className="aitown-tabs" role="tablist" aria-label="World">
        <button role="tab" aria-selected={active === "town"} className={`world-step-tab${active === "town" ? " active" : ""}`} onClick={() => setTab("town")}>
          AI Town
        </button>
        <button role="tab" aria-selected={active === "native"} className={`world-step-tab${active === "native" ? " active" : ""}`} onClick={() => setTab("native")}>
          Native 2D world <span className="dim">(fallback)</span>
        </button>
        <span className="spacer" />
        {active === "town" && status?.running && <span className="tiny muted">Local backend {status.url} · data stays on this PC</span>}
        {active === "town" && status && !status.running && (
          <button className="link-btn tiny" onClick={() => setDialog({ type: "sync" })}>
            Sync with AI Town upstream
          </button>
        )}
      </div>
      {content}
      {dialog?.type === "consent" && status && <InstallConsent status={status} onConfirm={() => void installAndStart()} onClose={() => setDialog(null)} />}
      {customizing && <CustomizeCharacter agent={customizing} world={world} onClose={() => setDialog(null)} />}
      {dialog?.type === "sync" && <UpstreamSync onClose={() => setDialog(null)} />}
      {dialog?.type === "about" && <AboutAiTown upstreamCommit={status?.upstreamCommit ?? null} onClose={() => setDialog(null)} />}
    </div>
  );
}

type Dialog = { type: "wizard"; oneClick: boolean } | { type: "edit" } | { type: "add" } | null;

/** The NEXUS native world: map, controls, selected character, events and conversations. */
function NativeWorld({ wizardRequested, onWizardShown }: { wizardRequested: boolean; onWizardShown: () => void }) {
  const { world, loading, error, reload, publish } = useWorld();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedTab, setFeedTab] = useState<FeedTab>("events");

  useEffect(() => {
    if (!wizardRequested) return;
    setDialog({ type: "wizard", oneClick: true });
    onWizardShown();
  }, [wizardRequested, onWizardShown]);

  const selected = world?.characters.find((c) => c.id === selectedId) ?? null;

  let content: React.ReactNode;
  if (loading && !world) content = <Loading text="Loading the AI World…" />;
  else if (error && !world) {
    content = (
      <div className="notice notice-error">
        Cannot load the AI World: {error}
        <button className="btn btn-sm" onClick={() => void reload()}>
          Retry
        </button>
      </div>
    );
  } else if (!world) {
    content = <WorldHero onOneClick={() => setDialog({ type: "wizard", oneClick: true })} onConvert={() => setDialog({ type: "wizard", oneClick: false })} />;
  } else {
    content = (
      <WorldLayout
        world={world}
        selected={selected}
        onSelect={setSelectedId}
        feedTab={feedTab}
        onFeedTab={setFeedTab}
        publish={publish}
        openDialog={setDialog}
      />
    );
  }

  return (
    <>
      {content}
      {dialog?.type === "wizard" && <ConversionWizard oneClick={dialog.oneClick} onClose={() => setDialog(null)} onOpenWorld={publish} />}
      {dialog?.type === "edit" && world && <EditWorldDialog world={world} onClose={() => setDialog(null)} onSaved={publish} />}
      {dialog?.type === "add" && world && <AddCharacterDialog world={world} onClose={() => setDialog(null)} onSaved={publish} />}
    </>
  );
}

function WorldLayout({ world, selected, onSelect, feedTab, onFeedTab, publish, openDialog }: {
  world: World;
  selected: World["characters"][number] | null;
  onSelect: (id: string | null) => void;
  feedTab: FeedTab;
  onFeedTab: (t: FeedTab) => void;
  publish: (w: Update) => void;
  openDialog: (d: Dialog) => void;
}) {
  const agents = useAgents();
  return (
    <>
      <div className="world-title row">
        <h1>{world.name}</h1>
        {world.description && <span className="muted">{world.description}</span>}
        {world.mode === "simulation" && <span className="chip tone-amber">Simulation — not your real agents</span>}
      </div>
      <WorldToolbar
        world={world}
        onWorld={publish}
        onDeleted={() => publish(null)}
        onEdit={() => openDialog({ type: "edit" })}
        onAddCharacter={() => openDialog({ type: "add" })}
      />
      <div className="world-layout">
        <div className="world-main">
          <div className="world-map panel">
            {world.mode === "simulation" && <div className="world-sim-label">Simulation — not your real agents</div>}
            {world.characters.length === 0 && <div className="world-sim-label">No characters: use “Add character from agent” or Edit world.</div>}
            <WorldCanvas world={world} agents={agents} selectedId={selected?.id ?? null} onSelect={onSelect} />
          </div>
          <RoomLegend rooms={world.rooms} />
        </div>
        <aside className="world-side">
          <div className="panel world-side-detail">
            {selected ? (
              <CharacterDetail
                world={world}
                character={selected}
                agents={agents}
                onConversation={(conv) => {
                  publish((w) => (w ? { ...w, conversations: [...w.conversations, conv] } : w));
                  onFeedTab("conversations");
                }}
              />
            ) : (
              <div className="small muted pad">Click a character on the map to see its details.</div>
            )}
          </div>
          <div className="panel world-side-feed">
            <WorldFeed world={world} tab={feedTab} onTab={onFeedTab} />
          </div>
        </aside>
      </div>
    </>
  );
}
