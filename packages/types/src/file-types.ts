// ============================================================
// File types
// ============================================================
//
// What a plain file is, for every surface that handles one. Doc formats
// (Markdown, block JSON, HTML Docs and drawings) have their own registry on
// the server; this table is for the files a Space keeps as they are.
//
// A file's type is worked out from its name each time it is asked for, and
// never stored, so changing this table migrates nothing. Nothing here reads
// a file: a listing can ask for every file's type without opening one. The
// name nominates a type; a surface may check the bytes and refuse them, but
// never take them as a wider type or as anything that runs.
//
// This module is pure data and stays runtime independent, and holds only
// what code reads, since every page loads it. Why surfaces differ, where
// each lives, and the rules they agree by are in file-type-notes.ts, which
// only the conformance test reads.
//
// The name rule, the one every surface uses:
// - The type comes from the base name, the part after the last "/".
// - A base name listed under a type's `names` (such as Dockerfile) is that
//   type, whatever its extension.
// - Otherwise the extension is what follows the last "." of the base name,
//   unless that dot starts the name: a hidden name such as ".png" holds no
//   file in a Space and has no type.
// - Matching folds ASCII A-Z to a-z and nothing else. There is no Unicode
//   case folding or normalization, so a look-alike such as the Kelvin sign
//   (U+212A) never stands for "k", and "ſ" never stands for "s".

/** A surface that decides something about a plain file by its type. */
export type FileSurface =
  | "serve"
  | "page"
  | "icon"
  | "agent"
  | "share"
  | "drawing"
  | "paste"
  | "import"
  | "diff"

/** A broad kind of file, for grouping; each surface has its own policy. */
export type FileFamily =
  | "image"
  | "table"
  | "spreadsheet"
  | "text"
  | "data"
  | "code"
  | "document"
  | "audio"
  | "video"
  | "archive"

/** What each surface does with a file of a type. */
export interface FileSurfacePolicies {
  /**
   * How the server sends the bytes: shown inline under its media type,
   * downloaded under its media type, or downloaded as plain bytes
   * (application/octet-stream). Every file response is sandboxed by its
   * Content-Security-Policy, which is what makes inline SVG safe.
   */
  serve: "inline" | "download" | "bytes"
  /** How the file's own page shows it in the app; a card offers Download. */
  page: "image" | "table" | "text" | "card"
  /** The icon lists show for it. */
  icon:
    | "image"
    | "spreadsheet"
    | "document"
    | "code"
    | "audio"
    | "video"
    | "archive"
    | "file"
  /** How an agent reading it gets it: as an image, as text, or as base64. */
  agent: "image" | "text" | "bytes"
  /** Whether a shared page shows it embedded as a data URL, or a placeholder. */
  share: "inline" | "placeholder"
  /** Whether a drawing may hold it as an embedded image. */
  drawing: boolean
  /** Whether a pasted file with no name of its own is named for this type. */
  paste: boolean
  /** Whether it can be imported into Records. */
  import: boolean
  /** Whether a text diff between its versions is offered. */
  diff: boolean
}

export interface FileTypeEntry {
  /** Lowercase ASCII, without the dot. The first is the one Worktable writes. */
  extensions: readonly string[]
  /** Whole base names, lowercase ASCII, that are this type. */
  names?: readonly string[]
  /** The type's media type, without parameters. */
  mediaType: string
  family: FileFamily
  /** The cell separator of a delimited table. */
  delimiter?: "," | "\t"
  surfaces: FileSurfacePolicies
}

const NONE = {
  share: "placeholder",
  drawing: false,
  paste: false,
  import: false,
  diff: false,
} as const

const RASTER = {
  serve: "inline",
  page: "image",
  icon: "image",
  agent: "image",
  share: "inline",
  drawing: true,
  paste: true,
  import: false,
  diff: false,
} as const

const CODE = {
  ...NONE,
  serve: "bytes",
  page: "card",
  icon: "file",
  agent: "text",
} as const

const BINARY = { ...NONE, page: "card", agent: "bytes" } as const

/**
 * Every plain file type Worktable knows. A name that matches none of them
 * gets UNKNOWN_FILE_POLICIES.
 */
export const FILE_TYPES = {
  png: {
    extensions: ["png"],
    mediaType: "image/png",
    family: "image",
    surfaces: RASTER,
  },
  jpeg: {
    extensions: ["jpg", "jpeg"],
    mediaType: "image/jpeg",
    family: "image",
    surfaces: RASTER,
  },
  gif: {
    extensions: ["gif"],
    mediaType: "image/gif",
    family: "image",
    surfaces: RASTER,
  },
  webp: {
    extensions: ["webp"],
    mediaType: "image/webp",
    family: "image",
    surfaces: RASTER,
  },
  avif: {
    extensions: ["avif"],
    mediaType: "image/avif",
    family: "image",
    surfaces: {
      ...RASTER,
      agent: "bytes",
      share: "placeholder",
      drawing: false,
    },
  },
  svg: {
    extensions: ["svg"],
    mediaType: "image/svg+xml",
    family: "image",
    surfaces: {
      ...RASTER,
      agent: "text",
      share: "placeholder",
      drawing: false,
    },
  },
  heic: {
    extensions: ["heic"],
    mediaType: "image/heic",
    family: "image",
    // Most browsers can't show HEIC and agents take no HEIC, so it is an
    // image only to its icon and to a paste's name.
    surfaces: { ...BINARY, serve: "bytes", icon: "image", paste: true },
  },
  csv: {
    extensions: ["csv"],
    mediaType: "text/csv",
    family: "table",
    delimiter: ",",
    surfaces: {
      ...NONE,
      serve: "download",
      page: "table",
      icon: "spreadsheet",
      agent: "text",
      import: true,
    },
  },
  tsv: {
    extensions: ["tsv"],
    mediaType: "text/tab-separated-values",
    family: "table",
    delimiter: "\t",
    surfaces: {
      ...NONE,
      serve: "download",
      page: "table",
      icon: "spreadsheet",
      agent: "text",
      import: true,
    },
  },
  xls: {
    extensions: ["xls"],
    mediaType: "application/vnd.ms-excel",
    family: "spreadsheet",
    surfaces: { ...BINARY, serve: "bytes", icon: "spreadsheet" },
  },
  xlsx: {
    extensions: ["xlsx"],
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    family: "spreadsheet",
    surfaces: { ...BINARY, serve: "bytes", icon: "spreadsheet" },
  },
  ods: {
    extensions: ["ods"],
    mediaType: "application/vnd.oasis.opendocument.spreadsheet",
    family: "spreadsheet",
    surfaces: { ...BINARY, serve: "bytes", icon: "spreadsheet" },
  },
  numbers: {
    extensions: ["numbers"],
    mediaType: "application/vnd.apple.numbers",
    family: "spreadsheet",
    surfaces: { ...BINARY, serve: "bytes", icon: "spreadsheet" },
  },
  txt: {
    extensions: ["txt"],
    mediaType: "text/plain",
    family: "text",
    surfaces: {
      ...NONE,
      serve: "download",
      page: "text",
      icon: "document",
      agent: "text",
    },
  },
  log: {
    extensions: ["log"],
    mediaType: "text/plain",
    family: "text",
    surfaces: {
      ...NONE,
      serve: "bytes",
      page: "text",
      icon: "document",
      agent: "text",
    },
  },
  // The Doc registry claims .json first; a plain file reaches this entry
  // only where a surface sees a bare name, as an agent's path.
  json: {
    extensions: ["json"],
    mediaType: "application/json",
    family: "data",
    surfaces: { ...NONE, serve: "bytes", page: "text", icon: "code", agent: "text" },
  },
  jsonl: {
    extensions: ["jsonl"],
    mediaType: "application/x-ndjson",
    family: "data",
    surfaces: {
      ...NONE,
      serve: "download",
      page: "text",
      icon: "code",
      agent: "text",
      import: true,
    },
  },
  yaml: {
    extensions: ["yaml", "yml"],
    mediaType: "application/yaml",
    family: "data",
    surfaces: { ...NONE, serve: "bytes", page: "text", icon: "code", agent: "text" },
  },
  xml: {
    extensions: ["xml"],
    mediaType: "application/xml",
    family: "data",
    surfaces: { ...NONE, serve: "bytes", page: "text", icon: "code", agent: "text" },
  },
  toml: {
    extensions: ["toml"],
    mediaType: "application/toml",
    family: "data",
    surfaces: { ...NONE, serve: "bytes", page: "text", icon: "code", agent: "text" },
  },
  ini: {
    extensions: ["ini"],
    mediaType: "text/plain",
    family: "data",
    surfaces: { ...NONE, serve: "bytes", page: "text", icon: "code", agent: "text" },
  },
  // The Doc registry claims .md and .html first, as it does .json.
  markdown: {
    extensions: ["md"],
    mediaType: "text/markdown",
    family: "code",
    surfaces: CODE,
  },
  html: {
    extensions: ["html", "htm"],
    mediaType: "text/html",
    family: "code",
    surfaces: CODE,
  },
  css: {
    extensions: ["css"],
    mediaType: "text/css",
    family: "code",
    surfaces: CODE,
  },
  javascript: {
    extensions: ["js"],
    mediaType: "text/javascript",
    family: "code",
    surfaces: CODE,
  },
  typescript: {
    extensions: ["ts"],
    mediaType: "text/plain",
    family: "code",
    surfaces: CODE,
  },
  dockerfile: {
    extensions: [],
    names: ["dockerfile"],
    mediaType: "text/plain",
    family: "code",
    // No surface lists it yet, so each treats it as an unknown file.
    surfaces: { ...BINARY, serve: "bytes", icon: "file" },
  },
  pdf: {
    extensions: ["pdf"],
    mediaType: "application/pdf",
    family: "document",
    surfaces: { ...BINARY, serve: "download", icon: "document" },
  },
  rtf: {
    extensions: ["rtf"],
    mediaType: "application/rtf",
    family: "document",
    surfaces: { ...BINARY, serve: "bytes", icon: "document" },
  },
  doc: {
    extensions: ["doc"],
    mediaType: "application/msword",
    family: "document",
    surfaces: { ...BINARY, serve: "bytes", icon: "document" },
  },
  docx: {
    extensions: ["docx"],
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    family: "document",
    surfaces: { ...BINARY, serve: "bytes", icon: "document" },
  },
  mp3: {
    extensions: ["mp3"],
    mediaType: "audio/mpeg",
    family: "audio",
    surfaces: { ...BINARY, serve: "download", icon: "audio" },
  },
  wav: {
    extensions: ["wav"],
    mediaType: "audio/wav",
    family: "audio",
    surfaces: { ...BINARY, serve: "download", icon: "audio" },
  },
  m4a: {
    extensions: ["m4a"],
    mediaType: "audio/mp4",
    family: "audio",
    surfaces: { ...BINARY, serve: "bytes", icon: "audio" },
  },
  ogg: {
    extensions: ["ogg"],
    mediaType: "audio/ogg",
    family: "audio",
    surfaces: { ...BINARY, serve: "bytes", icon: "audio" },
  },
  flac: {
    extensions: ["flac"],
    mediaType: "audio/flac",
    family: "audio",
    surfaces: { ...BINARY, serve: "bytes", icon: "audio" },
  },
  mp4: {
    extensions: ["mp4"],
    mediaType: "video/mp4",
    family: "video",
    surfaces: { ...BINARY, serve: "download", icon: "video" },
  },
  webm: {
    extensions: ["webm"],
    mediaType: "video/webm",
    family: "video",
    surfaces: { ...BINARY, serve: "download", icon: "video" },
  },
  mov: {
    extensions: ["mov"],
    mediaType: "video/quicktime",
    family: "video",
    surfaces: { ...BINARY, serve: "bytes", icon: "video" },
  },
  mkv: {
    extensions: ["mkv"],
    mediaType: "video/x-matroska",
    family: "video",
    surfaces: { ...BINARY, serve: "bytes", icon: "video" },
  },
  zip: {
    extensions: ["zip"],
    mediaType: "application/zip",
    family: "archive",
    surfaces: { ...BINARY, serve: "download", icon: "archive" },
  },
  tar: {
    extensions: ["tar"],
    mediaType: "application/x-tar",
    family: "archive",
    surfaces: { ...BINARY, serve: "bytes", icon: "archive" },
  },
  gzip: {
    extensions: ["gz", "tgz"],
    mediaType: "application/gzip",
    family: "archive",
    surfaces: { ...BINARY, serve: "bytes", icon: "archive" },
  },
  "7z": {
    extensions: ["7z"],
    mediaType: "application/x-7z-compressed",
    family: "archive",
    surfaces: { ...BINARY, serve: "bytes", icon: "archive" },
  },
  rar: {
    extensions: ["rar"],
    mediaType: "application/vnd.rar",
    family: "archive",
    surfaces: { ...BINARY, serve: "bytes", icon: "archive" },
  },
} as const satisfies Record<string, FileTypeEntry>

export type FileTypeId = keyof typeof FILE_TYPES

type Policy<S extends FileSurface> = FileSurfacePolicies[S]

/** The types whose policy on a surface is the given one. */
export type FileTypesWhere<S extends FileSurface, P extends Policy<S>> = {
  [K in FileTypeId]: (typeof FILE_TYPES)[K]["surfaces"][S] extends P
    ? K
    : never
}[FileTypeId]

/** What each surface does with a name that matches no type. */
export const UNKNOWN_FILE_POLICIES: FileSurfacePolicies = {
  serve: "bytes",
  page: "card",
  icon: "file",
  agent: "bytes",
  share: "placeholder",
  drawing: false,
  paste: false,
  import: false,
  diff: false,
}

const ENTRIES = FILE_TYPES as Readonly<Record<FileTypeId, FileTypeEntry>>
const BY_EXTENSION = new Map<string, FileTypeId>()
const BY_NAME = new Map<string, FileTypeId>()
for (const id of Object.keys(ENTRIES) as FileTypeId[]) {
  for (const extension of ENTRIES[id].extensions) BY_EXTENSION.set(extension, id)
  for (const name of ENTRIES[id].names ?? []) BY_NAME.set(name, id)
}

/** ASCII A-Z to a-z; every other character stays as it is. */
function foldFileName(name: string): string {
  return name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
}

/** A file's type by its name or path, under the name rule above. */
export function fileTypeFor(name: string): FileTypeId | null {
  const base = foldFileName(name.slice(name.lastIndexOf("/") + 1))
  const named = BY_NAME.get(base)
  if (named) return named
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return null
  return BY_EXTENSION.get(base.slice(dot + 1)) ?? null
}

/** A type's policy on a surface. */
export function fileTypePolicy<S extends FileSurface>(
  type: FileTypeId | null,
  surface: S
): Policy<S> {
  return type === null
    ? UNKNOWN_FILE_POLICIES[surface]
    : (ENTRIES[type].surfaces[surface] as Policy<S>)
}

/** A file's policy on a surface, by its name or path. */
export function filePolicy<S extends FileSurface>(
  name: string,
  surface: S
): Policy<S> {
  return fileTypePolicy(fileTypeFor(name), surface)
}

/** The media types of the types whose policy on a surface is the given one. */
export function fileMediaTypesWhere<S extends FileSurface>(
  surface: S,
  policy: Policy<S>
): string[] {
  return (Object.keys(ENTRIES) as FileTypeId[])
    .filter((id) => ENTRIES[id].surfaces[surface] === policy)
    .map((id) => ENTRIES[id].mediaType)
}

/**
 * The media types a surface accepts with the given policy, as a regular
 * expression alternation, for a surface's data URL pattern.
 */
export function mediaTypeAlternation<S extends FileSurface>(
  surface: S,
  policy: Policy<S>
): string {
  return fileMediaTypesWhere(surface, policy)
    .map((type) => type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
}

/**
 * The type a pasted file's media type names, when the paste surface names
 * files of that type.
 */
export function pastedFileType(mediaType: string): FileTypeId | null {
  for (const id of Object.keys(ENTRIES) as FileTypeId[]) {
    if (ENTRIES[id].surfaces.paste && ENTRIES[id].mediaType === mediaType) {
      return id
    }
  }
  return null
}
