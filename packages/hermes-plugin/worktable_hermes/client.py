"""Worktable thread tools, called through Hermes' own Worktable MCP connection."""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable, Optional

ToolCall = Callable[[str, dict, float], Awaitable[dict]]

# Worktable replies to a waiting claim as soon as a message arrives. Hermes
# serializes calls to one MCP server, so a long wait would also hold up the
# agent's own Worktable tools while it is working.
CLAIM_WAIT_SECONDS = 5
TOOL_TIMEOUT_SECONDS = 35


class WorktableError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _error_code(text: str) -> str:
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("code"), str):
        return parsed["code"][:100]
    match = re.search(r'"code"\s*:\s*"([A-Za-z0-9_]+)"', text)
    if match:
        return match.group(1)
    if "not connected" in text or "unavailable" in text.lower():
        return "MCP_UNAVAILABLE"
    return "WORKTABLE_ERROR"


def parse_envelope(envelope: dict) -> dict:
    """Turn a ``ctx.call_mcp`` envelope into Worktable's JSON result."""
    if not envelope.get("ok"):
        error = envelope.get("error")
        text = error if isinstance(error, str) else json.dumps(error)
        raise WorktableError(_error_code(text), text)
    structured = envelope.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    result = envelope.get("result")
    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except ValueError:
            raise WorktableError("INVALID_RESULT", "Worktable returned a non-JSON result") from None
        if isinstance(parsed, dict):
            return parsed
    raise WorktableError("INVALID_RESULT", "Worktable returned an empty result")


class WorktableTools:
    """The thread and delivery operations the connector needs."""

    def __init__(self, call: ToolCall) -> None:
        self._call = call

    async def _request(self, tool: str, request: dict, timeout: float = TOOL_TIMEOUT_SECONDS) -> dict:
        return await self._call(tool, {"request": request}, timeout)

    async def participants(self) -> list[dict]:
        result = await self._request("worktable_threads_read", {"action": "participants"})
        return list(result.get("participants") or [])

    async def register_participant(self, name: str) -> dict:
        result = await self._request(
            "worktable_thread_delivery", {"action": "register_participant", "name": name}
        )
        return dict(result.get("participant") or {})

    async def claim(self, wait_seconds: int = CLAIM_WAIT_SECONDS) -> Optional[dict]:
        result = await self._request(
            "worktable_thread_delivery",
            {"action": "claim", "waitSeconds": wait_seconds, "threadLocationVersion": 2},
            timeout=wait_seconds + TOOL_TIMEOUT_SECONDS,
        )
        delivery = result.get("delivery")
        return delivery if isinstance(delivery, dict) else None

    async def accept(self, message_id: str, lease_id: str) -> None:
        await self._request(
            "worktable_thread_delivery",
            {"action": "accept", "messageId": message_id, "leaseId": lease_id},
        )

    async def progress(self, message_id: str, lease_id: str, phase: str = "working") -> None:
        await self._request(
            "worktable_thread_delivery",
            {"action": "progress", "messageId": message_id, "leaseId": lease_id, "phase": phase},
        )

    async def fail(self, message_id: str, lease_id: str, retryable: bool, code: str, message: str) -> None:
        await self._request(
            "worktable_thread_delivery",
            {
                "action": "fail",
                "messageId": message_id,
                "leaseId": lease_id,
                "retryable": retryable,
                "code": code,
                "message": message,
            },
        )

    async def reply(self, reply: dict[str, Any]) -> dict:
        return await self._request(
            "worktable_threads_write",
            {
                "action": "post",
                **reply,
                "notifyIdentityIds": [],
                "responseIdentityId": None,
                "waitSeconds": 0,
            },
        )

    async def post(self, message: dict[str, Any]) -> dict:
        return await self._request(
            "worktable_threads_write", {"action": "post", **message, "waitSeconds": 0}
        )
