// How much one share link may read, shared by everyone holding it. Budgets
// cap abuse; the grant is the security boundary. They live in this process's
// memory: O(1) work and no I/O per query, and a restart resets them. Several
// processes serving one workspace would each allow the full budget.

import type { LinkGrantLimits } from "@worktable/types";

export type LinkLimitName = "queriesPerMinute" | "rowsPerHour";

export type LinkBudgetAdmission =
  | { ok: true; /** Rows the link may still read this hour. */ rowsLeft: number }
  | { ok: false; limit: LinkLimitName; /** Whole seconds until the link may try again. */ retryAfter: number };

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;

interface LinkUsage {
  /** The minute `queries` counts, as whole minutes since the epoch. */
  minute: number;
  queries: number;
  /** Rows read in each of the last 60 minutes, by minute modulo 60. */
  rows: number[];
  /** The latest minute `rows` holds. */
  rowsMinute: number;
  rowsTotal: number;
}

export class LinkBudgets {
  // Kept in order of last use, so idle links are dropped from the front.
  private readonly usage = new Map<string, LinkUsage>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Counts one query against the link before it runs, whether or not it is
   * then refused, so probing slows down too. Refuses when the link has made
   * its queries this minute or read its rows this hour.
   */
  admit(linkId: string, limits: Pick<LinkGrantLimits, "queriesPerMinute" | "rowsPerHour">): LinkBudgetAdmission {
    const now = this.now();
    const minute = Math.floor(now / MINUTE_MS);
    this.dropIdle(minute);
    const usage = this.touch(linkId, minute);
    if (minute > usage.minute) {
      usage.minute = minute;
      usage.queries = 0;
    }
    usage.queries += 1;
    if (usage.queries > limits.queriesPerMinute) {
      return { ok: false, limit: "queriesPerMinute", retryAfter: secondsUntil((minute + 1) * MINUTE_MS, now) };
    }
    const rowsLeft = limits.rowsPerHour - usage.rowsTotal;
    if (rowsLeft <= 0) {
      return { ok: false, limit: "rowsPerHour", retryAfter: secondsUntil(this.oldestRowsExpire(usage, minute), now) };
    }
    return { ok: true, rowsLeft };
  }

  /**
   * Takes the rows a query returned from the link's hour, or refuses when
   * they don't fit: groups, expanded rows and backlinks have no page size, so
   * a response goes out only once its rows are paid for.
   */
  take(linkId: string, rows: number, limits: Pick<LinkGrantLimits, "rowsPerHour">): LinkBudgetAdmission {
    const now = this.now();
    const minute = Math.floor(now / MINUTE_MS);
    const usage = this.touch(linkId, minute);
    const rowsLeft = limits.rowsPerHour - usage.rowsTotal;
    if (rows > rowsLeft) {
      return { ok: false, limit: "rowsPerHour", retryAfter: secondsUntil(this.oldestRowsExpire(usage, minute), now) };
    }
    usage.rows[minute % HOUR_MINUTES]! += rows;
    usage.rowsTotal += rows;
    return { ok: true, rowsLeft: rowsLeft - rows };
  }

  private touch(linkId: string, minute: number): LinkUsage {
    let usage = this.usage.get(linkId);
    if (usage) {
      this.usage.delete(linkId);
      advance(usage, minute);
    } else {
      usage = { minute, queries: 0, rows: new Array(HOUR_MINUTES).fill(0), rowsMinute: minute, rowsTotal: 0 };
    }
    this.usage.set(linkId, usage);
    return usage;
  }

  /** When the oldest minute that still holds rows leaves the hour. */
  private oldestRowsExpire(usage: LinkUsage, minute: number): number {
    for (let age = HOUR_MINUTES - 1; age > 0; age -= 1) {
      if (usage.rows[(minute - age) % HOUR_MINUTES]! > 0) return (minute - age + HOUR_MINUTES) * MINUTE_MS;
    }
    return (minute + HOUR_MINUTES) * MINUTE_MS;
  }

  /** Links unused for an hour have nothing left to count. */
  private dropIdle(minute: number): void {
    for (const [linkId, usage] of this.usage) {
      if (Math.max(usage.minute, usage.rowsMinute) > minute - HOUR_MINUTES) break;
      this.usage.delete(linkId);
    }
  }
}

/** Moves a link's hour forward to `minute`, emptying the minutes that left it. */
function advance(usage: LinkUsage, minute: number): void {
  if (minute <= usage.rowsMinute) return;
  const steps = Math.min(minute - usage.rowsMinute, HOUR_MINUTES);
  for (let step = 1; step <= steps; step += 1) {
    const slot = (usage.rowsMinute + step) % HOUR_MINUTES;
    usage.rowsTotal -= usage.rows[slot]!;
    usage.rows[slot] = 0;
  }
  usage.rowsMinute = minute;
}

function secondsUntil(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 1000));
}

/** The budgets every link query in this process shares. */
export const linkBudgets = new LinkBudgets();
