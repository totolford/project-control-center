// NEXUS addition: tests of the pure logic of the embedded world.
import { NEXUS_ZONES } from '../../data/nexusZones';
import { BUILTIN_SKINS, NEXUS_SKIN_PRESETS } from '../../data/nexusSkins';
import { characters } from '../../data/characters';
import { buildingLayout, signText } from './buildingLayout';
import { cinematicShots, clampScale, isActive, minScale } from './camera';
import { parseFromNexus } from './protocol';
import { bubbleText, indexAgents, parseTint, resolveCharacter, visibleSpeech, visualState } from './state';
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
    const state = { agents: [row({ nexusId: 'x', playerId: 'p:9' }), row({ nexusId: 'y', playerId: 'p:2' })] } as NexusState;
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

describe('buildings', () => {
  test('every zone has a door on its front wall and parts inside its rectangle', () => {
    for (const z of NEXUS_ZONES) {
      const l = buildingLayout(z);
      const b = l.bounds;
      expect(l.door.x).toBeGreaterThanOrEqual(b.x);
      expect(l.door.x + l.door.w).toBeLessThanOrEqual(b.x + b.w);
      expect(l.door.y + l.door.h).toBe(b.y + b.h);
      for (const p of l.base) {
        expect(p.x).toBeGreaterThanOrEqual(b.x);
        expect(p.x + p.w).toBeLessThanOrEqual(b.x + b.w);
      }
    }
    expect(signText(NEXUS_ZONES.find((z) => z.id === 'skill_shop')!)).toBe('SKILLS');
  });
});

describe('camera', () => {
  test('cinematic only visits real activity', () => {
    const agents = [row({ nexusId: 'busy', status: 'working', zone: 'mcp_lab' }), row({ nexusId: 'idle' })];
    const pos = new Map([
      ['busy', { x: 10, y: 20 }],
      ['idle', { x: 0, y: 0 }],
    ]);
    const shots = cinematicShots(agents, pos, NEXUS_ZONES);
    expect(shots.map((s) => (s.kind === 'agent' ? s.nexusId : s.zone))).toEqual(['busy', 'mcp_lab']);
    expect(cinematicShots([row({})], pos, NEXUS_ZONES)).toEqual([]);
    const size = { width: 800, height: 600, worldWidth: 1600, worldHeight: 2400 };
    expect(minScale(size)).toBe(0.25);
    expect(clampScale(100, size)).toBe(3);
    expect(clampScale(0, size)).toBe(0.25);
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
    expect(parseFromNexus({ source: 'evil', type: 'focus', nexusId: 'a' })).toBeNull();
    expect(parseFromNexus({ source: 'nexus', type: 'camera', mode: 'warp' })).toBeNull();
    expect(parseFromNexus({ source: 'nexus', type: 'zoom', delta: 50 })).toEqual({
      source: 'nexus',
      type: 'zoom',
      delta: 2,
    });
  });
});
