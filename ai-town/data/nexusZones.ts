// NEXUS addition: the buildings of the NEXUS AI World, placed on open
// (walkable) ground of the `gentle` map. Coordinates are in tiles.
// `door` is the walkable tile in front of the building where characters stand
// when they "work" there; buildings themselves are drawn by the frontend.

export type NexusZoneKind =
  | 'central_hq'
  | 'coding_office'
  | 'design_studio'
  | 'roblox_studio'
  | 'github_office'
  | 'server_room'
  | 'mcp_lab'
  | 'skill_shop'
  | 'testing_lab'
  | 'review_room'
  | 'archive';

export type NexusZone = {
  id: NexusZoneKind;
  name: string;
  /** What happens there, shown on hover. */
  purpose: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door: { x: number; y: number };
};

export const NEXUS_ZONES: NexusZone[] = [
  { id: 'central_hq', name: 'Central HQ', purpose: 'Central Agent plans and orchestrates missions', x: 42, y: 16, w: 8, h: 5, door: { x: 46, y: 21 } },
  { id: 'coding_office', name: 'Coding Office', purpose: 'Agents running a Claude Code turn on code', x: 57, y: 17, w: 6, h: 4, door: { x: 60, y: 21 } },
  { id: 'design_studio', name: 'Design Studio', purpose: 'UI / UX and design work', x: 4, y: 13, w: 7, h: 4, door: { x: 7, y: 17 } },
  { id: 'roblox_studio', name: 'Roblox Studio', purpose: 'Roblox Studio work through its MCP server', x: 30, y: 19, w: 6, h: 3, door: { x: 33, y: 22 } },
  { id: 'github_office', name: 'GitHub Office', purpose: 'Git and GitHub operations', x: 8, y: 4, w: 8, h: 3, door: { x: 11, y: 7 } },
  { id: 'server_room', name: 'Server Room', purpose: 'SSH sessions and remote machines', x: 37, y: 26, w: 8, h: 4, door: { x: 41, y: 30 } },
  { id: 'mcp_lab', name: 'MCP Lab', purpose: 'MCP servers and tools', x: 50, y: 29, w: 7, h: 4, door: { x: 53, y: 33 } },
  { id: 'skill_shop', name: 'Skill Shop', purpose: 'Skill Marketplace', x: 9, y: 22, w: 6, h: 3, door: { x: 12, y: 25 } },
  { id: 'testing_lab', name: 'Testing Lab', purpose: 'Running tests and checks', x: 53, y: 37, w: 7, h: 4, door: { x: 56, y: 41 } },
  { id: 'review_room', name: 'Review Room', purpose: 'Reviews and waiting for your approval', x: 12, y: 29, w: 7, h: 3, door: { x: 15, y: 32 } },
  { id: 'archive', name: 'Archive', purpose: 'Finished and retired agents', x: 40, y: 42, w: 7, h: 3, door: { x: 43, y: 45 } },
];

export function zoneById(id: string): NexusZone | undefined {
  return NEXUS_ZONES.find((z) => z.id === id);
}
