import { Info, Lock } from "lucide-react";
import { compatBanner } from "../lib/compat";
import { useStore } from "../store";

/** Compatibility mode (read-only, amber, persistent) or "newer format" information under the top bar. */
export function CompatBanner() {
  const readOnly = useStore((s) => s.project?.readOnly ?? false);
  const report = useStore((s) => s.project?.compatibility ?? null);
  const navigate = useStore((s) => s.navigate);
  const banner = compatBanner(readOnly, report);
  if (!banner) return null;
  const readOnlyMode = banner.kind === "read_only";
  return (
    <div className={`compat-banner ${readOnlyMode ? "read-only" : "newer"}`} role={readOnlyMode ? "alert" : "status"}>
      {readOnlyMode ? <Lock size={13} /> : <Info size={13} />}
      <div className="grow">
        <strong>
          {readOnlyMode
            ? `Compatibility mode — this project requires NEXUS ≥ ${banner.minimum}; it is opened read-only`
            : "This project uses a newer format — unknown fields are preserved"}
        </strong>
        {banner.notes.length > 0 && (
          <ul className="compat-notes">
            {banner.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
      <button className="btn btn-sm ghost" onClick={() => navigate({ name: "settings", section: "compatibility" })}>
        Details
      </button>
    </div>
  );
}
