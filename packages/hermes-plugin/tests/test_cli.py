"""What `hermes worktable connect` records about who may direct Hermes."""

from types import SimpleNamespace

import pytest

from worktable_hermes import cli, pairing
from worktable_hermes.settings import Settings
from worktable_hermes.store import MemoryState

OWNER, SOMEONE_ELSE = "ptc_maya_owner_01", "ptc_sam_member_01"


class Profile:
    def __init__(self):
        self.state = MemoryState()
        self.settings = {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def set_config(self, key, value):
        self.settings[key] = value


@pytest.fixture
def connect(monkeypatch):
    """Pair with a Worktable that answers as `redeemed` says."""
    profile = Profile()
    monkeypatch.setattr(cli, "_config_set", lambda *_: None)
    monkeypatch.setattr(cli, "_save_token", lambda _token: None)
    monkeypatch.setattr(pairing, "report", lambda *_: None)

    def run(server="https://worktable.example", **redeemed):
        monkeypatch.setattr(
            pairing,
            "redeem",
            lambda origin, *_: {"token": "wt_secret", "mcpUrl": f"{origin}/api/mcp", **redeemed},
        )
        args = SimpleNamespace(server=server, pairing_code="T83PD-NSQDP", name=None)
        assert cli.connect(profile, args) == 0
        return Settings(profile).access()

    return profile, run


def test_connecting_records_the_person_who_approved_and_trusts_nobody_else(connect, capsys):
    _profile, run = connect
    access = run(ownerMemberId=OWNER)
    assert (access.owner_id, access.trust_all_members, access.trust_all_agents) == (OWNER, False, False)
    assert "takes direction from: the person who connected it" in capsys.readouterr().out


def test_a_worktable_that_names_no_approver_leaves_hermes_closed(connect, capsys):
    profile, run = connect
    profile.settings.update(trust_all_members=True)
    for answer in ({}, {"ownerMemberId": "everyone"}, {"ownerMemberId": None}):
        access = run(**answer)
        assert access.refusal({"id": OWNER, "kind": "human"}, "Hermes").code == "OWNER_UNKNOWN"
    assert "Update that Worktable" in capsys.readouterr().err
    assert cli.status(profile, None) == 1


def test_trust_stays_with_the_owner_and_worktable_it_was_given_for(connect):
    profile, run = connect
    run(ownerMemberId=OWNER)
    profile.settings.update(trust_all_members=True, trust_all_agents=True)

    # Connecting again as the same person keeps what that person chose.
    again = run(ownerMemberId=OWNER)
    assert again.trust_all_members and again.trust_all_agents

    # Another approver, or another Worktable, starts closed.
    other_owner = run(ownerMemberId=SOMEONE_ELSE)
    assert (other_owner.owner_id, other_owner.trust_all_members, other_owner.trust_all_agents) == (
        SOMEONE_ELSE,
        False,
        False,
    )
    profile.settings.update(trust_all_members=True)
    moved = run(server="https://other.example", ownerMemberId=SOMEONE_ELSE)
    assert not moved.trust_all_members
