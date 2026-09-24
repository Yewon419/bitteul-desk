"""Part-based sprite model with automatic 4-tone shading, panel seams and outlines.

Shapes are painted as (material, part id) cells. Rendering shades each cell from its
neighbours within the same part (lit from the top), so touching parts get a seam, then
wraps the silhouette in a 4-neighbour outline. Overlays (glows, holograms) are drawn last.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from common import Canvas, Color, shade

Cell = tuple["Material", str]


@dataclass(frozen=True)
class Material:
    hi: Color
    base: Color
    shade: Color
    deep: Color
    emissive: bool = False


def lift(c: Color, amount: float) -> Color:
    return (
        round(c[0] + (255 - c[0]) * amount),
        round(c[1] + (255 - c[1]) * amount),
        round(c[2] + (255 - c[2]) * amount),
        c[3],
    )


def paint(c: Color) -> Material:
    return Material(lift(c, 0.35), c, shade(c, 0.8), shade(c, 0.62))


def emissive(c: Color) -> Material:
    return Material(lift(c, 0.65), c, c, c, emissive=True)


def with_alpha(c: Color, alpha: int) -> Color:
    return (c[0], c[1], c[2], alpha)


@dataclass
class Model:
    width: int
    height: int
    cells: dict[tuple[int, int], Cell] = field(default_factory=dict)
    overlays: dict[tuple[int, int], Color] = field(default_factory=dict)

    def fill(self, x: int, y: int, mat: Material, part: str) -> None:
        if 0 <= x < self.width and 0 <= y < self.height:
            self.cells[(x, y)] = (mat, part)

    def rect(
        self, x0: int, y0: int, x1: int, y1: int, mat: Material, part: str
    ) -> None:
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.fill(x, y, mat, part)

    def hrun(self, x0: int, x1: int, y: int, mat: Material, part: str) -> None:
        self.rect(x0, y, x1, y, mat, part)

    def rounded(
        self, x0: int, y0: int, x1: int, y1: int, mat: Material, part: str
    ) -> None:
        self.rect(x0 + 1, y0, x1 - 1, y1, mat, part)
        self.rect(x0, y0 + 1, x1, y1 - 1, mat, part)

    def blob(
        self, cx: float, cy: float, rx: float, ry: float, mat: Material, part: str
    ) -> None:
        for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
            for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                    self.fill(x, y, mat, part)

    def detail(self, x: int, y: int, c: Color) -> None:
        """Opaque or translucent pixel painted over the shaded result."""
        self.glow(x, y, c)

    def glow(self, x: int, y: int, c: Color) -> None:
        if 0 <= x < self.width and 0 <= y < self.height:
            self.overlays[(x, y)] = c

    def crop_below(self, y_limit: int) -> None:
        for key in [k for k in self.cells if k[1] > y_limit]:
            del self.cells[key]
        for key in [k for k in self.overlays if k[1] > y_limit]:
            del self.overlays[key]


def _cell_color(model: Model, x: int, y: int) -> Color:
    mat, part = model.cells[(x, y)]

    def same(dx: int, dy: int) -> bool:
        other = model.cells.get((x + dx, y + dy))
        return other is not None and other[1] == part

    if mat.emissive:
        return (
            mat.hi
            if same(-1, 0) and same(1, 0) or same(0, -1) and same(0, 1)
            else mat.base
        )
    if not same(0, -1):
        return mat.hi
    if not same(0, 1):
        return mat.deep
    if not same(1, 0):
        return mat.shade
    return mat.base


def render(model: Model, outline: Color) -> Canvas:
    out = Canvas(model.width, model.height)
    for x, y in model.cells:
        out.put(x, y, _cell_color(model, x, y))
    for x, y in list(model.cells):
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if (nx, ny) not in model.cells:
                out.put(nx, ny, outline)
    for (x, y), c in model.overlays.items():
        under = out.pixels.get((x, y))
        out.put(x, y, c if under is None else _blend(under, c))
    return out


def _blend(under: Color, over: Color) -> Color:
    a = over[3] / 255
    return (
        round(under[0] * (1 - a) + over[0] * a),
        round(under[1] * (1 - a) + over[1] * a),
        round(under[2] * (1 - a) + over[2] * a),
        max(under[3], over[3]),
    )
