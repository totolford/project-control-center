import { useEffect, useState } from "react";
import { Map as MapIcon, Wand2 } from "lucide-react";
import { Loading } from "../../components/Common";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { WorldProviderInfo } from "../../lib/types";
import { Prerequisites } from "./Prerequisites";

/** No world yet: the two ways in, and what each provider honestly needs. */
export function WorldHero({ onOneClick, onConvert }: { onOneClick: () => void; onConvert: () => void }) {
  const [providers, setProviders] = useState<WorldProviderInfo[] | null>(null);

  useEffect(() => {
    void attempt(() => api.worldProviders()).then((p) => setProviders(p ?? []));
  }, []);

  return (
    <div className="world-hero">
      <div className="world-hero-head">
        <MapIcon size={28} className="tone-accent-fg" />
        <h1>AI World</h1>
        <p className="muted">
          A living map of your project: each NEXUS agent becomes a character that walks to the room matching what it is
          really doing — the Workshop while it runs a turn, the Security Desk while it waits for your permission. Characters
          you create yourself are simulated and labelled as such.
        </p>
        <div className="row">
          <button className="btn primary world-hero-cta" onClick={onOneClick}>
            <Wand2 size={15} /> MAKE THIS PROJECT AN AI TOWN
          </button>
          <button className="btn" onClick={onConvert}>
            Convert → AI World
          </button>
        </div>
        <div className="tiny muted">
          One click uses the recommended defaults and asks for a single confirmation. Nothing in your project files is
          modified; .agent-project is backed up first.
        </div>
      </div>
      <div className="section-label">World providers</div>
      {providers === null ? (
        <Loading text="Checking providers…" />
      ) : (
        <div className="grid-2">
          {providers.map((p) => (
            <div key={p.id} className="panel pad">
              <div className="row">
                <strong>{p.name}</strong>
                <span className={`chip tone-${p.ready ? "green" : "amber"}`}>{p.ready ? "ready" : "prerequisites missing"}</span>
              </div>
              <div className="small muted">{p.description}</div>
              {p.prerequisites.length > 0 && <Prerequisites items={p.prerequisites} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
