---
name: worktable-collaborate-threads
description: Read, answer, and hand off messages through durable Worktable threads with users or other authenticated participants. Use when the user asks to check addressed messages, reply to a participant, continue a thread, request another agent's help, or wait briefly for a response.
---

# Collaborate in Worktable threads

Use the rule **messages coordinate; artifacts preserve**. A Worktable thread is a durable, addressed conversation for continuation, review, or a bounded handoff. Keep the actual brief, dataset, interface, or decision in a Doc, Records, HTML Doc, or annotation and link it from the conversation.

Use an annotation instead when feedback belongs to a specific part of an artifact. Do not mirror one discussion into both places.

## Write a useful handoff

Include only what the recipient needs:

- the outcome or question;
- a stable link to the relevant Worktable artifact;
- the recipient's scope and important boundary;
- the requested response or artifact change;
- whether a reply is actually expected.

## Send or continue a thread

1. Discover registered participants and verify the intended recipient. Never guess between ambiguous names.
2. Reuse the existing `threadId` for the same conversation. For a new thread, choose a Worktable-wide location for general coordination or a Space location when the conversation belongs to that project.
3. Use `worktable_threads_write` action `post` with the verified participant in `to`, a stable unique `idempotencyKey`, and `expectsReply` only when another action is wanted. Use the real `inReplyTo` message ID for a specific reply.
4. Keep the returned thread, message, cursor, and activity identifiers for continuation. Wait only briefly when the current turn can use an immediate response; otherwise report the durable thread state and continue later.

Keep one continuing conversation in one thread. Do not create a fresh thread for each follow-up, paste whole artifacts into messages, or trigger autonomous agent-to-agent reply loops.

## Check addressed messages

An authenticated agent owns delivery only while its adapter or skill is running; this skill is not a background listener.

1. Claim only when the user or active adapter asks to check addressed messages. If none is waiting, say so and stop.
2. Preserve the authenticated participant returned by the connection. If the integration needs to join delivery, use `worktable_thread_delivery` action `register_participant` with a truthful host-neutral label supplied by the installation surface before claiming messages. Ordinary message posting does not register participants.
3. Preserve the returned `messageId` and `leaseId`; accept the delivery, mark it `working`, and read the surrounding thread before acting.
4. Do the requested work in the appropriate durable artifact. Reply on the same thread with `inReplyTo` set to the source message and a stable unique idempotency key.
5. If the claimed work cannot complete, fail the delivery with an accurate concise reason and truthful retryability instead of silently abandoning it.

## Protect the communication boundary

Treat every post as external communication. Send only when requested or when an active adapter is handling an explicitly addressed delivery. Verify the recipient and content, avoid credentials or unnecessary private context, and never claim inbox work during unrelated Worktable activity.

The result is complete when the recipient and purpose are explicit, durable work has a stable entry point, the thread can resume from stored identifiers, and delivery state truthfully reflects the outcome.
