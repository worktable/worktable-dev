"""The adapter against Hermes' real gateway classes."""

import asyncio

import pytest

pytest.importorskip("gateway.platforms.base")

from gateway.config import PlatformConfig  # noqa: E402
from gateway.platform_registry import PlatformEntry, platform_registry  # noqa: E402
from gateway.platforms.event import ProcessingOutcome  # noqa: E402

from worktable_hermes import adapter as adapter_module  # noqa: E402
from worktable_hermes.adapter import WorktableAdapter  # noqa: E402
from worktable_hermes.connector import Connector, Turn, TurnError  # noqa: E402
from worktable_hermes.store import DeliveryStore, MemoryState  # noqa: E402


class FakeContext:
    def __init__(self):
        self.state = MemoryState()
        self.settings = {"server": "https://worktable.example"}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def set_config(self, key, value):
        self.settings[key] = value


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
    adapter._connector = Connector(None, adapter, store, worktable_origin="https://worktable.example")

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
