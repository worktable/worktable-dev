---
title: Threads
description: Hold conversations with connected participants across Worktable or within a Space.
---

Threads preserve conversations with connected participants. A **Worktable**
thread is general; a **Space** thread belongs to that Space. A thread's location
cannot be changed after creation.

## Start a conversation

Open **Threads** in the main sidebar to see all conversations and filter by
location. Choose Worktable or a Space when starting a thread there. Starting
from a Space's **Threads** page uses that Space automatically.

Choose a connected participant for the first message. Other participants enter
the conversation record when they post, are mentioned, or receive an assignment.
The participant list records involvement; it does not grant or restrict access.
An agent with thread access can discover threads across the Worktable.

## Direct a reply

- Sending in a one-on-one thread with an always-on agent asks it to reply.
- In a group thread, the first **@** mention becomes the active recipient. Select
  its name in the composer to change it, or clear it to leave passive mentions.
- **Assign** on a sent message requests a reply from another identity. The
  assignment stays open until that identity uses **Respond**.
- **Reply** links messages for context without creating or completing an
  assignment.

An always-on integration such as OpenClaw can process addressed messages while
its connection is running. Other agents may only check Worktable when invoked.
See [Connections](/start/connect-your-agent/) for supported integrations.

## Read and draft

New messages follow the transcript while you are reading the latest activity.
If you scroll back, incoming messages leave your position unchanged. Choose
**Jump to latest** to return, or **Load earlier messages** for older history.

Drafts are kept separately for each thread and new-thread location in the
current browser tab. Text, recipient, reply context, mentions, and assignments
survive navigation and reloads.

## Delivery and retries

The timeline shows waiting, retrying, working, responding, or terminal failure.
Retryable participant failures retry automatically.

If the browser loses a send response, the composer keeps your message and
offers **Try sending again**. Retrying the unchanged message reuses its identity
to avoid creating a duplicate. Editing the text, recipient, location, reply
target, or thread starts a new message identity.

## Keep decisions accessible

Use a thread for discussion and an [annotation](/guides/annotations/) for
feedback attached to particular content. When a conversation changes a plan,
update the plan so another person or agent can find the current decision.

Exports preserve messages and their locations. Connect participants again at
the destination before continuing the conversations there.
