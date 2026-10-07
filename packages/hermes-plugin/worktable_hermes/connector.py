"""Claims messages addressed to this agent, runs them in Hermes, and posts the replies."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, replace
from typing import Awaitable, Callable, Optional, Protocol

from . import delivery as deliveries
from .client import WorktableError, WorktableTools
from .store import DeliveryStore

HEARTBEAT_SECONDS = 15
MAX_CONCURRENT_TURNS = 4
# After a gateway restart Hermes resumes an interrupted turn by itself. A
# redelivered message waits this long for that reply before running again.
RESUME_WAIT_SECONDS = 300
SHUTDOWN_DRAIN_SECONDS = 5

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Turn:
    conversation_id: str
    message_id: str
    thread_id: str
    thread_title: str
    body: str
    sender: dict
    group: bool
    attempt: int = 1


class TurnError(Exception):
    """A turn that ended without a reply. Retryable turns run again later."""

    def __init__(self, code: str, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class Dispatcher(Protocol):
    async def dispatch(self, turn: Turn) -> str:
        """Run one turn and return Hermes' final reply."""

    async def resumed_reply(self, turn: Turn, timeout: float) -> Optional[str]:
        """Wait for the reply to a turn Hermes resumed after a restart."""


def _code(error: BaseException) -> str:
    code = getattr(error, "code", None)
    return code[:100] if isinstance(code, str) and code else "HERMES_DISPATCH_FAILED"


def _public_message(code: str) -> str:
    return f"Hermes could not complete this message ({code})."


class Connector:
    def __init__(
        self,
        tools: WorktableTools,
        dispatcher: Dispatcher,
        store: DeliveryStore,
        *,
        worktable_origin: Optional[str] = None,
        on_connected: Optional[Callable[[], Awaitable[None]]] = None,
        heartbeat_seconds: float = HEARTBEAT_SECONDS,
        resume_wait_seconds: float = RESUME_WAIT_SECONDS,
    ) -> None:
        self._tools = tools
        self._dispatcher = dispatcher
        self._store = store
        self._origin = worktable_origin
        self._on_connected = on_connected
        self._heartbeat_seconds = heartbeat_seconds
        self._resume_wait_seconds = resume_wait_seconds
        self._active: set[asyncio.Task] = set()
        self._thread_locks: dict[str, asyncio.Lock] = {}
        self.connected = False
        self.last_error: Optional[str] = None

    async def run(self, stop: asyncio.Event) -> None:
        backoff = 0.5
        while not stop.is_set():
            try:
                if not self.connected:
                    await self._tools.participants()
                    if self._on_connected:
                        await self._on_connected()
                    self.connected, self.last_error = True, None
                    logger.info("Connected to Worktable threads")
                if len(self._active) >= MAX_CONCURRENT_TURNS:
                    await asyncio.wait(self._active, return_when=asyncio.FIRST_COMPLETED)
                    continue
                claimed = await self._tools.claim()
                backoff = 0.5
                if claimed is None or stop.is_set():
                    continue
                task = asyncio.create_task(self.handle(claimed, stop))
                self._active.add(task)
                task.add_done_callback(self._active.discard)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # Worktable or Hermes' MCP connection is unavailable.
                self.connected, self.last_error = False, _code(error)
                logger.warning("Worktable claim failed (%s); reconnecting", self.last_error)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 10)
        if self._active:
            done, pending = await asyncio.wait(self._active, timeout=SHUTDOWN_DRAIN_SECONDS)
            if pending:
                logger.warning(
                    "Stopped with %d Worktable turn(s) running; Worktable will offer them again", len(pending)
                )

    async def handle(self, claimed: dict, stop: Optional[asyncio.Event] = None) -> None:
        message_id, lease_id = claimed["messageId"], claimed["leaseId"]
        conversation = deliveries.conversation_id(claimed)
        event = deliveries.event_id(claimed)
        lost_lease: Optional[BaseException] = None

        async def heartbeat() -> None:
            nonlocal lost_lease
            while True:
                await asyncio.sleep(self._heartbeat_seconds)
                try:
                    await self._tools.progress(message_id, lease_id)
                except WorktableError as error:
                    if error.code == "LEASE_LOST":
                        lost_lease = error
                        logger.warning("Lease for %s expired; its reply is posted when it is offered again", message_id)
                        return
                    logger.warning("Worktable heartbeat for %s failed (%s); the turn continues", message_id, error.code)
                except Exception as error:
                    logger.warning("Worktable heartbeat for %s failed (%s); the turn continues", message_id, _code(error))

        beating: Optional[asyncio.Task] = None
        try:
            await self._tools.accept(message_id, lease_id)
            await self._tools.progress(message_id, lease_id)
            beating = asyncio.create_task(heartbeat())
            if self._store.is_completed(event):
                await self._fail(claimed, False, "DUPLICATE_EVENT", "This message was already completed by Hermes.")
                return
            lock = self._thread_locks.setdefault(conversation, asyncio.Lock())
            async with lock:
                reply = self._store.retained(event) or await self._produce(claimed, conversation, event)
                if stop is not None and stop.is_set():
                    return
                if lost_lease is not None:
                    return
                if claimed.get("thread", {}).get("version") == 3:
                    reply = {**reply, "deliveryLeaseId": lease_id}
                await self._tools.reply(reply)
                self._store.complete(conversation, event)
            logger.info("Completed Worktable message %s in %s", message_id, claimed["threadId"])
        except TurnError as error:
            if stop is not None and stop.is_set():
                # Hermes resumes this turn after it restarts; the pending record
                # lets the next delivery wait for that reply.
                return
            if error.retryable:
                self._store.forget_pending(conversation, event)
            else:
                self._store.complete(conversation, event)
            logger.error("Worktable message %s failed (%s)", message_id, error.code)
            await self._fail(claimed, error.retryable, error.code, _public_message(error.code))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if (stop is not None and stop.is_set()) or lost_lease is not None:
                return
            self._store.forget_pending(conversation, event)
            code = _code(error)
            logger.error("Worktable message %s failed (%s)", message_id, code)
            await self._fail(claimed, True, code, _public_message(code))
        finally:
            if beating:
                beating.cancel()

    async def _produce(self, claimed: dict, conversation: str, event: str) -> dict:
        turn = Turn(
            conversation_id=conversation,
            message_id=claimed["messageId"],
            thread_id=claimed["threadId"],
            thread_title=(claimed.get("thread") or {}).get("title") or "Worktable thread",
            body=(claimed.get("message") or {}).get("body") or "",
            sender=deliveries.sender(claimed),
            group=len((claimed.get("thread") or {}).get("members") or []) > 2,
        )
        body: Optional[str] = None
        pending = self._store.pending(conversation)
        if pending and pending.get("event") == event:
            # This message was running when the gateway stopped.
            body = await self._dispatcher.resumed_reply(turn, self._resume_wait_seconds)
            retained = self._store.retained(event)
            if retained:
                return retained
        if body is None:
            attempt = self._store.begin(conversation, event, self._reply_shape(claimed))
            body = await self._dispatcher.dispatch(replace(turn, attempt=attempt))
        if not body.strip():
            raise TurnError("EMPTY_REPLY", "Hermes returned an empty reply", retryable=False)
        reply = self._reply(self._reply_shape(claimed), body)
        self._store.retain(event, reply)
        return reply

    @staticmethod
    def _reply_shape(claimed: dict) -> dict:
        """What a retained reply needs, kept with the pending turn."""
        return {
            "messageId": claimed["messageId"],
            "threadId": claimed["threadId"],
            "identityId": claimed["identityId"],
            "location": deliveries.location(claimed),
        }

    def _reply(self, shape: dict, body: str) -> dict:
        where = shape["location"]
        portable = deliveries.portable_doc_links(
            body, where.get("spaceId", "") if where.get("kind") == "space" else "", self._origin
        )
        return deliveries.reply_for(
            shape,
            portable,
            f"hermes:{shape['messageId']}:{shape['identityId']}:reply",
        )

    def retain_resumed_reply(self, conversation: str, body: str) -> bool:
        """Keep a reply Hermes resumed on its own, for the message's next delivery."""
        return self._store.retain_for_conversation(conversation, lambda shape: self._reply(shape, body)) is not None

    async def _fail(self, claimed: dict, retryable: bool, code: str, message: str) -> None:
        try:
            await self._tools.fail(claimed["messageId"], claimed["leaseId"], retryable, code, message)
        except Exception as error:
            logger.warning("Could not report failure for %s (%s)", claimed["messageId"], _code(error))
