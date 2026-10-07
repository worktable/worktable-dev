import asyncio
from typing import Optional

from worktable_hermes.client import WorktableError
from worktable_hermes.connector import Connector, Turn, TurnError
from worktable_hermes.store import DeliveryStore, MemoryState


def claimed(message_id="msg_1", lease_id="lease_1", body="Summarize the launch plan"):
    return {
        "messageId": message_id,
        "threadId": "thr_1",
        "location": {"kind": "space", "spaceId": "atlas"},
        "leaseId": lease_id,
        "leaseExpiresAt": "2026-10-07T00:00:00Z",
        "identityId": "idt_hermes",
        "thread": {
            "id": "thr_1",
            "version": 3,
            "title": "Launch",
            "members": [
                {"id": "ptc_maya", "kind": "human", "name": "Maya"},
                {"id": "ptc_hermes", "kind": "agent", "name": "Hermes"},
            ],
            "identities": [
                {"id": "idt_hermes", "memberId": "ptc_hermes", "name": "Hermes", "default": True, "status": "active"},
                {"id": "idt_maya", "memberId": "ptc_maya", "name": "Maya", "default": True, "status": "active"},
            ],
        },
        "message": {"id": message_id, "body": body, "authorMemberId": "ptc_maya", "authorIdentityId": "idt_maya"},
    }


class FakeTools:
    def __init__(self):
        self.calls = []
        self.replies = []
        self.failures = []
        self.lose_lease = False

    async def participants(self):
        return []

    async def accept(self, message_id, lease_id):
        self.calls.append(("accept", message_id, lease_id))

    async def progress(self, message_id, lease_id, phase="working"):
        if self.lose_lease:
            raise WorktableError("LEASE_LOST", "lease expired")
        self.calls.append(("progress", message_id, lease_id))

    async def fail(self, message_id, lease_id, retryable, code, message):
        self.failures.append({"messageId": message_id, "retryable": retryable, "code": code})

    async def reply(self, reply):
        self.replies.append(reply)
        return {"messageId": "msg_reply"}


class FakeDispatcher:
    def __init__(self, replies=None, error: Optional[Exception] = None):
        self.turns: list[Turn] = []
        self.replies = list(replies or ["Here is the summary."])
        self.error = error
        self.resumed: Optional[str] = None
        self.gate: Optional[asyncio.Event] = None

    async def dispatch(self, turn):
        self.turns.append(turn)
        if self.gate:
            await self.gate.wait()
        if self.error:
            raise self.error
        return self.replies.pop(0)

    async def resumed_reply(self, turn, timeout):
        return self.resumed


def connector(tools, dispatcher, store=None, **options):
    return Connector(
        tools,
        dispatcher,
        store or DeliveryStore(MemoryState()),
        worktable_origin="https://worktable.example",
        heartbeat_seconds=options.pop("heartbeat_seconds", 60),
        resume_wait_seconds=options.pop("resume_wait_seconds", 0.05),
        **options,
    )


async def test_answers_a_message_once_and_rejects_its_redelivery():
    tools, dispatcher = FakeTools(), FakeDispatcher()
    subject = connector(tools, dispatcher)

    await subject.handle(claimed())
    await subject.handle(claimed(lease_id="lease_2"))

    assert [turn.sender["name"] for turn in dispatcher.turns] == ["Maya"]
    assert dispatcher.turns[0].conversation_id == "atlas/thr_1"
    assert tools.replies == [
        {
            "location": {"kind": "space", "spaceId": "atlas"},
            "spaceId": "atlas",
            "threadId": "thr_1",
            "inReplyTo": "msg_1",
            "responseTo": "msg_1",
            "authorIdentityId": "idt_hermes",
            "body": "Here is the summary.",
            "idempotencyKey": "hermes:msg_1:idt_hermes:reply",
            "deliveryLeaseId": "lease_1",
        }
    ]
    assert tools.failures == [{"messageId": "msg_1", "retryable": False, "code": "DUPLICATE_EVENT"}]


async def test_rewrites_links_to_this_worktables_docs_as_portable_paths():
    tools = FakeTools()
    dispatcher = FakeDispatcher(
        ["Updated [the plan](https://worktable.example/spaces/atlas/docs/plans/launch) and `https://worktable.example/spaces/atlas/docs/x`."]
    )

    await connector(tools, dispatcher).handle(claimed())

    assert tools.replies[0]["body"] == (
        "Updated [the plan](/plans/launch) and `https://worktable.example/spaces/atlas/docs/x`."
    )


async def test_a_failed_turn_runs_again_with_a_new_hermes_message():
    tools = FakeTools()
    store = DeliveryStore(MemoryState())
    failing = FakeDispatcher(error=TurnError("HERMES_TURN_FAILED", "model unavailable"))

    await connector(tools, failing, store).handle(claimed())
    assert tools.failures == [{"messageId": "msg_1", "retryable": True, "code": "HERMES_TURN_FAILED"}]

    retry = FakeDispatcher()
    await connector(tools, retry, store).handle(claimed(lease_id="lease_2"))
    assert retry.turns[0].attempt == 2
    assert len(tools.replies) == 1


async def test_an_empty_reply_is_reported_and_not_retried():
    tools = FakeTools()
    await connector(tools, FakeDispatcher(["  "])).handle(claimed())

    assert tools.replies == []
    assert tools.failures == [{"messageId": "msg_1", "retryable": False, "code": "EMPTY_REPLY"}]


async def test_a_turn_interrupted_by_shutdown_waits_for_hermes_to_resume_it():
    tools = FakeTools()
    store = DeliveryStore(MemoryState())
    stop = asyncio.Event()
    interrupted = FakeDispatcher(error=TurnError("CHANNEL_STOPPED", "stopping"))
    interrupted.gate = asyncio.Event()

    running = asyncio.create_task(connector(tools, interrupted, store).handle(claimed(), stop))
    await asyncio.sleep(0)
    stop.set()
    interrupted.gate.set()
    await running
    assert tools.failures == [] and tools.replies == []

    # After the restart Hermes delivers the resumed reply before Worktable
    # offers the message again.
    restarted = FakeDispatcher()
    subject = connector(tools, restarted, store)
    assert subject.retain_resumed_reply("atlas/thr_1", "Resumed answer.")
    await subject.handle(claimed(lease_id="lease_2"))

    assert restarted.turns == []
    assert [reply["body"] for reply in tools.replies] == ["Resumed answer."]


async def test_a_redelivered_message_takes_the_resumed_reply_while_waiting():
    tools = FakeTools()
    store = DeliveryStore(MemoryState())
    store.begin("atlas/thr_1", "atlas/thr_1/msg_1", {})
    dispatcher = FakeDispatcher()
    dispatcher.resumed = "Answer after restart."

    await connector(tools, dispatcher, store).handle(claimed(lease_id="lease_2"))

    assert dispatcher.turns == []
    assert tools.replies[0]["body"] == "Answer after restart."


async def test_runs_the_message_again_when_hermes_does_not_resume_it():
    tools = FakeTools()
    store = DeliveryStore(MemoryState())
    store.begin("atlas/thr_1", "atlas/thr_1/msg_1", {})
    dispatcher = FakeDispatcher()

    await connector(tools, dispatcher, store).handle(claimed(lease_id="lease_2"))

    assert dispatcher.turns[0].attempt == 2
    assert tools.replies[0]["body"] == "Here is the summary."


async def test_a_lost_lease_keeps_the_reply_for_the_next_delivery():
    tools = FakeTools()
    store = DeliveryStore(MemoryState())
    slow = FakeDispatcher()
    slow.gate = asyncio.Event()

    tools.lose_lease = False
    running = asyncio.create_task(connector(tools, slow, store, heartbeat_seconds=0.01).handle(claimed()))
    await asyncio.sleep(0.005)
    tools.lose_lease = True
    await asyncio.sleep(0.05)
    slow.gate.set()
    await running
    assert tools.replies == [] and tools.failures == []

    tools.lose_lease = False
    again = FakeDispatcher()
    await connector(tools, again, store).handle(claimed(lease_id="lease_2"))
    assert again.turns == []
    assert tools.replies[0]["body"] == "Here is the summary."
    assert tools.replies[0]["deliveryLeaseId"] == "lease_2"
