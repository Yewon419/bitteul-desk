"""Hand-dotted Claude-style mascot staff for the scene: a squat orange block with square eyes,
stubby arms and four little legs.

Usage: python art/clawd.py
Writes webview-ui/public/scene/staff/<pose>_<variant>_<frame>.png, already scaled by DOT.
  poses:  back (seen from behind, as at a desk), front (standing, facing the camera)
  frames: back  a/b = typing (arms swap), c-f = same as a
          front a = rest, b/d = walking (alternate legs lifted), c = blink,
                e = stretch (arms up), f = asleep (eyes shut)
  variants: 0 = plain, 1-5 = a thin headband in an accent colour, so live sessions differ.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from PIL import Image

OUT = (
    Path(__file__).resolve().parent.parent / "webview-ui" / "public" / "scene" / "staff"
)

DOT = 6
W, H = 26, 18
BODY_X0, BODY_X1 = 5, 20
BODY_Y0, BODY_Y1 = 1, 12
ARM_ROWS = (7, 9)
LEGS = (6, 9, 16, 19)
LEG_Y0, LEG_Y1 = 13, 15
FRAMES = ("a", "b", "c", "d", "e", "f")
WALK_LIFT: dict[str, tuple[int, ...]] = {"b": (0, 2), "d": (1, 3)}

Colour = tuple[int, int, int]
Grid = NDArray[np.uint8]

OUTLINE: Colour = (74, 34, 22)
LIGHT: Colour = (236, 150, 118)
BODY: Colour = (217, 119, 87)
SHADE: Colour = (184, 94, 64)
DEEP: Colour = (150, 72, 48)
EYE: Colour = (31, 20, 16)
BAND_ACCENTS: tuple[Colour | None, ...] = (
    None,
    (43, 134, 197),
    (53, 176, 143),
    (236, 120, 170),
    (127, 99, 240),
    (242, 190, 60),
)


def _put(g: Grid, x: int, y: int, c: Colour) -> None:
    if 0 <= x < W and 0 <= y < H:
        g[y, x, :3] = c
        g[y, x, 3] = 255


def _rect(g: Grid, x0: int, y0: int, x1: int, y1: int, c: Colour) -> None:
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            _put(g, x, y, c)


def _body(g: Grid) -> None:
    _rect(g, BODY_X0, BODY_Y0, BODY_X1, BODY_Y1, BODY)
    _rect(g, BODY_X0, BODY_Y0, BODY_X1, BODY_Y0 + 1, LIGHT)
    _rect(g, BODY_X0, BODY_Y0 + 2, BODY_X0, BODY_Y1 - 2, LIGHT)
    _rect(g, BODY_X1, BODY_Y0 + 2, BODY_X1, BODY_Y1, SHADE)
    _rect(g, BODY_X0, BODY_Y1 - 1, BODY_X1, BODY_Y1, SHADE)
    _rect(g, BODY_X0 + 1, BODY_Y1, BODY_X1 - 1, BODY_Y1, DEEP)


def _arms(g: Grid, left_up: bool | None) -> None:
    top, bottom = ARM_ROWS
    for side in (-1, 1):
        lift = 0
        if left_up is not None:
            lift = -1 if (side < 0) == left_up else 1
        x0, x1 = (BODY_X0 - 3, BODY_X0 - 1) if side < 0 else (BODY_X1 + 1, BODY_X1 + 3)
        _rect(g, x0, top + lift, x1, bottom + lift, BODY)
        _rect(g, x0, bottom + lift, x1, bottom + lift, SHADE)
        _rect(g, x0, top + lift, x1, top + lift, LIGHT)


def _arms_up(g: Grid) -> None:
    """Arms thrown up and out: a short shoulder stub, then a raised forearm."""
    for side in (-1, 1):
        stub = (BODY_X0 - 2, BODY_X0 - 1) if side < 0 else (BODY_X1 + 1, BODY_X1 + 2)
        fore = (BODY_X0 - 4, BODY_X0 - 3) if side < 0 else (BODY_X1 + 3, BODY_X1 + 4)
        _rect(g, stub[0], 5, stub[1], 7, BODY)
        _rect(g, fore[0], 1, fore[1], 6, BODY)
        _rect(g, fore[0], 1, fore[1], 1, LIGHT)
        _rect(
            g,
            fore[1] if side > 0 else fore[0],
            2,
            fore[1] if side > 0 else fore[0],
            6,
            SHADE,
        )


def _legs(g: Grid, lifted: tuple[int, ...]) -> None:
    for i, x in enumerate(LEGS):
        bottom = LEG_Y1 - (1 if i in lifted else 0)
        _rect(g, x, LEG_Y0, x + 1, bottom, BODY)
        _rect(g, x + 1, LEG_Y0, x + 1, bottom, SHADE)


def _eyes(g: Grid, closed: bool) -> None:
    for x in (BODY_X0 + 3, BODY_X1 - 4):
        if closed:
            _rect(g, x, 6, x + 1, 6, EYE)
        else:
            _rect(g, x, 4, x + 1, 7, EYE)


def _band(g: Grid, accent: Colour | None) -> None:
    if accent is None:
        return
    dark = tuple(round(c * 0.72) for c in accent)
    _rect(g, BODY_X0, BODY_Y0 + 1, BODY_X1, BODY_Y0 + 2, accent)
    _rect(
        g, BODY_X1 - 1, BODY_Y0 + 1, BODY_X1, BODY_Y0 + 2, (dark[0], dark[1], dark[2])
    )


def _outline(g: Grid) -> Grid:
    solid = g[..., 3] > 0
    padded = np.pad(solid, 1)
    near = padded[:-2, 1:-1] | padded[2:, 1:-1] | padded[1:-1, :-2] | padded[1:-1, 2:]
    ring = near & ~solid
    out = g.copy()
    out[ring, :3] = OUTLINE
    out[ring, 3] = 255
    return out


def sprite(pose: str, accent: Colour | None, frame: str) -> Grid:
    g = np.zeros((H, W, 4), np.uint8)
    _body(g)
    if pose == "back":
        _arms(g, left_up=frame == "b")
    else:
        if frame == "e":
            _arms_up(g)
        else:
            _arms(g, left_up=None)
        _legs(g, lifted=WALK_LIFT.get(frame, ()))
        _eyes(g, closed=frame in ("c", "f"))
    _band(g, accent)
    return _outline(g)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.png"):
        stale.unlink()
    for pose in ("back", "front"):
        for v, accent in enumerate(BAND_ACCENTS):
            for frame in FRAMES:
                img = Image.fromarray(sprite(pose, accent, frame), "RGBA")
                img.resize((W * DOT, H * DOT), Image.Resampling.NEAREST).save(
                    OUT / f"{pose}_{v}_{frame}.png"
                )
    print(f"wrote {2 * len(BAND_ACCENTS) * len(FRAMES)} sprites to {OUT}")


if __name__ == "__main__":
    main()
