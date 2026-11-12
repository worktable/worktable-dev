"""`hermes worktable connect | status | disconnect`."""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
from dataclasses import replace
from typing import Any, Optional

from . import pairing
from .access import OWNER_TELLING_WORKTABLE_VERSION, Access
from .settings import DEFAULT_PARTICIPANT_NAME, MCP_SERVER, PLATFORM, TOKEN_ENV, Settings, member_id
from .store import DeliveryStore

# `hermes config unset` and `mcp remove` on an entry that is already gone.
_ALREADY_ABSENT = re.compile(r"not set|not found", re.IGNORECASE)

# The agent uses Worktable's other tools through this server. The plugin claims
# messages itself, so the agent must not take deliveries meant for the gateway:
# the delivery tools, by their current names and the earlier one.
DELIVERY_TOOLS = [
    "worktable_delivery_claim",
    "worktable_delivery_report",
    "worktable_thread_delivery",
]


def _hermes() -> list[str]:
    found = shutil.which("hermes")
    if found:
        return [found]
    if os.path.basename(sys.argv[0]).startswith("hermes"):
        return [sys.argv[0]]
    return [sys.executable, "-m", "hermes_cli.main"]


def _hermes_run(*args: str, interactive: bool = False) -> None:
    """Change the profile through Hermes' own documented commands."""
    command = [*_hermes(), *args]
    if interactive:
        result = subprocess.run(command, check=False)
    else:
        result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        detail = "" if interactive else (result.stderr or result.stdout).strip()
        raise RuntimeError(f"`hermes {' '.join(args[:3])}` failed{': ' + detail if detail else ''}")


def _config_set(key: str, value: Any) -> None:
    _hermes_run("config", "set", key, value if isinstance(value, str) else json.dumps(value))


def _save_token(token: str) -> None:
    """Store the token in the profile's .env without exposing it in process arguments."""
    from hermes_cli.config import get_env_value, save_env_value

    save_env_value(TOKEN_ENV, token)
    if get_env_value(TOKEN_ENV) != token:
        raise RuntimeError(f"Hermes did not save {TOKEN_ENV} to the profile's .env")


def _mcp_server(url: str) -> dict:
    return {
        "url": url,
        "headers": {"Authorization": "Bearer ${%s}" % TOKEN_ENV},
        "tools": {"exclude": list(DELIVERY_TOOLS)},
    }


def _enable(url: str) -> None:
    _config_set(f"mcp_servers.{MCP_SERVER}", _mcp_server(url))
    _config_set(f"plugins.entries.{PLATFORM}.mcp_allowlist", [MCP_SERVER])
    _config_set(f"platforms.{PLATFORM}.enabled", "true")
    # Restart notices would otherwise be posted into every Worktable thread.
    _config_set(f"platforms.{PLATFORM}.gateway_restart_notification", "false")


def _who(access: Access) -> str:
    """Whose messages this Hermes runs, in the words `status` and `connect` print."""
    who = ["the person who connected it"]
    if access.trust_own_agents:
        who.append("the agents that person connected")
    if access.trust_all_members:
        who.append("every member of the Worktable")
    if access.trust_all_agents:
        who.append("other people's agents")
    return ", ".join(who)


def connect(ctx: Any, args: Any) -> int:
    settings = Settings(ctx)
    given = pairing.worktable_origin(args.server)
    origin = given
    name = (args.name or DEFAULT_PARTICIPANT_NAME).strip()
    code: Optional[str] = (args.pairing_code or "").strip() or None
    store = DeliveryStore(ctx.state)
    if not code:
        # Ask Worktable to connect; a person approves Hermes there.
        def show(user_code: str, approval_url: str) -> None:
            print(
                f"Approve this Hermes in Worktable:\n{approval_url}\n"
                f"Check that Worktable shows {user_code}. Waiting for approval…",
                flush=True,
            )

        try:
            code, origin = pairing.request_approval(
                given,
                store.installation_id(),
                socket.gethostname()[:64],
                (args.name or "").strip() or None,
                show,
            )
        except pairing.PairingError as error:
            if error.status in (404, 405):
                raise pairing.PairingError(
                    f"{given} did not answer as a Worktable that connects agents. "
                    "Check the address, or update that Worktable.",
                    error.code,
                    error.status,
                ) from None
            raise

    redeemed = pairing.redeem(origin, code, socket.gethostname()[:64], store.installation_id())
    try:
        _save_token(redeemed["token"])
    except Exception:
        # Nothing holds the new credential, so Worktable may revoke it.
        pairing.report(origin, code, "failed_no_config", "Hermes could not save the Worktable connection.")
        raise
    owner = member_id(redeemed.get("ownerMemberId"))
    participant = redeemed.get("participantName") or name
    trusted = settings.access()
    try:
        _enable(redeemed["mcpUrl"])
        kept_trust = settings.save(
            server=origin,
            participant_name=participant,
            owner_id=owner,
            pending_pairing_code=code,
        )
    except Exception:
        # The token is saved; running connect again finishes the setup.
        pairing.report(origin, code, "failed", "Hermes saved the token but not the rest of the connection.")
        raise
    pairing.report(origin, code, "config_written", "Worktable connection saved in Hermes.")
    pairing.report(origin, code, "verifying", "Waiting for the Hermes gateway to connect.")
    print(f"Connected Hermes to {redeemed.get('workspaceName') or origin} as {participant}.")
    if not owner:
        print(
            "This Worktable did not say who approved the connection. Unless it has one person, "
            f"Hermes will refuse thread messages until it is updated to {OWNER_TELLING_WORKTABLE_VERSION} or later.",
            file=sys.stderr,
        )
    else:
        access = (
            replace(trusted, owner_id=owner)
            if kept_trust
            else replace(trusted, owner_id=owner, trust_all_members=False, trust_all_agents=False)
        )
        print(f"It takes direction from: {_who(access)}. Everyone else is refused.")
    print("Restart the gateway so Hermes starts answering Worktable messages: hermes gateway restart")
    return 0


def status(ctx: Any, _args: Any) -> int:
    settings = Settings(ctx)
    if not settings.server:
        print("Worktable is not connected. Run `hermes worktable connect <address>`.")
        return 1
    print(f"Worktable: {settings.server}")
    print(f"Participant: {settings.participant_name}")
    print(f"Takes direction from: {_who(settings.access())}")
    if settings.pairing_error:
        print(f"Pairing did not finish ({settings.pairing_error}). Run `hermes worktable connect` with a new code.")
        return 1
    if settings.pending_pairing_code:
        print("Waiting for the gateway to finish pairing. Restart it with: hermes gateway restart")
    return 0


def disconnect(ctx: Any, _args: Any) -> int:
    settings = Settings(ctx)
    skipped = 0
    for args in (
        ("mcp", "remove", MCP_SERVER),
        ("config", "unset", TOKEN_ENV),
        ("config", "unset", f"plugins.entries.{PLATFORM}.mcp_allowlist"),
        ("config", "set", f"platforms.{PLATFORM}.enabled", "false"),
    ):
        try:
            _hermes_run(*args)
        except RuntimeError as error:
            if _ALREADY_ABSENT.search(str(error)):
                continue
            skipped += 1
            print(f"Skipped: {error}", file=sys.stderr)
    settings.clear()
    if skipped:
        print("Disconnected Hermes from Worktable, but some settings could not be removed (see above).")
    else:
        print("Disconnected Hermes from Worktable. Restart the gateway to stop answering messages.")
    print("To remove its access in Worktable, disconnect it in Settings → Agents.")
    return 1 if skipped else 0


def register_cli(ctx: Any) -> None:
    commands = {"connect": connect, "status": status, "disconnect": disconnect}

    def setup(parser: Any) -> None:
        actions = parser.add_subparsers(dest="worktable_command", required=True)
        connect_parser = actions.add_parser("connect", help="Connect this Hermes profile to Worktable")
        connect_parser.add_argument("server", help="Your Worktable address, such as https://app.worktable.cloud")
        connect_parser.add_argument(
            "--pairing-code",
            help="Code from Settings → Agents → Hermes; without one, approve Hermes in Worktable",
        )
        connect_parser.add_argument("--name", help="How this agent appears in Worktable threads")
        actions.add_parser("status", help="Show the Worktable connection")
        actions.add_parser("disconnect", help="Remove the Worktable connection from this profile")

    def handle(args: Any) -> int:
        try:
            return commands[args.worktable_command](ctx, args)
        except (pairing.PairingError, RuntimeError) as error:
            print(str(error), file=sys.stderr)
            return 1

    ctx.register_cli_command(
        "worktable",
        help="Connect Hermes to Worktable",
        setup_fn=setup,
        handler_fn=handle,
        description="Connect this Hermes profile to a Worktable workspace and its threads.",
    )
