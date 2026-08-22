---
name: worktable-create-or-manage-interactive-html
description: Create or improve durable visual and interactive artifacts in Worktable. Use for dashboards, trackers, calculators, mini apps, slide presentations, and other requests that benefit from a polished HTML Doc.
---

# Create interactive Worktable HTML

Treat an HTML Doc as a **durable interface**, not decorated prose. Help the user understand or do something faster, make the artifact useful after the current chat, and let it stand on its own for the next person or agent.

## Choose the composition

- **Presentation or visual brief:** keep the complete high-level experience in one HTML Doc. Link a narrative Doc when deeper reasoning or source notes matter independently.
- **Board, tracker, planner, directory, or dashboard:** keep independently changing entities in Records; make the HTML Doc a focused view that subscribes to and updates those Records.
- **Calculator or mini tool:** keep deterministic logic in the HTML. Use `worktable.state` only for interface-local drafts, filters, selections, or preferences. Create Records only when outputs need durable identity or reuse.
- **Live external data:** request network access only when the user actually needs it. Prefer Worktable runtime APIs for Worktable data.

## Build the artifact

1. Discover the workspace and related artifacts. Update the existing HTML Doc when it already owns the job.
2. Before updating an existing HTML Doc, read its complete source with `worktable_html_read` action `read`. List open annotations with `worktable_annotations_read` filtered by its `htmlId`, inspect the context of relevant instructions, and preserve user-owned content that the request does not replace.
3. Define the audience, purpose, 30-second takeaway, and one memorable compositional idea before writing markup. Give each viewport one dominant idea and reveal supporting depth only when useful.
4. Read `worktable_html_read` action `guide` with the `runtime` profile for the authoritative sandbox, bridge, permission, and data contract. Do not treat visual workflow guidance as a server security boundary.
5. Model and seed canonical Records first when the interface depends on them. Then write one complete self-contained HTML document with the narrowest permissions that cover its actual calls.
6. Validate Mermaid sources with `worktable_mermaid` when embedding a diagram or returned SVG. Repair actionable Worktable validation warnings.
7. Exercise the real experience when possible: render desktop and mobile, use every important control, and verify that a Record mutation survives rereading the collection.

## Hold the quality bar

- **Comprehension:** create a clear narrative spine, strong hierarchy, and obvious next action. Avoid generic card grids, random eyebrows, everything-equal layouts, ornamental metrics, and decoration without meaning.
- **Visual craft:** refine typography, line length, spacing rhythm, alignment, contrast, and negative space. Use real content, responsive composition, and coherent light and dark themes through Worktable semantic variables.
- **Interaction:** give every control a purpose and legible loading, saving, success, empty, and failure states where relevant. Record-backed actions must update canonical Records, not only local HTML.
- **Accessibility:** use semantic headings and native controls, visible focus, keyboard operation, comfortable targets, reduced-motion support, and a non-drag path for drag-and-drop workflows.
- **Continuity:** explain the artifact without relying on the transcript, link supporting durable work, preserve user-owned content, and make the next update straightforward.

Return `urlToSendInChat` as the entry point and briefly name the durable sources behind the interface. The artifact is complete when its purpose is clear within seconds, its important path works with real data, and the user can return through one stable link.
