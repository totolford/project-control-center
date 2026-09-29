import { Bot, Plus, UserCog } from "lucide-react";
import { Menu, type MenuEntry } from "../components/Menu";
import { useUi } from "../state/ui";
import { useProviders } from "../workspace/hooks";

const CLAUDE_CODE = "claude-code";

/** "+ Agent": only providers the backend reports as available can be chosen. */
export function AddAgentMenu() {
  const providers = useProviders();
  const openDialog = useUi((s) => s.openDialog);

  const entries = (): MenuEntry[] => {
    if (providers === null) return [{ label: "Detecting providers…", disabled: true }];
    const available = providers.filter((p) => p.available);
    const custom = available.find((p) => p.id === CLAUDE_CODE) ?? available[0];
    return [
      { heading: "Providers" },
      ...providers.map((p) => ({
        label: `${p.name} agent`,
        detail: p.available ? p.description : p.detail,
        icon: <Bot size={13} />,
        disabled: !p.available,
        onSelect: () => openDialog({ type: "newAgent", provider: p.id }),
      })),
      "separator",
      {
        label: "Custom agent…",
        detail: custom ? `${custom.name} with your own role and instructions` : "No provider available",
        icon: <UserCog size={13} />,
        disabled: !custom,
        onSelect: () => custom && openDialog({ type: "newAgent", provider: custom.id }),
      },
    ];
  };

  return (
    <Menu
      trigger={
        <>
          <Plus size={13} /> Agent
        </>
      }
      buttonClassName="btn btn-sm"
      entries={entries}
      label="Add agent"
    />
  );
}
