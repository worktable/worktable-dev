"""Who may direct this Hermes from a Worktable thread.

A turn runs with the profile's terminal, file and MCP tools on the machine
Hermes runs on, so the rule is the operator's: the person who approved the
connection, plus whoever that person chose to trust in the plugin's settings.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Refusal:
    code: str
    message: str


@dataclass(frozen=True)
class Access:
    # The thread member who approved the connection, recorded at pairing.
    owner_id: Optional[str]
    # The owner's opt-ins. Both are off unless the owner turns them on.
    trust_all_members: bool = False
    trust_all_agents: bool = False

    def refusal(self, sender: dict, name: str) -> Optional[Refusal]:
        """Why this author's message is not run, or None when it may run."""
        if not self.owner_id:
            # Nobody is on record, so nobody is let in, whatever else is set.
            return Refusal(
                "OWNER_UNKNOWN",
                f"Connect {name} to Worktable again before it can answer: hermes worktable connect",
            )
        kind = sender.get("kind")
        # The owner is a person the thread lists; an id alone is not enough.
        if sender.get("id") == self.owner_id and kind == "human":
            return None
        if kind == "agent":
            if self.trust_all_agents:
                return None
            return Refusal("AGENT_NOT_TRUSTED", f"{name} does not take direction from other agents.")
        # A person, or an author Worktable does not describe: never trusted as one.
        if kind == "human" and self.trust_all_members:
            return None
        return Refusal("NOT_OWNER", f"Only the person who connected {name} can direct it.")
