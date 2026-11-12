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


def test_connecting_records_the_person_who_approved_and_opts_into_nobody_else(connect, capsys):
    _profile, run = connect
    access = run(ownerMemberId=OWNER)
    assert (access.owner_id, access.trust_own_agents, access.trust_all_members, access.trust_all_agents) == (
        OWNER,
        True,
        False,
        False,
    )
    assert (
        "takes direction from: the person who connected it, the agents that person connected. Everyone else"
        in capsys.readouterr().out
    )


def test_a_worktable_that_names_no_approver_records_nobody_and_says_what_follows(connect, capsys):
    profile, run = connect
    profile.settings.update(trust_all_members=True)
    for answer in ({}, {"ownerMemberId": "everyone"}, {"ownerMemberId": None}):
        access = run(**answer)
        # Nobody is recorded, and no opt-in outlives that.
        assert (access.owner_id, access.trust_all_members) == (None, False)
    assert "until it is updated to 0.1.45 or later" in capsys.readouterr().err
    # The connection itself is fine: a current Worktable names its owner.
    # `status` says what an older one means for it.
    assert cli.status(profile, None) == 0
    assert "One older than 0.1.45 cannot" in capsys.readouterr().out


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
    # Having turned the owner's own agents off is a restriction, and stays.
    profile.settings.update(trust_all_members=True, trust_own_agents=False)
    moved = run(server="https://other.example", ownerMemberId=SOMEONE_ELSE)
    assert not moved.trust_all_members and not moved.trust_own_agents
