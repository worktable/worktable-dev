"""Worktable HTTP endpoints used to set up a connection."""

from __future__ import annotations

import json
import time
from datetime import datetime
import urllib.error
import urllib.request
from typing import Callable, Optional
from urllib.parse import urlsplit

TIMEOUT_SECONDS = 15
# Worktable Cloud's edge refuses requests without a product User-Agent.
USER_AGENT = "worktable-hermes/0.1.0"


class PairingError(Exception):
    def __init__(self, message: str, code: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def worktable_origin(server: str) -> str:
    parts = urlsplit(server.strip() if "://" in server else f"https://{server.strip()}")
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise PairingError(f"Not a Worktable address: {server}", "BAD_SERVER")
    return f"{parts.scheme}://{parts.netloc}"


def _timestamp(value: object) -> Optional[float]:
    """Seconds since the epoch for an ISO 8601 time, or None."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _request(url: str, body: Optional[dict] = None, token: Optional[str] = None) -> dict:
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read() or b"{}")
            return payload if isinstance(payload, dict) else {}
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b"{}")
        except ValueError:
            payload = {}
        raise PairingError(
            payload.get("error") or f"Worktable returned HTTP {error.code}",
            payload.get("code") or f"HTTP_{error.code}",
            error.code,
        ) from None
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise PairingError(f"Could not reach Worktable at {url}: {error}", "UNREACHABLE") from None


def mcp_resource(origin: str) -> Optional[str]:
    """The MCP endpoint a Worktable advertises for OAuth sign-in, if any."""
    try:
        metadata = _request(f"{origin}/.well-known/oauth-protected-resource")
    except PairingError:
        return None
    resource = metadata.get("resource")
    servers = metadata.get("authorization_servers")
    return resource if isinstance(resource, str) and isinstance(servers, list) and servers else None


def redeem(origin: str, code: str, hostname: str, installation_id: str) -> dict:
    result = _request(
        f"{origin}/api/pairing/redeem",
        {"code": code, "hostname": hostname, "installationId": installation_id},
    )
    if not isinstance(result.get("token"), str) or not isinstance(result.get("mcpUrl"), str):
        raise PairingError("Worktable returned an incomplete pairing", "INVALID_PAIRING")
    return result


def report(origin: str, code: str, event: str, detail: str) -> None:
    """Progress is informative; a dropped report never fails setup."""
    try:
        _request(f"{origin}/api/pairing/progress", {"code": code, "event": event, "detail": detail})
    except PairingError:
        pass


def complete(origin: str, code: str, token: str, attempts: int = 3) -> None:
    for attempt in range(1, attempts + 1):
        try:
            _request(f"{origin}/api/pairing/complete", {"code": code}, token)
            return
        except PairingError as error:
            if (error.status is not None and error.status < 500) or attempt == attempts:
                raise
            time.sleep(0.25 * attempt)


def request_approval(
    origin: str,
    installation_id: str,
    hostname: str,
    name: Optional[str],
    on_approval_needed: Callable[[str, str], None],
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """Ask Worktable to connect; return the pairing code once its owner approves."""
    request = _request(
        f"{origin}/api/pairing/requests",
        {
            "target": {"kind": "agent-adapter", "adapter": "hermes", "installationId": installation_id},
            "hostname": hostname,
            **({"name": name} if name else {}),
        },
    )
    poll_token = request.get("pollToken")
    if not isinstance(poll_token, str) or not isinstance(request.get("approvalUrl"), str):
        raise PairingError("Worktable returned an incomplete connection request", "INVALID_REQUEST")
    on_approval_needed(str(request.get("code")), request["approvalUrl"])
    interval = max(1.0, float(request.get("interval") or 2))
    # Whatever it answers, a request is over when it expires.
    deadline = _timestamp(request.get("expiresAt"))
    while True:
        sleep(interval)
        result = _request(f"{origin}/api/pairing/requests/poll", {"pollToken": poll_token})
        status = result.get("status")
        if status == "approved" and isinstance(result.get("code"), str):
            return result["code"]
        if status == "denied":
            raise PairingError("The Worktable owner declined this connection.", "DENIED")
        if status == "expired" or (deadline is not None and time.time() >= deadline):
            raise PairingError("The connection request expired. Run the connect command again.", "EXPIRED")
