---
title: How Worktable works
description: What each part of Worktable is, and how it behaves for you and your agents.
---

## What's in Worktable

### Worktable

**Where your work and your agents meet.** Your Worktable holds your Spaces.
Every agent you connect works in it.

Run it on your own computer, on your own server, or in Worktable Cloud, and
open it in Desktop or a browser. Local and self-hosted Worktables keep your
work in a folder you control, and you can export any Worktable to keep a copy.

See [Desktop](/start/desktop/), [Cloud setup](/guides/worktable-cloud/) and
[Import and export](/guides/import-export/).

### Agents

**Connect the agents you already use.** Connect ChatGPT, Claude, Grok Bot or
others. Each one works in the Spaces it can access.

Connect one from **Settings → Agents**. An agent reads and edits the same Docs,
drawings and Records you do, and Activity shows what it changed. On your own
Worktable you choose what each agent can do when you connect it. In a team,
your agents follow your Space access.

See [Connections](/start/connect-your-agent/) and
[Agent Replies](#agent-replies).

### Spaces

**Like a project, a client or a topic.** A Space holds one area of work,
whatever you want it to be. Agents work in the Spaces they can access.

Create a Space from the sidebar. Its **+** menu makes Docs, drawings and
folders. Click a Space's name to open Space Home, with its latest work, pinned
Docs and what archives soon. Each Space has its own threads.

See [Spaces](/guides/organize-and-find/).

### Docs

**Notes, plans and research.** Write in rich text or Markdown. You and your
agents edit the same Doc.

Choose **Doc** from a Space's **+** menu, type a title and start writing. An
open Doc shows an agent's changes as they save. Agents read every Doc as
Markdown.

See [Documents](/guides/docs-and-versions/).

### HTML Docs

**Pages you can click through.** Comparisons, mockups, explainers, slideshows
and tools, often built by your agents. They can use your Records.

Tell an agent what the page should do, try it, and ask for changes to the same
HTML Doc. Pages run in a sandbox, and their permissions say what else they can
reach. With permission, a page can read and update Records, so the table, the
page and your agents share the same rows.

See [HTML docs](/guides/widgets/) and
[Interactive tools](/workflows/interactive-tools/).

### Drawings

**Sketches and diagrams.** Draw freehand or add shapes and images. Your agents
can read and edit them too.

Choose **Drawing** from a Space's **+** menu. It saves when you stop drawing.
An agent looks at a preview and changes specific shapes, labels and arrows, and
leaves the rest alone. Typed text shows up in search.

See [Drawings](/guides/drawings/).

### Files

**Images, PDFs and spreadsheets.** Add any file to a Space. Your agents can
open it.

Choose **Upload File** from a Space's **+** menu. Agents read a file's text and
look at its images. A file keeps its history when it changes.

### Records

**Tables of things that change one by one.** Like tasks, leads or sources.
Agents can add and update rows, and pages can use them.

A collection holds the rows, and its schema sets the fields. Edit a cell, or
open a row to see all of it. Filters and sorting stay on your device. Copy the
link to share a view.

See [Records](/guides/records/), the
[request workflow](/workflows/track-requests/) and the
[records reference](/reference/records/).

### Comments

**Comment on any line or any part of a page.** Send a comment to a person or an
agent, or leave it as a note.

Select text in a Doc to comment on it. In an HTML Doc, click the part you mean.
People and agents reply and resolve comments. If the text changes, the comment
moves to **Text Changed** and still opens the version it was written on.

See [Annotations](/guides/annotations/) and
[Agent Replies](#agent-replies).

### Threads

**Conversations with people and agents.** A thread belongs to the whole
Worktable or to one Space. In a group thread, @mention the agent you want.

Start one from **Threads** in the sidebar or on a Space's **Threads** page. You
can't move a thread later. **Assign** asks someone to reply, and it stays open
until they do.

See [Threads](/guides/threads/).

### Pending

**Anything that needs you.** Things waiting on you, like a request sent to you
or a message that didn't get through.

Pending shows on Home only when something waits on you: a message assigned to
you, a comment sent to you, a message that didn't get through, a visitor
comment you can answer, or a Library change an agent suggested. Space Home
shows the same for one Space.

A thread shows once, however many of its messages ask you, and leaves when
you reply in it. Each row opens at its place: the thread at the message that
asked, the Doc on the comment.

**Done** on a request lets it go without an answer. It stops waiting on you,
and the thread or comment shows it is no longer waiting.

See [Find content](/guides/organize-and-find/#find-content).

### Library

**What your team approved for agents to use.** Skills and other material your
team approved for its agents. Agents suggest changes, and someone approves
them.

Choose **Add to Library** from a Doc's menu. A skill can be for the whole
Worktable, one Space or one agent. Every agent that library reaches follows the
skill, even one that can't open the Doc's Space: it gets the skill's text, not
the rest of the Space, and the Library names those agents. Agents get the
version someone saved, never a half-done edit. If the Doc is archived, agents
keep the saved version until you restore the Doc or remove the skill.

When an agent suggests a new skill, a change or a removal, it waits in the
Library and in Pending. Choose **Approve** to make it live or **Discard** to
drop it. Until then, agents keep using the last approved version.

See [Skills](/agents/skills/).

## How it behaves

### Temporary Docs

**Most new Docs archive after a week untouched.** This keeps your Spaces tidy.
Archived Docs stay readable by your agents, and you can restore them. You or
your agent can change the date, or keep a Doc for good.

A temporary Doc archives seven days after its last edit, rename or comment.
Open the **Archives** chip under its title to **Keep** it, pick another date, or
**Archive now**. Archived Docs are never deleted on their own, and restoring
one keeps it for good. To start new Docs durable, clear **Start as Temporary**
in a Space's **+** menu.

See [Document lifetimes](/guides/organize-and-find/#document-lifetimes).

### Versions

**Go back to an earlier version.** Your edits and your agents' are saved as
versions. Compare any two and restore one.

Edits in a row by one person or agent make one version until a 10-minute
pause. Versions are kept for 30 days unless you change it in
**Settings → Data**. Choose **Save version** to keep one for good. Restoring an
HTML Doc brings back its source, not the Records it changed.

See [Version history](/guides/docs-and-versions/#version-history).

### Share Links

**Anyone with the link sees it as it is now.** Send a Doc or page to anyone.
Links last 14 days unless you change it.

Choose **Share**, then **Create Link**. Readers don't need to sign in. Add a
password, or give each audience its own link. Revoke a link any time from
**Share** or **Settings → Sharing**. Share links work in Worktable Cloud, and
on your own Worktable with Worktable Link on.

See [Sharing](/guides/sharing/).

### Who Can See It

**In a team, Spaces are shared unless you limit them.** Choose who can open each
Space, people and agents alike.

Every member can read and edit a new Space. To limit one, choose
**Manage Access** from the Space's menu and pick **Only selected people and
agents**. Owners can open every Space. Your agents follow your access, and team
agents need their own. A Space's threads follow its access.

When you turn on Teams on your own Worktable, your existing Spaces stay limited
until you share them.

See [Team access](/reference/security/#team-access).

### Agent Replies

**Some agents answer on their own.** Always-on agents like OpenClaw and Hermes
answer any time. Others answer while Auto-reply is on. The rest see your
message next time they're open.

- **Always-on agents** answer thread messages while their connection runs. Set
  them up in **Settings → Agents → Connect App**. They see comments the
  next time they work in Worktable.
- **Auto-reply** shows on an agent in **Settings → Agents**. ChatGPT answers
  while a Work chat watches Worktable. Claude answers from a scheduled task,
  even when your computer is off. Claude Code, Codex CLI and ChatGPT Desktop
  answer while their session is open.
- **Every other agent** picks up what you sent the next time you use it.

See [Connections](/agents/connections/) and [Threads](/guides/threads/).

### Linked Work

**Docs, Records and pages can point to each other.** Link one Doc from another.
A Record can point to the Doc about it, and a page can show your Records.

- **Doc links:** link with Markdown such as `[Project brief](/project-brief)`.
  The count under a Doc's title shows what links to it. Links keep working when
  you move or rename a Doc.
- **Records:** a document field points to a Doc in the Space, and a relation
  field points to other Records.
- **Pages:** an HTML Doc with permission reads your Records, so a board or a
  calendar shows the same rows as the table.

See [Links and backlinks](/guides/docs-and-versions/#links-and-backlinks),
[Define fields](/guides/records/#define-fields) and
[Use records](/guides/widgets/#use-records).

### Worktable Link

**Reach this Worktable from any device.** Worktable Link is for a Worktable that
runs on your own computer or server. It lets Claude, ChatGPT and other AI apps
reach it from any device, and turns on share links.

- **Your files stay put.** Link passes approved requests through your Cloud
  account to your computer. Nothing is copied to Cloud.
- **Keep it running.** The computer has to be on with Worktable running.
  Worktable Desktop keeps a linked Worktable running in the background until
  you quit it.
- **Turn it on** in **Settings → Remote**, or with **Set Up** when you connect
  a chat app.

See [Worktable Link](/guides/remote-access/#worktable-link).
