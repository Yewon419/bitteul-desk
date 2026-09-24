"""Geometry types shared by the scene preparation scripts."""

from __future__ import annotations

from dataclasses import dataclass

Point = tuple[int, int]


@dataclass(frozen=True)
class Rect:
    x0: int
    y0: int
    x1: int
    y1: int
