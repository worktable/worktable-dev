import asyncio
from typing import Optional

import pytest

from worktable_hermes.access import Access
from worktable_hermes.client import WorktableError
from worktable_hermes.connector import Connector, Turn, TurnError
from worktable_hermes.store import DeliveryStore, MemoryState


OWNER = "ptc_maya_owner_01"
MEMBERS = {
    OWNER: ("human", "Maya"),
    "ptc_sam_member_01": ("human", "Sam"),
    "ptc_atlas_agent_1": ("agent", "Atlas"),
}


def claimed(message_id="msg_1", lease_id="lease_1", body="Summarize the launch plan", author=OWNER):
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
                *({"id": id, "kind": kind, "name": name} for id, (kind, name) in MEMBERS.items()),
                {"id": "ptc_hermes", "kind": "agent", "name": "Hermes"},
            ],
            "identities": [
                {"id": "idt_hermes", "memberId": "ptc_hermes", "name": "Hermes", "default": True, "status": "active"},
                *(
                    {"id": f"idt_{id}", "memberId": id, "name": name, "default": True, "status": "active"}
                    for id, (_kind, name) in MEMBERS.items()
                ),
            ],
        },
        "message": {"id": message_id, "body": body, "authorMemberId": author, "authorIdentityId": f"idt_{author}"},
    }


class FakeTools:
    def __init__(self):
        self.calls = []
        self.replies = []
        self.failures = []
        self.messages = []
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
        self.messages.append(message)

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
    access = options.pop("access", Access(OWNER))
    return Connector(
        tools,
        dispatcher,
        store or DeliveryStore(MemoryState()),
        access=lambda: access,
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


SAM, ATLAS = "ptc_sam_member_01", "ptc_atlas_agent_1"


@pytest.mark.parametrize(
    "access, author, refused",
    [
        # Only the person who connected Hermes, until that person opts into more.
        (Access(OWNER), OWNER, None),
        (Access(OWNER), SAM, "NOT_OWNER"),
        (Access(OWNER), ATLAS, "AGENT_NOT_TRUSTED"),
        # Trusting the Worktable's members lets people in, not their agents.
        (Access(OWNER, trust_all_members=True), SAM, None),
        (Access(OWNER, trust_all_members=True), ATLAS, "AGENT_NOT_TRUSTED"),
        # Agents are their own opt-in.
        (Access(OWNER, trust_all_agents=True), ATLAS, None),
        (Access(OWNER, trust_all_agents=True), SAM, "NOT_OWNER"),
        # A connection with nobody on record lets nobody in, whatever it trusts.
        (Access(None, trust_all_members=True, trust_all_agents=True), OWNER, "OWNER_UNKNOWN"),
    ],
)
async def test_runs_a_message_only_for_an_author_the_owner_allows(access, author, refused):
    tools, dispatcher = FakeTools(), FakeDispatcher()

    await connector(tools, dispatcher, access=access).handle(claimed(author=author))

    if refused is None:
        assert [turn.sender["id"] for turn in dispatcher.turns] == [author]
        assert len(tools.replies) == 1 and tools.failures == []
    else:
        # Nothing reaches Hermes, and the author sees why on their message.
        assert dispatcher.turns == [] and tools.replies == [] and tools.calls == []
        assert tools.failures == [{"messageId": "msg_1", "retryable": False, "code": refused}]
        assert "Hermes" in tools.messages[0]


async def test_an_author_the_thread_does_not_list_is_never_trusted():
    tools, dispatcher = FakeTools(), FakeDispatcher()
    delivery = claimed(author=SAM)
    delivery["thread"]["members"] = [member for member in delivery["thread"]["members"] if member["id"] != SAM]
    everyone = Access(OWNER, trust_all_members=True, trust_all_agents=True)

    await connector(tools, dispatcher, access=everyone).handle(delivery)

    assert dispatcher.turns == []
    assert [failure["code"] for failure in tools.failures] == ["NOT_OWNER"]


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


async def test_a_turn_waiting_behind_another_does_not_start_once_hermes_stops():
    tools = FakeTools()
    store = DeliveryStore(MemoryState())
    stop = asyncio.Event()
    first = FakeDispatcher(error=TurnError("CHANNEL_STOPPED", "stopping"))
    first.gate = asyncio.Event()
    subject = connector(tools, first, store)

    running = asyncio.create_task(subject.handle(claimed(), stop))
    await asyncio.sleep(0)
    queued = asyncio.create_task(subject.handle(claimed("msg_2", "lease_2"), stop))
    await asyncio.sleep(0)
    stop.set()
    first.gate.set()
    await asyncio.gather(running, queued)

    # Only the first turn ran, so Hermes' resumed reply still belongs to it.
    assert [turn.message_id for turn in first.turns] == ["msg_1"]
    assert store.pending("atlas/thr_1")["event"] == "atlas/thr_1/msg_1"
