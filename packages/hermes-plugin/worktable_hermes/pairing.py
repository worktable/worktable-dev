"""Worktable HTTP endpoints used to set up a connection."""

from __future__ import annotations

import http.client
import json
import time
from datetime import datetime
import urllib.error
import urllib.request
from typing import Callable, Optional
from urllib.parse import urlsplit

TIMEOUT_SECONDS = 15
# Worktable Cloud's edge refuses requests without a product User-Agent.
USER_AGENT = "worktable-hermes/0.1.3"
# Worktable Cloud serves every workspace from this host.
CLOUD_HOST = "app.worktable.cloud"
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


class PairingError(Exception):
    def __init__(self, message: str, code: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def worktable_origin(server: str) -> str:
    """The Worktable address, path included: Cloud gives each workspace one under /w/<id>."""
    parts = urlsplit(server.strip() if "://" in server else f"https://{server.strip()}")
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise PairingError(f"Not a Worktable address: {server}", "BAD_SERVER")
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


def _host(parts) -> str:
    host = (parts.hostname or "").lower()
    return "loopback" if host in _LOOPBACK else host


def known_address(given: str, returned: str) -> str:
    """An address Worktable answered with, accepted only on the host the user
    gave or on Worktable Cloud. The token and every later request go there."""
    asked = urlsplit(given)
    try:
        answer = urlsplit(returned)
        answer.hostname
    except ValueError:
        # Not an address at all, such as an unclosed IPv6 bracket.
        raise PairingError(
            f"Worktable at {asked.netloc} answered with an address Hermes can't read.",
            "ADDRESS_MISMATCH",
        ) from None
    same_host = bool(answer.hostname) and _host(answer) == _host(asked)
    # Never from an encrypted address to a plain one.
    downgraded = asked.scheme == "https" and answer.scheme != "https"
    cloud = answer.scheme == "https" and (answer.hostname or "").lower() == CLOUD_HOST
    if answer.scheme in ("http", "https") and ((same_host and not downgraded) or cloud):
        return returned
    raise PairingError(
        f"Worktable at {asked.netloc} answered with an address somewhere else: "
        f"{answer.scheme}://{answer.netloc}. If that is your Worktable, run connect with that address.",
        "ADDRESS_MISMATCH",
    )


# Consecutive failed checks tolerated when a request has no expiry.
MAX_WAIT_FAILURES = 30


def _retryable_wait_error(error: PairingError) -> bool:
    return error.status is None or error.status == 429 or error.status >= 500


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
        except (ValueError, http.client.HTTPException, OSError):
            # An unreadable or cut-off body still has its status.
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        raise PairingError(
            payload.get("error") or f"Worktable returned HTTP {error.code}",
            payload.get("code") or f"HTTP_{error.code}",
            error.code,
        ) from None
    except (urllib.error.URLError, TimeoutError, ValueError, http.client.HTTPException, OSError) as error:
        # Includes a connection cut partway through the answer.
        raise PairingError(f"Could not reach Worktable at {url}: {error}", "UNREACHABLE") from None


def redeem(origin: str, code: str, hostname: str, installation_id: str) -> dict:
    result = _request(
        f"{origin}/api/pairing/redeem",
        {"code": code, "hostname": hostname, "installationId": installation_id},
    )
    if not isinstance(result.get("token"), str) or not isinstance(result.get("mcpUrl"), str):
        raise PairingError("Worktable returned an incomplete pairing", "INVALID_PAIRING")
    try:
        known_address(origin, result["mcpUrl"])
    except PairingError:
        # The token is dropped here, so Worktable can retire it.
        report(origin, code, "failed_no_config", "Hermes refused a Worktable address on another host.")
        raise
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
) -> tuple[str, str]:
    """Ask Worktable to connect; once its owner approves, return the pairing
    code and the address to pair with (on Cloud, the approved workspace's)."""
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
    failures = 0
    while True:
        sleep(interval)
        try:
            result = _request(f"{origin}/api/pairing/requests/poll", {"pollToken": poll_token})
            failures = 0
        except PairingError as error:
            # A dropped connection, a restarting Worktable, or a busy one does
            # not end the wait for approval; anything else does.
            failures += 1
            expired = time.time() >= deadline if deadline is not None else failures > MAX_WAIT_FAILURES
            if not _retryable_wait_error(error) or expired:
                raise
            if error.status == 429:
                sleep(max(interval, 10.0))
            continue
        status = result.get("status")
        if status == "approved" and isinstance(result.get("code"), str):
            server = result.get("server")
            if not isinstance(server, str):
                return result["code"], origin
            return result["code"], known_address(origin, worktable_origin(server))
        if status == "denied":
            raise PairingError("The Worktable owner declined this connection.", "DENIED")
        if status == "expired" or (deadline is not None and time.time() >= deadline):
            raise PairingError("The connection request expired. Run the connect command again.", "EXPIRED")
