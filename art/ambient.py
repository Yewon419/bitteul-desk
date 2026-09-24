"""Split the static scene into ambient-animation layers.

Produces a background with the swaying plants painted out, the moving layers themselves,
and the anchor data the scene page needs (all in scene pixels).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from scene_types import Point, Rect

Pixels = NDArray[np.uint8]
Mask = NDArray[np.bool_]

# Measured on the Nano Banana two-desk room (768x1344).
# Main lower pane only; the transom above carries the fairy lights and stays still.
WINDOW = Rect(190, 436, 584, 598)
MULLIONS: tuple[Rect, ...] = ()
SEA = Rect(186, 601, 588, 654)
LIGHT_BAND = Rect(140, 280, 630, 770)
FLOOR_BEAMS = Rect(60, 1100, 740, 1340)
LAMPS: list[tuple[int, int, int]] = []
STEAM = [(350, 786), (425, 786), (625, 782)]
DUST = Rect(60, 300, 740, 1300)
CLOUD_EDGE_MIN = 150
BLUE_MARGIN = 45
MIN_BLUE_PIXELS = 10
SMOOTH_ROWS = 9
MIN_CLOUD_ALPHA = 6
CLOUD_CORE = 200
WARM_MARGIN = 45
CLOUD_OUTLINE_REACH = 2
VEIN_REACH = 4
OCCLUDER_MARGIN = 2
SAMPLE_ROWS = 12
SAMPLE_SKIP = 10
HORIZON_HAZE = 0.45
SEA_POINTS = 260


@dataclass(frozen=True)
class Plant:
    file: str
    x: int
    y: int
    w: int
    h: int
    pivot: str
    amp: float
    period: float


@dataclass(frozen=True)
class PlantSpec:
    name: str
    box: Rect
    pivot: str
    amp: float
    period: float


PLANTS = (
    PlantSpec("hang_left", Rect(96, 252, 214, 456), "top", 3.0, 5.2),
    PlantSpec("hang_right", Rect(564, 252, 684, 464), "top", 3.0, 4.6),
    PlantSpec("monstera", Rect(28, 770, 192, 1082), "bottom", 2.5, 6.3),
    PlantSpec("sill", Rect(346, 694, 420, 752), "bottom", 1.2, 3.7),
)


@dataclass
class Ambient:
    static: Image.Image
    sky: Image.Image
    clouds: Image.Image
    beams: Image.Image
    plant_images: dict[str, Image.Image]
    data: dict[str, object] = field(default_factory=dict)


def _box(a: Pixels, r: Rect) -> Pixels:
    return a[r.y0 : r.y1 + 1, r.x0 : r.x1 + 1]


def _glass_and_colours(
    a: Pixels, occluded: Mask
) -> tuple[Mask, tuple[int, int, int], tuple[int, int, int]]:
    """Window glass (sky or cloud, minus the mullions), sampled zenith colour and a hazier horizon."""
    win = _box(a, WINDOW)[..., :3].astype(int)
    r, g, b = win[..., 0], win[..., 1], win[..., 2]
    cloud = np.minimum(np.minimum(r, g), b) >= CLOUD_EDGE_MIN
    sky = (b > r + 30) & (b > g + 8)
    warm = r > b + WARM_MARGIN
    hidden = occluded[WINDOW.y0 : WINDOW.y1 + 1, WINDOW.x0 : WINDOW.x1 + 1]
    glass = (sky | cloud) & ~warm & ~_grow(hidden, OCCLUDER_MARGIN)
    for m in MULLIONS:
        glass[
            m.y0 - WINDOW.y0 : m.y1 - WINDOW.y0 + 1,
            m.x0 - WINDOW.x0 : m.x1 - WINDOW.x0 + 1,
        ] = False
    clear = sky & ~cloud
    band = slice(SAMPLE_SKIP, SAMPLE_SKIP + SAMPLE_ROWS)
    top = np.median(win[band][clear[band]], axis=0)
    zenith = (int(top[0]), int(top[1]), int(top[2]))
    horizon = tuple(round(c + (255 - c) * HORIZON_HAZE) for c in zenith)
    return (
        np.asarray(glass, dtype=np.bool_),
        zenith,
        (horizon[0], horizon[1], horizon[2]),
    )


def _sky_model(
    win: NDArray[np.float64], glass: Mask, horizon: tuple[int, int, int]
) -> NDArray[np.float64]:
    """Per-row sky colour from clearly blue pixels, interpolated across rows without any."""
    h = win.shape[0]
    r, g, b = win[..., 0], win[..., 1], win[..., 2]
    blue = glass & (b > r + BLUE_MARGIN) & (b > g + 8)
    rows = np.full((h, 3), np.nan)
    for y in range(h):
        if blue[y].sum() >= MIN_BLUE_PIXELS:
            rows[y] = np.median(win[y][blue[y]], axis=0)
    valid = np.nonzero(~np.isnan(rows[:, 0]))[0]
    if len(valid) == 0:
        raise ValueError("no clear sky found in the window")
    last = valid[-1]
    for y in range(last + 1, h):
        t = (y - last) / max(1, h - 1 - last)
        rows[y] = rows[last] + (np.array(horizon, float) - rows[last]) * t
    valid = np.nonzero(~np.isnan(rows[:, 0]))[0]
    for c in range(3):
        rows[:, c] = np.interp(np.arange(h), valid, rows[valid, c])
    kernel = np.ones(SMOOTH_ROWS) / SMOOTH_ROWS
    padded = np.pad(rows, ((SMOOTH_ROWS // 2, SMOOTH_ROWS // 2), (0, 0)), mode="edge")
    smooth = np.stack(
        [np.convolve(padded[:, c], kernel, mode="valid") for c in range(3)], axis=1
    )
    return np.repeat(smooth[:, None, :], win.shape[1], axis=1)


def _fill_rows(values: NDArray[np.float64], known: Mask) -> NDArray[np.float64]:
    """Fill each run of unknown pixels with the known texture right beside it, shifted over.

    Copying keeps the cloud texture's structure, where interpolation would smear it into
    horizontal streaks and mirroring would stamp symmetric shapes that show once it moves.
    """
    out = values.copy()
    w = values.shape[1]
    for y in range(values.shape[0]):
        row = known[y]
        if row.all() or not row.any():
            continue
        x = 0
        while x < w:
            if row[x]:
                x += 1
                continue
            start = x
            while x < w and not row[x]:
                x += 1
            end = x - 1
            span = end - start + 1
            for gx in range(start, end + 1):
                right = gx + span
                left = gx - span
                if right < w and row[right]:
                    out[y, gx] = values[y, right]
                elif left >= 0 and row[left]:
                    out[y, gx] = values[y, left]
                else:
                    near = np.nonzero(row)[0]
                    out[y, gx] = values[y, near[np.abs(near - gx).argmin()]]
    return out


def _sky_layers(a: Pixels, occluded: Mask) -> tuple[Pixels, Pixels]:
    """The original sky split into a still backdrop and a moving cloud layer.

    Cloud bodies (bright cores grown by a couple of pixels so their outlines come along)
    move as solid original pixels. Everything else is treated as backdrop B blended with a
    whitish haze C at opacity a (O = B(1-a) + Ca), so at rest the layers reproduce the
    original exactly. Behind mullions and leaves the cloud layer is carried
    across from both sides, so clouds pass behind them without leaving gaps.
    """
    glass, _, horizon = _glass_and_colours(a, occluded)
    win = _box(a, WINDOW)[..., :3].astype(float)
    backdrop = _sky_model(win, glass, horizon)
    lift = np.clip((win - backdrop) / np.maximum(1.0, 255.0 - backdrop), 0.0, 1.0)
    alpha = lift.max(axis=-1)
    solid = _grow(win.min(axis=-1) >= CLOUD_CORE, CLOUD_OUTLINE_REACH) & glass
    alpha[solid] = 1.0
    alpha[~glass] = 0.0
    safe = np.maximum(alpha, 1e-3)[..., None]
    colour = np.clip(backdrop + (win - backdrop) / safe, 0, 255)
    colour[solid] = win[solid]
    layer = np.concatenate([colour, alpha[..., None] * 255.0], axis=-1)
    layer = _fill_rows(layer, glass)
    h, w = glass.shape
    sky_img = np.zeros((h, w, 4), np.uint8)
    sky_img[..., :3] = np.clip(backdrop, 0, 255).astype(np.uint8)
    sky_img[..., 3] = np.where(glass, 255, 0)
    cloud_img = np.clip(layer, 0, 255).astype(np.uint8)
    cloud_img[cloud_img[..., 3] < MIN_CLOUD_ALPHA, 3] = 0
    seamless = np.concatenate([cloud_img, cloud_img[:, ::-1]], axis=1)
    return sky_img, seamless


def _plant_mask(part: Pixels) -> Mask:
    p = part.astype(int)
    r, g, b = p[..., 0], p[..., 1], p[..., 2]
    green = (g > r + 12) & (g > b - 6) & (g > 60)
    near = np.zeros_like(green)
    padded = np.pad(green, 1)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            near |= padded[
                1 + dy : 1 + dy + green.shape[0], 1 + dx : 1 + dx + green.shape[1]
            ]
    dark_edge = near & ((r + g + b) / 3 < 95)
    leaf = green | dark_edge
    mask: Mask = np.asarray(leaf | _sandwiched(leaf, VEIN_REACH), dtype=np.bool_)
    return mask


def _grow(mask: Mask, steps: int) -> Mask:
    out = mask.copy()
    for _ in range(steps):
        padded = np.pad(out, 1)
        out = (
            out
            | padded[:-2, 1:-1]
            | padded[2:, 1:-1]
            | padded[1:-1, :-2]
            | padded[1:-1, 2:]
        )
    grown: Mask = np.asarray(out, dtype=np.bool_)
    return grown


def _sandwiched(mask: Mask, reach: int) -> Mask:
    """Pixels with the mask on both sides within `reach` (leaf veins and slits)."""
    h, w = mask.shape
    left = np.zeros_like(mask)
    right = np.zeros_like(mask)
    up = np.zeros_like(mask)
    down = np.zeros_like(mask)
    for d in range(1, reach + 1):
        left[:, d:] |= mask[:, :-d]
        right[:, :-d] |= mask[:, d:]
        up[d:, :] |= mask[:-d, :]
        down[:-d, :] |= mask[d:, :]
    inside: Mask = np.asarray(((left & right) | (up & down)) & ~mask, dtype=np.bool_)
    return inside


def _inpaint_rows(part: Pixels, mask: Mask) -> Pixels:
    out = part.copy()
    for y in range(part.shape[0]):
        row = mask[y]
        if not row.any():
            continue
        xs = np.nonzero(~row)[0]
        if len(xs) == 0:
            continue
        for c in range(3):
            out[y, row, c] = np.interp(np.nonzero(row)[0], xs, part[y, xs, c]).astype(
                np.uint8
            )
    return out


def _bulbs(a: Pixels) -> list[Point]:
    band = _box(a, LIGHT_BAND).astype(int)
    r, g, b = band[..., 0], band[..., 1], band[..., 2]
    hot = (r > 240) & (g > 215) & (r - b > 35)
    seen = np.zeros_like(hot)
    centers: list[Point] = []
    h, w = hot.shape
    for y in range(h):
        for x in range(w):
            if not hot[y, x] or seen[y, x]:
                continue
            stack = [(y, x)]
            seen[y, x] = True
            pts: list[tuple[int, int]] = []
            while stack:
                cy, cx = stack.pop()
                pts.append((cy, cx))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and hot[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if len(pts) >= 4:
                cy = round(sum(p[0] for p in pts) / len(pts)) + LIGHT_BAND.y0
                cx = round(sum(p[1] for p in pts) / len(pts)) + LIGHT_BAND.x0
                centers.append((cx, cy))
    return centers


def _sea_points(a: Pixels) -> list[Point]:
    sea = _box(a, SEA).astype(int)
    blue = sea[..., 2] > sea[..., 0] + 40
    ys, xs = np.nonzero(blue)
    rng = np.random.default_rng(7)
    pick = rng.choice(len(xs), size=min(SEA_POINTS, len(xs)), replace=False)
    return [(int(xs[i]) + SEA.x0, int(ys[i]) + SEA.y0) for i in pick]


def _beams(a: Pixels) -> Pixels:
    floor = _box(a, FLOOR_BEAMS).astype(int)
    lum = floor[..., :3].mean(axis=-1)
    out = np.zeros(floor.shape[:2] + (4,), np.uint8)
    out[..., :3] = 255
    out[..., 3] = np.clip((lum - 200) * 4, 0, 255).astype(np.uint8)
    return out


def build(bg: Image.Image) -> Ambient:
    a = np.array(bg.convert("RGBA"))
    static = a.copy()
    plant_images: dict[str, Image.Image] = {}
    plants: list[Plant] = []
    occluded = np.zeros(a.shape[:2], np.bool_)
    for spec in PLANTS:
        part = _box(a, spec.box)
        mask = _plant_mask(part)
        occluded[spec.box.y0 : spec.box.y1 + 1, spec.box.x0 : spec.box.x1 + 1] |= mask
        layer = np.zeros_like(part)
        layer[mask] = part[mask]
        fixed = _inpaint_rows(part[..., :3], mask)
        static[spec.box.y0 : spec.box.y1 + 1, spec.box.x0 : spec.box.x1 + 1, :3] = fixed
        name = f"plant_{spec.name}.png"
        plant_images[name] = Image.fromarray(layer, "RGBA")
        plants.append(
            Plant(
                name,
                spec.box.x0,
                spec.box.y0,
                spec.box.x1 - spec.box.x0 + 1,
                spec.box.y1 - spec.box.y0 + 1,
                spec.pivot,
                spec.amp,
                spec.period,
            )
        )
    sky, clouds = _sky_layers(a, occluded)
    data: dict[str, object] = {
        "window": [WINDOW.x0, WINDOW.y0],
        "plants": [asdict(p) for p in plants],
        "bulbs": _bulbs(a),
        "sea": _sea_points(a),
        "lamps": [list(lamp) for lamp in LAMPS],
        "steam": STEAM,
        "beams": [FLOOR_BEAMS.x0, FLOOR_BEAMS.y0],
        "dust": [DUST.x0, DUST.y0, DUST.x1, DUST.y1],
    }
    return Ambient(
        static=Image.fromarray(static, "RGBA"),
        sky=Image.fromarray(sky, "RGBA"),
        clouds=Image.fromarray(clouds, "RGBA"),
        beams=Image.fromarray(_beams(a), "RGBA"),
        plant_images=plant_images,
        data=data,
    )
