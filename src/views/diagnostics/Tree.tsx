import { memo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { StatusDot } from "../../components/StatusBadge";
import type { TreeNode } from "./trees";

const TreeItem = memo(function TreeItem({ node, level }: { node: TreeNode; level: number }) {
  const [open, setOpen] = useState(level < 2);
  const hasChildren = node.children.length > 0;
  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-level={level + 1} className="dtree-item">
      <div className="dtree-row" style={{ paddingLeft: 4 + level * 14 }}>
        {hasChildren ? (
          <button className="dtree-toggle" onClick={() => setOpen(!open)} aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="dtree-leaf" aria-hidden="true" />
        )}
        {node.status && <StatusDot tone={node.status.tone} />}
        <span className="dtree-label ellipsis" title={node.label}>
          {node.label}
        </span>
        {node.status && <span className={`dtree-status tone-${node.status.tone}-fg`}>{node.status.label}</span>}
        {node.detail && (
          <span className="dtree-detail ellipsis" title={node.detail}>
            {node.detail}
          </span>
        )}
      </div>
      {hasChildren && open && (
        <ul role="group" className="dtree-group">
          {node.children.map((c) => (
            <TreeItem key={c.id} node={c} level={level + 1} />
          ))}
        </ul>
      )}
    </li>
  );
});

/** Dense, collapsible tree (first two levels open). */
export function Tree({ nodes, label, empty }: { nodes: TreeNode[]; label: string; empty: string }) {
  if (nodes.length === 0) return <div className="muted small dtree-empty">{empty}</div>;
  return (
    <ul role="tree" aria-label={label} className="dtree">
      {nodes.map((n) => (
        <TreeItem key={n.id} node={n} level={0} />
      ))}
    </ul>
  );
}
