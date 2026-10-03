// NEXUS addition: skins. Built-in skins are AI Town's own characters
// (data/characters.ts: the folk sprites f1..f8 and the NEXUS sprites
// nexus-robot, nexus-android, nexus-wizard, nexus-cyberpunk drawn by
// scripts/nexus_skins.py). Spritesheets imported in NEXUS are stored in Convex
// (table `nexusSkins`) and referenced as `nexus-skin:<name>`.

export const NEXUS_SKIN_PREFIX = 'nexus-skin:';

export type NexusSkinPreset = {
  id: string;
  label: string;
  character: string;
  /** What the sprite really looks like (shown in "Customize Character"). */
  look: string;
};

/**
 * Named presets. Each one uses a sprite that actually looks like its label:
 * people roles use AI Town's villager sprites, the others NEXUS's own sprites.
 */
export const NEXUS_SKIN_PRESETS: NexusSkinPreset[] = [
  { id: 'default', label: 'Default', character: 'f1', look: 'AI Town villager: grey hair, blue shirt' },
  { id: 'developer', label: 'Developer', character: 'f5', look: 'AI Town villager: spiky blond hair, black jacket' },
  { id: 'engineer', label: 'Engineer', character: 'f2', look: 'AI Town villager: short dark hair, green shirt' },
  { id: 'designer', label: 'Designer', character: 'f6', look: 'AI Town villager: pink hair' },
  { id: 'manager', label: 'Manager', character: 'f8', look: 'AI Town villager: long blond hair, dark jacket' },
  { id: 'robot', label: 'Robot', character: 'nexus-robot', look: 'NEXUS sprite: steel body, box head, antenna' },
  { id: 'android', label: 'Android', character: 'nexus-android', look: 'NEXUS sprite: white shell, cyan visor' },
  { id: 'wizard', label: 'Wizard', character: 'nexus-wizard', look: 'NEXUS sprite: pointed hat, white beard, purple robe' },
  { id: 'cyberpunk', label: 'Cyberpunk', character: 'nexus-cyberpunk', look: 'NEXUS sprite: neon hair, magenta visor' },
];

/** Built-in character names NEXUS accepts as a skin. */
export const BUILTIN_SKINS = [
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8',
  'nexus-robot', 'nexus-android', 'nexus-wizard', 'nexus-cyberpunk',
];
