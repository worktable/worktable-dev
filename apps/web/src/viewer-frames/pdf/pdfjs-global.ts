// pdf.js's viewer components read the library from the global scope as they
// load, so this module sits between the two in the frame's imports.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs
