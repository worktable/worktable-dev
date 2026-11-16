"""The team's Library skills listed as Hermes skills."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from worktable_hermes.client import WorktableError
from worktable_hermes.library import LibrarySkills


class FakeHermes:
    def __init__(self, data_dir: Path) -> None:
        self.state = SimpleNamespace(data_dir=data_dir)
        self.listed: dict[str, str] = {}
        self.described: dict[str, str] = {}

    def register_skill(self, name: str, path: Path, description: str = "") -> None:
        self.listed[name] = Path(path).read_text(encoding="utf-8")
        self.described[name] = description


def library(hermes: FakeHermes, answers: list) -> LibrarySkills:
    def call() -> dict:
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    return LibrarySkills(hermes, reserved=["worktable-create-or-update-docs"], call=call)


RELEASE = {"name": "release-checklist", "description": "Use when shipping a release.", "library": "Worktable"}


def test_lists_each_skill_by_when_to_use_it_and_reads_it_from_worktable(tmp_path: Path) -> None:
    hermes = FakeHermes(tmp_path)
    shadow = {"name": "worktable-create-or-update-docs", "description": "x", "library": "Worktable"}
    assert library(hermes, [{"skills": [RELEASE, shadow]}]).refresh()

    listed = hermes.listed["release-checklist"]
    # Hermes picks a skill by the description it lists beside the name.
    assert hermes.described["release-checklist"] == "Use when shipping a release."
    assert '`worktable_skills_read` {"name": "release-checklist"}' in listed
    # A Library skill never replaces one of the plugin's own.
    assert "worktable-create-or-update-docs" not in hermes.listed


def test_a_restart_lists_the_kept_skills_before_worktable_answers(tmp_path: Path) -> None:
    library(FakeHermes(tmp_path), [{"skills": [RELEASE]}]).refresh()

    restarted = FakeHermes(tmp_path)
    library(restarted, []).register_kept()
    assert "release-checklist" in restarted.listed


def test_a_removed_skill_says_so_until_hermes_restarts_and_a_failed_refresh_changes_nothing(tmp_path: Path) -> None:
    hermes = FakeHermes(tmp_path)
    skills = library(hermes, [{"skills": [RELEASE]}, WorktableError("MCP_UNAVAILABLE", "down"), {"skills": []}, {}])
    skills.refresh()

    assert not skills.refresh()
    assert "Use when shipping" in hermes.listed["release-checklist"]

    skills.refresh()
    assert "Removed from your team's Worktable Library" in hermes.listed["release-checklist"]
    skills.refresh()
    assert not (tmp_path / "library" / "release-checklist").exists()
