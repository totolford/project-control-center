import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "../../components/Modal";
import { run } from "../../lib/toast";

const REPO = "https://github.com/a16z-infra/ai-town";

/** MIT credit for AI Town (full notice: THIRD_PARTY_NOTICES.md). */
export function AboutAiTown({ upstreamCommit, onClose }: { upstreamCommit: string | null; onClose: () => void }) {
  return (
    <Modal
      title="About AI Town"
      onClose={onClose}
      width={560}
      footer={
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="world-step small">
        <p>
          The AI World is built on <strong>AI Town</strong> by a16z-infra, a virtual town where characters live, chat and socialize
          (React, PixiJS, Convex). NEXUS bundles it, based on upstream commit{" "}
          <span className="mono">{upstreamCommit ? upstreamCommit.slice(0, 7) : "unknown"}</span>, and adds a NEXUS layer: its
          buildings, your real agents as characters, the profile card and the camera. NEXUS changes are marked
          <span className="mono"> NEXUS</span> in the code.
        </p>
        <p>
          AI Town is released under the <strong>MIT License</strong>, Copyright (c) 2023 a16z-infra. Its pixel art comes from the
          artists credited in its README (George Bailey, hilau, ansimuz, Mounir Tohami). The full license and credits are in{" "}
          <span className="mono">THIRD_PARTY_NOTICES.md</span>, shipped with NEXUS.
        </p>
        <p className="muted">
          The NEXUS sprites (Robot, Android, Wizard, Cyberpunk) are redrawn by NEXUS from AI Town's villager sprites.
        </p>
        <button className="btn btn-sm" onClick={() => void run(() => openUrl(REPO))}>
          <ExternalLink size={12} /> github.com/a16z-infra/ai-town
        </button>
      </div>
    </Modal>
  );
}
