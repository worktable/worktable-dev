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

/**
 * The most files a Worktable may hold: its storage limit outside Cloud, and
 * by default. The limit counts people's files, Docs, Records and threads,
 * not their history (Plan 22a item 12).
 */
export const PROVEN_WORKTABLE_BYTES = 2 * GIB

/**
 * Everything a Worktable may take on disk, as a multiple of its limit:
 * its files, the copy of each file's current version kept in history (as
 * large as the files), and an allowance of half the limit for older history,
 * deleted items and indexes, which Worktable prunes oldest first.
 */
export const STORAGE_CEILING_RATIO = 2.5

/**
 * What an export may hold, as a multiple of the limit: everything the total
 * limit allows. Pruning keeps history within the total, not within a share
 * of its own, so a Worktable of small files with large old versions can
 * carry nearly all of it as history that no file's bytes match; a full one
 * of uploaded files packs at about 1.5 times the limit, since the history
 * copy of each file's current version is stored once (package version 3).
 * Past 4 GiB a package is ZIP64.
 */
export const EXPORT_CONTENT_RATIO = STORAGE_CEILING_RATIO

/**
 * What an export may hold beyond that, so a full Worktable always fits: a person's drawing saves may pass the limit by up to 64 MiB
 * (storage-limit.ts storageGraceBytes), the offline viewer takes up to
 * 64 MiB, ZIP headers about 200 bytes an entry (40 MiB at the 200,000 entries
 * an archive may hold), and files that don't compress grow a little. A
 * Worktable filled to its limit with incompressible files measured 1.5 MB
 * of overhead for 499 files.
 */
export const EXPORT_HEADROOM_BYTES = 256 * MIB
