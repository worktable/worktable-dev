"""Who may direct this Hermes from a Worktable thread.

A turn runs with the profile's terminal, file and MCP tools on the machine
Hermes runs on, so the rule is the operator's: the person who connected it,
the other agents that person connected, and whoever that person chose to
trust in the plugin's settings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

# The oldest Worktable that says, with each message, who connected whom.
OWNER_TELLING_WORKTABLE_VERSION = "0.1.45"
# A Worktable thread member id, as deliveries name people and agents.
MEMBER_ID = re.compile(r"ptc_[A-Za-z0-9_-]{12,}")
# Every person and agent a Worktable lists is its one person, or that
# person's: a Worktable that has no teammates. Its person may post as more
# than one thread member, so no single member id stands for them.
ONE_PERSON = object()


def member_id(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and MEMBER_ID.fullmatch(value) else None


@dataclass(frozen=True)
class Refusal:
    code: str
    message: str


@dataclass(frozen=True)
class Ownership:
    """What is known for one message about who connected whom."""

    # Whether this Worktable says who connected its agents.
    told: bool
    # The person who connected this Hermes: a member id, or ONE_PERSON.
    owner: Any = None
    # The person who connected the author, when the author is an agent.
    author_owner: Optional[str] = None


async def resolve_ownership(
    connected_by: Any,
    recorded_owner: Optional[str],
    is_one_person_worktable: Callable[[], Awaitable[bool]],
) -> Ownership:
    """Who connected this Hermes and the message's author.

    Worktable is the authority and says so with each delivery, so a connection
    made by any earlier plugin has its owner without connecting again: that it
    has one person, or who connected each agent. An older Worktable does not
    say: asked whether it has one person, it is treated the same way, and
    otherwise the owner recorded at pairing stands.
    """
    if isinstance(connected_by, dict):
        if connected_by.get("onePerson") is True:
            return Ownership(told=True, owner=ONE_PERSON)
        return Ownership(
            told=True,
            # An agent the team owns has nobody; its pairing recorded who approved.
            owner=member_id(connected_by.get("recipient")) or recorded_owner,
            author_owner=member_id(connected_by.get("author")),
        )
    if await is_one_person_worktable():
        return Ownership(told=False, owner=ONE_PERSON)
    return Ownership(told=False, owner=recorded_owner)


@dataclass(frozen=True)
class Access:
    """The operator's settings, under ``plugins.entries.worktable.settings``."""

    # The thread member who approved the connection, as recorded at pairing.
    # Worktable names the owner with each message; this stands in where it
    # does not.
    owner_id: Optional[str]
    # Agents the owner connected. On unless the owner turns it off.
    trust_own_agents: bool = True
    # The owner's opt-ins. Both are off unless the owner turns them on.
    trust_all_members: bool = False
    trust_all_agents: bool = False

    def refusal(self, ownership: Ownership, sender: dict, name: str) -> Optional[Refusal]:
        """Why this author's message is not run, or None when it may run."""
        owner = ownership.owner
        if not owner:
            # Nobody is known to have connected it, so nobody is let in,
            # whatever else is set.
            if ownership.told:
                return Refusal("OWNER_UNKNOWN", f"Connect {name} to Worktable again before it can answer.")
            return Refusal(
                "WORKTABLE_TOO_OLD",
                f"Update this Worktable to {OWNER_TELLING_WORKTABLE_VERSION} or later before {name} can answer.",
            )
        kind = sender.get("kind")
        if kind == "human":
            # The owner is a person the thread lists; an id alone is not enough.
            if owner is ONE_PERSON or sender.get("id") == owner or self.trust_all_members:
                return None
            return Refusal("NOT_OWNER", f"Only the person who connected {name} can direct it.")
        if kind == "agent":
            # An agent with nobody on record is not the owner's own.
            own = owner is ONE_PERSON or (ownership.author_owner is not None and ownership.author_owner == owner)
            if (own and self.trust_own_agents) or self.trust_all_agents:
                return None
            return Refusal("AGENT_NOT_TRUSTED", f"{name} does not take direction from this agent.")
        # An author Worktable does not describe is never trusted.
        return Refusal("NOT_OWNER", f"Only the person who connected {name} can direct it.")
