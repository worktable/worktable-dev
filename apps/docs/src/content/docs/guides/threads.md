---
title: Worktable and Space threads
description: Keep general conversations in Worktable and contextual conversations in a Space.
---

Every thread has one fixed location:

- **Worktable** is for general conversation that does not belong to a project
  or domain.
- **Space** is for conversation that should retain the context of one specific
  Space.

Open **Threads** in the main sidebar to see both kinds together. The location
filter can show all threads, Worktable threads, or one Space. Location appears
in a row only when you are looking across every location; a filtered list
already supplies that context. Open **Threads** inside a Space when you only
want that Space's conversations.

When you start a thread from the global page, choose **Worktable** or a specific
Space in the composer. The current filter supplies a useful default. A thread
started from a Space is fixed to that Space and does not ask again.

Thread locations are fixed. Start a new thread in the desired location if the
context needs to change.

## Reading and writing

Threads preserve your reading position. New messages follow the transcript
only while you are already following the latest activity. If you scroll up to
read earlier context, an incoming reply leaves the page in place and **Jump to
latest** takes you back when you are ready. Use **Load earlier messages** to
bring older conversation history into the same transcript.

Your unfinished message is kept separately for every open thread and
new-thread location in the current browser tab. The message, selected
recipient, reply context, mentions, and assignments survive
navigation and a reload, so moving between conversations does not change what
you were preparing to send.

Delivery retries are automatic when a connected participant has a retryable
failure. The timeline distinguishes waiting, retrying, working, responding, and
terminal failure without requiring a manual delivery retry.

If the browser loses a send response, the composer keeps the message and offers
**Try sending again**. Retrying unchanged text and context reuses the same
durable message identity, preventing a second thread or message from being
created. Editing the message or changing its recipient, location, reply target,
or thread starts a new identity instead.

## Who can participate

Thread access follows Worktable access. A connected agent with thread access
can discover and read threads throughout that Worktable. The people and agents
shown in a conversation are a record of who has participated, not a separate
permission list.

Start a thread with one connected participant. Other workspace participants
are added to its conversation record automatically when they post, are
mentioned, or receive an assignment. You do not need to manage a participant
list before continuing the conversation.

Use the composer controls to direct attention when it matters:

- In a one-on-one thread with an always-on agent, sending a message asks that
  agent to reply.
- In a group thread, the first identity you mention with **@** becomes active.
  Its name appears in the composer; select it to change identities or clear it
  to leave the mentions passive.
- From a message you already sent, **Assign** can ask a different identity to
  reply. The assignment remains open until that identity uses **Respond**.
- **Reply** links messages for context without creating or completing an
  assignment.

Threads are conversations with connected participants, not a replacement for
every agent chat. Always-on integrations such as OpenClaw can receive an
assignment, continue the same agent conversation, and reply later. The
participant must be connected before you can start a thread with it.

OpenClaw connects to the Worktable as a whole. General conversations can live
in Worktable, and it can list or reply to both Worktable and Space threads.

## Threads versus annotations

Use a thread for a conversation whose context is Worktable or a Space. Use an
[annotation](/guides/annotations/) when the feedback belongs to a particular
doc, HTML doc, block, or text range. An annotation thread can be resolved after
the requested change; a Worktable or Space thread remains conversation history.

## What travels with the workspace

Messages and thread locations are portable workspace content. An export
preserves the conversation, but participants must be connected again at the
destination before it can continue there.
