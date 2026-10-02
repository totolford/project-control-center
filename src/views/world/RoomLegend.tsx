import type { Room } from "../../lib/types";
import { ROOM_META } from "./status";

/** What each room means for a linked character in Hybrid / Real execution. */
export function RoomLegend({ rooms }: { rooms: Room[] }) {
  return (
    <div className="world-legend">
      <div className="section-label">Rooms — what they mean for linked agents</div>
      <ul>
        {rooms.map((r) => (
          <li key={r.id}>
            <span className="world-swatch" style={{ background: ROOM_META[r.kind]?.floor }} />
            <strong>{r.name}</strong> <span className="muted">= {ROOM_META[r.kind]?.meaning ?? r.kind}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
