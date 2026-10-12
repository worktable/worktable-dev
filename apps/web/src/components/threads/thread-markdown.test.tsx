import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadLocation } from "@worktable/types"
import { ThreadMarkdown, ThreadMarkdownProvider } from "./thread-markdown"

function render(
  location: ThreadLocation,
  mentionNames: string[],
  body: string
): string {
  return renderToStaticMarkup(
    <ThreadMarkdownProvider location={location} mentionNames={mentionNames}>
      <ThreadMarkdown messageId="msg_markdown_reuse" body={body} />
    </ThreadMarkdownProvider>
  )
}

test("a message shows its current text, mentions and links each time it renders", () => {
  const space = { kind: "space", spaceId: "launch" } as const
  const body = "Ask @Atlas about [the plan](/plans/q1)."
  const mention = "bg-primary/10"

  const first = render(space, ["Atlas"], body)
  expect(first).toContain(mention)
  expect(first).toContain('href="/spaces/launch/documents/plans/q1"')

  // The same message again, after the thread's names or location changed.
  expect(render(space, ["Finn"], body)).not.toContain(mention)
  expect(render({ kind: "worktable" }, ["Atlas"], body)).toContain(
    "This Space-relative link has no Worktable location"
  )

  // The message after an edit.
  const edited = render(space, ["Atlas"], "Ask @Atlas again.")
  expect(edited).toContain("again.")
  expect(edited).not.toContain("the plan")
})
