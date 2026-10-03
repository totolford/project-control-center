// Imported character spritesheets ("Customize Character" → Import): detect
// the grid, map rows to directions and build the PIXI spritesheet data AI Town
// expects (same shape as ai-town/data/spritesheets/f1.ts). Pure, tested.

export const DIRECTIONS = ["down", "left", "right", "up"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface SheetLayout {
  frameW: number;
  frameH: number;
  /** Top-left of the character block used (sheets often hold several characters). */
  originX: number;
  originY: number;
  /** Walk frames per direction, read left to right. */
  framesPerDir: number;
  /** Row (inside the block) of each direction. */
  rows: Record<Direction, number>;
}

export interface Detection {
  layout: SheetLayout;
  /** Whole grid of the image in frames. */
  cols: number;
  gridRows: number;
  /** Character blocks found (framesPerDir x 4 frames each). */
  blocks: { x: number; y: number }[];
  notes: string[];
}

const SIZES = [32, 16, 48, 64, 24];

/** Proposes a frame size and a direction mapping for an image of `width` x `height`. */
export function detectLayout(width: number, height: number): Detection {
  const notes: string[] = [];
  let frameW = 0;
  let frameH = 0;
  for (const s of SIZES) {
    if (width % s === 0 && height % s === 0 && width / s >= 1 && height / s >= 4) {
      frameW = frameH = s;
      break;
    }
  }
  if (!frameW) {
    // One character, 3 frames x 4 directions, whatever the frame size.
    frameW = Math.max(1, Math.floor(width / 3));
    frameH = Math.max(1, Math.floor(height / 4));
    notes.push(`No square grid found: guessed ${frameW}x${frameH} frames (3 columns x 4 rows). Adjust if needed.`);
  }
  if (frameW !== 32 || frameH !== 32) notes.push("AI Town characters are 32x32; other sizes are drawn at their own size.");
  const cols = Math.max(1, Math.floor(width / frameW));
  const gridRows = Math.max(1, Math.floor(height / frameH));
  const framesPerDir = Math.min(3, cols);
  const blocks: { x: number; y: number }[] = [];
  for (let by = 0; by + 4 <= gridRows; by += 4) {
    for (let bx = 0; bx + framesPerDir <= cols; bx += framesPerDir) {
      blocks.push({ x: bx * frameW, y: by * frameH });
    }
  }
  if (blocks.length > 1) notes.push(`The sheet holds ${blocks.length} characters: choose which one to use.`);
  if (gridRows < 4) notes.push("Fewer than 4 rows: some directions share a row.");
  const row = (i: number) => Math.min(i, gridRows - 1);
  return {
    layout: {
      frameW,
      frameH,
      originX: 0,
      originY: 0,
      framesPerDir,
      // AI Town / RPG Maker order: down, left, right, up.
      rows: { down: row(0), left: row(1), right: row(2), up: row(3) },
    },
    cols,
    gridRows,
    blocks,
    notes,
  };
}

/** Frame rectangle of a direction's n-th frame. */
export function frameRect(l: SheetLayout, dir: Direction, n: number) {
  return { x: l.originX + n * l.frameW, y: l.originY + l.rows[dir] * l.frameH, w: l.frameW, h: l.frameH };
}

/** Problems that make the layout unusable for this image (empty = OK). */
export function layoutErrors(l: SheetLayout, width: number, height: number): string[] {
  const errors: string[] = [];
  if (l.frameW < 8 || l.frameH < 8 || l.frameW > 256 || l.frameH > 256) errors.push("Frames must be 8 to 256 px.");
  if (l.framesPerDir < 1 || l.framesPerDir > 12) errors.push("1 to 12 frames per direction.");
  for (const d of DIRECTIONS) {
    const last = frameRect(l, d, l.framesPerDir - 1);
    if (last.x < 0 || last.y < 0 || last.x + last.w > width || last.y + last.h > height) {
      errors.push(`The ${d} row goes outside the image.`);
    }
  }
  return errors;
}

export interface SpritesheetData {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; sourceSize: { w: number; h: number }; spriteSourceSize: { x: number; y: number } }>;
  animations: Record<Direction, string[]>;
  meta: { scale: string };
}

/** PIXI spritesheet data: frames `down`, `down2`… and one animation per direction. */
export function buildSpritesheetData(l: SheetLayout): SpritesheetData {
  const frames: SpritesheetData["frames"] = {};
  const animations = {} as Record<Direction, string[]>;
  for (const d of DIRECTIONS) {
    animations[d] = [];
    for (let n = 0; n < l.framesPerDir; n++) {
      const name = n === 0 ? d : `${d}${n + 1}`;
      frames[name] = { frame: frameRect(l, d, n), sourceSize: { w: l.frameW, h: l.frameH }, spriteSourceSize: { x: 0, y: 0 } };
      animations[d].push(name);
    }
  }
  return { frames, animations, meta: { scale: "1" } };
}
