import { useEffect, useState } from "react";
import { Loading } from "../../components/Common";
import type { World } from "../../lib/types";
import { useUi } from "../../state/ui";
import { useAgents } from "../../store";
import { AddCharacterDialog } from "./AddCharacterDialog";
import { CharacterDetail } from "./CharacterDetail";
import { EditWorldDialog } from "./EditWorldDialog";
import { RoomLegend } from "./RoomLegend";
import { useWorld, type Update } from "./useWorld";
import { WorldCanvas } from "./WorldCanvas";
import { WorldFeed, type FeedTab } from "./WorldFeed";
import { WorldHero } from "./WorldHero";
import { WorldToolbar } from "./WorldToolbar";
import { ConversionWizard } from "./wizard/ConversionWizard";

type Dialog = { type: "wizard"; oneClick: boolean } | { type: "edit" } | { type: "add" } | null;

/** Full-page AI World: map, controls, selected character, events and conversations. */
export function AiWorldView() {
  const { world, loading, error, reload, publish } = useWorld();
  const wizardRequested = useUi((s) => s.aiWorldWizard);
  const setWizardRequested = useUi((s) => s.setAiWorldWizard);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedTab, setFeedTab] = useState<FeedTab>("events");

  // Command bar / nav ask for the one-click conversion.
  useEffect(() => {
    if (!wizardRequested) return;
    setDialog({ type: "wizard", oneClick: true });
    setWizardRequested(false);
  }, [wizardRequested, setWizardRequested]);

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
    <div className="page page-fill world-page">
      {content}
      {dialog?.type === "wizard" && <ConversionWizard oneClick={dialog.oneClick} onClose={() => setDialog(null)} onOpenWorld={publish} />}
      {dialog?.type === "edit" && world && <EditWorldDialog world={world} onClose={() => setDialog(null)} onSaved={publish} />}
      {dialog?.type === "add" && world && <AddCharacterDialog world={world} onClose={() => setDialog(null)} onSaved={publish} />}
    </div>
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
