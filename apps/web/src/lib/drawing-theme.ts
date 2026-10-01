import {
  THEMES,
  FONTS,
  invalidateTextLayouts,
  type Editor,
} from "@quickdrawjs/core"
import { DRAWING_THEME } from "@worktable/types"
import { refreshDrawingBindings } from "./drawing-bindings"

// Configure the engine's public palette once, before constructing an editor.
// Internal exports and tool swatches then use the same colors as agent previews.
Object.assign(THEMES.light, DRAWING_THEME.light)
Object.assign(THEMES.dark, DRAWING_THEME.dark)

import { DRAWING_FONTS } from "@worktable/ui/lib/drawing-fonts"
Object.assign(FONTS, DRAWING_FONTS)

/** Declare optional faces without fetching the font collection. Canvas/CSS
 * matching requests only the faces used on the board. Opening, editing and
 * saving never wait for the stylesheet or its fonts. */
export function installDrawingFonts(editor: Editor): () => void {
  let sheet = document.querySelector<HTMLLinkElement>(
    "link[data-worktable-drawing-fonts]"
  )
  const refresh = () => {
    invalidateTextLayouts()
    refreshDrawingBindings(editor.store)
    editor.requestRender()
  }
  document.fonts.addEventListener("loadingdone", refresh)
  document.fonts.addEventListener("loadingerror", refresh)
  if (!sheet) {
    sheet = document.createElement("link")
    sheet.dataset.worktableDrawingFonts = ""
    sheet.rel = "stylesheet"
    sheet.href = "/worktable-preview/fonts.css"
    // Keep even a stalled stylesheet outside the page's render-blocking path.
    sheet.media = "print"
    sheet.addEventListener("load", () => {
      sheet!.media = "all"
    })
    sheet.addEventListener("error", () => sheet!.remove(), { once: true })
    document.head.appendChild(sheet)
  }
  sheet.addEventListener("load", refresh)
  return () => {
    document.fonts.removeEventListener("loadingdone", refresh)
    document.fonts.removeEventListener("loadingerror", refresh)
    sheet!.removeEventListener("load", refresh)
  }
}
