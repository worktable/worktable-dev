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
    from .library import description_of

    bundled = sorted(SKILLS.glob("*/SKILL.md"))
    for skill in bundled:
        # Hermes lists a skill with its description, which is how it picks one.
        ctx.register_skill(skill.parent.name, skill, description=description_of(skill))
    register_library(ctx, reserved=[skill.parent.name for skill in bundled])


def register_library(ctx: Any, reserved: list[str]) -> None:
    """List the team's Library skills once this profile is connected to Worktable."""
    from .library import LibrarySkills
    from .settings import Settings

    if not Settings(ctx).server:
        return
    library = LibrarySkills(ctx, reserved=reserved)
    library.register_kept()
    library.start()
