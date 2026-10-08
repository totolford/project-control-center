// NEXUS addition: parameters passed by NEXUS when AI Town is embedded.
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

/** True when running inside NEXUS (iframe with ?embed=nexus). */
export const EMBEDDED = params.get('embed') === 'nexus';

/**
 * AI World Safe Mode (`&safe=1`, chosen after a world crash): built-in
 * sprites only, no animated effects, no speech bubbles, only characters that
 * passed validation unrepaired, rooms drawn without their most recent
 * additions' decorations.
 */
export const SAFE_MODE = params.get('safe') === '1';

/** World of the open NEXUS project. */
export const EMBEDDED_WORLD = (params.get('world') || undefined) as Id<'worlds'> | undefined;

/** The project's world when embedded, AI Town's default world otherwise. */
export function useWorldStatus() {
  const byId = useQuery(api.nexus.worldStatus, EMBEDDED_WORLD ? { worldId: EMBEDDED_WORLD } : 'skip');
  const byDefault = useQuery(api.world.defaultWorldStatus, EMBEDDED_WORLD ? 'skip' : {});
  return EMBEDDED_WORLD ? byId : byDefault;
}
