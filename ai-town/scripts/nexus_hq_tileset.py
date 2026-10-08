"""NEXUS addition: builds the tileset of NEXUS HQ (the AI World building).

AI Town draws a map from ONE tileset image whose tiles sit on a 32 px grid.
The interior pieces NEXUS needs (floors, walls, functional furniture) exist
in AI Town's own public/assets/rpg-tileset.png, but many of them are not
aligned on its 32 px grid. This script crops them at their real pixel
positions and packs them on a 32 px grid:

    python ai-town/scripts/nexus_hq_tileset.py

writes ai-town/public/assets/nexus-hq.png (requires Pillow). The tile order
below is the contract with data/nexusHq.ts (`HQ_TILES`): append new tiles at
the end, never reorder.
"""

from __future__ import annotations

import os

from PIL import Image, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "public", "assets")
SRC = os.path.join(ASSETS, "rpg-tileset.png")
OUT = os.path.join(ASSETS, "nexus-hq.png")

T = 32
COLS = 16

# Floors (bg layer): a 32x32 crop inside each texture, seamless when repeated.
FLOORS = [
    ("floor_wood", (1312, 64)),
    ("floor_darkwood", (1408, 64)),
    ("floor_stone", (1504, 64)),
    ("floor_carpet", (1408, 176)),
    ("floor_tiles", (1296, 160)),
    ("floor_grate", (224, 496)),
    ("floor_corridor", (416, 512)),
    ("floor_threshold", (1392, 112)),
]

# Walls: front face (a floor tile below) and top (darker, seen from above).
WALLS = [
    ("wall_plaster", (1184, 704)),
    ("wall_brick", (1312, 704)),
    ("wall_stone", (1440, 704)),
    ("wall_dark", (1344, 800)),
]

# Functional furniture (object layer, blocks movement): (name, src rect, tiles w, tiles h).
FURNITURE = [
    ("server_rack", (928, 752, 32, 64), 1, 2),
    ("bookshelf", (832, 584, 32, 64), 1, 2),
    ("shelf", (736, 584, 32, 64), 1, 2),
    ("table", (832, 656, 64, 64), 2, 2),
    ("shop_counter", (896, 560, 96, 64), 3, 2),
    ("chest", (864, 752, 32, 32), 1, 1),
    ("command_chair", (1024, 752, 32, 48), 1, 2),
    ("mission_board", (800, 464, 32, 32), 1, 1),
]


def build() -> tuple[Image.Image, list[str]]:
    src = Image.open(SRC).convert("RGBA")
    tiles: list[tuple[str, Image.Image]] = []

    for name, (x, y) in FLOORS:
        tiles.append((name, src.crop((x, y, x + T, y + T))))

    for name, (x, y) in WALLS:
        face = src.crop((x, y, x + T, y + T))
        top = ImageEnhance.Brightness(face).enhance(0.55)
        tiles.append((name + "_face", face))
        tiles.append((name + "_top", top))

    # Workstation: a desk edge with a screen on it, both from the same tileset.
    ws = Image.new("RGBA", (T, T))
    desk = src.crop((832, 720, 864, 738))
    ws.alpha_composite(desk, (0, T - desk.height))
    screen = src.crop((770, 784, 798, 806))
    ws.alpha_composite(screen, ((T - screen.width) // 2, 2))
    tiles.append(("workstation", ws))

    for name, (x, y, w, h), tw, th in FURNITURE:
        piece = src.crop((x, y, x + w, y + h))
        canvas = Image.new("RGBA", (tw * T, th * T))
        # Bottom-centered: furniture stands on its last row.
        canvas.alpha_composite(piece, ((tw * T - w) // 2, th * T - h))
        for j in range(th):
            for i in range(tw):
                tiles.append((f"{name}_{i}_{j}", canvas.crop((i * T, j * T, i * T + T, j * T + T))))

    rows = (len(tiles) + COLS - 1) // COLS
    sheet = Image.new("RGBA", (COLS * T, rows * T))
    for k, (_, img) in enumerate(tiles):
        sheet.alpha_composite(img, ((k % COLS) * T, (k // COLS) * T))
    return sheet, [n for n, _ in tiles]


if __name__ == "__main__":
    sheet, names = build()
    sheet.save(OUT)
    print(f"{OUT}: {sheet.width}x{sheet.height}")
    for i, n in enumerate(names):
        print(f"  {i:3d} {n}")
