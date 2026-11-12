"""The adapter against Hermes' real gateway classes."""

import asyncio
import time

import pytest

pytest.importorskip("gateway.platforms.base")

from gateway.config import PlatformConfig  # noqa: E402
from gateway.platform_registry import PlatformEntry, platform_registry  # noqa: E402
from gateway.platforms.event import ProcessingOutcome  # noqa: E402

from worktable_hermes.access import Access  # noqa: E402
from worktable_hermes import adapter as adapter_module  # noqa: E402
from worktable_hermes import pairing  # noqa: E402
from worktable_hermes.adapter import WorktableAdapter  # noqa: E402
from worktable_hermes.connector import Connector, Turn, TurnError  # noqa: E402
from worktable_hermes.store import DeliveryStore, MemoryState  # noqa: E402


OWNER, TEAMMATE = "ptc_maya_owner_01", "ptc_sam_member_01"


def delivery(message_id, author):
    return {
        "messageId": message_id,
        "threadId": "thr_1",
        "location": {"kind": "space", "spaceId": "atlas"},
        "leaseId": f"lease_{message_id}",
        "identityId": "idt_hermes",
        "thread": {
            "id": "thr_1",
            "version": 3,
            "title": "Launch",
            "members": [
                {"id": OWNER, "kind": "human", "name": "Maya"},
                {"id": TEAMMATE, "kind": "human", "name": "Sam"},
                {"id": "ptc_hermes", "kind": "agent", "name": "Ada"},
            ],
            "identities": [{"id": "idt_hermes", "memberId": "ptc_hermes", "name": "Ada", "default": True}],
        },
        "message": {"id": message_id, "body": "Run the release script", "authorMemberId": author},
    }


class FakeContext:
    """A profile's settings and state, and Worktable behind Hermes' MCP connection."""

    def __init__(self):
        self.state = MemoryState()
        self.settings = {"server": "https://worktable.example"}
        self.offered = []
        self.requests = []

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def set_config(self, key, value):
        self.settings[key] = value

    def call_mcp(self, server, tool, arguments, timeout):
        request = arguments["request"]
        self.requests.append(request)
        if request["action"] == "claim":
            if not self.offered:
                time.sleep(0.01)
            return {"ok": True, "structuredContent": {"delivery": self.offered.pop(0) if self.offered else None}}
        return {"ok": True, "structuredContent": {}}

    def sent(self, action):
        return [request for request in self.requests if request["action"] == action]


async def until(condition):
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out")


def turn(attempt=1):
    return Turn(
        conversation_id="atlas/thr_1",
        message_id="msg_1",
        thread_id="thr_1",
        thread_title="Launch",
        body="Summarize the launch plan",
        sender={"id": "ptc_maya", "kind": "human", "name": "Maya"},
        group=False,
        attempt=attempt,
    )


@pytest.fixture(scope="module", autouse=True)
def worktable_platform():
    # Hermes accepts a plugin platform name once the plugin registers it.
    platform_registry.register(
        PlatformEntry(name="worktable", label="Worktable", adapter_factory=lambda config: None, check_fn=lambda: True)
    )


@pytest.fixture
def subject(monkeypatch):
    adapter = WorktableAdapter(PlatformConfig(enabled=True), FakeContext())
    events = []

    async def handle_message(event):
        events.append(event)

    monkeypatch.setattr(adapter, "handle_message", handle_message)
    return adapter, events


async def test_a_teammate_reaches_hermes_only_once_the_owner_trusts_the_worktables_members(subject):
    adapter, events = subject
    profile = adapter._ctx
    profile.settings.update(owner_id=OWNER, participant_name="Ada")
    profile.offered.append(delivery("msg_1", TEAMMATE))
    assert await adapter.connect()
    try:
        # Refused on the teammate's own message, and Hermes never hears of it.
        await until(lambda: profile.sent("fail"))
        assert events == []
        refusal = profile.sent("fail")[0]
        assert (refusal["messageId"], refusal["code"], refusal["retryable"]) == ("msg_1", "NOT_OWNER", False)
        assert refusal["message"] == "Only the person who connected Ada can direct it."

        # The owner's setting applies to the next message.
        profile.settings["trust_all_members"] = True
        profile.offered.append(delivery("msg_2", TEAMMATE))
        await until(lambda: events)
        assert (events[0].message_id, events[0].source.user_id) == ("msg_2", TEAMMATE)
        await adapter.send("atlas/thr_1", "Released.", reply_to="msg_2", metadata={"notify": True})
        await until(lambda: profile.sent("post"))
        assert profile.sent("post")[0]["body"] == "Released."
    finally:
        await adapter.disconnect()


def test_a_connection_without_a_recorded_owner_starts_closed(subject):
    adapter, _events = subject
    # As a connection made before owners were recorded reads after an update.
    adapter._ctx.settings.update(trust_all_members=True, trust_all_agents=True)
    access = adapter._settings.access()
    assert access.refusal({"id": OWNER, "kind": "human"}, "Ada").code == "OWNER_UNKNOWN"


async def test_a_turn_ends_with_hermes_final_reply_and_ignores_notices(subject):
    adapter, events = subject
    running = asyncio.create_task(adapter.dispatch(turn(attempt=2)))
    await asyncio.sleep(0)

    event = events[0]
    assert event.message_id == "msg_1/retry-1"
    assert event.source.chat_id == "atlas/thr_1"
    assert event.source.user_name == "Maya"
    assert event.allow_gateway_control is False

    await adapter.send("atlas/thr_1", "No home channel is set.", metadata={})
    await adapter.send("atlas/thr_1", "An older turn's reply", reply_to="msg_0", metadata={"notify": True})
    assert not running.done()

    await adapter.send("atlas/thr_1", "Here is the summary.", reply_to="msg_1/retry-1", metadata={"notify": True})
    assert await running == "Here is the summary."


async def test_a_turn_that_completes_without_a_reply_is_retried(subject, monkeypatch):
    adapter, events = subject
    monkeypatch.setattr(adapter_module, "REPLY_GRACE_SECONDS", 0.01)
    running = asyncio.create_task(adapter.dispatch(turn()))
    await asyncio.sleep(0)

    await adapter.on_processing_complete(events[0], ProcessingOutcome.SUCCESS)

    with pytest.raises(TurnError) as raised:
        await running
    assert raised.value.code == "NO_REPLY" and raised.value.retryable


async def test_a_reply_after_completion_still_answers_the_turn(subject):
    adapter, events = subject
    running = asyncio.create_task(adapter.dispatch(turn()))
    await asyncio.sleep(0)

    await adapter.on_processing_complete(events[0], ProcessingOutcome.SUCCESS)
    await adapter.send("atlas/thr_1", "Here is the summary.", metadata={"notify": True})

    assert await running == "Here is the summary."


async def test_a_resumed_reply_without_a_waiting_turn_is_kept(subject):
    adapter, _events = subject
    store = DeliveryStore(MemoryState())
    store.begin(
        "atlas/thr_1",
        "atlas/thr_1/msg_1",
        {"messageId": "msg_1", "threadId": "thr_1", "identityId": "idt_hermes", "location": {"kind": "space", "spaceId": "atlas"}},
    )
    adapter._connector = Connector(
        None, adapter, store, access=lambda: Access("ptc_maya_owner_01"), worktable_origin="https://worktable.example"
    )

    await adapter.send("atlas/thr_1", "Answer after restart.", metadata={"notify": True})

    assert store.retained("atlas/thr_1/msg_1")["body"] == "Answer after restart."


async def test_a_restart_notice_is_not_a_reply(subject):
    adapter, _events = subject
    running = asyncio.create_task(adapter.dispatch(turn()))
    await asyncio.sleep(0)

    await adapter.send(
        "atlas/thr_1",
        "\u23f3 Gateway is restarting and is not accepting new work right now.",
        reply_to="msg_1",
        metadata={"notify": True},
    )

    with pytest.raises(TurnError) as raised:
        await running
    assert raised.value.code == "CHANNEL_STOPPED"
    assert adapter._stop.is_set()


async def test_a_refused_pairing_stops_instead_of_retrying(subject, monkeypatch):
    adapter, _events = subject
    adapter._ctx.settings["pending_pairing_code"] = "ABCDE-12345"
    adapter._tools = object()
    outages = [pairing.PairingError("Worktable is restarting", "HTTP_503", 503)]

    def complete(server, code, token):
        raise outages.pop() if outages else pairing.PairingError("Pairing expired", "PAIRING_EXPIRED", 410)

    monkeypatch.setattr(pairing, "complete", complete)

    # An outage keeps the pairing for the next attempt.
    with pytest.raises(pairing.PairingError):
        await adapter._on_connected()
    assert adapter._ctx.settings["pending_pairing_code"] == "ABCDE-12345"
    assert not adapter._stop.is_set()

    with pytest.raises(pairing.PairingError):
        await adapter._on_connected()
    assert adapter._ctx.settings["pending_pairing_code"] == ""
    assert adapter._ctx.settings["pairing_error"] == "PAIRING_EXPIRED"
    assert adapter._stop.is_set()
