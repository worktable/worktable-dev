import type { Database } from "bun:sqlite"
import type {
  SHARE_VIEW_SOURCES,
  ShareViewMessage,
  ShareViewReply,
} from "@worktable/hosted-contract"
import { openShareLinksDatabase } from "./share-links-store.ts"

// ============================================================
// Views of shared pages
// ============================================================
//
// Best effort, for the page's owner: a view is a page load whose code ran and
// was visible for a few seconds, as the share page reports it through the
// gateway. Nothing here runs while a page or its data is served; each message
// is its own request, written as it arrives so a sleeping Worktable can't lose
// a view.
//
// The tables sit beside the links in sharing.sqlite, outside the workspace and
// backups, and are created on first write so binaries that predate them still
// open the store. Rows last 90 days; a visitor's daily digest only 2 days,
// after which each day keeps just its count of distinct digests.

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
/** Another load from the same browser within this is a reload, not a view. */
const SAME_VIEW_MS = 30 * MINUTE_MS
/** How long views are kept. */
export const SHARE_VIEW_RETENTION_MS = 90 * DAY_MS
/** How long a day's visitor digests are kept before only their count stays. */
const DAY_DIGEST_RETENTION_MS = 2 * DAY_MS
/** Views from a hosting network, with no input and shorter than this, look automated. */
const AUTOMATED_UNDER_SECONDS = 15

/** What the gateway saw of the visitor; the page can't set any of it. */
export interface ShareViewVisitor {
  /** The visitor key's digest, where a key may be kept. */
  visitor: string | null
  /** A digest for this link and day, for views without a key. */
  day: string | null
  country: string | null
  network: "cloud" | "other" | null
  browser: string | null
  device: "phone" | "desktop" | null
  /** The part of an ISO 3166-2 code after the dash, such as "CA". */
  region: string | null
  system: string | null
  language: string | null
  /** Only outside consent regions; see SHARE_VIEW_HEADERS.ORGANIZATION. */
  organization: string | null
  /** What the page reported: how far down it was read, 0 to 100. */
  scroll: number | null
  source: string | null
  screen: string | null
}

/** Where a link's latest view came from, as its share dialog shows it. */
export interface ShareViewPlace {
  country: string | null
  region: string | null
  organization: string | null
  /** Checked against SHARE_VIEW_SOURCES when it was written. */
  source: (typeof SHARE_VIEW_SOURCES)[number] | null
}

/** A link's views as its share dialog and agents see them. */
export interface ShareViewSummary {
  views: number
  /** An estimate: distinct browsers with a key, plus the most keyless visitors on one day. */
  people: number
  lastViewAt: number | null
  /** Browsers with a key that viewed the link on more than one day. */
  returning: number
  latest: ShareViewPlace | null
}

export interface ShareViewRow {
  startedAt: number
  /** False for a reload within 30 minutes of a counted view. */
  counted: boolean
  visibleSeconds: number
  hadInput: boolean
  automated: boolean
  visitor: string | null
  country: string | null
  browser: string | null
  device: string | null
  network: string | null
  region: string | null
  system: string | null
  language: string | null
  organization: string | null
  scroll: number | null
  source: string | null
  screen: string | null
  /** This browser had a counted view of the link on an earlier day. */
  returning: boolean
}

export interface SharePreviewRow {
  app: string
  day: string
  at: number
}

const tablesReady = new WeakSet<Database>()

function ensureTables(db: Database): void {
  if (tablesReady.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_views (
      link_id TEXT NOT NULL,
      load_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      counted INTEGER NOT NULL,
      visible_s INTEGER NOT NULL DEFAULT 0,
      had_input INTEGER NOT NULL DEFAULT 0,
      webdriver INTEGER NOT NULL DEFAULT 0,
      visitor TEXT,
      day_digest TEXT,
      day TEXT NOT NULL,
      country TEXT,
      network TEXT,
      browser TEXT,
      device TEXT,
      region TEXT,
      system TEXT,
      language TEXT,
      organization TEXT,
      scroll INTEGER,
      source TEXT,
      screen TEXT,
      PRIMARY KEY (link_id, load_id)
    );
    CREATE INDEX IF NOT EXISTS share_views_by_link
      ON share_views (link_id, started_at);
    CREATE TABLE IF NOT EXISTS share_view_days (
      link_id TEXT NOT NULL,
      day TEXT NOT NULL,
      visitors INTEGER NOT NULL,
      PRIMARY KEY (link_id, day)
    );
    CREATE TABLE IF NOT EXISTS share_previews (
      link_id TEXT NOT NULL,
      app TEXT NOT NULL,
      day TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (link_id, app, day)
    );
  `)
  addViewColumns(db)
  tablesReady.add(db)
}

/** Columns added after share_views first shipped, for stores made before them. */
const ADDED_VIEW_COLUMNS = [
  "region TEXT",
  "system TEXT",
  "language TEXT",
  "organization TEXT",
  "scroll INTEGER",
  "source TEXT",
  "screen TEXT",
] as const

function addViewColumns(db: Database): void {
  const present = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(share_views)")
      .all()
      .map((column) => column.name)
  )
  for (const column of ADDED_VIEW_COLUMNS)
    if (!present.has(column.split(" ")[0]!))
      db.exec(`ALTER TABLE share_views ADD COLUMN ${column}`)
}

/** The store with its view tables, or null when nothing was ever recorded. */
function readableDatabase(): Database | null {
  const db = openShareLinksDatabase(false)
  if (!db) return null
  if (tablesReady.has(db)) return db
  const present = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'share_views'"
    )
    .get()
  if (!present?.n) return null
  addViewColumns(db)
  tablesReady.add(db)
  return db
}

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** The SQL condition for a view that looks automated (see AUTOMATED_UNDER_SECONDS). */
const automated = (table?: string): string => {
  const column = (name: string) => (table ? `${table}.${name}` : name)
  return `(${column("webdriver")} = 1 OR (COALESCE(${column("network")}, '') = 'cloud' AND ${column("had_input")} = 0 AND ${column("visible_s")} < ${AUTOMATED_UNDER_SECONDS}))`
}
const AUTOMATED = automated()

/**
 * Record a page's start or update. The first message for a load creates its
 * row and decides whether it counts; later ones only raise its totals.
 */
export function recordShareView(
  linkId: string,
  message: Extract<ShareViewMessage, { kind: "start" | "update" }>,
  seen: ShareViewVisitor,
  now = Date.now()
): ShareViewReply {
  const db = openShareLinksDatabase(true)!
  ensureTables(db)
  return db.transaction((): ShareViewReply => {
    const existing = db
      .query<{ counted: number }, [string, string]>(
        "SELECT counted FROM share_views WHERE link_id = ? AND load_id = ?"
      )
      .get(linkId, message.load)
    if (existing) {
      db.query(
        `UPDATE share_views SET
           visible_s = MAX(visible_s, ?1), had_input = MAX(had_input, ?2),
           webdriver = MAX(webdriver, ?3),
           scroll = CASE WHEN ?4 IS NULL THEN scroll
             ELSE MAX(COALESCE(scroll, 0), ?4) END,
           source = COALESCE(source, ?5), screen = COALESCE(screen, ?6)
         WHERE link_id = ?7 AND load_id = ?8`
      ).run(
        message.visible,
        message.input ? 1 : 0,
        message.webdriver ? 1 : 0,
        seen.scroll,
        seen.source,
        seen.screen,
        linkId,
        message.load
      )
      return { counted: false, first: false }
    }
    // Keys are compared first; a day digest stands in only when there is no
    // key, so two keys behind one office address stay two browsers. A view
    // with neither (Do Not Track, GPC) always counts.
    const visitor = seen.visitor
    const digest = visitor ? null : seen.day
    const reload =
      visitor || digest
        ? db
            .query<{ one: number }, [string, string, number]>(
              // A load that looks automated never makes a person's view a reload.
              `SELECT 1 AS one FROM share_views
               WHERE link_id = ? AND counted = 1 AND started_at > ?3
                 AND NOT ${AUTOMATED} AND ${
                 visitor ? "visitor = ?2" : "visitor IS NULL AND day_digest = ?2"
               } LIMIT 1`
            )
            .get(linkId, (visitor ?? digest)!, now - SAME_VIEW_MS)
        : null
    const first = !db
      .query<{ one: number }, [string]>(
        "SELECT 1 AS one FROM share_views WHERE link_id = ? AND counted = 1 LIMIT 1"
      )
      .get(linkId)
    const counted = !reload
    db.query(
      `INSERT INTO share_views (link_id, load_id, started_at, counted,
         visible_s, had_input, webdriver, visitor, day_digest, day, country,
         network, browser, device, region, system, language, organization,
         scroll, source, screen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      linkId,
      message.load,
      now,
      counted ? 1 : 0,
      message.visible,
      message.input ? 1 : 0,
      message.webdriver ? 1 : 0,
      visitor,
      digest,
      utcDay(now),
      seen.country,
      seen.network,
      seen.browser,
      seen.device,
      seen.region,
      seen.system,
      seen.language,
      seen.organization,
      seen.scroll,
      seen.source,
      seen.screen
    )
    return { counted, first: counted && first }
  })()
}

/** Record that an app's link preview fetched the page, once per app and day. */
export function recordSharePreview(
  linkId: string,
  app: string,
  now = Date.now()
): void {
  const db = openShareLinksDatabase(true)!
  ensureTables(db)
  db.query(
    `INSERT INTO share_previews (link_id, app, day, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (link_id, app, day) DO NOTHING`
  ).run(linkId, app, utcDay(now), now)
}

/**
 * Whether this Worktable has ever been told of a view or preview, which
 * means the gateway in front of it reports them. Until then links keep
 * showing when they were last opened.
 */
export function shareViewsReported(): boolean {
  return readableDatabase() !== null
}

/** Each link's views, in one indexed read. Links without views are absent. */
export function shareViewSummaries(
  linkIds: readonly string[]
): Map<string, ShareViewSummary> {
  const summaries = new Map<string, ShareViewSummary>()
  const db = linkIds.length ? readableDatabase() : null
  if (!db) return summaries
  const ids = `(${linkIds.map(() => "?").join(", ")})`
  const counted = `link_id IN ${ids} AND counted = 1 AND NOT ${AUTOMATED}`
  for (const row of db
    .query<
      { link_id: string; views: number; keys: number; last: number },
      string[]
    >(
      `SELECT link_id, COUNT(*) AS views, COUNT(DISTINCT visitor) AS keys,
         MAX(started_at) AS last
       FROM share_views WHERE ${counted} GROUP BY link_id`
    )
    .all(...linkIds)) {
    summaries.set(row.link_id, {
      views: row.views,
      people: row.keys,
      lastViewAt: row.last,
      returning: 0,
      latest: null,
    })
  }
  if (!summaries.size) return summaries
  for (const row of db
    .query<{ link_id: string; came_back: number }, string[]>(
      `SELECT link_id, COUNT(*) AS came_back FROM (
         SELECT link_id FROM share_views
         WHERE ${counted} AND visitor IS NOT NULL
         GROUP BY link_id, visitor HAVING COUNT(DISTINCT day) > 1
       ) GROUP BY link_id`
    )
    .all(...linkIds))
    summaries.get(row.link_id)!.returning = row.came_back
  for (const row of db
    .query<ShareViewPlace & { link_id: string }, string[]>(
      `SELECT link_id, country, region, organization, source FROM (
         SELECT link_id, country, region, organization, source,
           ROW_NUMBER() OVER (
             PARTITION BY link_id ORDER BY started_at DESC
           ) AS latest
         FROM share_views WHERE ${counted}
       ) WHERE latest = 1`
    )
    .all(...linkIds)) {
    const { link_id: id, ...place } = row
    summaries.get(id)!.latest = place
  }
  // Keyless visitors: the most on any one day, from digests still kept and
  // from days already folded into counts. Never added across days.
  const busiest = new Map<string, number>()
  for (const row of db
    .query<{ link_id: string; visitors: number }, string[]>(
      `SELECT link_id, MAX(visitors) AS visitors FROM (
         SELECT link_id, day, COUNT(DISTINCT day_digest) AS visitors
           FROM share_views
           WHERE ${counted} AND visitor IS NULL AND day_digest IS NOT NULL
           GROUP BY link_id, day
         UNION ALL
         SELECT link_id, day, visitors FROM share_view_days
           WHERE link_id IN ${ids}
       ) GROUP BY link_id`
    )
    .all(...linkIds, ...linkIds)) {
    busiest.set(row.link_id, row.visitors)
  }
  // Views with no identifier at all add to views, never to people, except
  // that a link someone viewed has at least one person.
  for (const [id, summary] of summaries) {
    summary.people = Math.max(1, summary.people + (busiest.get(id) ?? 0))
  }
  return summaries
}

/** A link's latest views and previews, newest first, for its owner's agents. */
export function shareViewDetail(
  linkId: string,
  limit = 50
): { views: ShareViewRow[]; previews: SharePreviewRow[] } {
  const db = readableDatabase()
  if (!db) return { views: [], previews: [] }
  const views = db
    .query<
      {
        started_at: number
        counted: number
        visible_s: number
        had_input: number
        automated: number
        visitor: string | null
        country: string | null
        browser: string | null
        device: string | null
        network: string | null
        region: string | null
        system: string | null
        language: string | null
        organization: string | null
        scroll: number | null
        source: string | null
        screen: string | null
        came_back: number
      },
      [string, number]
    >(
      `SELECT started_at, counted, visible_s, had_input, ${AUTOMATED} AS automated,
         visitor, country, browser, device, network, region, system, language,
         organization, scroll, source, screen,
         visitor IS NOT NULL AND EXISTS (
           SELECT 1 FROM share_views AS earlier
           WHERE earlier.link_id = this.link_id AND earlier.visitor = this.visitor
             AND earlier.counted = 1 AND earlier.day < this.day
             AND NOT ${automated("earlier")}
         ) AS came_back
       FROM share_views AS this WHERE link_id = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(linkId, limit)
    .map(
      (row): ShareViewRow => ({
        startedAt: row.started_at,
        counted: row.counted === 1,
        visibleSeconds: row.visible_s,
        hadInput: row.had_input === 1,
        automated: row.automated === 1,
        visitor: row.visitor,
        country: row.country,
        browser: row.browser,
        device: row.device,
        network: row.network,
        region: row.region,
        system: row.system,
        language: row.language,
        organization: row.organization,
        scroll: row.scroll,
        source: row.source,
        screen: row.screen,
        returning: row.came_back === 1,
      })
    )
  const previews = db
    .query<SharePreviewRow, [string]>(
      "SELECT app, day, at FROM share_previews WHERE link_id = ? ORDER BY at DESC LIMIT 50"
    )
    .all(linkId)
  return { views, previews }
}

/**
 * Fold day digests older than two days into per-day counts, and forget views
 * and previews older than 90 days or of links that are gone. Background work:
 * the retention sweep runs it, never a request.
 */
export function sweepShareViews(now = Date.now()): void {
  const db = readableDatabase()
  if (!db) return
  const digestsBefore = utcDay(now - DAY_DIGEST_RETENTION_MS)
  const before = now - SHARE_VIEW_RETENTION_MS
  db.transaction(() => {
    db.query(
      `INSERT INTO share_view_days (link_id, day, visitors)
       SELECT link_id, day, COUNT(DISTINCT day_digest) FROM share_views
       WHERE day < ? AND counted = 1 AND visitor IS NULL
         AND day_digest IS NOT NULL AND NOT ${AUTOMATED}
       GROUP BY link_id, day
       ON CONFLICT (link_id, day) DO UPDATE SET
         visitors = MAX(visitors, excluded.visitors)`
    ).run(digestsBefore)
    db.query(
      "UPDATE share_views SET day_digest = NULL WHERE day < ? AND day_digest IS NOT NULL"
    ).run(digestsBefore)
    db.query("DELETE FROM share_views WHERE started_at < ?").run(before)
    db.query("DELETE FROM share_previews WHERE at < ?").run(before)
    // The boundary day goes too, so expired visitors never add to people.
    db.query("DELETE FROM share_view_days WHERE day <= ?").run(utcDay(before))
    for (const table of ["share_views", "share_previews", "share_view_days"]) {
      db.exec(
        `DELETE FROM ${table} WHERE link_id NOT IN (SELECT id FROM share_links)`
      )
    }
  })()
}

/**
 * A link's views as an agent reads them: no digests, and no names, since a
 * comment name is visitor text that agents read only once a member passes the
 * comment on. Each browser with a key gets a stable label within the link.
 */
export function shareViewsForAgent(linkId: string): {
  views: Array<{
    at: string
    visibleSeconds: number
    counted: boolean
    automated: boolean
    hadInput: boolean
    browserId: string | null
    country: string | null
    browser: string | null
    device: string | null
    network: string | null
    /** ISO 3166-2, such as "US-CA". */
    region: string | null
    os: string | null
    language: string | null
    organization: string | null
    screen: string | null
    /** How far down the page was read, 0 to 100. */
    scrolledPercent: number | null
    source: string | null
    /** The same browser viewed the link on an earlier day. */
    returning: boolean
  }>
  previews: Array<{ app: string; at: string }>
} {
  const { views, previews } = shareViewDetail(linkId)
  // Numbered by first view over every retained view, not just these, so a
  // browser keeps its label from one read to the next.
  const labels = new Map<string, string>()
  for (const { visitor } of readableDatabase()
    ?.query<{ visitor: string }, [string]>(
      `SELECT visitor FROM share_views WHERE link_id = ? AND visitor IS NOT NULL
       GROUP BY visitor ORDER BY MIN(started_at), visitor`
    )
    .all(linkId) ?? [])
    labels.set(visitor, `Browser ${labels.size + 1}`)
  return {
    views: views.map((view) => ({
      at: new Date(view.startedAt).toISOString(),
      visibleSeconds: view.visibleSeconds,
      counted: view.counted,
      automated: view.automated,
      hadInput: view.hadInput,
      browserId: view.visitor ? labels.get(view.visitor)! : null,
      country: view.country,
      browser: view.browser,
      device: view.device,
      network: view.network,
      region:
        view.country && view.region ? `${view.country}-${view.region}` : null,
      os: view.system,
      language: view.language,
      organization: view.organization,
      screen: view.screen,
      scrolledPercent: view.scroll,
      source: view.source,
      returning: view.returning,
    })),
    previews: previews.map((preview) => ({
      app: preview.app,
      at: new Date(preview.at).toISOString(),
    })),
  }
}
