"""Where the Worktable connection lives in a Hermes profile.

``plugins.entries.worktable.settings`` holds the connection and who may direct
Hermes through it. The paired token is an environment secret in the profile's
``.env``.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from .access import Access

PLATFORM = "worktable"
MCP_SERVER = "worktable"
TOKEN_ENV = "WORKTABLE_TOKEN"
DEFAULT_PARTICIPANT_NAME = "Hermes"
# A Worktable thread member id, as deliveries name their authors.
MEMBER_ID = re.compile(r"ptc_[A-Za-z0-9_-]{12,}")
# The owner's opt-ins, set with `hermes config set`.
TRUST_SETTINGS = ("trust_all_members", "trust_all_agents")


def member_id(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and MEMBER_ID.fullmatch(value) else None


class Settings:
    def __init__(self, ctx: Any) -> None:
        self._ctx = ctx

    def _get(self, key: str) -> Any:
        return self._ctx.get_config(key)

    @property
    def server(self) -> Optional[str]:
        value = self._get("server")
        return value if isinstance(value, str) and value else None

    @property
    def owner_id(self) -> Optional[str]:
        """The thread member who approved this connection."""
        return member_id(self._get("owner_id"))

    def access(self) -> Access:
        """Read on every message, so a changed setting applies to the next one."""
        return Access(
            owner_id=self.owner_id,
            trust_all_members=self._get("trust_all_members") is True,
            trust_all_agents=self._get("trust_all_agents") is True,
        )

    @property
    def participant_name(self) -> str:
        value = self._get("participant_name")
        return value if isinstance(value, str) and value.strip() else DEFAULT_PARTICIPANT_NAME

    @property
    def pending_pairing_code(self) -> Optional[str]:
        value = self._get("pending_pairing_code")
        return value if isinstance(value, str) and value else None

    @property
    def pairing_error(self) -> Optional[str]:
        value = self._get("pairing_error")
        return value if isinstance(value, str) and value else None

    def save(
        self,
        *,
        server: str,
        participant_name: str,
        owner_id: Optional[str],
        pending_pairing_code: Optional[str],
    ) -> bool:
        """Save a connection. Returns whether it kept the owner's trust settings."""
        # Trust is given to one Worktable's members by one owner. A connection
        # to another Worktable, or approved by someone else, starts closed.
        same = bool(owner_id) and owner_id == self.owner_id and server == self.server
        if not same:
            for key in TRUST_SETTINGS:
                self._ctx.set_config(key, False)
        self._ctx.set_config("server", server)
        self._ctx.set_config("participant_name", participant_name)
        self._ctx.set_config("owner_id", owner_id or "")
        self._ctx.set_config("pending_pairing_code", pending_pairing_code or "")
        self._ctx.set_config("pairing_error", "")
        return same

    def clear(self) -> None:
        for key in ("server", "participant_name", "owner_id", "pending_pairing_code", "pairing_error"):
            self._ctx.set_config(key, "")
        for key in TRUST_SETTINGS:
            self._ctx.set_config(key, False)

    def clear_pending_pairing_code(self) -> None:
        self._ctx.set_config("pending_pairing_code", "")

    def record_pairing_error(self, code: str) -> None:
        """Worktable refused to finish pairing; the profile needs a new code."""
        self._ctx.set_config("pending_pairing_code", "")
        self._ctx.set_config("pairing_error", code)

    @staticmethod
    def token() -> Optional[str]:
        from gateway.platforms._shared import get_scoped_secret

        value = get_scoped_secret(TOKEN_ENV, "")
        return value.strip() or None
