/**
 * How long a Space's contents (its page, Docs list, documents and record
 * collections) stay in the tab once nothing shows them. React Query drops
 * unobserved data after 5 minutes by default, and a Space opened again in
 * the sidebar after that waited for all of it before showing its tree.
 * Kept, it opens at once from what the tab holds and refreshes in the
 * background.
 */
export const SPACE_CONTENTS_GC_MS = 60 * 60_000
