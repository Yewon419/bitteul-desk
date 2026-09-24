"""Floors (16x16), wall autotile (64x128) and carpet marching-squares sheets, all grayscale.

The renderer colorizes these by luminance, so only lightness matters here.
"""

from __future__ import annotations

from PIL import Image

from common import Canvas, gray

TILE = 16

FLOOR_BASE = 170


def _floor_plain() -> Canvas:
    c = Canvas(TILE, TILE)
    c.rect(0, 0, 15, 15, gray(FLOOR_BASE))
    for x, y in ((3, 4), (11, 2), (7, 10), (13, 13), (2, 12)):
        c.put(x, y, gray(FLOOR_BASE + 8))
    return c


def _floor_big_tiles() -> Canvas:
    c = Canvas(TILE, TILE)
    c.rect(0, 0, 15, 15, gray(FLOOR_BASE))
    c.hline(0, 15, 15, gray(FLOOR_BASE - 22))
    c.vline(15, 0, 15, gray(FLOOR_BASE - 22))
    c.hline(0, 14, 0, gray(FLOOR_BASE + 14))
    c.vline(0, 0, 14, gray(FLOOR_BASE + 14))
    return c


def _floor_quad_tiles() -> Canvas:
    c = Canvas(TILE, TILE)
    c.rect(0, 0, 15, 15, gray(FLOOR_BASE))
    for k in (7, 15):
        c.hline(0, 15, k, gray(FLOOR_BASE - 20))
        c.vline(k, 0, 15, gray(FLOOR_BASE - 20))
    return c


def _floor_grout_light() -> Canvas:
    c = Canvas(TILE, TILE)
    c.rect(0, 0, 15, 15, gray(FLOOR_BASE))
    for k in (7, 15):
        c.hline(0, 15, k, gray(236))
        c.vline(k, 0, 15, gray(236))
    return c


def _floor_planks(dark_seams: bool) -> Canvas:
    c = Canvas(TILE, TILE)
    seam = gray(FLOOR_BASE - 26) if dark_seams else gray(232)
    c.rect(0, 0, 15, 15, gray(FLOOR_BASE))
    for row, joint in ((0, 5), (4, 12), (8, 2), (12, 9)):
        c.hline(0, 15, row + 3, seam)
        c.vline(joint, row, row + 2, seam)
        c.hline(0, 15, row, gray(FLOOR_BASE + 6))
    for x, y in ((2, 1), (9, 5), (13, 9), (6, 13), (11, 2)):
        c.put(x, y, gray(FLOOR_BASE - 8))
    return c


def _floor_herringbone() -> Canvas:
    c = Canvas(TILE, TILE)
    c.rect(0, 0, 15, 15, gray(FLOOR_BASE))
    seam = gray(FLOOR_BASE - 24)
    for i in range(0, 16, 4):
        for d in range(4):
            c.put((i + d) % 16, d, seam)
            c.put((i + d) % 16, 8 + d, seam)
            c.put((i + 3 - d + 2) % 16, 4 + d, seam)
            c.put((i + 3 - d + 2) % 16, 12 + d, seam)
    return c


def _floor_checker(cell: int, light: int, dark: int) -> Canvas:
    c = Canvas(TILE, TILE)
    for y in range(TILE):
        for x in range(TILE):
            on = ((x // cell) + (y // cell)) % 2 == 0
            c.put(x, y, gray(light if on else dark))
    return c


def floor_tiles() -> list[Image.Image]:
    tiles = [
        _floor_plain(),
        _floor_big_tiles(),
        _floor_quad_tiles(),
        _floor_grout_light(),
        _floor_planks(dark_seams=False),
        _floor_herringbone(),
        _floor_planks(dark_seams=True),
        _floor_checker(4, 236, 110),
        _floor_checker(8, 236, 150),
    ]
    return [t.to_image() for t in tiles]


WALL_EDGE = gray(52)
WALL_CAP = gray(196)
WALL_CAP_HI = gray(214)
WALL_FACE = gray(248)
WALL_TRIM = gray(226)
WALL_PANEL = gray(234)
WALL_BASE = gray(182)

N, E, S, W = 1, 2, 4, 8


def _wall_piece(mask: int) -> Canvas:
    c = Canvas(16, 32)
    has_s = bool(mask & S)
    cap_bottom = 31 if has_s else 7
    c.rect(0, 0, 15, cap_bottom, WALL_CAP)
    c.hline(0, 15, 1, WALL_CAP_HI)
    if not mask & N:
        c.hline(0, 15, 0, WALL_EDGE)
    if not has_s:
        c.rect(0, 8, 15, 31, WALL_FACE)
        c.hline(0, 15, 8, WALL_TRIM)
        c.hline(0, 15, 21, WALL_TRIM)
        c.rect(0, 22, 15, 29, WALL_PANEL)
        for x in (3, 11):
            c.vline(x, 23, 28, WALL_TRIM)
        c.hline(0, 15, 30, WALL_BASE)
        c.hline(0, 15, 31, WALL_EDGE)
    if not mask & W:
        c.vline(0, 0, 31, WALL_EDGE)
    if not mask & E:
        c.vline(15, 0, 31, WALL_EDGE)
    if mask & N and mask & W:
        c.put(0, 0, WALL_EDGE)
    if mask & N and mask & E:
        c.put(15, 0, WALL_EDGE)
    return c


def wall_sheet() -> Image.Image:
    sheet = Image.new("RGBA", (64, 128), (0, 0, 0, 0))
    for mask in range(16):
        sheet.alpha_composite(
            _wall_piece(mask).to_image(), ((mask % 4) * 16, (mask // 4) * 32)
        )
    return sheet


CARPET_MAIN = gray(100)
CARPET_ACCENT = gray(200)

NW, NE, SE, SW = 1, 2, 4, 8
QUADS = ((NW, 0, 0), (NE, 8, 0), (SE, 8, 8), (SW, 0, 8))


def _inside(mask: int, x: int, y: int) -> bool:
    for bit, qx, qy in QUADS:
        if mask & bit and qx <= x < qx + 8 and qy <= y < qy + 8:
            return True
    return False


def _carpet_piece(mask: int, style: int) -> Canvas:
    c = Canvas(TILE, TILE)
    for y in range(TILE):
        for x in range(TILE):
            if not _inside(mask, x, y):
                continue
            ring = min(
                _edge_distance(mask, x, y, dx, dy)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
            )
            if ring == 2:
                c.put(x, y, CARPET_ACCENT)
            elif style == 1 and ring > 3 and (x + y) % 4 == 0:
                c.put(x, y, CARPET_ACCENT)
            elif style == 2 and ring > 3 and x % 4 == 2 and y % 4 == 2:
                c.put(x, y, CARPET_ACCENT)
            else:
                c.put(x, y, CARPET_MAIN)
    return c


def _edge_distance(mask: int, x: int, y: int, dx: int, dy: int) -> int:
    """Pixels until leaving the carpet in one direction; neighbours outside the tile count as carpet."""
    d = 0
    cx, cy = x, y
    while 0 <= cx < TILE and 0 <= cy < TILE and _inside(mask, cx, cy):
        d += 1
        cx += dx
        cy += dy
        if d > 6:
            return 99
    if not (0 <= cx < TILE and 0 <= cy < TILE):
        return 99
    return d


def carpet_sheets() -> list[Image.Image]:
    out: list[Image.Image] = []
    for style in range(3):
        sheet = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        for mask in range(16):
            sheet.alpha_composite(
                _carpet_piece(mask, style).to_image(),
                ((mask % 4) * 16, (mask // 4) * 16),
            )
        out.append(sheet)
    return out
