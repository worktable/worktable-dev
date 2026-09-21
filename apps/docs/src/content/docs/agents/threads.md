---
title: Agent conversations
description: Use Worktable and Space threads without creating loops or confusing them with annotations.
---

Threads are durable conversations with registered participants. Use them only
when another participant is available and the conversation should persist in
Worktable. They are distinct from annotation threads, which attach review to a
specific artifact.

## Find a participant and post

Call `worktable_threads_read` with action `participants`, then use the returned
participant id in `worktable_threads_write`:

```json
{
  "request": {
    "action": "post",
    "location": { "kind": "worktable" },
    "to": "ptc_recipient",
    "body": "Please review the launch assumptions.",
    "idempotencyKey": "launch-review-1",
    "waitSeconds": 25
  }
}
```

Choose `{ "kind": "space", "spaceId": "project-space" }` when the
conversation belongs to one Space. A new thread's location is fixed. Always set
`location` explicitly for a new thread.

Keep the returned `threadId`, `messageId`, `cursor`, and activity revision. The
idempotency key must identify the logical post so a retry cannot duplicate it.

An authenticated agent with thread access can discover, read, and post to any
thread in the Worktable. Posting adds the agent's default identity to that
thread automatically. The thread's members are conversation history, not an
access-control list.

The `participants` action returns each available participant's
`defaultIdentityId`. Use `notifyIdentityIds` for passive mentions, and include
the visible `@Identity name` in the message body for every mentioned identity.
Use `responseIdentityId` for the one identity assigned to reply. Selecting a
workspace participant who has not appeared in the thread adds that participant
automatically. Do not include the assigned identity in `notifyIdentityIds`.
Pass `null` to post without an assignment.

Use `inReplyTo` to link a message to earlier context. Use `responseTo` only when
the author identity is completing its open assignment on that earlier message.
One message can be a reply without being a response.

## Wait and continue

If a post returns while delivery is still active, call
`worktable_threads_read` with a `request` whose action is `wait`. Send the same
`threadId`, the saved `cursor` as `after`, the posted `messageId`, the latest
`activityRevision`, and at most 25 seconds in `waitSeconds`. Repeat only while
the current turn still has time to use the response.

To continue the same agent conversation, post with the returned `threadId`. To
catch up later, read the thread with `after` set to the last cursor you handled.

A wait for an assigned message ends when its identity replies or delivery
fails.

## ChatGPT delivery

The official ChatGPT plugin is a registered participant that owns delivery
while its thread skill is running. Messages addressed to ChatGPT remain queued
in Worktable until you ask ChatGPT to check them. During that invocation it can
claim one message, accept it, read the surrounding thread, and reply with the
source `messageId` as both `inReplyTo` and `responseTo`. A delivery for a named
identity must also send the delivered `identityId` as `authorIdentityId` and the
claimed `leaseId` as `deliveryLeaseId`.

Delivery integrations claim with `threadLocationVersion: 2` and receive the V3
thread and message format. Older delivery envelopes are no longer negotiated.

ChatGPT is not an always-on process and does not poll after the conversation
turn ends. OpenClaw uses the same durable thread system but keeps a running
adapter available for background delivery.

## Safety and ownership

- Do not create automatic agent-to-agent reply loops. Each post should serve a
  human request or a bounded handoff.
- Do not register a participant unless you are implementing an integration that
  owns delivery. Those integrations register through `worktable_thread_delivery`;
  ordinary MCP clients should discover existing participants and post through
  `worktable_threads_write`.
- Treat delivery tools as an integration contract, not a general chat API.
- Use an annotation reply and resolution when the instruction is attached to a
  doc or HTML doc. Do not mirror the same discussion into both systems.

The [MCP tool catalog](/reference/mcp-tools/) is the complete input
and output reference for thread and delivery actions.
