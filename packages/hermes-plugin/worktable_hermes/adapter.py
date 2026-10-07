"""The Hermes gateway platform that answers Worktable thread messages."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Optional

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType, ProcessingOutcome

from . import delivery as deliveries
from . import pairing
from .client import WorktableTools, parse_envelope
from .connector import Connector, Turn, TurnError
from .settings import MCP_SERVER, PLATFORM, TOKEN_ENV, Settings
from .store import DeliveryStore

logger = logging.getLogger(__name__)

# Hermes can report a turn complete just before it sends the final reply.
REPLY_GRACE_SECONDS = 10
# Hermes resumes interrupted turns as it starts. A redelivered message waits
# this long for its chat's resumed turn to begin before running again.
RESUME_START_SECONDS = 30
# Longer than Hermes' own 30-minute gateway turn timeout.
TURN_TIMEOUT_SECONDS = 45 * 60
# Hermes answers a message that arrives while it drains for a restart with this
# notice instead of running it.
DRAINING_NOTICE = re.compile(r"^\W*Gateway is (?:restarting|shutting down) and is not accepting new work")

COLLABORATION_PROMPT = (
    "You are answering a message in a Worktable thread. Your final reply is posted to the "
    "thread for you; do not post it again with Worktable tools. Treat inspection, research, "
    "review, and discussion as read-only unless the message explicitly asks for edits. Make "
    "only requested changes. After changing Worktable content, name every changed Worktable "
    "path in the reply and use portable Worktable links."
)


@dataclass
class _Waiter:
    hermes_message_id: Optional[str]
    future: asyncio.Future


class WorktableAdapter(BasePlatformAdapter):
    # Nobody is waiting to be asked what to do next: a resumed turn finishes
    # answering the Worktable message it was working on.
    interactive_resume = False

    def __init__(self, config: Any, ctx: Any) -> None:
        super().__init__(config, Platform(PLATFORM))
        self._ctx = ctx
        self._settings = Settings(ctx)
        self._waiters: dict[str, _Waiter] = {}
        self._stop = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._connector: Optional[Connector] = None
        self._tools: Optional[WorktableTools] = None
        self._processing: dict[str, int] = {}
        self._processing_started: dict[str, asyncio.Event] = {}

    @property
    def authorization_is_upstream(self) -> bool:
        # Worktable authenticates every author and decides who is addressed.
        return True

    async def _call(self, tool: str, arguments: dict, timeout: float) -> dict:
        envelope = await asyncio.to_thread(self._ctx.call_mcp, MCP_SERVER, tool, arguments, timeout)
        return parse_envelope(envelope)

    async def connect(self, **_kwargs: Any) -> bool:
        server = self._settings.server
        if not server:
            logger.error("Worktable is not set up. Run `hermes worktable connect`.")
            return False
        self._stop = asyncio.Event()
        self._tools = WorktableTools(self._call)
        self._connector = Connector(
            self._tools,
            self,
            DeliveryStore(self._ctx.state),
            worktable_origin=server,
            on_connected=self._on_connected,
        )
        self._task = asyncio.create_task(self._connector.run(self._stop), name="worktable-deliveries")
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._stop.set()
        for waiter in self._waiters.values():
            if not waiter.future.done():
                waiter.future.set_exception(TurnError("CHANNEL_STOPPED", "Hermes is stopping"))
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=10)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        self._mark_disconnected()

    async def _on_connected(self) -> None:
        assert self._tools is not None
        code = self._settings.pending_pairing_code
        if code:
            token = self._settings.token()
            if token:
                await asyncio.to_thread(pairing.complete, self._settings.server, code, token)
            self._settings.clear_pending_pairing_code()
        if self._settings.auth == "oauth" and not self._settings.participant_registered:
            await self._tools.register_participant(self._settings.participant_name)
            self._settings.mark_participant_registered()

    # -- Dispatcher -------------------------------------------------------

    def _expect(self, conversation: str, hermes_message_id: Optional[str]) -> asyncio.Future:
        previous = self._waiters.get(conversation)
        if previous and not previous.future.done():
            previous.future.set_exception(TurnError("SUPERSEDED", "A newer turn started in this thread"))
        future = asyncio.get_running_loop().create_future()
        self._waiters[conversation] = _Waiter(hermes_message_id, future)
        return future

    async def _settle(self, conversation: str, future: asyncio.Future, timeout: Optional[float]) -> str:
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        finally:
            waiter = self._waiters.get(conversation)
            if waiter and waiter.future is future:
                del self._waiters[conversation]

    async def dispatch(self, turn: Turn) -> str:
        # A retried message gets a new id so Hermes runs it rather than treating it as a duplicate.
        hermes_message_id = turn.message_id if turn.attempt == 1 else f"{turn.message_id}/retry-{turn.attempt - 1}"
        future = self._expect(turn.conversation_id, hermes_message_id)
        event = MessageEvent(
            text=turn.body,
            message_type=MessageType.TEXT,
            message_id=hermes_message_id,
            source=self.build_source(
                chat_id=turn.conversation_id,
                chat_name=turn.thread_title,
                chat_type="group" if turn.group else "dm",
                user_id=turn.sender["id"],
                user_name=turn.sender["name"],
            ),
            channel_prompt=COLLABORATION_PROMPT,
            allow_gateway_control=False,
        )
        await self.handle_message(event)
        try:
            return await self._settle(turn.conversation_id, future, TURN_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            raise TurnError("HERMES_TIMEOUT", "Hermes did not finish the turn") from None

    async def resumed_reply(self, turn: Turn, timeout: float) -> Optional[str]:
        conversation = turn.conversation_id
        future = self._expect(conversation, None)
        started = self._processing_started.setdefault(conversation, asyncio.Event())
        if self._processing.get(conversation):
            started.set()
        beginning = asyncio.ensure_future(started.wait())
        try:
            await asyncio.wait(
                [beginning, future], timeout=min(timeout, RESUME_START_SECONDS), return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            beginning.cancel()
        if not future.done() and not started.is_set():
            # Hermes is not resuming this chat, so the message runs again.
            self._waiters.pop(conversation, None)
            return None
        try:
            return await self._settle(conversation, future, timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            self._processing_started.pop(conversation, None)

    # -- Hermes output ----------------------------------------------------

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None, metadata: Optional[dict] = None):
        message_id = str(int(time.time() * 1000))
        if not (metadata or {}).get("notify") or self._stop.is_set():
            # Status notices, interim output, and shutdown notices are not
            # thread messages. Hermes resumes an interrupted turn after it
            # restarts, and that reply is the answer.
            return SendResult(success=True, message_id=message_id)
        waiter = self._waiters.get(chat_id)
        if DRAINING_NOTICE.match(content or ""):
            # Hermes is about to restart. Leave this and any new message for
            # after the restart.
            self._stop.set()
            if waiter and not waiter.future.done():
                waiter.future.set_exception(TurnError("CHANNEL_STOPPED", "Hermes is restarting"))
            return SendResult(success=True, message_id=message_id)
        if waiter and not waiter.future.done() and reply_to in (None, waiter.hermes_message_id):
            waiter.future.set_result(content or "")
            return SendResult(success=True, message_id=message_id)
        if self._connector and self._connector.retain_resumed_reply(chat_id, content or ""):
            logger.info("Kept a resumed Hermes reply for its Worktable message in %s", chat_id)
            return SendResult(success=True, message_id=message_id)
        return await self._post_unprompted(chat_id, content or "", message_id)

    async def _post_unprompted(self, chat_id: str, content: str, message_id: str) -> SendResult:
        """Messages Hermes starts itself, such as scheduled results, become thread messages."""
        thread = deliveries.thread_for_conversation(chat_id)
        if not thread or not self._tools or not content.strip():
            return SendResult(success=False, error="Not a Worktable thread")
        key = hashlib.sha256(f"{chat_id}\0{content}".encode()).hexdigest()[:32]
        try:
            await self._tools.post({**thread, "body": content, "idempotencyKey": f"hermes-out:{key}"})
        except Exception as error:
            logger.warning("Could not post a Hermes message to %s: %s", chat_id, error)
            return SendResult(success=False, error=str(error))
        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id: str, metadata: Optional[dict] = None) -> None:
        return None

    async def get_chat_info(self, chat_id: str) -> dict:
        return {"name": f"Worktable {chat_id}", "type": "group"}

    async def on_processing_start(self, event: MessageEvent) -> None:
        chat_id = getattr(event.source, "chat_id", None)
        if chat_id:
            self._processing[chat_id] = self._processing.get(chat_id, 0) + 1
            started = self._processing_started.get(chat_id)
            if started:
                started.set()

    async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
        chat_id = getattr(event.source, "chat_id", None)
        if chat_id and self._processing.get(chat_id):
            self._processing[chat_id] -= 1
        waiter = self._waiters.get(chat_id) if chat_id else None
        if not waiter or waiter.future.done() or event.message_id != waiter.hermes_message_id:
            return
        if outcome is ProcessingOutcome.FAILURE:
            waiter.future.set_exception(TurnError("HERMES_TURN_FAILED", "Hermes could not complete the turn"))
        elif outcome is ProcessingOutcome.CANCELLED:
            waiter.future.set_exception(TurnError("HERMES_TURN_CANCELLED", "The Hermes turn was cancelled"))
        else:
            asyncio.get_running_loop().call_later(REPLY_GRACE_SECONDS, self._no_reply, waiter.future)

    @staticmethod
    def _no_reply(future: asyncio.Future) -> None:
        # An interrupted turn also reports success, without a reply.
        if not future.done():
            future.set_exception(TurnError("NO_REPLY", "Hermes finished without a reply"))


def register_platform(ctx: Any) -> None:
    settings = Settings(ctx)
    ctx.register_platform(
        name=PLATFORM,
        label="Worktable",
        adapter_factory=lambda config: WorktableAdapter(config, ctx),
        check_fn=lambda: bool(settings.server),
        required_env=[],
        install_hint="Run `hermes worktable connect <your Worktable address>`.",
        max_message_length=0,
        emoji="🗂️",
        allow_update_command=False,
        platform_hint=(
            "You are replying in a Worktable thread, a durable conversation shared with "
            "people and other agents in the user's workspace."
        ),
    )
