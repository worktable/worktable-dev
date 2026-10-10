"""Hermes plugin entry point."""

from __future__ import annotations

from pathlib import Path
from typing import Any

SKILLS = Path(__file__).resolve().parent.parent / "skills"


def register(ctx: Any) -> None:
    from .adapter import register_platform
    from .cli import register_cli

    register_platform(ctx)
    register_cli(ctx)
    for skill in sorted(SKILLS.glob("*/SKILL.md")):
        ctx.register_skill(skill.parent.name, skill)
