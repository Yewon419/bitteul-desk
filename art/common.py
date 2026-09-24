"""Shared palette and a tiny pixel canvas for the Bitteul asset generator."""

from __future__ import annotations

from dataclasses import dataclass, field

from PIL import Image

Color = tuple[int, int, int, int]


def hex_color(value: str, alpha: int = 255) -> Color:
    v = value.lstrip("#")
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), alpha)


OUTLINE = hex_color("#13293D")
WHITE = hex_color("#F6FAFC")
PURE_WHITE = hex_color("#FFFFFF")
SKY = hex_color("#BFE0F5")
CERULEAN = hex_color("#2B86C5")
DEEP_CERULEAN = hex_color("#2779B3")
NAVY = hex_color("#13293D")
BUTTER = hex_color("#FFD166")
SCREEN = hex_color("#1B3A55")
GLOW = hex_color("#8FE3FF")
LEG = hex_color("#3B4D63")
LEG_DARK = hex_color("#2A394B")


def shade(c: Color, factor: float) -> Color:
    return (
        max(0, min(255, round(c[0] * factor))),
        max(0, min(255, round(c[1] * factor))),
        max(0, min(255, round(c[2] * factor))),
        c[3],
    )


def gray(level: int) -> Color:
    return (level, level, level, 255)


@dataclass
class Canvas:
    width: int
    height: int
    pixels: dict[tuple[int, int], Color] = field(default_factory=dict)

    def put(self, x: int, y: int, c: Color) -> None:
        if 0 <= x < self.width and 0 <= y < self.height:
            self.pixels[(x, y)] = c

    def clear(self, x: int, y: int) -> None:
        self.pixels.pop((x, y), None)

    def rect(self, x0: int, y0: int, x1: int, y1: int, c: Color) -> None:
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.put(x, y, c)

    def hline(self, x0: int, x1: int, y: int, c: Color) -> None:
        self.rect(x0, y, x1, y, c)

    def vline(self, x: int, y0: int, y1: int, c: Color) -> None:
        self.rect(x, y0, x, y1, c)

    def box(
        self,
        x0: int,
        y0: int,
        x1: int,
        y1: int,
        fill: Color,
        edge: Color,
        rounded: bool = True,
    ) -> None:
        self.rect(x0, y0, x1, y1, edge)
        self.rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, fill)
        if rounded:
            for cx, cy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
                self.clear(cx, cy)

    def crop_below(self, y_limit: int) -> None:
        for key in [k for k in self.pixels if k[1] > y_limit]:
            del self.pixels[key]

    def shifted(self, dx: int, dy: int) -> Canvas:
        out = Canvas(self.width, self.height)
        for (x, y), c in self.pixels.items():
            out.put(x + dx, y + dy, c)
        return out

    def to_image(self) -> Image.Image:
        img = Image.new("RGBA", (self.width, self.height), (0, 0, 0, 0))
        for (x, y), c in self.pixels.items():
            img.putpixel((x, y), c)
        return img


def preview(
    img: Image.Image, scale: int, background: Color = (238, 244, 248, 255)
) -> Image.Image:
    bg = Image.new("RGBA", img.size, background)
    bg.alpha_composite(img)
    return bg.resize((img.width * scale, img.height * scale), Image.Resampling.NEAREST)
