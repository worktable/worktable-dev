// The code an open skill renders: the skill itself and its Doc's page. Once
// loaded it is used directly, as a lazy component suspends once even when its
// code is in, which would blank a skill for a frame. Kept out of the Library
// route's file, whose page code the router splits from its loader.

let docModule: typeof import("@/components/doc-document") | undefined
let skillModule: typeof import("@/components/library/open-skill") | undefined

/** Load the Doc's page code. */
export const loadDocCode = () =>
  import("@/components/doc-document").then((module) => (docModule = module))

/** The Doc's page code, once loaded. */
export const loadedDocCode = () => docModule

/** Load an open skill's code and its Doc's; the Library waits on both. */
export const loadSkillCode = () =>
  Promise.all([import("@/components/library/open-skill"), loadDocCode()]).then(
    ([module]) => (skillModule = module)
  )

/** The open skill's code, once loaded. */
export const loadedSkillCode = () => skillModule
