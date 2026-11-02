import { useEffect, type RefObject } from "react"
import type { Annotation, PassageSelector } from "@worktable/types"
import { listDocVersions } from "@/lib/docs-api"
import { rangeForPassage, readPassageText, setHighlight } from "./passage-text"

const ORIGINAL = "worktable-comment-original"

/**
 * The version a comment was written on: the last one saved before it, or
 * the first version when the comment is older than the Doc's history.
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
  const before = byTime.filter(
    (version) => version.createdAt <= annotation.createdAt
  )
  return (before.at(-1) ?? byTime[0])?.id ?? null
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
