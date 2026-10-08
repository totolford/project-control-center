// NEXUS addition: tests of the pure logic of the embedded world.
import { initialLayout, type HqRoom } from '../../data/nexusHq';
import { BUILTIN_SKINS, NEXUS_SKIN_PRESETS } from '../../data/nexusSkins';
import { characters } from '../../data/characters';
import { connectionLines, isRecent, roomAt, signAnchor, signText } from './roomGeometry';
import { cinematicShots, clampScale, groupFrame, isActive, minScale, roomCenter } from './camera';
import { mapSignature } from './mapKey';
import { setWorldStrings, text } from './strings';
import { crashContext, trace, traceCharacter } from './trace';
import { DEFAULT_CHARACTER, WarningReporter, checkAgent, validPosition, validateWorld } from './validate';
import { parseFromNexus } from './protocol';
import { bubbleText, family, indexAgents, parentLink, parseTint, rankLabel, rankPips, resolveCharacter, visibleSpeech, visualState } from './state';
import type { NexusAgentRow, NexusState } from './state';

function row(over: Partial<NexusAgentRow>): NexusAgentRow {
  return {
    nexusId: 'a1',
    name: 'Ada',
    role: 'Backend',
    character: 'f1',
    isCentral: false,
    status: 'idle',
    statusLabel: 'Idle',
    zone: 'coding_office',
    skills: [],
    mcp: [],
    connections: [],
    updatedAt: 0,
    ...over,
  } as NexusAgentRow;
}

describe('visual state follows the agent row only', () => {
  test('statuses', () => {
    expect(visualState(row({ status: 'idle' }))).toBe('idle');
    expect(visualState(row({ status: 'working', emoji: '💭' }))).toBe('thinking');
    expect(visualState(row({ status: 'working', emoji: '⚙️' }))).toBe('working');
    expect(visualState(row({ status: 'awaiting_permission', emoji: '✋' }))).toBe('waiting');
    expect(visualState(row({ status: 'crashed' }))).toBe('error');
    expect(visualState(row({ status: 'idle', emoji: '✅' }))).toBe('finished');
    expect(visualState(row({ status: 'idle', emoji: '❗' }))).toBe('error');
    expect(visualState(row({ status: 'offline', emoji: '💤' }))).toBe('offline');
    expect(isActive(row({ status: 'idle', emoji: '✅' }))).toBe(false);
    expect(isActive(row({ status: 'working' }))).toBe(true);
  });
});

describe('speech bubbles', () => {
  test('latest visible line per speaker', () => {
    const now = 100_000;
    const speech = [
      { id: '1', from: 'a', text: 'old', origin: 'real', ts: now - 50_000, delivered: true },
      { id: '2', from: 'a', to: 'b', text: 'hi', origin: 'real', ts: now - 2_000, delivered: false },
      { id: '3', from: 'b', text: 'do it', origin: 'user', ts: now - 1_000, delivered: true },
    ] as NexusState['speech'];
    const v = visibleSpeech(speech, 12_000, now);
    expect(v.get('a')?.text).toBe('hi');
    expect(v.get('a')?.age).toBe(2_000);
    expect(v.get('b')?.origin).toBe('user');
    const names = (id: string) => ({ b: 'Bob' })[id] ?? id;
    expect(bubbleText(v.get('a')!, names)).toBe('→ Bob: hi');
    expect(bubbleText(v.get('b')!, names)).toBe('You: do it');
    expect(visibleSpeech(speech, 12_000, now + 20_000).size).toBe(0);
  });
});

describe('agents ↔ players', () => {
  test('token wins over the stored player id', () => {
    const state = {
      agents: [row({ nexusId: 'x', playerId: 'p:9' }), row({ nexusId: 'y', playerId: 'p:2' })],
      rooms: [{ ...ROOMS[0], id: 'coding_office' }],
      skins: [],
    } as unknown as NexusState;
    const w = indexAgents(state, [{ id: 'p:1', human: 'nexus:x' }, { id: 'p:3', human: 'Me' }]);
    expect(w.byPlayer.get('p:1')?.nexusId).toBe('x');
    expect(w.byPlayer.get('p:2')?.nexusId).toBe('y');
    expect(w.playerOf('x')).toBe('p:1');
    expect(w.byPlayer.has('p:3')).toBe(false);
  });
});

describe('skins', () => {
  test('every preset is a registered built-in character', () => {
    for (const p of NEXUS_SKIN_PRESETS) {
      expect(BUILTIN_SKINS).toContain(p.character);
      expect(characters.some((c) => c.name === p.character)).toBe(true);
    }
    expect(resolveCharacter('nexus-robot', [])?.textureUrl).toBe('/ai-town/assets/nexus-skins/robot.png');
    expect(resolveCharacter('nexus-skin:mine', [])).toBeUndefined();
    const skins = [{ name: 'mine', label: 'Mine', textureUrl: 'blob:x', spritesheetData: {}, speed: 0.1 }];
    expect(resolveCharacter('nexus-skin:mine', skins)?.textureUrl).toBe('blob:x');
    expect(parseTint('#ff0080')).toBe(0xff0080);
    expect(parseTint('red')).toBeUndefined();
  });
});

const ROOMS: HqRoom[] = [
  initialLayout().rooms[0],
  { ...initialLayout().rooms[0], id: 'mcp_lab', name: 'MCP Lab', kind: 'mcp_lab', x: 16, y: 2, w: 9, h: 6, door: { x: 20, y: 7, side: 'bottom' } },
];

describe('rooms overlay', () => {
  test('signs, anchors, clicks and connections', () => {
    expect(signText({ name: 'Server Room' }, 0)).toBe('Server Room');
    expect(signText({ name: 'Salle des serveurs' }, 2)).toBe('Salle des serveurs · 2');
    expect(signAnchor({ x: 2, y: 2, w: 12 })).toEqual({ x: 256, y: 80 });
    expect(roomAt(ROOMS, 17 * 32, 3 * 32)?.id).toBe('mcp_lab');
    expect(roomAt(ROOMS, 15 * 32, 3 * 32)).toBeUndefined();
    const lines = connectionLines(ROOMS, [
      { from: 'central_hq', to: 'mcp_lab' },
      { from: 'central_hq', to: 'gone' },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].b).toEqual({ x: 20 * 32 + 16, y: 7 * 32 + 16 });
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(isRecent({ createdAt: '2026-10-07T11:55:00Z' }, now)).toBe(true);
    expect(isRecent({ createdAt: '2026-10-07T10:00:00Z' }, now)).toBe(false);
    expect(isRecent({}, now)).toBe(false);
  });
});

describe('world validator and repair', () => {
  const look = (c: string) => !!resolveCharacter(c, []);
  const rooms = ['central_hq', 'coding_office'];

  test('a missing appearance is replaced by the default one, the world continues', () => {
    const c = checkAgent(row({ nexusId: 'a1', character: 'nexus-skin:deleted' }), look, rooms);
    expect(c.ok).toBe(true);
    expect(c.row.character).toBe(DEFAULT_CHARACTER);
    expect(c.warnings).toEqual([
      {
        code: 'AI_WORLD_CHARACTER_APPEARANCE_MISSING',
        nexusId: 'a1',
        detail: 'sprite “nexus-skin:deleted” cannot be loaded',
        repair: 'Default appearance restored. World rendering continues.',
      },
    ]);
    const empty = checkAgent(row({ nexusId: 'a2', character: '' }), look, rooms);
    expect(empty.row.character).toBe(DEFAULT_CHARACTER);
  });

  test('names, statuses and rooms are repaired; rows without id are not drawn', () => {
    const c = checkAgent(row({ nexusId: 'a3', name: '', status: 'dancing', zone: 'warp_core' }), look, rooms);
    expect(c.row.name).toBe('a3');
    expect(c.row.status).toBe('idle');
    expect(c.row.zone).toBe('central_hq');
    expect(c.warnings.map((w) => w.code)).toEqual([
      'AI_WORLD_CHARACTER_NAME_MISSING',
      'AI_WORLD_CHARACTER_STATUS_UNKNOWN',
      'AI_WORLD_CHARACTER_ROOM_UNKNOWN',
    ]);
    expect(checkAgent(row({ nexusId: '' }), look, rooms).ok).toBe(false);
    expect(checkAgent(row({ nexusId: 'ok', tint: 'red' }), look, rooms).row.tint).toBeUndefined();
    expect(checkAgent(row({ nexusId: 'ok', zone: 'coding_office' }), look, rooms).warnings).toEqual([]);
  });

  test('safe mode draws only valid characters; duplicates are dropped', () => {
    const rows = [row({ nexusId: 'good' }), row({ nexusId: 'bad', character: 'nope' }), row({ nexusId: 'good' })];
    const normal = validateWorld(rows, look, ['coding_office']);
    expect(normal.rows.map((r) => r.nexusId)).toEqual(['good', 'bad']);
    expect(normal.hidden).toEqual(['good']);
    const safe = validateWorld(rows, look, ['coding_office'], true);
    expect(safe.rows.map((r) => r.nexusId)).toEqual(['good']);
    expect(safe.hidden).toEqual(['bad', 'good']);
  });

  test('indexAgents validates before indexing and lists hidden players', () => {
    const state = {
      agents: [row({ nexusId: 'x', character: 'nope' }), row({ nexusId: 'y' })],
      rooms: [{ ...ROOMS[0], id: 'coding_office' }],
      skins: [],
    } as unknown as NexusState;
    const w = indexAgents(state, [{ id: 'p:1', human: 'nexus:x' }, { id: 'p:2', human: 'nexus:y' }], true);
    expect(w.byPlayer.has('p:1')).toBe(false);
    expect(w.hiddenPlayers.has('p:1')).toBe(true);
    expect(w.warnings[0].code).toBe('AI_WORLD_CHARACTER_APPEARANCE_MISSING');
    const normal = indexAgents(state, [{ id: 'p:1', human: 'nexus:x' }]);
    expect(normal.byPlayer.get('p:1')?.character).toBe(DEFAULT_CHARACTER);
  });

  test('positions and once-only reports', () => {
    expect(validPosition({ x: 3, y: 4 }, 10, 10)).toBe(true);
    expect(validPosition({ x: NaN, y: 4 }, 10, 10)).toBe(false);
    expect(validPosition({ x: 12, y: 4 }, 10, 10)).toBe(false);
    expect(validPosition(undefined, 10, 10)).toBe(false);
    const sent: string[] = [];
    const r = new WarningReporter((w) => sent.push(`${w.code}:${w.nexusId}`));
    const w = checkAgent(row({ nexusId: 'z', character: 'nope' }), look, rooms).warnings;
    r.report(w);
    r.report(w);
    expect(sent).toEqual(['AI_WORLD_CHARACTER_APPEARANCE_MISSING:z']);
  });

  test('crash context carries the last render operation', () => {
    traceCharacter('a9', { character: 'f3' }, 'f3', '/ai-town/assets/32x32folk.png');
    trace.camera = { mode: 'follow', x: 1, y: 2, scale: 1.5 };
    const c = crashContext(new Error('boom'), 'at Player', { worldId: 'w', agents: 2, rooms: 6, revision: 4 }, false);
    expect(c.message).toBe('boom');
    expect(c.characterId).toBe('a9');
    expect(c.lastRenderOp).toBe('draw character a9');
    expect(c.sprite).toBe('f3');
    expect(c.appearance).toEqual({ character: 'f3' });
    expect(c.camera?.mode).toBe('follow');
    expect(c.world.rooms).toBe(6);
  });
});

describe('world strings and map signature', () => {
  test('NEXUS sends the texts in the AI World language', () => {
    expect(text('safeMode')).toBe('SAFE MODE');
    expect(setWorldStrings({ safeMode: 'MODE SANS ÉCHEC', bogus: 'x', recoverView: 42 })).toBe(1);
    expect(text('safeMode')).toBe('MODE SANS ÉCHEC');
    expect(text('recoverView')).toBe('Recover View');
  });

  test('the static map is redrawn only when the tiles change', () => {
    const a = { width: 2, height: 1, tileSetUrl: 'x', bgTiles: [[[1], [2]]], objectTiles: [[[-1], [-1]]] };
    const b = { ...a, objectTiles: [[[-1], [5]]] };
    expect(mapSignature(a)).toBe(mapSignature({ ...a }));
    expect(mapSignature(a)).not.toBe(mapSignature(b));
  });
});

describe('camera', () => {
  test('cinematic only visits real activity', () => {
    const agents = [row({ nexusId: 'busy', status: 'working', zone: 'mcp_lab' }), row({ nexusId: 'idle' })];
    const pos = new Map([
      ['busy', { x: 10, y: 20 }],
      ['idle', { x: 0, y: 0 }],
    ]);
    const shots = cinematicShots(agents, pos, ROOMS);
    expect(shots.map((s) => (s.kind === 'agent' ? s.nexusId : s.room))).toEqual(['busy', 'mcp_lab']);
    expect(shots[1]).toMatchObject(roomCenter(ROOMS[1]));
    expect(cinematicShots([row({})], pos, ROOMS)).toEqual([]);
    const size = { width: 800, height: 600, worldWidth: 1600, worldHeight: 2400 };
    expect(minScale(size)).toBe(0.25);
    expect(clampScale(100, size)).toBe(3);
    expect(clampScale(0, size)).toBe(0.25);
  });

  test('follow mission frames only the agents reported on it', () => {
    const size = { width: 800, height: 600, worldWidth: 3200, worldHeight: 3200 };
    const pos = new Map([
      ['a', { x: 100, y: 100 }],
      ['b', { x: 500, y: 300 }],
    ]);
    const f = groupFrame(['a', 'b', 'ghost'], pos, size)!;
    expect(f.x).toBe(300);
    expect(f.y).toBe(200);
    expect(f.scale).toBeGreaterThan(0.25);
    expect(f.scale).toBeLessThanOrEqual(2.2);
    expect(groupFrame(['ghost'], pos, size)).toBeNull();
  });
});

describe('protocol', () => {
  test('only well-formed NEXUS messages are accepted', () => {
    expect(parseFromNexus({ source: 'nexus', type: 'focus', nexusId: 'a' })).toEqual({
      source: 'nexus',
      type: 'focus',
      nexusId: 'a',
    });
    expect(parseFromNexus({ source: 'nexus', type: 'focusZone', zone: 'mars' })).toBeNull();
    expect(parseFromNexus({ source: 'nexus', type: 'focusRoom', roomId: 'api-lab' })).toEqual({
      source: 'nexus',
      type: 'focusRoom',
      roomId: 'api-lab',
    });
    expect(parseFromNexus({ source: 'nexus', type: 'focusRoom', roomId: '../x' })).toBeNull();
    expect(
      parseFromNexus({ source: 'nexus', type: 'followMission', missionId: 'm1', label: 'Login', nexusIds: ['a', 7, 'b'] }),
    ).toEqual({ source: 'nexus', type: 'followMission', missionId: 'm1', label: 'Login', nexusIds: ['a', 'b'] });
    expect(parseFromNexus({ source: 'nexus', type: 'followMission', missionId: 'm1', nexusIds: 'a' })).toBeNull();
    expect(parseFromNexus({ source: 'evil', type: 'focus', nexusId: 'a' })).toBeNull();
    expect(parseFromNexus({ source: 'nexus', type: 'camera', mode: 'warp' })).toBeNull();
    expect(parseFromNexus({ source: 'nexus', type: 'zoom', delta: 50 })).toEqual({
      source: 'nexus',
      type: 'zoom',
      delta: 2,
    });
  });
});

describe('agent hierarchy in the world', () => {
  const central = row({ nexusId: 'central', name: 'Central', isCentral: true, rank: 'commander' });
  const lead = row({ nexusId: 'lead', name: 'Lua Lead', rank: 'lieutenant', parentId: 'central' });
  const kid = row({ nexusId: 'kid', name: 'Lua Files', rank: 'specialist', parentId: 'lead' });
  const solo = row({ nexusId: 'solo', name: 'Solo', parentId: 'central' });
  const all = [central, lead, kid, solo];

  test('rank insignia and labels', () => {
    expect([rankPips('commander'), rankPips('lieutenant'), rankPips('specialist'), rankPips(undefined)]).toEqual([3, 2, 0, 0]);
    expect([rankLabel(central), rankLabel(lead), rankLabel(solo)]).toEqual(['Commander', 'Lieutenant', 'Specialist']);
  });

  test('dormant and paused agents are drawn as such', () => {
    expect(visualState(row({ status: 'sleeping' }))).toBe('sleeping');
    expect(visualState(row({ status: 'idle', paused: true }))).toBe('paused');
    // A turn still running while pausing keeps its real state.
    expect(visualState(row({ status: 'working', emoji: '⚙️', paused: true }))).toBe('working');
  });

  test('family: supervisor and direct reports', () => {
    expect(family(lead, all)).toEqual({ parent: { nexusId: 'central', name: 'Central' }, children: [{ nexusId: 'kid', name: 'Lua Files', rank: 'specialist' }] });
    expect(family(central, all).children.map((c) => c.nexusId)).toEqual(['lead', 'solo']);
    expect(family(kid, all).children).toEqual([]);
  });

  test('links to the supervisor', () => {
    const positions = new Map([['central', { x: 0, y: 0 }], ['lead', { x: 100, y: 0 }], ['kid', { x: 100, y: 50 }], ['solo', { x: 30, y: 30 }]]);
    const byId = new Map(all.map((a) => [a.nexusId, a]));
    expect(parentLink(kid, { x: 100, y: 50 }, positions, byId, null)).toEqual({ dx: 0, dy: -50, strong: false });
    // Links to Central only when one end is selected.
    expect(parentLink(solo, { x: 30, y: 30 }, positions, byId, null)).toBeNull();
    expect(parentLink(solo, { x: 30, y: 30 }, positions, byId, 'solo')).toEqual({ dx: -30, dy: -30, strong: true });
    expect(parentLink(central, { x: 0, y: 0 }, positions, byId, 'central')).toBeNull();
  });
});
