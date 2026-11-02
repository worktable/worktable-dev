import { useEffect, type RefObject } from "react"
import type { Annotation, PassageSelector } from "@worktable/types"
import { listDocVersions, readDocVersion } from "@/lib/docs-api"
import { rangeForPassage, readPassageText, setHighlight } from "./passage-text"

const ORIGINAL = "worktable-comment-original"

/**
 * The version a comment was written on: the last one saved before it, or
 * the first version when the comment is older than the Doc's history. Saves
 * close together share one version, so the newest one before the comment
 * can already hold a later rewrite; the words are checked, going back a few
 * versions until they are there.
 */
export async function versionCommentedOn(
  spaceId: string,
  docPath: string,
  annotation: Annotation
): Promise<string | null> {
  const versions = await listDocVersions(spaceId, docPath, true)
  const byTime = [...versions].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )
  const before = byTime
    .filter((version) => version.createdAt <= annotation.createdAt)
    .reverse()
  const candidates = before.length ? before : byTime.slice(0, 1)
  const target = annotation.target
  const quote = "quote" in target ? target.quote : undefined
  if (quote) {
    const words = plain(quote)
    for (const version of candidates.slice(0, 5)) {
      const snapshot = await readDocVersion(spaceId, docPath, version.id)
      if (plain(textOf(snapshot.after.content)).includes(words)) return version.id
    }
  }
  return candidates[0]?.id ?? null
}

/** A saved Doc's words: Markdown as written, or the text in its blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  const parts: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === "string") parts.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === "object") {
      const node = value as { text?: unknown; content?: unknown; children?: unknown }
      walk(node.text)
      walk(node.content)
      walk(node.children)
    }
  }
  walk(content)
  return parts.join(" ")
}

/** Words without Markdown marks or line breaks, to compare passages. */
function plain(text: string): string {
  return text.replace(/[*_`~#>[\]]/g, "").replace(/\s+/g, " ").trim()
}

/** Marks a comment's passage in an earlier version and brings it into view. */
export function useMarkOriginal(
  rootRef: RefObject<HTMLElement | null>,
  passage: PassageSelector | null
) {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !passage) return
    let frame = 0
    let revealed = false
    const place = () => {
      frame = 0
      const range = rangeForPassage(readPassageText(root), passage)
      setHighlight(ORIGINAL, range ? [range] : [])
      if (range && !revealed) {
        revealed = true
        range.startContainer.parentElement?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        })
      }
    }
    place()
    // The version loads and renders after it is chosen.
    const observer = new MutationObserver(() => {
      frame ||= requestAnimationFrame(place)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      setHighlight(ORIGINAL, [])
    }
  }, [rootRef, passage])
}
