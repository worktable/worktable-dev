// A Doc's page code, which an open skill renders. Once loaded it is used
// directly: a lazy component suspends once even when its code is in, which
// would blank a skill's body for a frame.

let docModule: typeof import("@/components/doc-document") | undefined

/** Load the Doc's page code; the Library waits on it before opening a skill. */
export const loadDocCode = () =>
  import("@/components/doc-document").then((module) => (docModule = module))

/** The Doc's page code, once loaded. */
export const loadedDocCode = () => docModule
