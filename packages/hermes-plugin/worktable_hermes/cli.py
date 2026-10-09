"""`hermes worktable connect | status | disconnect`."""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
from typing import Any, Optional

from . import pairing
from .settings import DEFAULT_PARTICIPANT_NAME, MCP_SERVER, PLATFORM, TOKEN_ENV, Settings
from .store import DeliveryStore

# `hermes config unset` and `mcp remove` on an entry that is already gone.
_ALREADY_ABSENT = re.compile(r"not set|not found", re.IGNORECASE)

# The agent uses Worktable's other tools through this server. The plugin claims
# messages itself, so the agent must not take deliveries meant for the gateway.
DELIVERY_TOOL = "worktable_thread_delivery"

# Worktable Cloud's sign-in client for Hermes. It signs in with a code entered
# on any device, so a gateway without a browser connects like a desktop does.
CLOUD_SIGN_IN_CLIENTS = {"https://app.worktable.cloud": "client_01M4GPPF7CBN9KB2GQGJY16942"}
SIGN_IN_SCOPE = "openid profile email offline_access"


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


def _mcp_server(url: str, auth: str, client_id: Optional[str] = None) -> dict:
    server: dict[str, Any] = {"url": url, "tools": {"exclude": [DELIVERY_TOOL]}}
    if auth == "oauth":
        server["auth"] = "oauth"
        if client_id:
            server["oauth"] = {"client_id": client_id, "flow": "device", "scope": SIGN_IN_SCOPE}
    else:
        server["headers"] = {"Authorization": "Bearer ${%s}" % TOKEN_ENV}
    return server


def _enable(url: str, auth: str, client_id: Optional[str] = None) -> None:
    _config_set(f"mcp_servers.{MCP_SERVER}", _mcp_server(url, auth, client_id))
    _config_set(f"plugins.entries.{PLATFORM}.mcp_allowlist", [MCP_SERVER])
    _config_set(f"platforms.{PLATFORM}.enabled", "true")
    # Restart notices would otherwise be posted into every Worktable thread.
    _config_set(f"platforms.{PLATFORM}.gateway_restart_notification", "false")


def connect(ctx: Any, args: Any) -> int:
    settings = Settings(ctx)
    origin = pairing.worktable_origin(args.server)
    name = (args.name or DEFAULT_PARTICIPANT_NAME).strip()
    code: Optional[str] = (args.pairing_code or "").strip() or None

    if code:
        store = DeliveryStore(ctx.state)
        redeemed = pairing.redeem(origin, code, socket.gethostname()[:64], store.installation_id())
        try:
            _save_token(redeemed["token"])
        except Exception:
            # Nothing holds the new credential, so Worktable may revoke it.
            pairing.report(origin, code, "failed_no_config", "Hermes could not save the Worktable connection.")
            raise
        try:
            _enable(redeemed["mcpUrl"], "token")
            settings.save(
                server=origin,
                auth="token",
                participant_name=redeemed.get("participantName") or name,
                pending_pairing_code=code,
            )
        except Exception:
            # The token is saved; running connect again finishes the setup.
            pairing.report(origin, code, "failed", "Hermes saved the token but not the rest of the connection.")
            raise
        pairing.report(origin, code, "config_written", "Worktable connection saved in Hermes.")
        pairing.report(origin, code, "verifying", "Waiting for the Hermes gateway to connect.")
        print(f"Connected Hermes to {redeemed.get('workspaceName') or origin} as {redeemed.get('participantName') or name}.")
    else:
        resource = pairing.mcp_resource(origin)
        if not resource:
            print(
                "This Worktable needs a pairing code. In Worktable, open Settings → Agents → Hermes, "
                "then run the command it shows.",
                file=sys.stderr,
            )
            return 2
        _enable(resource, "oauth", CLOUD_SIGN_IN_CLIENTS.get(origin))
        settings.save(server=origin, auth="oauth", participant_name=name, pending_pairing_code=None)
        try:
            _hermes_run("mcp", "test", MCP_SERVER)
        except RuntimeError:
            print("Sign in to Worktable to let Hermes use your workspace.", flush=True)
            _hermes_run("mcp", "login", MCP_SERVER, interactive=True)
            # `hermes mcp login` reports a failed or expired sign-in without failing.
            try:
                _hermes_run("mcp", "test", MCP_SERVER)
            except RuntimeError:
                raise RuntimeError(
                    "Hermes is not signed in to Worktable. Run this command again to get a new code."
                ) from None
        print(f"Connected Hermes to {origin} as {name}.")
    print("Restart the gateway so Hermes starts answering Worktable messages: hermes gateway restart")
    return 0


def status(ctx: Any, _args: Any) -> int:
    settings = Settings(ctx)
    if not settings.server:
        print("Worktable is not connected. Run `hermes worktable connect <address>`.")
        return 1
    sign_in = "Worktable sign-in" if settings.auth == "oauth" else "paired token"
    print(f"Worktable: {settings.server}")
    print(f"Participant: {settings.participant_name}")
    print(f"Credential: {sign_in}")
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
        connect_parser.add_argument("--pairing-code", help="Code from Settings → Agents → Hermes on a self-hosted Worktable")
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
