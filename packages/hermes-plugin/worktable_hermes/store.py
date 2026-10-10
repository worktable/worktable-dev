"""Durable delivery state kept in Hermes' per-plugin state file.

Three records survive a gateway restart:

* ``pending``: the Worktable message each Hermes chat is currently answering.
  Hermes resumes an interrupted turn on its own after a restart and delivers
  the reply without naming the message, so the chat identifies it.
* ``outbox``: replies produced but not yet appended to Worktable.
* ``completed``: messages already answered, so a redelivery is not run twice.

``attempts`` counts dispatches per message so a retry reaches Hermes as a new
message.
"""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Optional, Protocol

COMPLETED_TTL_SECONDS = 30 * 24 * 60 * 60
MAX_COMPLETED = 2_000


class KeyValueState(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...


class MemoryState:
    def __init__(self) -> None:
        self.values: dict[str, Any] = {}

    def get(self, key: str, default: Any = None) -> Any:
        return self.values.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value


class DeliveryStore:
    def __init__(self, state: KeyValueState, clock=time.time) -> None:
        self._state = state
        self._clock = clock
        self._lock = threading.Lock()

    def _read(self, key: str) -> dict:
        value = self._state.get(key, {})
        return dict(value) if isinstance(value, dict) else {}

    def _update(self, key: str, change) -> Any:
        with self._lock:
            value = self._read(key)
            result = change(value)
            self._state.set(key, value)
            return result

    def installation_id(self) -> str:
        """A stable id for this Hermes profile's Worktable connection."""
        with self._lock:
            existing = self._state.get("installation_id")
            if isinstance(existing, str) and existing:
                return existing
            created = f"hci_{secrets.token_urlsafe(18)}"
            self._state.set("installation_id", created)
            return created

    def is_completed(self, event: str) -> bool:
        return event in self._read("completed")

    def retained(self, event: str) -> Optional[dict]:
        reply = self._read("outbox").get(event)
        return reply if isinstance(reply, dict) else None

    def retain(self, event: str, reply: dict) -> None:
        self._update("outbox", lambda outbox: outbox.__setitem__(event, reply))

    def pending(self, conversation: str) -> Optional[dict]:
        record = self._read("pending").get(conversation)
        return record if isinstance(record, dict) else None

    def begin(self, conversation: str, event: str, delivery: dict) -> int:
        """Record a dispatch and return its attempt number, starting at 1."""

        def count(attempts: dict) -> int:
            attempt = int(attempts.pop(event, 0)) + 1
            attempts[event] = attempt
            for stale in list(attempts)[:-MAX_COMPLETED]:
                del attempts[stale]
            return attempt

        attempt = self._update("attempts", count)
        self._update(
            "pending",
            lambda pending: pending.__setitem__(
                conversation, {"event": event, "delivery": delivery, "dispatchedAt": self._clock()}
            ),
        )
        return attempt

    def retain_for_conversation(self, conversation: str, reply_for) -> Optional[str]:
        """Keep a reply Hermes produced for a chat's pending message, if there is one."""
        record = self.pending(conversation)
        if not record:
            return None
        self.retain(record["event"], reply_for(record["delivery"]))
        return record["event"]

    def complete(self, conversation: str, event: str) -> None:
        now = self._clock()

        def mark(completed: dict) -> None:
            completed[event] = now
            fresh = [(key, at) for key, at in completed.items() if now - at < COMPLETED_TTL_SECONDS]
            completed.clear()
            completed.update(sorted(fresh, key=lambda item: item[1])[-MAX_COMPLETED:])

        self._update("completed", mark)
        self._update("outbox", lambda outbox: outbox.pop(event, None))
        self._update("attempts", lambda attempts: attempts.pop(event, None))
        self.forget_pending(conversation, event)

    def forget_pending(self, conversation: str, event: str) -> None:
        """A turn that failed while Hermes kept running is not resumed later."""

        def clear(pending: dict) -> None:
            if (pending.get(conversation) or {}).get("event") == event:
                pending.pop(conversation, None)

        self._update("pending", clear)
