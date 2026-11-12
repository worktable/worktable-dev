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


def claimed(message_id="msg_1", lease_id="lease_1", body="Summarize the launch plan", author=OWNER, connected_by=None):
    return {
        # What a current Worktable says with a delivery; an older one says nothing.
        **({"connectedBy": connected_by} if connected_by is not None else {}),
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


def said(author=None, recipient=OWNER):
    """Worktable naming who connected this Hermes and, for an agent, the author."""
    return {"recipient": recipient, "author": author}


# A connection made by a plugin that recorded no owner.
UNRECORDED = Access(None)


@pytest.mark.parametrize(
    "access, author, connected_by, refused",
    [
        # Worktable names the owner with each message, so a connection made
        # by an earlier plugin answers its owner without connecting again.
        (UNRECORDED, OWNER, said(), None),
        (UNRECORDED, SAM, said(), "NOT_OWNER"),
        # An agent the owner connected is the owner's own, until turned off.
        (UNRECORDED, ATLAS, said(author=OWNER), None),
        (Access(None, trust_own_agents=False), ATLAS, said(author=OWNER), "AGENT_NOT_TRUSTED"),
        (Access(None, trust_own_agents=False), OWNER, said(), None),
        # Another person's agent, or one with nobody on record, is not.
        (UNRECORDED, ATLAS, said(author=SAM), "AGENT_NOT_TRUSTED"),
        (UNRECORDED, ATLAS, said(), "AGENT_NOT_TRUSTED"),
        (Access(None, trust_all_agents=True), ATLAS, said(author=SAM), None),
        (Access(None, trust_all_agents=True), ATLAS, said(), None),
        # Each opt-in covers its own kind of author only.
        (Access(None, trust_all_members=True), SAM, said(), None),
        (Access(None, trust_all_members=True), ATLAS, said(author=SAM), "AGENT_NOT_TRUSTED"),
        (Access(None, trust_all_agents=True), SAM, said(), "NOT_OWNER"),
        # Worktable has nobody on record for an agent a team owns: the
        # approver recorded at pairing stands in, and without one nobody does.
        (Access(OWNER), OWNER, said(recipient=None), None),
        (Access(None, trust_all_members=True, trust_all_agents=True), OWNER, said(recipient=None), "OWNER_UNKNOWN"),
        # An older Worktable says nothing. With teammates, the recorded
        # approver stands and no agent counts as the owner's own.
        (Access(OWNER), OWNER, None, None),
        (Access(OWNER), SAM, None, "NOT_OWNER"),
        (Access(OWNER), ATLAS, None, "AGENT_NOT_TRUSTED"),
        (Access(None, trust_all_members=True, trust_all_agents=True), OWNER, None, "WORKTABLE_TOO_OLD"),
    ],
)
async def test_runs_a_message_only_for_an_author_the_owner_allows(access, author, connected_by, refused):
    tools, dispatcher = FakeTools(), FakeDispatcher()

    await connector(tools, dispatcher, access=access).handle(claimed(author=author, connected_by=connected_by))

    if refused is None:
        assert [turn.sender["id"] for turn in dispatcher.turns] == [author]
        assert len(tools.replies) == 1 and tools.failures == []
    else:
        # Nothing reaches Hermes, and the author sees why on their message.
        assert dispatcher.turns == [] and tools.replies == [] and tools.calls == []
        assert tools.failures == [{"messageId": "msg_1", "retryable": False, "code": refused}]
        assert "Hermes" in tools.messages[0]


async def test_an_older_worktable_with_one_person_answers_that_person_and_their_agents():
    # It cannot say who connected whom, but it has nobody else in it.
    asked = []

    async def one_person():
        asked.append(True)
        return True

    for access, author, refused in [
        (UNRECORDED, OWNER, None),
        (UNRECORDED, ATLAS, None),
        (Access(None, trust_own_agents=False), ATLAS, "AGENT_NOT_TRUSTED"),
    ]:
        tools, dispatcher = FakeTools(), FakeDispatcher()
        await connector(tools, dispatcher, access=access, is_one_person_worktable=one_person).handle(
            claimed(author=author)
        )
        assert [failure["code"] for failure in tools.failures] == ([refused] if refused else [])
        assert len(dispatcher.turns) == (0 if refused else 1)
    assert len(asked) == 3

    # A Worktable that says who connected whom is never asked.
    tools, dispatcher = FakeTools(), FakeDispatcher()
    await connector(tools, dispatcher, access=UNRECORDED, is_one_person_worktable=one_person).handle(
        claimed(author=SAM, connected_by=said())
    )
    assert len(asked) == 3 and [failure["code"] for failure in tools.failures] == ["NOT_OWNER"]
    assert tools.messages == ["Only the person who connected Hermes can direct it."]


@pytest.mark.parametrize("author", [SAM, OWNER])
async def test_an_author_the_thread_does_not_list_is_never_trusted(author):
    # Not even under the owner's id: the owner is a person the thread lists.
    tools, dispatcher = FakeTools(), FakeDispatcher()
    delivery = claimed(author=author, connected_by=said(author=OWNER))
    delivery["thread"]["members"] = [member for member in delivery["thread"]["members"] if member["id"] != author]
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
