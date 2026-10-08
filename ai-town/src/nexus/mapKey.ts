// NEXUS addition: a cheap signature of a map's tiles, to redraw the static
// map only when NEXUS HQ really changed.
import type { WorldMap } from '../../convex/aiTown/worldMap';

const cache = new WeakMap<object, string>();

export function mapSignature(map: Pick<WorldMap, 'width' | 'height' | 'tileSetUrl' | 'bgTiles' | 'objectTiles'>): string {
  const hit = cache.get(map);
  if (hit) return hit;
  let h = 2166136261;
  const mix = (n: number) => {
    h ^= n + 1;
    h = Math.imul(h, 16777619);
  };
  for (const layer of [...map.bgTiles, ...map.objectTiles]) {
    for (const col of layer) for (const t of col) mix(t);
    mix(-7);
  }
  const sig = `${map.width}x${map.height}:${map.tileSetUrl}:${(h >>> 0).toString(16)}`;
  cache.set(map, sig);
  return sig;
}
