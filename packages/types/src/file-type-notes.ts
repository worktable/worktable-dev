// ============================================================
// File type notes
// ============================================================
//
// The documentation half of the file type table: where each surface lives,
// how surfaces are expected to agree, and why a type breaks a rule where it
// does. Only the conformance test imports this module, so none of it ships
// to the app; file-types.ts holds what code reads.

import type {
  FileSurface,
  FileSurfacePolicies,
  FileTypeEntry,
  FileTypeId,
} from "./file-types"

/**
 * Why a surface treats a type differently from what an agreement rule
 * expects. `fix` marks a difference that looks accidental, and says what
 * a later change could do; it is kept as it is until then.
 */
export interface FileTypeNote {
  why: string
  fix?: string
}

const CODE_PAGE: FileTypeNote = {
  why: "Agents read source as text; the page has no source view yet.",
  fix: "Show it as text on its page, as agents read it.",
}

/** Each type's notes, by the surfaces that break an agreement rule. */
export const FILE_TYPE_NOTES: {
  readonly [K in FileTypeId]?: { readonly [S in FileSurface]?: FileTypeNote }
} = {
  avif: {
    agent: {
      why: "Agents take images as PNG, JPEG, GIF or WebP, so an AVIF comes as base64.",
      fix: "Convert it to PNG when an agent reads it, so it arrives as an image.",
    },
    share: {
      why: "The shared-page policy, which the Cloud gateway enforces too, accepts PNG, JPEG, GIF and WebP data URLs only.",
      fix: "Add AVIF to the shared-page policy together with the Cloud gateway.",
    },
  },
  svg: {
    agent: {
      why: "SVG is XML markup: agents read and edit its source as text.",
    },
    share: {
      why: "SVG can carry script and outside references, so shared pages, which carry only raster data URLs, show a placeholder.",
    },
  },
  markdown: { page: CODE_PAGE },
  html: {
    serve: {
      why: "Served inline as text/html, unlike other text, because its page shows it in a frame. The response's sandbox policy and the frame's sandbox keep its scripts off and load nothing, so it shows as a static page until a person opens it as an HTML Doc.",
    },
  },
  css: { page: CODE_PAGE },
  javascript: { page: CODE_PAGE },
  typescript: { page: CODE_PAGE },
}

/** Each surface: where it lives, and what holds for it across types. */
export const FILE_SURFACE_NOTES: {
  readonly [S in FileSurface]: { where: string; note?: string }
} = {
  serve: {
    where: "packages/server/src/file-media.ts",
    note: "Only images, and HTML for the sandboxed frame its page shows it in, show inline; a type without a media type here downloads as plain bytes.",
  },
  page: { where: "apps/web/src/components/file-page.tsx" },
  icon: { where: "apps/web/src/components/document-format-icon.tsx" },
  agent: {
    where: "packages/server/src/mcp/file-results.ts",
    note: "Size limits and UTF-8 decoding stay with the surface: a large image or text, or text that isn't UTF-8, also comes as base64. Agents overwriting a delimited table get a row summary.",
  },
  share: {
    where:
      "packages/server/src/space-images.ts, packages/ui/src/markdown-document.ts, and the literal list in packages/hosted-contract/src/public-share-policy.ts",
    note: "The MIT share policy keeps its own list, which the Cloud gateway enforces too; a server test checks it against this table, so changing it is a change on both sides.",
  },
  drawing: {
    where: "packages/server/src/drawing-image-validation.ts",
    note: "Drawing images are data URLs; their declared media type names the type, and the bytes must match it.",
  },
  paste: {
    where: "apps/web/src/lib/file-embeds.ts",
    note: "A pasted image with no name of its own is named for its media type. An image type not in this table keeps the subtype of its media type.",
  },
  import: {
    where: "packages/server/src/records-import.ts and the file page's Import",
  },
  diff: {
    where: "packages/server/src/document-diff.ts",
    note: "Diffs compare a Doc's text projection; a plain file keeps versions but has no projection yet, even text agents read as text. Offering one needs that projection first.",
  },
}

/**
 * How surfaces are expected to agree for every type. A type that breaks one
 * carries a note on one of the rule's surfaces saying why.
 */
export const FILE_SURFACE_RULES: readonly {
  name: string
  surfaces: readonly FileSurface[]
  holds: (surfaces: FileSurfacePolicies, entry: FileTypeEntry) => boolean
}[] = [
  {
    name: "People and agents see the same thing",
    surfaces: ["page", "agent"],
    holds: ({ page, agent }) =>
      page === "image"
        ? agent === "image"
        : page === "card"
          ? agent === "bytes"
          : agent === "text",
  },
  {
    name: "The page shows an image exactly when serving shows it inline",
    surfaces: ["page", "serve"],
    holds: ({ page, serve }) => (page === "image") === (serve === "inline"),
  },
  {
    name: "Shared pages show the images the page shows",
    surfaces: ["share", "page"],
    holds: ({ share, page }) => (share === "inline") === (page === "image"),
  },
  {
    name: "Drawings hold the images shared pages carry",
    surfaces: ["drawing", "share"],
    holds: ({ drawing, share }) => drawing === (share === "inline"),
  },
  {
    name: "A paste is named for image types only",
    surfaces: ["paste"],
    holds: ({ paste }, entry) => paste === entry.mediaType.startsWith("image/"),
  },
  {
    name: "A table shows as a table and splits on its delimiter",
    surfaces: ["page"],
    holds: ({ page }, entry) =>
      (page === "table") === (entry.delimiter !== undefined),
  },
  {
    name: "What imports into Records is text people and agents can read",
    surfaces: ["import"],
    holds: (surfaces) =>
      !surfaces.import ||
      (surfaces.agent === "text" &&
        (surfaces.page === "table" || surfaces.page === "text")),
  },
]
