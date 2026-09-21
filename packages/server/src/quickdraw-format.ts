import {
  parseQuickdrawDocument,
  QUICKDRAW_FORMAT,
  QUICKDRAW_MAX_BYTES,
} from "@worktable/types"
import type { ServerDocumentFormatRegistration } from "./document-format-registry.ts"
import { DocumentSourceReadError } from "./document-source-errors.ts"
import { DocumentProjectionError } from "./document-projections.ts"

export const quickdrawFormat: ServerDocumentFormatRegistration = {
  id: QUICKDRAW_FORMAT,
  extensions: [".quickdraw"],
  sourceVersions: [1],
  fileSource: { extension: ".quickdraw", discoveryVersion: 1 },
  rendererKey: "quickdraw",
  renderDisposition: "trusted-component",
  capabilities: {
    authoring: "replace",
    publicProjection: "safe",
    execution: "none",
  },
  versionedCompanionKeys: [],
  portableState: "none",
  async prepareWrite({ bytes }) {
    parseQuickdrawDocument(bytes)
    return { bytes }
  },
  projectionMaxInputBytes: QUICKDRAW_MAX_BYTES,
  async projectText({ read, budget }) {
    try {
      const drawing = parseQuickdrawDocument(
        await read(Math.min(QUICKDRAW_MAX_BYTES, budget.maxInputBytes))
      )
      const shapes = Object.values(drawing.snapshot.document.store).filter(
        (record) => record.typeName === "shape"
      )
      const lines = [
        drawing.title,
        `Drawing with ${shapes.length} objects. Freehand marks require an image preview to interpret.`,
      ]
      for (const shape of shapes) {
        if (shape.type === "text" || shape.type === "note")
          lines.push(shape.props.text)
        if (shape.type === "geo" && shape.props.label)
          lines.push(shape.props.label)
      }
      const bytes = new TextEncoder().encode(lines.join("\n\n"))
      return {
        kind: "text",
        text: new TextDecoder().decode(bytes.slice(0, budget.maxOutputBytes), {
          stream: true,
        }),
        headings: [drawing.title],
        truncated: bytes.byteLength > budget.maxOutputBytes,
      }
    } catch (error) {
      if (
        error instanceof DocumentProjectionError ||
        error instanceof DocumentSourceReadError
      )
        throw error
      throw new DocumentProjectionError(
        "invalid",
        "This drawing could not be read"
      )
    }
  },
}
