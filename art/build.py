"""Regenerate every bundled art asset and the default layout's tile colours.

Run from anywhere: `python art/build.py`. Output goes to webview-ui/public/assets/.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from characters import all_character_sheets
from environment import carpet_sheets, floor_tiles, wall_sheet
from furniture import furniture_images

ASSETS = Path(__file__).resolve().parent.parent / "webview-ui" / "public" / "assets"
LAYOUT = ASSETS / "default-layout-1.json"

TileColor = dict[str, int]

# Tile type -> Colorize HSBC. 0 = wall, 7 = work room planks, 1 = lounge, 9 = pantry checker.
THEME: dict[int, TileColor] = {
    0: {"h": 205, "s": 28, "b": 0, "c": 0},
    7: {"h": 34, "s": 50, "b": 24, "c": -20},
    1: {"h": 204, "s": 60, "b": 14, "c": -30},
    9: {"h": 204, "s": 35, "b": 4, "c": -10},
}

ENTRY = re.compile(r"null|\{[^{}]*\}")


def write_images() -> list[Path]:
    written: list[Path] = []
    for i, sheet in enumerate(all_character_sheets()):
        written.append(ASSETS / "characters" / f"char_{i}.png")
        sheet.save(written[-1])
    for i, tile in enumerate(floor_tiles()):
        written.append(ASSETS / "floors" / f"floor_{i}.png")
        tile.save(written[-1])
    written.append(ASSETS / "walls" / "wall_0.png")
    wall_sheet().save(written[-1])
    for i, sheet in enumerate(carpet_sheets()):
        written.append(ASSETS / "carpets" / f"carpet_{i}.png")
        sheet.save(written[-1])
    for key, img in furniture_images().items():
        path = ASSETS / "furniture" / f"{key}.png"
        if not path.parent.is_dir():
            raise FileNotFoundError(
                f"furniture folder missing for {key}: {path.parent}"
            )
        img.save(path)
        written.append(path)
    return written


def themed_layout_text(text: str) -> str:
    layout = json.loads(text)
    tiles: list[int] = layout["tiles"]
    start = text.index('"tileColors"')
    open_bracket = text.index("[", start)
    close_bracket = text.index("]", open_bracket)
    body = text[open_bracket + 1 : close_bracket]
    entries = list(ENTRY.finditer(body))
    if len(entries) != len(tiles):
        raise ValueError(
            f"tileColors has {len(entries)} entries but tiles has {len(tiles)}"
        )
    parts: list[str] = []
    cursor = 0
    for match, tile in zip(entries, tiles, strict=True):
        parts.append(body[cursor : match.start()])
        if tile == 255:
            parts.append("null")
        elif tile in THEME:
            parts.append(json.dumps(THEME[tile], separators=(",", ":")))
        else:
            raise ValueError(f"no theme colour for tile type {tile}")
        cursor = match.end()
    parts.append(body[cursor:])
    return text[: open_bracket + 1] + "".join(parts) + text[close_bracket:]


def main() -> None:
    written = write_images()
    original = LAYOUT.read_text(encoding="utf-8")
    LAYOUT.write_text(themed_layout_text(original), encoding="utf-8", newline="\n")
    print(f"wrote {len(written)} images and themed {LAYOUT.name}")


if __name__ == "__main__":
    main()
