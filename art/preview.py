"""Write enlarged previews of generated sheets to a directory given on the command line."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

from characters import all_character_sheets
from common import preview
from environment import carpet_sheets, floor_tiles, wall_sheet
from furniture import furniture_images

MAGENTA = (255, 0, 255, 255)


def stack(images: list[Image.Image], horizontal: bool, gap: int) -> Image.Image:
    if horizontal:
        w = sum(i.width for i in images) + gap * (len(images) - 1)
        h = max(i.height for i in images)
    else:
        w = max(i.width for i in images)
        h = sum(i.height for i in images) + gap * (len(images) - 1)
    board = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    pos = 0
    for i in images:
        if horizontal:
            board.alpha_composite(i, (pos, h - i.height))
            pos += i.width + gap
        else:
            board.alpha_composite(i, (0, pos))
            pos += i.height + gap
    return board


def furniture_board(max_width: int) -> Image.Image:
    rows: list[list[Image.Image]] = [[]]
    width = 0
    for img in furniture_images().values():
        if width + img.width > max_width and rows[-1]:
            rows.append([])
            width = 0
        rows[-1].append(img)
        width += img.width + 3
    return stack([stack(r, True, 3) for r in rows], False, 3)


def main(out_dir: Path) -> None:
    preview(stack(all_character_sheets(), False, 2), 4).save(
        out_dir / "chars_board.png"
    )
    env = stack(
        [stack(floor_tiles(), True, 2), wall_sheet(), stack(carpet_sheets(), True, 2)],
        False,
        4,
    )
    preview(env, 4, MAGENTA).save(out_dir / "env_board.png")
    preview(furniture_board(260), 4, MAGENTA).save(out_dir / "furn_board.png")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
