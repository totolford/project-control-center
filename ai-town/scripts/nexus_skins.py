"""NEXUS addition: generates the NEXUS character spritesheets.

Each skin is derived from one of AI Town's own 32x32 folk characters
(public/assets/32x32folk.png, MIT) and redrawn pixel by pixel: palette
remapped and head gear drawn over every frame. The output has the same frame
layout as data/spritesheets/f1.ts (3 columns x 4 rows of 32x32 frames: down,
left, right, up), so the skins animate exactly like the built-in characters.

    python ai-town/scripts/nexus_skins.py

writes ai-town/public/assets/nexus-skins/<name>.png (requires Pillow).
"""

from __future__ import annotations

import colorsys
import os
from typing import Callable

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "public", "assets")
OUT = os.path.join(ASSETS, "nexus-skins")

T = 32
DIRS = ["down", "left", "right", "up"]
# Origin (px) of each folk character in 32x32folk.png.
FOLK = {
    "f1": (0, 0), "f2": (96, 0), "f3": (192, 0), "f4": (288, 0),
    "f5": (0, 128), "f6": (96, 128), "f7": (192, 128), "f8": (288, 128),
}

RGBA = tuple[int, int, int, int]


def hexc(h: str, a: int = 255) -> RGBA:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def lum(p: RGBA) -> float:
    return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255


def is_skin(p: RGBA) -> bool:
    r, g, b, _ = p
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return 0.02 <= h <= 0.11 and 0.18 <= s <= 0.6 and v >= 0.55


def ramp(colors: list[str]) -> Callable[[float], RGBA]:
    """Maps a luminance (0..1) to one color of a small palette (dark → light)."""
    pal = [hexc(c) for c in colors]

    def pick(l: float) -> RGBA:
        i = min(len(pal) - 1, max(0, int(l * len(pal) * 1.15)))
        return pal[i]

    return pick


class Frame:
    def __init__(self, img: Image.Image, direction: str):
        self.img = img
        self.px = img.load()
        self.dir = direction
        ys = [y for y in range(T) for x in range(T) if self.px[x, y][3] > 0]
        self.top = min(ys)
        # Head: the first 18 rows of the sprite (AI Town's chibi proportions).
        self.neck = self.top + 17
        xs = [x for y in range(self.top, self.neck) for x in range(T) if self.px[x, y][3] > 0]
        self.left, self.right = min(xs), max(xs)
        self.cx = (self.left + self.right) // 2

    def get(self, x: int, y: int) -> RGBA:
        if 0 <= x < T and 0 <= y < T:
            return self.px[x, y]
        return (0, 0, 0, 0)

    def put(self, x: int, y: int, c: RGBA) -> None:
        if 0 <= x < T and 0 <= y < T:
            self.px[x, y] = c

    def rect(self, x0: int, y0: int, x1: int, y1: int, c: RGBA) -> None:
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.put(x, y, c)

    def paint(self, x0: int, y0: int, x1: int, y1: int, c: RGBA) -> None:
        """Like rect() but only over pixels that are already drawn."""
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if self.get(x, y)[3] > 0:
                    self.put(x, y, c)

    def remap(self, fn: Callable[[int, int, RGBA], RGBA | None]) -> None:
        for y in range(T):
            for x in range(T):
                p = self.px[x, y]
                if p[3] == 0:
                    continue
                q = fn(x, y, p)
                if q is not None:
                    self.px[x, y] = (q[0], q[1], q[2], p[3])

    def outline(self, c: RGBA) -> None:
        """1px dark outline around opaque pixels (keeps the folk look)."""
        add = []
        for y in range(T):
            for x in range(T):
                if self.px[x, y][3] > 0:
                    continue
                if any(self.get(x + dx, y + dy)[3] > 0 and self.get(x + dx, y + dy) != c
                       for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    add.append((x, y))
        for x, y in add:
            self.px[x, y] = c


# ------------------------------------------------------------------ robot

def robot(f: Frame) -> None:
    dark, mid, light, shine = hexc("#1f2633"), hexc("#5c6b80"), hexc("#97a6ba"), hexc("#d5dee9")
    eye, bulb = hexc("#46f0ff"), hexc("#ff4d4d")
    body = ramp(["#1f2633", "#3b4658", "#5c6b80", "#7d8ca2", "#a9b6c6"])
    # Metal body: every pixel below the head is plated.
    f.remap(lambda x, y, p: body(lum(p)) if y >= f.neck - 1 else None)
    # Box head replaces the hair and face.
    f.rect(0, 0, T - 1, f.neck - 2, (0, 0, 0, 0))
    x0, x1 = f.cx - 8, f.cx + 8
    y0, y1 = f.top + 3, f.neck - 2
    f.rect(x0, y0, x1, y1, dark)
    f.rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, light)
    f.rect(x0 + 1, y1 - 2, x1 - 1, y1 - 1, mid)          # jaw shade
    f.rect(x0 + 2, y0 + 1, x0 + 4, y0 + 1, shine)        # highlight
    # Bolts on the sides.
    f.rect(x0 - 1, y0 + 6, x0 - 1, y0 + 8, mid)
    f.rect(x1 + 1, y0 + 6, x1 + 1, y0 + 8, mid)
    # Antenna.
    f.rect(f.cx, y0 - 3, f.cx, y0 - 1, dark)
    f.rect(f.cx - 1, y0 - 5, f.cx, y0 - 4, bulb)
    vy = y0 + 5
    if f.dir == "down":
        f.rect(x0 + 2, vy, x1 - 2, vy + 3, dark)
        f.rect(x0 + 4, vy + 1, x0 + 5, vy + 2, eye)
        f.rect(x1 - 5, vy + 1, x1 - 4, vy + 2, eye)
        f.rect(f.cx - 2, y1 - 3, f.cx + 2, y1 - 3, dark)   # mouth grille
        f.rect(f.cx - 1, f.neck + 3, f.cx, f.neck + 4, eye)  # chest light
    elif f.dir == "left":
        f.rect(x0 + 1, vy, f.cx, vy + 3, dark)
        f.rect(x0 + 2, vy + 1, x0 + 3, vy + 2, eye)
    elif f.dir == "right":
        f.rect(f.cx, vy, x1 - 1, vy + 3, dark)
        f.rect(x1 - 3, vy + 1, x1 - 2, vy + 2, eye)
    else:  # up: back panel with vents
        f.rect(x0 + 4, vy, x1 - 4, vy + 6, mid)
        for k in range(3):
            f.rect(x0 + 5, vy + 1 + 2 * k, x1 - 5, vy + 1 + 2 * k, dark)


# ------------------------------------------------------------------ android

def android(f: Frame) -> None:
    shell = ramp(["#2c3440", "#7f8fa3", "#b9c6d4", "#e1e8ef", "#f7fafc"])
    synth_skin = ramp(["#6f7f92", "#a8b7c7", "#cfdae4", "#e6edf3"])
    suit = ramp(["#1a2230", "#33415a", "#e7edf3", "#ffffff"])
    glow = hexc("#38e8ff")

    def fn(x: int, y: int, p: RGBA) -> RGBA | None:
        if lum(p) < 0.16:
            return hexc("#1b2230")          # keep the outline dark
        if is_skin(p):
            return synth_skin(lum(p))
        if y < f.neck:
            return shell(lum(p))            # hair → smooth white shell
        return suit(lum(p))

    eye_row = f.top + 12
    face = [x for x in range(T) if is_skin(f.get(x, eye_row))]
    f.remap(fn)
    # Cyan visor line across the eyes and seams on the suit.
    if f.dir != "up":
        for x in face:
            f.put(x, eye_row, glow)
    else:
        f.rect(f.cx - 1, f.top + 4, f.cx, f.neck - 4, glow)  # spine light on the shell
    for y in range(f.neck + 1, T):
        p = f.get(f.cx, y)
        if p[3] and lum(p) > 0.3:
            f.put(f.cx, y, glow)


# ------------------------------------------------------------------ wizard

def wizard(f: Frame) -> None:
    robe = ramp(["#1d1030", "#3b1d63", "#5a2d91", "#7d47c2", "#a77be0"])
    hat, hat_dark, hat_light = hexc("#5a2d91"), hexc("#2a1446"), hexc("#7d47c2")
    band, star = hexc("#f2c94c"), hexc("#fff2a8")
    beard, beard_dark = hexc("#eef0f4"), hexc("#b9bfcc")

    def fn(x: int, y: int, p: RGBA) -> RGBA | None:
        if y >= f.neck and not is_skin(p) and lum(p) > 0.12:
            return robe(lum(p))
        return None

    f.remap(fn)
    # Pointed hat: the top of the hair becomes a cone sitting on a wide brim
    # just above the eyes; its tip bends to one side.
    brim_y = f.top + 9
    f.rect(0, 0, T - 1, brim_y - 1, (0, 0, 0, 0))
    half = (f.right - f.left) // 2 + 1
    rows = brim_y - 1
    for k, y in enumerate(range(brim_y - 1, 0, -1)):
        w = max(0, half - 2 - ((k + 1) * (half - 2)) // rows)
        f.rect(f.cx - w, y, f.cx + w, y, hat)
        f.put(f.cx - w, y, hat_light)
        f.put(f.cx - w - 1, y, hat_dark)
        f.put(f.cx + w + 1, y, hat_dark)
    tip = -1 if f.dir == "left" else 1
    f.rect(f.cx + tip, 0, f.cx + 2 * tip, 0, hat)
    f.put(f.cx + 3 * tip, 0, hat_dark)
    f.put(f.cx + 3 * tip, 1, hat_dark)
    f.rect(f.cx - half + 3, brim_y - 2, f.cx + half - 3, brim_y - 1, band)
    f.rect(f.left - 2, brim_y, f.right + 2, brim_y + 1, hat_dark)
    f.rect(f.left - 1, brim_y, f.right + 1, brim_y, hat)
    if f.dir != "up":
        sy = brim_y - 5
        f.put(f.cx, sy - 1, star)
        f.put(f.cx - 1, sy, star)
        f.put(f.cx, sy, star)
        f.put(f.cx + 1, sy, star)
        f.put(f.cx, sy + 1, star)
    # Long white beard over the chin and chest.
    by = f.top + 14
    if f.dir == "down":
        for k in range(9):
            w = 5 - k // 2
            if w < 1:
                break
            f.rect(f.cx - w, by + k, f.cx + w, by + k, beard)
            f.put(f.cx - w, by + k, beard_dark)
            f.put(f.cx + w, by + k, beard_dark)
    elif f.dir in ("left", "right"):
        side = -1 if f.dir == "left" else 1
        for k in range(8):
            w = 3 - k // 3
            if w < 1:
                break
            x0 = f.cx + side * 2
            f.rect(min(x0, x0 + side * w), by + k, max(x0, x0 + side * w), by + k, beard)


# ------------------------------------------------------------------ cyberpunk

def cyberpunk(f: Frame) -> None:
    hair = ramp(["#0b3b5c", "#0f7fb0", "#1fc6ff", "#7af2ff"])
    jacket = ramp(["#07070c", "#14141f", "#24243a", "#3a3a5c"])
    neon, visor = hexc("#ff2bd6"), hexc("#ff2bd6")

    def fn(x: int, y: int, p: RGBA) -> RGBA | None:
        if lum(p) < 0.14:
            return None
        if is_skin(p):
            return None
        if y < f.neck:
            return hair(lum(p))
        return jacket(lum(p))

    f.remap(fn)
    # Neon collar and a zip down the jacket (back seam when seen from behind).
    collar = f.neck + 3
    row = [x for x in range(T) if f.get(x, collar)[3]]
    for x in row[1:-1]:
        f.put(x, collar, neon)
    if f.dir in ("down", "up"):
        for y in range(collar + 1, T - 5):
            if f.get(f.cx, y)[3]:
                f.put(f.cx, y, neon)
    eye_row = f.top + 12
    if f.dir == "down":
        f.paint(f.cx - 6, eye_row - 1, f.cx + 6, eye_row, visor)
    elif f.dir == "left":
        f.paint(f.left + 1, eye_row - 1, f.cx, eye_row, visor)
    elif f.dir == "right":
        f.paint(f.cx, eye_row - 1, f.right - 1, eye_row, visor)
    else:
        f.paint(f.left + 2, eye_row - 1, f.right - 2, eye_row - 1, visor)  # visor strap


SKINS: dict[str, tuple[str, Callable[[Frame], None]]] = {
    "robot": ("f1", robot),
    "android": ("f7", android),
    "wizard": ("f4", wizard),
    "cyberpunk": ("f5", cyberpunk),
}


def build(base: str, draw: Callable[[Frame], None], folk: Image.Image) -> Image.Image:
    ox, oy = FOLK[base]
    sheet = Image.new("RGBA", (3 * T, 4 * T), (0, 0, 0, 0))
    for row, direction in enumerate(DIRS):
        for col in range(3):
            frame = folk.crop((ox + col * T, oy + row * T, ox + (col + 1) * T, oy + (row + 1) * T))
            f = Frame(frame, direction)
            draw(f)
            sheet.paste(f.img, (col * T, row * T))
    return sheet


def main() -> None:
    folk = Image.open(os.path.join(ASSETS, "32x32folk.png")).convert("RGBA")
    os.makedirs(OUT, exist_ok=True)
    for name, (base, draw) in SKINS.items():
        path = os.path.join(OUT, f"{name}.png")
        build(base, draw, folk).save(path)
        print(f"wrote {os.path.relpath(path)} (from {base})")


if __name__ == "__main__":
    main()
