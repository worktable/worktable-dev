// A file's page and the upload code load with the Doc renderer. They share
// its byline, tables and styles; reaching them through the renderer keeps
// those in its chunk, rather than split into small chunks every Doc then
// loads. HTML Docs don't load any of it.
export { DocDocumentRenderer } from "@/components/doc-document"
export { FilePage } from "@/components/file-page"
export { uploadFileToFolder } from "@/lib/file-embeds"
