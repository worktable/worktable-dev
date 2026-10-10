"""Where the Worktable connection lives in a Hermes profile.

``plugins.entries.worktable.settings`` holds the connection. A paired token is
an environment secret in the profile's ``.env``; an OAuth sign-in is held by
Hermes' own MCP client.
"""

from __future__ import annotations

from typing import Any, Optional

PLATFORM = "worktable"
MCP_SERVER = "worktable"
TOKEN_ENV = "WORKTABLE_TOKEN"
DEFAULT_PARTICIPANT_NAME = "Hermes"


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
    def auth(self) -> str:
        return "oauth" if self._get("auth") == "oauth" else "token"

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

    @property
    def participant_registered(self) -> bool:
        return self._get("participant_registered") is True

    def save(self, *, server: str, auth: str, participant_name: str, pending_pairing_code: Optional[str]) -> None:
        self._ctx.set_config("server", server)
        self._ctx.set_config("auth", auth)
        self._ctx.set_config("participant_name", participant_name)
        self._ctx.set_config("pending_pairing_code", pending_pairing_code or "")
        self._ctx.set_config("pairing_error", "")
        self._ctx.set_config("participant_registered", False)

    def clear(self) -> None:
        for key in ("server", "auth", "participant_name", "pending_pairing_code", "pairing_error"):
            self._ctx.set_config(key, "")
        self._ctx.set_config("participant_registered", False)

    def clear_pending_pairing_code(self) -> None:
        self._ctx.set_config("pending_pairing_code", "")

    def record_pairing_error(self, code: str) -> None:
        """Worktable refused to finish pairing; the profile needs a new code."""
        self._ctx.set_config("pending_pairing_code", "")
        self._ctx.set_config("pairing_error", code)

    def mark_participant_registered(self) -> None:
        self._ctx.set_config("participant_registered", True)

    @staticmethod
    def token() -> Optional[str]:
        from gateway.platforms._shared import get_scoped_secret

        value = get_scoped_secret(TOKEN_ENV, "")
        return value.strip() or None
