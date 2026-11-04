// ============================================================
// Images on shared pages
// ============================================================
//
// A shared Doc shows the images it embeds from its own Space, and nothing
// else in the Space becomes reachable: each image is read and placed in the
// page as a data URL, which the share renderer and its policy already allow
// (space-images.ts, where the caps and rules live). Images past the page's
// budget, larger ones, and types the file type table's share policy leaves
// out (SVG and AVIF) keep the placeholder shared pages show today.

import { filesEnabled } from "./files-enabled.ts"
import { rewriteBlockLinks, rewriteMarkdownLinks } from "./link-rewrite.ts"
import {
  embeddedFilesUnchanged,
  readSpaceImages,
  type EmbeddedFile,
} from "./space-images.ts"

export { embeddedFilesUnchanged, type EmbeddedFile }

/**
 * A shared Doc's content with the images it embeds from its Space placed in
 * it as data URLs, and what it saw of each file it embeds. With files off,
 * the content as it is.
 */
export async function inlineSharedImages<T extends string | unknown[]>(
  spaceId: string,
  docPath: string,
  content: T
): Promise<{ content: T; embeds: EmbeddedFile[] }> {
  if (!filesEnabled()) return { content, embeds: [] }
  // Each image's occurrences, as every one carries its own data URL.
  const targets = new Map<string, number>()
  const collect = (target: string, imageUses = 1) => {
    // A definition many images refer to shows its bytes in each of them.
    targets.set(target, (targets.get(target) ?? 0) + Math.max(1, imageUses))
    return null
  }
  if (typeof content === "string") {
    rewriteMarkdownLinks(content, collect, { imagesOnly: true })
  } else {
    rewriteBlockLinks(content, collect, { imagesOnly: true })
  }
  if (targets.size === 0) return { content, embeds: [] }

  const { dataUrls, embeds } = await readSpaceImages(spaceId, docPath, targets)
  const inline = (target: string) => dataUrls.get(target) ?? null
  const inlined =
    typeof content === "string"
      ? rewriteMarkdownLinks(content, inline, { imagesOnly: true })
      : rewriteBlockLinks(content, inline, { imagesOnly: true }).blocks
  return { content: inlined as T, embeds }
}
