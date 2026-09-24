"""Bitteul Company furniture: same ids, sizes and footprints as the upstream manifests.

Every piece is built as shaded parts (see shading.py) so it matches the android staff.
Coordinates are interior pixels; the renderer adds a 1px outline around the silhouette.
"""

from __future__ import annotations

from collections.abc import Callable

from PIL import Image

from common import Color, hex_color
from shading import Material, Model, paint, render, with_alpha

OUTLINE = hex_color("#16233A")

OAK = Material(
    hex_color("#F6E6C8"),
    hex_color("#E8CFA6"),
    hex_color("#D4B587"),
    hex_color("#B9976A"),
)
SHELL = Material(
    hex_color("#FFFFFF"),
    hex_color("#EEF4F9"),
    hex_color("#CFDDE9"),
    hex_color("#A9BDCF"),
)
PALE = Material(
    hex_color("#F2F9FE"),
    hex_color("#DDEEF9"),
    hex_color("#C3DCEE"),
    hex_color("#A2C3DC"),
)
METAL = Material(
    hex_color("#6D7D93"),
    hex_color("#4A586C"),
    hex_color("#39465A"),
    hex_color("#2A3547"),
)
SCREEN = Material(
    hex_color("#2B527C"),
    hex_color("#12243E"),
    hex_color("#0E1D33"),
    hex_color("#0A1628"),
)
FABRIC = paint(hex_color("#2B86C5"))
FABRIC_DEEP = paint(hex_color("#1F6A9E"))
LEAF = paint(hex_color("#5FA07D"))
LEAF_DARK = paint(hex_color("#4A8768"))
CACTUS_GREEN = paint(hex_color("#6AAE7E"))
TRUNK = paint(hex_color("#A98A63"))
SOIL = paint(hex_color("#6B5646"))
BUTTER = hex_color("#FFD166")
CYAN = hex_color("#5FE3FF")
WHITE = hex_color("#FFFFFF")
SKY = hex_color("#BFE0F5")
CERULEAN = hex_color("#2B86C5")
MINT = hex_color("#5CC4A8")
CORAL = hex_color("#FF8A7A")
PINK = hex_color("#FF9EC4")
SEA = hex_color("#3F9BD6")
SEA_DEEP = hex_color("#2779B3")
SAND = hex_color("#F3E3BF")
SKY_PALE = hex_color("#D8EEFA")
GRAIN = with_alpha(hex_color("#B9976A"), 110)

BOOKS: tuple[Material, ...] = (
    paint(CERULEAN),
    SHELL,
    paint(hex_color("#1F6A9E")),
    paint(BUTTER),
    paint(SKY),
    paint(CORAL),
    paint(hex_color("#4FA3D9")),
    paint(MINT),
)

Sprite = Callable[[], Image.Image]


def _done(m: Model) -> Image.Image:
    return render(m, OUTLINE).to_image()


def _grain(m: Model, x0: int, x1: int, rows: range) -> None:
    for i, y in enumerate(rows):
        start = x0 + 2 + (i * 5) % 7
        end = x1 - 3 - (i * 3) % 6
        for x in range(start, end):
            m.detail(x, y, GRAIN)


def _led_strip(m: Model, x0: int, x1: int, y: int) -> None:
    for x in range(x0, x1 + 1):
        m.detail(x, y, with_alpha(CYAN, 170))


# ── Tables ────────────────────────────────────────────────────────────


def desk_front() -> Image.Image:
    m = Model(48, 32)
    m.rect(3, 12, 44, 25, OAK, "top")
    m.rect(3, 26, 44, 27, SHELL, "apron")
    for x in (4, 42):
        m.rect(x, 28, x + 1, 30, METAL, f"leg{x}")
    _grain(m, 3, 44, range(15, 25, 3))
    _led_strip(m, 8, 39, 27)
    return _done(m)


def desk_side() -> Image.Image:
    m = Model(16, 64)
    m.rect(2, 12, 13, 54, OAK, "top")
    m.rect(2, 55, 13, 56, SHELL, "apron")
    for x in (3, 11):
        m.rect(x, 57, x + 1, 59, METAL, f"leg{x}")
    for y0 in (17, 29, 41):
        for y in range(y0, y0 + 6):
            m.detail(6 + (y0 // 6) % 3, y, GRAIN)
    _led_strip(m, 4, 11, 56)
    return _done(m)


def small_table_front() -> Image.Image:
    m = Model(32, 32)
    m.rect(1, 12, 30, 25, OAK, "top")
    m.rect(1, 26, 30, 27, SHELL, "apron")
    for x in (2, 28):
        m.rect(x, 28, x + 1, 30, METAL, f"leg{x}")
    _grain(m, 1, 30, range(15, 25, 3))
    return _done(m)


def small_table_side() -> Image.Image:
    m = Model(16, 48)
    m.rect(1, 11, 14, 40, OAK, "top")
    m.rect(1, 41, 14, 42, SHELL, "apron")
    for x in (2, 12):
        m.rect(x, 43, x + 1, 46, METAL, f"leg{x}")
    for y0 in (15, 27):
        for y in range(y0, y0 + 6):
            m.detail(7, y, GRAIN)
    return _done(m)


def table_front() -> Image.Image:
    m = Model(48, 64)
    m.rect(1, 12, 46, 57, OAK, "top")
    m.rect(1, 58, 46, 59, SHELL, "apron")
    for x in (2, 44):
        m.rect(x, 60, x + 1, 62, METAL, f"leg{x}")
    _grain(m, 1, 46, range(15, 57, 4))
    for y in range(27, 43):
        for x in range(15, 33):
            border = x in (15, 32) or y in (27, 42)
            m.detail(x, y, with_alpha(CYAN, 190 if border else 45))
    for x, y in ((18, 30), (19, 30), (20, 30), (18, 32), (19, 32), (24, 34), (25, 33)):
        m.detail(x, y, with_alpha(WHITE, 200))
    _led_strip(m, 6, 41, 59)
    return _done(m)


def coffee_table() -> Image.Image:
    m = Model(32, 32)
    m.rect(5, 7, 26, 7, SHELL, "top")
    m.rect(4, 8, 27, 8, SHELL, "top")
    m.rect(3, 9, 28, 20, SHELL, "top")
    m.rect(4, 21, 27, 21, SHELL, "top")
    m.rect(4, 22, 27, 23, PALE, "rim")
    for x in (6, 25):
        m.rect(x, 24, x, 28, METAL, f"leg{x}")
    for x, y in ((9, 12), (10, 13), (11, 13), (20, 16), (21, 17)):
        m.detail(x, y, with_alpha(SKY, 200))
    m.rect(17, 11, 21, 14, FABRIC, "book")
    m.rounded(9, 16, 12, 19, paint(CERULEAN), "mug")
    m.detail(10, 16, WHITE)
    return _done(m)


# ── Computer ──────────────────────────────────────────────────────────

CODE_LINES: tuple[tuple[int, int, Color], ...] = (
    (4, 5, CYAN),
    (4, 7, BUTTER),
    (5, 4, WHITE),
    (4, 6, CYAN),
    (6, 4, MINT),
    (4, 3, PINK),
)


def _monitor(m: Model) -> None:
    m.rounded(2, 4, 13, 15, SHELL, "bezel")
    m.rect(3, 5, 12, 13, SCREEN, "screen")
    m.rect(7, 16, 8, 17, METAL, "stand")
    m.rect(5, 18, 10, 18, SHELL, "base")
    m.rect(1, 20, 10, 21, SHELL, "keys")
    m.rounded(12, 20, 14, 21, SHELL, "mouse")
    for x in range(2, 10, 2):
        m.detail(x, 21, with_alpha(hex_color("#A9BDCF"), 200))


def pc_front(frame: int | None) -> Image.Image:
    m = Model(16, 32)
    _monitor(m)
    if frame is None:
        m.detail(4, 6, with_alpha(WHITE, 60))
        m.detail(5, 6, with_alpha(WHITE, 40))
        m.detail(4, 7, with_alpha(WHITE, 40))
        return _done(m)
    for i in range(4):
        x0, length, col = CODE_LINES[(i + frame) % len(CODE_LINES)]
        for x in range(x0, min(12, x0 + length)):
            m.detail(x, 6 + i * 2, col)
    m.detail(4 + (frame * 3) % 7, 12, WHITE)
    m.detail(12, 5, with_alpha(WHITE, 90))
    m.detail(11, 5, with_alpha(WHITE, 50))
    m.detail(8, 19, with_alpha(CYAN, 140))
    m.detail(7, 19, with_alpha(CYAN, 140))
    return _done(m)


def pc_back() -> Image.Image:
    m = Model(16, 32)
    m.rounded(2, 6, 13, 16, SHELL, "back")
    m.rect(7, 17, 8, 19, METAL, "stand")
    m.rect(5, 20, 10, 20, SHELL, "base")
    m.rounded(6, 9, 9, 12, paint(CERULEAN), "logo")
    return _done(m)


def pc_side() -> Image.Image:
    m = Model(16, 32)
    m.rect(4, 4, 5, 15, SHELL, "panel")
    m.rect(6, 10, 8, 11, METAL, "arm")
    m.rect(8, 12, 8, 17, METAL, "post")
    m.rect(5, 18, 10, 18, SHELL, "base")
    m.rect(1, 20, 8, 20, SHELL, "keys")
    for y in range(5, 15):
        m.detail(3, y, with_alpha(CYAN, 110))
    return _done(m)


# ── Seating ───────────────────────────────────────────────────────────


def _chair_base(m: Model, y: int) -> None:
    m.rect(7, y, 8, y + 3, METAL, "stem")
    m.rect(4, y + 4, 11, y + 4, METAL, "star")
    m.detail(4, y + 5, hex_color("#2A3547"))
    m.detail(11, y + 5, hex_color("#2A3547"))


def chair_front() -> Image.Image:
    m = Model(16, 32)
    m.rounded(4, 10, 11, 18, SHELL, "backrest")
    m.rounded(3, 19, 12, 22, FABRIC, "seat")
    _chair_base(m, 23)
    m.detail(6, 12, with_alpha(CYAN, 150))
    m.detail(9, 12, with_alpha(CYAN, 150))
    return _done(m)


def chair_back() -> Image.Image:
    m = Model(16, 32)
    m.rounded(3, 21, 12, 23, FABRIC, "seat")
    m.rounded(4, 14, 11, 23, SHELL, "backrest")
    for x in range(6, 10):
        m.detail(x, 17, with_alpha(CYAN, 150))
    _chair_base(m, 24)
    return _done(m)


def chair_side() -> Image.Image:
    m = Model(16, 32)
    m.rounded(2, 10, 4, 21, SHELL, "backrest")
    m.rounded(3, 19, 11, 22, FABRIC, "seat")
    _chair_base(m, 23)
    return _done(m)


def lounge_chair_front() -> Image.Image:
    m = Model(16, 16)
    m.rounded(2, 1, 13, 12, SHELL, "shell")
    m.rounded(4, 3, 11, 11, FABRIC, "cushion")
    m.rect(4, 13, 4, 14, METAL, "legL")
    m.rect(11, 13, 11, 14, METAL, "legR")
    return _done(m)


def lounge_chair_back() -> Image.Image:
    m = Model(16, 16)
    m.rounded(2, 3, 13, 13, SHELL, "shell")
    m.rect(4, 14, 4, 14, METAL, "legL")
    m.rect(11, 14, 11, 14, METAL, "legR")
    for x in range(5, 11):
        m.detail(x, 6, with_alpha(CYAN, 130))
    return _done(m)


def lounge_chair_side() -> Image.Image:
    m = Model(16, 16)
    m.rounded(1, 1, 4, 12, SHELL, "shell")
    m.rounded(3, 6, 11, 12, SHELL, "seatShell")
    m.rounded(4, 5, 10, 9, FABRIC, "cushion")
    m.rect(3, 13, 3, 14, METAL, "legL")
    m.rect(10, 13, 10, 14, METAL, "legR")
    return _done(m)


def pouf() -> Image.Image:
    m = Model(16, 16)
    m.blob(7.5, 9, 5.2, 4.6, FABRIC, "pouf")
    m.detail(7, 8, with_alpha(WHITE, 160))
    m.detail(8, 8, with_alpha(WHITE, 160))
    return _done(m)


def stool() -> Image.Image:
    m = Model(16, 16)
    m.rounded(3, 4, 12, 8, OAK, "seat")
    for x in (4, 11):
        m.rect(x, 9, x, 14, METAL, f"leg{x}")
    m.rect(5, 12, 10, 12, METAL, "rung")
    return _done(m)


def sofa_front() -> Image.Image:
    m = Model(32, 16)
    m.rounded(1, 1, 30, 6, FABRIC_DEEP, "back")
    m.rounded(1, 4, 3, 12, FABRIC_DEEP, "armL")
    m.rounded(28, 4, 30, 12, FABRIC_DEEP, "armR")
    m.rounded(4, 7, 15, 11, FABRIC, "seatL")
    m.rounded(16, 7, 27, 11, FABRIC, "seatR")
    m.rect(2, 12, 29, 12, SHELL, "plinth")
    m.rounded(5, 3, 9, 7, SHELL, "pillow")
    m.detail(7, 5, BUTTER)
    m.detail(3, 14, hex_color("#2A3547"))
    m.detail(28, 14, hex_color("#2A3547"))
    return _done(m)


def sofa_back() -> Image.Image:
    m = Model(32, 16)
    m.rounded(1, 3, 30, 12, FABRIC_DEEP, "back")
    m.rect(2, 13, 29, 13, SHELL, "plinth")
    for x in range(4, 28):
        m.detail(x, 6, with_alpha(hex_color("#4FA3D9"), 120))
    return _done(m)


def sofa_side() -> Image.Image:
    m = Model(16, 32)
    m.rounded(1, 2, 4, 29, FABRIC_DEEP, "back")
    m.rounded(3, 2, 12, 5, FABRIC_DEEP, "armTop")
    m.rounded(3, 26, 12, 29, FABRIC_DEEP, "armBottom")
    m.rounded(5, 6, 11, 15, FABRIC, "seatA")
    m.rounded(5, 16, 11, 25, FABRIC, "seatB")
    m.rect(12, 6, 12, 25, SHELL, "plinth")
    return _done(m)


# ── Shelves & wall items ──────────────────────────────────────────────


def _books(m: Model, x0: int, x1: int, board_y: int, seed: int) -> None:
    x = x0
    i = seed
    while x <= x1 - 1:
        if (i * 5) % 11 == 3 and x + 3 <= x1:
            m.rect(x, board_y - 3, x + 2, board_y - 1, SHELL, f"pot{x}")
            m.blob(x + 1, board_y - 5, 1.8, 1.6, LEAF, f"leaf{x}")
            x += 4
        else:
            h = 5 + (i * 7) % 3
            w = 2 if i % 3 else 1
            m.rect(
                x, board_y - h, min(x1, x + w - 1), board_y - 1, BOOKS[i % 8], f"b{x}"
            )
            x += w
        i += 1


def bookshelf() -> Image.Image:
    m = Model(32, 16)
    _books(m, 1, 30, 11, 1)
    m.rect(0, 11, 31, 12, SHELL, "board")
    _led_strip(m, 2, 29, 12)
    return _done(m)


def double_bookshelf() -> Image.Image:
    m = Model(32, 32)
    m.rect(1, 6, 30, 22, PALE, "cabinet")
    _books(m, 2, 29, 13, 2)
    _books(m, 2, 29, 21, 5)
    m.rect(1, 13, 30, 13, SHELL, "board1")
    m.rect(1, 21, 30, 22, SHELL, "board2")
    return _done(m)


def clock() -> Image.Image:
    m = Model(16, 32)
    m.blob(7.5, 16, 5.0, 5.0, paint(CERULEAN), "rim")
    m.blob(7.5, 16, 3.9, 3.9, SHELL, "face")
    for x, y in ((7, 13), (11, 16), (7, 19), (4, 16), (8, 13), (8, 19)):
        m.detail(x, y, with_alpha(SKY, 255))
    for y in (14, 15, 16):
        m.detail(7, y, OUTLINE)
    for x in (8, 9, 10):
        m.detail(x, 16, OUTLINE)
    m.detail(7, 16, CORAL)
    return _done(m)


def whiteboard() -> Image.Image:
    m = Model(32, 32)
    m.rect(3, 9, 28, 21, SHELL, "board")
    m.rect(3, 22, 28, 22, METAL, "tray")
    pts = ((5, 19), (8, 18), (11, 18), (14, 16), (17, 16), (20, 13), (23, 11))
    for (xa, ya), (xb, yb) in zip(pts, pts[1:], strict=False):
        for x in range(xa, xb + 1):
            t = (x - xa) / max(1, xb - xa)
            m.detail(x, round(ya + (yb - ya) * t), CERULEAN)
    for x, y in ((22, 10), (23, 10), (23, 12)):
        m.detail(x, y, CERULEAN)
    for x in range(5, 25):
        m.detail(x, 20, with_alpha(SKY, 255))
    for y in range(11, 20):
        m.detail(5, y, with_alpha(SKY, 255))
    for x in range(6, 12):
        m.detail(x, 11, OUTLINE)
    for x in range(6, 10):
        m.detail(x, 13, with_alpha(SKY, 255))
    for y in range(11, 15):
        for x in range(24, 28):
            m.detail(x, y, BUTTER)
    for x in range(25, 27):
        m.detail(x, 13, hex_color("#C99A2E"))
    m.detail(24, 22, CORAL)
    m.detail(25, 22, CORAL)
    return _done(m)


def _frame(m: Model, x0: int, y0: int, x1: int, y1: int) -> None:
    m.rect(x0, y0, x1, y1, SHELL, "frame")


def large_painting() -> Image.Image:
    m = Model(32, 32)
    _frame(m, 3, 13, 28, 25)
    for y in range(15, 24):
        for x in range(5, 27):
            if y <= 16:
                col = SKY
            elif y <= 19:
                col = SKY_PALE
            elif y <= 21:
                col = SEA if y == 21 else SEA_DEEP
            else:
                col = SAND
            m.detail(x, y, col)
    for x in range(21, 24):
        for y in range(16, 19):
            m.detail(x, y, BUTTER)
    for x in range(8, 13):
        m.detail(x, 17, WHITE)
    for x in range(9, 15):
        m.detail(x, 18, WHITE)
    for x in (7, 8, 16, 17, 18):
        m.detail(x, 21, hex_color("#8FD0F5"))
    return _done(m)


def small_painting_sky() -> Image.Image:
    m = Model(16, 32)
    _frame(m, 3, 13, 12, 25)
    for y in range(15, 24):
        for x in range(5, 11):
            m.detail(x, y, CERULEAN if y < 17 else hex_color("#4FA3D9"))
    for x in range(5, 9):
        m.detail(x, 19, WHITE)
    for x in range(6, 10):
        m.detail(x, 18, WHITE)
    m.detail(9, 15, BUTTER)
    m.detail(9, 16, BUTTER)
    return _done(m)


def small_painting_palm() -> Image.Image:
    m = Model(16, 32)
    _frame(m, 3, 13, 12, 25)
    for y in range(15, 24):
        for x in range(5, 11):
            col = SKY_PALE if y < 21 else (SEA if y == 21 else SAND)
            m.detail(x, y, col)
    for y in range(17, 23):
        m.detail(8, y, hex_color("#A98A63"))
    for x in range(5, 11):
        m.detail(x, 16, hex_color("#5FA07D"))
    m.detail(6, 17, hex_color("#5FA07D"))
    m.detail(10, 17, hex_color("#5FA07D"))
    return _done(m)


# ── Plants & small items ──────────────────────────────────────────────


def _pot(m: Model, x0: int, y0: int, x1: int, y1: int, mat: Material) -> None:
    m.rect(x0, y0, x1, y0, mat, "potRim")
    m.rect(x0 + 1, y0 + 1, x1 - 1, y1, mat, "pot")


def plant_monstera() -> Image.Image:
    m = Model(16, 32)
    m.rect(7, 13, 7, 21, LEAF_DARK, "stem1")
    m.rect(9, 16, 9, 21, LEAF_DARK, "stem2")
    leaves = (
        (4, 9, 3.2, 2.6),
        (11, 6, 3.4, 2.8),
        (5, 15, 2.8, 2.3),
        (11, 13, 3.0, 2.5),
        (8, 3, 2.6, 2.2),
    )
    for i, (cx, cy, rx, ry) in enumerate(leaves):
        m.blob(cx, cy, rx, ry, LEAF if i % 2 else LEAF_DARK, f"leaf{i}")
        m.detail(round(cx), round(cy), with_alpha(hex_color("#2F5E48"), 160))
    _pot(m, 3, 22, 12, 29, SHELL)
    m.rect(5, 22, 10, 22, SOIL, "soil")
    return _done(m)


def plant_snake() -> Image.Image:
    m = Model(16, 32)
    for i, (x, top) in enumerate(((4, 7), (6, 3), (8, 5), (10, 9), (5, 11), (11, 13))):
        m.rect(x, top, x + 1, 21, LEAF if i % 2 else LEAF_DARK, f"blade{i}")
        m.detail(x, top + 4, with_alpha(hex_color("#C9E6A0"), 200))
        m.detail(x + 1, top + 8, with_alpha(hex_color("#C9E6A0"), 160))
    _pot(m, 3, 22, 12, 29, paint(CERULEAN))
    for x in range(5, 11):
        m.detail(x, 25, with_alpha(WHITE, 200))
    return _done(m)


def cactus() -> Image.Image:
    m = Model(16, 32)
    m.rounded(6, 4, 9, 21, CACTUS_GREEN, "trunk")
    m.rounded(2, 10, 4, 15, CACTUS_GREEN, "armL")
    m.rect(5, 13, 5, 14, CACTUS_GREEN, "joinL")
    m.rounded(11, 7, 13, 12, CACTUS_GREEN, "armR")
    m.rect(10, 11, 10, 12, CACTUS_GREEN, "joinR")
    m.rect(7, 2, 8, 3, paint(PINK), "flower")
    for x, y in ((7, 8), (8, 12), (7, 16), (3, 12), (12, 9)):
        m.detail(x, y, with_alpha(WHITE, 220))
    _pot(m, 3, 22, 12, 29, SHELL)
    for x in range(5, 11):
        m.detail(x, 26, CERULEAN)
    return _done(m)


def large_plant() -> Image.Image:
    m = Model(32, 48)
    m.rect(15, 16, 16, 35, TRUNK, "trunk")
    leaves = (
        (11, 11, 3.6, 3.0),
        (20, 10, 4.0, 3.0),
        (8, 18, 4.0, 3.0),
        (23, 17, 4.2, 3.0),
        (15, 16, 4.2, 3.2),
        (9, 25, 3.4, 2.6),
        (22, 24, 3.4, 2.6),
        (16, 6, 3.8, 2.8),
        (4, 13, 2.8, 2.4),
        (27, 12, 2.8, 2.4),
        (15, 26, 3.0, 2.4),
    )
    for i, (cx, cy, rx, ry) in enumerate(leaves):
        m.blob(cx, cy, rx, ry, LEAF if i % 2 else LEAF_DARK, f"leaf{i}")
    _pot(m, 8, 35, 23, 45, SHELL)
    m.rect(10, 35, 21, 35, SOIL, "soil")
    for x in range(10, 22):
        m.detail(x, 40, with_alpha(CERULEAN, 230))
    return _done(m)


def hanging_plant() -> Image.Image:
    m = Model(16, 32)
    m.rect(7, 1, 8, 4, METAL, "hook")
    for i, (x, y0, y1) in enumerate(
        ((2, 10, 24), (5, 11, 29), (10, 11, 26), (13, 9, 20))
    ):
        for y in range(y0, y1 + 1, 2):
            m.blob(
                x + (1 if (y // 4) % 2 else 0),
                y,
                1.3,
                1.0,
                LEAF if i % 2 else LEAF_DARK,
                f"v{i}_{y}",
            )
    for i, (cx, cy) in enumerate(((3, 6), (12, 6), (6, 5), (10, 5))):
        m.blob(cx, cy, 1.9, 1.6, LEAF, f"top{i}")
    _pot(m, 3, 5, 12, 10, SHELL)
    for x in range(5, 11):
        m.detail(x, 8, with_alpha(CERULEAN, 230))
    return _done(m)


def small_pot() -> Image.Image:
    m = Model(16, 16)
    for i, (cx, cy) in enumerate(((5, 5), (10, 5), (7.5, 3.5), (4, 7.5), (11, 7.5))):
        m.blob(cx, cy, 1.9, 1.6, LEAF if i % 2 else LEAF_DARK, f"s{i}")
    _pot(m, 3, 9, 12, 14, SHELL)
    for x in range(5, 11):
        m.detail(x, 12, with_alpha(SKY, 255))
    return _done(m)


def trash_bin() -> Image.Image:
    m = Model(16, 16)
    m.rect(4, 3, 11, 4, METAL, "lid")
    m.rect(4, 5, 11, 14, SHELL, "bin")
    m.rect(4, 9, 11, 10, paint(CERULEAN), "band")
    m.detail(9, 4, with_alpha(CYAN, 200))
    return _done(m)


def tumbler() -> Image.Image:
    m = Model(16, 16)
    m.rect(10, 1, 13, 1, SHELL, "lid")
    m.rect(10, 2, 13, 6, paint(CERULEAN), "cup")
    for x in range(10, 14):
        m.detail(x, 4, with_alpha(WHITE, 220))
    return _done(m)


FURNITURE: dict[str, Sprite] = {
    "BIN/BIN": trash_bin,
    "BOOKSHELF/BOOKSHELF": bookshelf,
    "CACTUS/CACTUS": cactus,
    "CLOCK/CLOCK": clock,
    "COFFEE/COFFEE": tumbler,
    "COFFEE_TABLE/COFFEE_TABLE": coffee_table,
    "CUSHIONED_BENCH/CUSHIONED_BENCH": pouf,
    "CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT": lounge_chair_front,
    "CUSHIONED_CHAIR/CUSHIONED_CHAIR_BACK": lounge_chair_back,
    "CUSHIONED_CHAIR/CUSHIONED_CHAIR_SIDE": lounge_chair_side,
    "DESK/DESK_FRONT": desk_front,
    "DESK/DESK_SIDE": desk_side,
    "DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF": double_bookshelf,
    "HANGING_PLANT/HANGING_PLANT": hanging_plant,
    "LARGE_PAINTING/LARGE_PAINTING": large_painting,
    "LARGE_PLANT/LARGE_PLANT": large_plant,
    "PC/PC_FRONT_OFF": lambda: pc_front(None),
    "PC/PC_FRONT_ON_1": lambda: pc_front(0),
    "PC/PC_FRONT_ON_2": lambda: pc_front(1),
    "PC/PC_FRONT_ON_3": lambda: pc_front(2),
    "PC/PC_BACK": pc_back,
    "PC/PC_SIDE": pc_side,
    "PLANT/PLANT": plant_monstera,
    "PLANT_2/PLANT_2": plant_snake,
    "POT/POT": small_pot,
    "SMALL_PAINTING/SMALL_PAINTING": small_painting_sky,
    "SMALL_PAINTING_2/SMALL_PAINTING_2": small_painting_palm,
    "SMALL_TABLE/SMALL_TABLE_FRONT": small_table_front,
    "SMALL_TABLE/SMALL_TABLE_SIDE": small_table_side,
    "SOFA/SOFA_FRONT": sofa_front,
    "SOFA/SOFA_BACK": sofa_back,
    "SOFA/SOFA_SIDE": sofa_side,
    "TABLE_FRONT/TABLE_FRONT": table_front,
    "WHITEBOARD/WHITEBOARD": whiteboard,
    "WOODEN_BENCH/WOODEN_BENCH": stool,
    "WOODEN_CHAIR/WOODEN_CHAIR_FRONT": chair_front,
    "WOODEN_CHAIR/WOODEN_CHAIR_BACK": chair_back,
    "WOODEN_CHAIR/WOODEN_CHAIR_SIDE": chair_side,
}


def furniture_images() -> dict[str, Image.Image]:
    return {key: build() for key, build in FURNITURE.items()}
