import { MoreHorizontal } from "lucide-react";
import { Menu, type MenuEntry } from "../components/Menu";
import type { PanelSpec } from "./layout";
import type { PanelChrome } from "./PanelFrame";
import { PANEL_ICON, usePanelTitle } from "./panelMeta";

export interface PanelHeaderProps {
  spec: PanelSpec;
  chrome: PanelChrome;
}

/** Right side shared by every header: ⋯ menu + panel controls. */
export function HeaderActions({ chrome, extra }: { chrome: PanelChrome; extra?: MenuEntry[] }) {
  const entries = extra && extra.length > 0 ? [...extra, "separator" as const, ...chrome.menu] : chrome.menu;
  return (
    <div className="panel-head-actions">
      <Menu trigger={<MoreHorizontal size={14} />} entries={entries} align="right" label="Panel menu" />
      {chrome.controls}
    </div>
  );
}

export function GenericHeader({ spec, chrome }: PanelHeaderProps) {
  const title = usePanelTitle(spec);
  const Icon = PANEL_ICON[spec.type];
  return (
    <header className="panel-head">
      {chrome.grip}
      <Icon size={14} className="panel-head-icon" />
      <span className="panel-head-title" title={title}>
        {title}
      </span>
      <HeaderActions chrome={chrome} />
    </header>
  );
}
