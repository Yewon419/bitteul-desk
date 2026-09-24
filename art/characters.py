"""Bitteul Company AI staff: six futuristic androids, 112x96 sheets (7 frames x down/up/right).

Frame order per row: walk0, walk1 (idle pose), walk2, type0, type1, read0, read1.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from PIL import Image

from common import Color, hex_color
from shading import Material, Model, emissive, paint, render, with_alpha

FRAME_W = 16
FRAME_H = 32
FRAMES = 7

OUTLINE = hex_color("#111B2B")

ARMOR_WHITE = Material(
    hex_color("#FFFFFF"),
    hex_color("#E6EFF6"),
    hex_color("#BACCDC"),
    hex_color("#8FA5BA"),
)
ARMOR_SKY = Material(
    hex_color("#F4FBFF"),
    hex_color("#CFE6F6"),
    hex_color("#9FC4E0"),
    hex_color("#7AA3C4"),
)
ARMOR_GRAPHITE = Material(
    hex_color("#7C8DA4"),
    hex_color("#55657B"),
    hex_color("#3E4B60"),
    hex_color("#2C3749"),
)
SUIT = Material(
    hex_color("#5A6980"),
    hex_color("#3B4759"),
    hex_color("#2C3646"),
    hex_color("#212938"),
)
VISOR = Material(
    hex_color("#34618F"),
    hex_color("#10203A"),
    hex_color("#0C182C"),
    hex_color("#09121F"),
)


class Eyes(Enum):
    BAR = "bar"
    MONO = "mono"
    TWIN_ROUND = "twin_round"
    HAPPY = "happy"
    SLIT = "slit"
    TWIN = "twin"


class Crown(Enum):
    FIN = "fin"
    ANTENNA = "antenna"
    ANTENNAS = "antennas"
    HALO = "halo"
    CREST = "crest"
    HEADSET = "headset"


class Facing(Enum):
    DOWN = 0
    UP = 1
    RIGHT = 2


@dataclass(frozen=True)
class Variant:
    armor: Material
    accent: Color
    light: Color
    eyes: Eyes
    crown: Crown

    @property
    def paint(self) -> Material:
        return paint(self.accent)

    @property
    def emit(self) -> Material:
        return emissive(self.light)


VARIANTS: tuple[Variant, ...] = (
    Variant(
        ARMOR_WHITE, hex_color("#2B86C5"), hex_color("#5FE3FF"), Eyes.BAR, Crown.FIN
    ),
    Variant(
        ARMOR_GRAPHITE,
        hex_color("#F0715E"),
        hex_color("#FF9A7A"),
        Eyes.MONO,
        Crown.ANTENNA,
    ),
    Variant(
        ARMOR_WHITE,
        hex_color("#35B08F"),
        hex_color("#6FFFD2"),
        Eyes.TWIN_ROUND,
        Crown.ANTENNAS,
    ),
    Variant(
        ARMOR_SKY, hex_color("#2779B3"), hex_color("#FF8FD0"), Eyes.HAPPY, Crown.HALO
    ),
    Variant(
        ARMOR_GRAPHITE,
        hex_color("#7F63F0"),
        hex_color("#B9A2FF"),
        Eyes.SLIT,
        Crown.CREST,
    ),
    Variant(
        ARMOR_WHITE,
        hex_color("#E3A72E"),
        hex_color("#FFD166"),
        Eyes.TWIN,
        Crown.HEADSET,
    ),
)

STEP = {0: 1, 1: 0, 2: -1}


# ── Head ──────────────────────────────────────────────────────────────


def _eyes_front(m: Model, v: Variant, hy: int) -> None:
    e = v.emit
    row = hy + 4
    if v.eyes is Eyes.BAR:
        m.hrun(5, 10, row, e, "eye")
    elif v.eyes is Eyes.MONO:
        m.rect(7, row - 1, 8, row, e, "eye")
    elif v.eyes is Eyes.TWIN_ROUND:
        m.rect(5, row - 1, 6, row, e, "eyeL")
        m.rect(9, row - 1, 10, row, e, "eyeR")
    elif v.eyes is Eyes.HAPPY:
        for x in (5, 7, 8, 10):
            m.fill(x, row, e, f"eye{x}")
        m.fill(6, row - 1, e, "eyeL")
        m.fill(9, row - 1, e, "eyeR")
    elif v.eyes is Eyes.SLIT:
        m.hrun(4, 11, row, e, "eye")
    else:
        m.hrun(5, 6, row, e, "eyeL")
        m.hrun(9, 10, row, e, "eyeR")


def _crown(m: Model, v: Variant, facing: Facing, hy: int) -> None:
    p = v.paint
    e = v.emit
    side = facing is Facing.RIGHT
    if v.crown is Crown.FIN:
        if side:
            m.rect(6, hy - 2, 8, hy - 1, p, "fin")
            m.fill(6, hy - 3, p, "fin")
        else:
            m.rect(7, hy - 3, 8, hy - 1, p, "fin")
    elif v.crown is Crown.ANTENNA:
        ax = 8 if side else 7
        m.rect(ax, hy - 2, ax, hy - 1, SUIT, "ant")
        m.rect(ax, hy - 4, ax + 1, hy - 3, e, "antTip")
        m.glow(ax - 1, hy - 4, with_alpha(v.light, 90))
        m.glow(ax + 2, hy - 3, with_alpha(v.light, 90))
    elif v.crown is Crown.ANTENNAS:
        xs = (6, 10) if side else (5, 10)
        for i, ax in enumerate(xs):
            m.rect(ax, hy - 2, ax, hy - 1, SUIT, f"ant{i}")
            m.fill(ax, hy - 3, e, f"tip{i}")
            m.glow(ax, hy - 4, with_alpha(v.light, 110))
    elif v.crown is Crown.HALO:
        x0, x1 = (6, 10) if side else (5, 10)
        ring = with_alpha(v.light, 235)
        soft = with_alpha(v.light, 80)
        for x in range(x0 + 1, x1):
            m.glow(x, hy - 4, ring)
            m.glow(x, hy - 2, ring)
            m.glow(x, hy - 5, soft)
        m.glow(x0, hy - 3, ring)
        m.glow(x1, hy - 3, ring)
    elif v.crown is Crown.CREST:
        if side:
            m.rect(5, hy - 1, 8, hy - 1, p, "crest")
            m.rect(5, hy - 2, 6, hy - 2, p, "crest")
            m.fill(4, hy - 3, p, "crest")
        else:
            for x, y in ((4, hy - 1), (3, hy - 2), (11, hy - 1), (12, hy - 2)):
                m.fill(x, y, p, "crestL" if x < 8 else "crestR")
            m.rect(7, hy - 1, 8, hy - 1, e, "gem")
    elif side:
        m.rect(6, hy + 2, 8, hy + 5, p, "cup")
        m.fill(7, hy + 3, e, "cupLed")
        m.hrun(9, 11, hy + 7, SUIT, "mic")
        m.fill(12, hy + 7, e, "micLed")
    else:
        for cx in (2, 12):
            m.rect(cx, hy + 2, cx + 1, hy + 5, p, f"cup{cx}")
        m.hrun(4, 11, hy - 1, SUIT, "band")
        m.hrun(9, 11, hy + 7, SUIT, "mic")
        m.fill(12, hy + 7, e, "micLed")


def _head_front(m: Model, v: Variant, hy: int, back: bool) -> None:
    a = v.armor
    m.hrun(5, 10, hy, a, "head")
    m.rect(4, hy + 1, 11, hy + 6, a, "head")
    m.hrun(5, 10, hy + 7, a, "head")
    if back:
        m.rect(4, hy + 3, 4, hy + 5, VISOR, "visorL")
        m.rect(11, hy + 3, 11, hy + 5, VISOR, "visorR")
        m.rect(6, hy + 4, 9, hy + 6, SUIT, "vent")
        m.hrun(7, 8, hy + 5, v.emit, "ventLed")
    else:
        m.rect(4, hy + 3, 11, hy + 5, VISOR, "visor")
        _eyes_front(m, v, hy)
        m.hrun(7, 8, hy + 7, v.paint, "chin")
    for x in (3, 12):
        m.rect(x, hy + 3, x, hy + 5, v.paint, f"ear{x}")
        m.fill(x, hy + 4, v.emit, f"earLed{x}")
    _crown(m, v, Facing.UP if back else Facing.DOWN, hy)


def _head_side(m: Model, v: Variant, hy: int) -> None:
    a = v.armor
    m.hrun(6, 10, hy, a, "head")
    m.rect(5, hy + 1, 11, hy + 6, a, "head")
    m.hrun(6, 10, hy + 7, a, "head")
    m.rect(9, hy + 3, 11, hy + 5, VISOR, "visor")
    e = v.emit
    if v.eyes in (Eyes.MONO, Eyes.TWIN_ROUND):
        m.rect(10, hy + 3, 11, hy + 4, e, "eye")
    elif v.eyes is Eyes.HAPPY:
        m.fill(10, hy + 3, e, "eye")
        m.fill(11, hy + 4, e, "eye2")
    else:
        m.hrun(10, 11, hy + 4, e, "eye")
    m.rect(6, hy + 3, 7, hy + 5, v.paint, "ear")
    m.fill(6, hy + 4, e, "earLed")
    m.fill(7, hy + 4, e, "earLed")
    _crown(m, v, Facing.RIGHT, hy)


# ── Body ──────────────────────────────────────────────────────────────


def _torso_front(m: Model, v: Variant, by: int, back: bool) -> None:
    a = v.armor
    m.fill(7, by - 1, SUIT, "neck")
    m.fill(8, by - 1, SUIT, "neck")
    m.rect(5, by, 10, by + 3, a, "chest")
    m.rect(6, by + 4, 9, by + 5, SUIT, "abs")
    m.hrun(5, 10, by + 6, a, "hips")
    m.rect(2, by, 4, by + 1, v.paint, "shL")
    m.rect(11, by, 13, by + 1, v.paint, "shR")
    if back:
        m.rect(6, by + 1, 9, by + 4, SUIT, "pack")
        m.hrun(6, 9, by + 1, v.paint, "packTop")
        m.fill(6, by + 4, v.emit, "thrL")
        m.fill(9, by + 4, v.emit, "thrR")
        m.glow(6, by + 5, with_alpha(v.light, 150))
        m.glow(9, by + 5, with_alpha(v.light, 150))
    else:
        m.rect(7, by + 1, 8, by + 2, v.emit, "core")
        m.hrun(6, 9, by + 6, v.paint, "belt")


def _arm_front(m: Model, v: Variant, side: int, by: int, drop: int) -> None:
    x0 = 2 if side < 0 else 12
    m.rect(x0, by + 2, x0 + 1, by + 4 + drop, SUIT, f"arm{side}")
    m.rect(x0, by + 5 + drop, x0 + 1, by + 6 + drop, v.armor, f"hand{side}")


def _leg_front(m: Model, v: Variant, x: int, top: int, thigh: int, side: int) -> None:
    m.rect(x, top, x + 1, top + thigh - 1, SUIT, f"thigh{side}")
    boot = top + thigh
    m.rect(x, boot, x + 1, boot + 2, v.armor, f"boot{side}")
    m.hrun(x, x + 1, boot + 2, v.paint, f"sole{side}")
    m.glow(x, boot + 4, with_alpha(v.light, 110))
    m.glow(x + 1, boot + 4, with_alpha(v.light, 110))


def _hologram(
    m: Model, v: Variant, x0: int, y0: int, x1: int, y1: int, page: int
) -> None:
    edge = with_alpha(v.light, 215)
    fill = with_alpha(v.light, 70)
    text = with_alpha(hex_color("#FFFFFF"), 225)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            border = x in (x0, x1) or y in (y0, y1)
            m.glow(x, y, edge if border else fill)
    for i, y in enumerate(range(y0 + 1, y1)):
        length = (x1 - x0 - 2) - ((i + page) % 3)
        for x in range(x0 + 1, x0 + 1 + max(0, length)):
            m.glow(x, y, text if (i + page) % 2 == 0 else edge)


def _frame_down(v: Variant, frame: int) -> Model:
    m = Model(FRAME_W, FRAME_H)
    if frame <= 2:
        hy, by = 5, 14
        step = STEP[frame]
        _leg_front(m, v, 5, by + 7, 2 + step, -1)
        _leg_front(m, v, 9, by + 7, 2 - step, 1)
        _torso_front(m, v, by, back=False)
        _arm_front(m, v, -1, by, max(0, -step))
        _arm_front(m, v, 1, by, max(0, step))
        _head_front(m, v, hy, back=False)
        return m
    hy = 8 + (1 if frame == 6 else 0)
    by = 17
    m.rect(5, by + 7, 6, by + 8, SUIT, "kneeL")
    m.rect(9, by + 7, 10, by + 8, SUIT, "kneeR")
    m.rect(5, by + 9, 6, by + 10, v.armor, "bootL")
    m.rect(9, by + 9, 10, by + 10, v.armor, "bootR")
    _torso_front(m, v, by, back=False)
    _head_front(m, v, hy, back=False)
    if frame in (3, 4):
        left_up = frame == 3
        for side, up in ((-1, left_up), (1, not left_up)):
            x0 = 2 if side < 0 else 12
            hx = 3 if side < 0 else 11
            m.rect(x0, by + 2, x0 + 1, by + 3, SUIT, f"arm{side}")
            hand_y = by + 4 + (0 if up else 1)
            m.rect(hx, hand_y, hx + 1, hand_y + 1, v.armor, f"hand{side}")
    else:
        for side in (-1, 1):
            x0 = 2 if side < 0 else 12
            m.rect(x0, by + 2, x0 + 1, by + 4, SUIT, f"arm{side}")
            m.rect(x0, by + 5, x0 + 1, by + 6, v.armor, f"hand{side}")
        _hologram(m, v, 4, by + 1, 11, by + 6, frame - 5)
    return m


def _frame_up(v: Variant, frame: int) -> Model:
    m = Model(FRAME_W, FRAME_H)
    if frame <= 2:
        hy, by = 5, 14
        step = STEP[frame]
        _leg_front(m, v, 5, by + 7, 2 - step, -1)
        _leg_front(m, v, 9, by + 7, 2 + step, 1)
        _torso_front(m, v, by, back=True)
        _arm_front(m, v, -1, by, max(0, step))
        _arm_front(m, v, 1, by, max(0, -step))
        _head_front(m, v, hy, back=True)
        return m
    hy = 6 + (1 if frame == 6 else 0)
    by = 15
    _torso_front(m, v, by, back=True)
    if frame in (3, 4):
        lift_left = frame == 3
        _arm_front(m, v, -1, by - (1 if lift_left else 0), 0)
        _arm_front(m, v, 1, by - (0 if lift_left else 1), 0)
    else:
        _arm_front(m, v, -1, by - 1, 0)
        _arm_front(m, v, 1, by - 1, 0)
        glow = with_alpha(v.light, 120)
        for y in range(by + 1, by + 4):
            m.glow(1, y, glow)
            m.glow(14, y, glow)
    _head_front(m, v, hy, back=True)
    m.crop_below(25)
    return m


def _torso_side(m: Model, v: Variant, by: int) -> None:
    a = v.armor
    m.fill(8, by - 1, SUIT, "neck")
    m.rect(6, by, 9, by + 3, a, "chest")
    m.rect(7, by + 4, 8, by + 5, SUIT, "abs")
    m.hrun(6, 9, by + 6, a, "hips")
    m.rect(4, by + 1, 5, by + 4, SUIT, "pack")
    m.hrun(4, 5, by + 1, v.paint, "packTop")
    m.fill(4, by + 4, v.emit, "thr")
    m.glow(4, by + 5, with_alpha(v.light, 150))
    m.glow(3, by + 5, with_alpha(v.light, 70))
    m.fill(9, by + 1, v.emit, "core")
    m.fill(9, by + 2, v.emit, "core")


def _frame_right(v: Variant, frame: int) -> Model:
    m = Model(FRAME_W, FRAME_H)
    if frame <= 2:
        hy, by = 5, 14
        step = STEP[frame]
        back_x = 7 - step
        front_x = 7 + step
        m.rect(back_x, by + 7, back_x + 1, by + 8, SUIT, "thighB")
        m.rect(back_x, by + 9, back_x + 2, by + 11, v.armor, "bootB")
        m.hrun(back_x, back_x + 2, by + 11, v.paint, "soleB")
        _torso_side(m, v, by)
        m.rect(front_x, by + 7, front_x + 1, by + 8, SUIT, "thighF")
        m.rect(front_x, by + 9, front_x + 2, by + 11, v.armor, "bootF")
        m.hrun(front_x, front_x + 2, by + 11, v.paint, "soleF")
        for x in range(front_x, front_x + 3):
            m.glow(x, by + 13, with_alpha(v.light, 110))
        m.rect(7, by, 8, by + 1, v.paint, "sh")
        ax = 7 + step
        m.rect(ax, by + 2, ax + 1, by + 4, SUIT, "arm")
        m.rect(ax, by + 5, ax + 1, by + 6, v.armor, "hand")
        _head_side(m, v, hy)
        return m
    hy = 6 + (1 if frame == 6 else 0)
    by = 15
    _torso_side(m, v, by)
    m.rect(7, by + 7, 11, by + 8, SUIT, "thigh")
    m.rect(10, by + 9, 11, by + 10, SUIT, "shin")
    m.rect(10, by + 11, 12, by + 12, v.armor, "boot")
    m.hrun(10, 12, by + 12, v.paint, "sole")
    m.rect(7, by, 8, by + 1, v.paint, "sh")
    m.rect(7, by + 2, 8, by + 3, SUIT, "arm")
    if frame in (3, 4):
        fy = by + 4 - (1 if frame == 3 else 0)
        m.rect(9, fy, 10, fy, SUIT, "fore")
        m.rect(11, fy, 12, fy, v.armor, "hand")
    else:
        m.fill(9, by + 3, SUIT, "fore")
        m.rect(10, by + 2, 10, by + 3, v.armor, "hand")
        _hologram(m, v, 11, by - 2, 14, by + 4, frame - 5)
    _head_side(m, v, hy)
    return m


def character_sheet(v: Variant) -> Image.Image:
    sheet = Image.new("RGBA", (FRAME_W * FRAMES, FRAME_H * 3), (0, 0, 0, 0))
    builders = (_frame_down, _frame_up, _frame_right)
    for row, build in enumerate(builders):
        for f in range(FRAMES):
            img = render(build(v, f), OUTLINE).to_image()
            sheet.alpha_composite(img, (f * FRAME_W, row * FRAME_H))
    return sheet


def all_character_sheets() -> list[Image.Image]:
    return [character_sheet(v) for v in VARIANTS]
