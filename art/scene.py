"""Prepare the illustrated office scene: background, occluding front layer and anchors.

Usage: python art/scene.py <generated background.png>
Writes webview-ui/public/scene/: background (swaying plants painted out), front, sky,
clouds, beams and plant layers, plus scene.json with anchors and ambient-animation data.
Anchor numbers are measured on the Nano Banana two-desk room (768x1344); the page
repeats that room ROOMS times side by side.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import Image, ImageDraw

from ambient import build
from scene_types import Point

OUT = Path(__file__).resolve().parent.parent / "webview-ui" / "public" / "scene"
SIZE = (768, 1344)
ROOMS = 3


@dataclass(frozen=True)
class Seat:
    """A desk: its monitor outline and the bottom-centre point where the staff sprite stands."""

    screen: list[Point]
    anchor_x: int
    anchor_y: int


@dataclass(frozen=True)
class Quad:
    """Trapezoid of the wall display: left edge x0 (y0..y1), right edge x1 (y2..y3)."""

    x0: int
    y0: int
    y1: int
    x1: int
    y2: int
    y3: int


@dataclass(frozen=True)
class SceneLayout:
    width: int
    height: int
    rooms: int
    seats: list[Seat]
    wall: Quad
    standing: list[Point]
    floor: tuple[int, int, int, int]
    step_off_y: int


LAYOUT = SceneLayout(
    width=SIZE[0],
    height=SIZE[1],
    rooms=ROOMS,
    seats=[
        Seat([(190, 660), (342, 660), (342, 750), (190, 750)], 198, 842),
        Seat([(437, 660), (590, 660), (590, 750), (437, 750)], 598, 842),
    ],
    wall=Quad(x0=46, y0=462, y1=668, x1=115, y2=476, y3=652),
    standing=[(250, 1250), (520, 1250)],
    floor=(220, 1130, 640, 1320),
    step_off_y=1120,
)

# Chair backs (with armrests) that sit between the camera and whoever sits in them.
CHAIR_BACKS: tuple[list[Point], ...] = (
    [
        (128, 812),
        (134, 806),
        (262, 806),
        (268, 812),
        (268, 855),
        (292, 858),
        (292, 905),
        (268, 905),
        (265, 955),
        (135, 958),
        (128, 950),
    ],
    [
        (528, 812),
        (534, 806),
        (662, 806),
        (668, 812),
        (668, 950),
        (662, 958),
        (532, 955),
        (528, 905),
        (500, 905),
        (500, 858),
        (528, 855),
    ],
)


def front_layer(bg: Image.Image) -> Image.Image:
    src = bg.convert("RGBA")
    mask = Image.new("L", src.size, 0)
    draw = ImageDraw.Draw(mask)
    for outline in CHAIR_BACKS:
        draw.polygon(outline, fill=255)
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    out.paste(src, (0, 0), mask)
    return out


def main(background: Path) -> None:
    bg = Image.open(background).convert("RGBA")
    if bg.size != SIZE:
        bg = bg.resize(SIZE, Image.Resampling.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    ambient = build(bg)
    ambient.static.save(OUT / "background.png")
    ambient.sky.save(OUT / "sky.png")
    ambient.clouds.save(OUT / "clouds.png")
    ambient.beams.save(OUT / "beams.png")
    for name, img in ambient.plant_images.items():
        img.save(OUT / name)
    front_layer(bg).save(OUT / "front.png")
    payload = {**asdict(LAYOUT), "ambient": ambient.data}
    (OUT / "scene.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"wrote background, front layer and anchors to {OUT}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
