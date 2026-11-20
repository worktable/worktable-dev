// ============================================================
// How big a Worktable may be, and what its export must hold
// ============================================================
//
// One figure ties the storage limit to what export, import and backups are
// proven to carry, so every Worktable within its limit can be taken out
// whole (docs/files.md rules 14 and 16). Raise it only in a change that
// cites a round trip at the new size.

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** The most a Worktable may hold: its storage limit outside Cloud, and by default. */
export const PROVEN_WORKTABLE_BYTES = 2 * GIB

/**
 * What an export may hold beyond a Worktable's counted bytes, so a full one
 * always fits: a person's drawing saves may pass the limit by up to 64 MiB
 * (storage-limit.ts storageGraceBytes), the offline viewer takes up to
 * 64 MiB, ZIP headers about 200 bytes an entry (40 MiB at the 200,000 entries
 * an archive may hold), and files that don't compress grow a little. A
 * Worktable filled to its limit with incompressible files measured 1.5 MB
 * of overhead for 499 files.
 */
export const EXPORT_HEADROOM_BYTES = 256 * MIB
