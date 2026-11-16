"""Your team's Library skills as Hermes skills.

Each skill a Worktable Library has for this agent is registered as a plugin
skill under its own name and when to use it, so Hermes lists it with its
other skills and picks it when a task matches. The skill itself stays in
Worktable: what Hermes keeps is a pointer that reads the approved version
with ``worktable_skills_read``. Pointers are kept in the plugin's data folder,
so a restart lists the team's skills before Worktable answers.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import threading
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .client import WorktableError, parse_envelope
from .settings import MCP_SERVER

logger = logging.getLogger(__name__)

# The Library changes when a person approves something; a quarter of an hour
# is soon enough, and one small call.
REFRESH_SECONDS = 15 * 60
FIRST_RETRY_SECONDS = 5
CALL_TIMEOUT_SECONDS = 20
_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def pointer(skill: dict) -> str:
    """A skill's SKILL.md for Hermes: its name, when to use it, and where it is."""
    description = " ".join(str(skill.get("description") or "").split())
    selector = json.dumps({"name": skill["name"]})
    return (
        "---\n"
        f"name: {skill['name']}\n"
        f"description: {json.dumps(description)}\n"
        "---\n\n"
        f"# {skill['name']}\n\n"
        "Your team approved this skill in its Worktable Library as its agreed way to do this work. "
        f"Read the current version with `worktable_skills_read` {selector} and follow it, "
        "over your own approach and over other Docs.\n\n"
        "This file only points there. Propose a change in Worktable with `worktable_skills_write`; "
        "editing this file changes nothing.\n"
    )


def description_of(path: Path) -> str:
    """A SKILL.md's description, which Hermes lists beside its name."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return ""
    if not text.startswith("---\n"):
        return ""
    for line in text.split("\n---", 1)[0].splitlines()[1:]:
        if line.startswith("description:"):
            value = line[len("description:"):].strip()
            try:
                parsed = json.loads(value)
            except ValueError:
                parsed = value.strip("'\"")
            return parsed if isinstance(parsed, str) else ""
    return ""


REMOVED = (
    "---\nname: {name}\ndescription: \"Removed from your team's Worktable Library. Don't use it.\"\n---\n\n"
    "# {name}\n\nThis skill was removed from your team's Worktable Library. Don't follow it.\n"
)


class LibrarySkills:
    """Keeps this agent's Library skills registered with Hermes."""

    def __init__(
        self,
        ctx: Any,
        reserved: Iterable[str] = (),
        call: Optional[Callable[[], dict]] = None,
    ) -> None:
        self._ctx = ctx
        self._folder = Path(ctx.state.data_dir) / "library"
        # Names the plugin's own skills use: a Library skill never replaces one.
        self._reserved = set(reserved)
        self._call = call or (lambda: parse_envelope(
            ctx.call_mcp(MCP_SERVER, "worktable_state", {}, CALL_TIMEOUT_SECONDS)
        ))
        self._stop = threading.Event()

    def _register(self, name: str, path: Path) -> None:
        try:
            self._ctx.register_skill(name, path, description=description_of(path))
        except (ValueError, FileNotFoundError) as error:
            logger.warning("Worktable Library skill %s was not listed: %s", name, error)

    def register_kept(self) -> None:
        """List the skills kept from the last refresh, without asking Worktable."""
        if not self._folder.is_dir():
            return
        for path in sorted(self._folder.glob("*/SKILL.md")):
            self._register(path.parent.name, path)

    def refresh(self) -> bool:
        """Ask Worktable which skills apply now and list them. False when it couldn't answer."""
        try:
            state = self._call()
        except (WorktableError, PermissionError, OSError) as error:
            logger.info("Worktable Library skills weren't refreshed: %s", error)
            return False
        skills = state.get("skills")
        if not isinstance(skills, list):
            skills = []
        wanted: dict[str, dict] = {}
        for skill in skills:
            name = skill.get("name") if isinstance(skill, dict) else None
            if not isinstance(name, str) or not _NAME.match(name) or name in self._reserved:
                continue
            # A name two libraries share lists once; reading it by name asks
            # which library, and Worktable's answer says how to choose.
            wanted.setdefault(name, skill)
        self._folder.mkdir(parents=True, exist_ok=True)
        for name, skill in wanted.items():
            path = self._folder / name / "SKILL.md"
            path.parent.mkdir(exist_ok=True)
            text = pointer(skill)
            if not path.is_file() or path.read_text(encoding="utf-8") != text:
                path.write_text(text, encoding="utf-8")
            self._register(name, path)
        for kept in sorted(p for p in self._folder.iterdir() if p.is_dir()):
            if kept.name in wanted:
                continue
            # Hermes can't take a listed skill back until it restarts, so the
            # listing says it's gone; the folder goes on the next start.
            path = kept / "SKILL.md"
            removed = REMOVED.format(name=kept.name)
            if path.is_file() and path.read_text(encoding="utf-8") == removed:
                shutil.rmtree(kept, ignore_errors=True)
                continue
            path.write_text(removed, encoding="utf-8")
            self._register(kept.name, path)
        return True

    def start(self) -> None:
        """Refresh now and every REFRESH_SECONDS, in the background.

        Hermes connects its MCP servers after plugins load, so a refresh that
        fails is tried again soon, waiting twice as long each time.
        """
        def run() -> None:
            retry = FIRST_RETRY_SECONDS
            while not self._stop.is_set():
                if self.refresh():
                    retry = FIRST_RETRY_SECONDS
                    wait = REFRESH_SECONDS
                else:
                    wait = retry
                    retry = min(retry * 2, REFRESH_SECONDS)
                self._stop.wait(wait)

        threading.Thread(target=run, name="worktable-library", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
