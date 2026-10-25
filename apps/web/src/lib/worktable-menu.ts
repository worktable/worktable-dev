import { desktopWorktables, type DesktopWorktable } from "./desktop-worktables"
import { fetchJSON, HttpError } from "./http"

/** A hosted Worktable in Worktable Cloud. */
export interface HostedWorktable {
  id: string
  name: string
}

/** A folder on one of the person's devices, reachable through Worktable Link. */
export interface LinkedWorktable {
  id: string
  name: string
  /** The device's name. */
  device: string
  state: string
  /** Where the device says it opens. Older Cloud versions don't say. */
  openUrl?: string
  /** The folder's own id, so a device can tell its own Worktables. */
  localWorkspaceId?: string
}

/** The person's Worktables as Worktable Cloud lists them. */
export interface CloudDirectory {
  /** Where hosted Worktables open. */
  cloudOrigin: string
  /** This device's name in Cloud, when the list came through this Worktable. */
  device?: string
  worktables: HostedWorktable[]
  linked: LinkedWorktable[]
}

/**
 * Where the menu runs: Desktop, a Worktable Cloud tab, or a browser on a
 * local or self-hosted Worktable.
 */
export type MenuSurface = "desktop" | "cloud" | "local"

/** What the menu lists, loaded when it first opens. */
export interface WorktableMenuData {
  /** This Mac's Worktables; null outside Desktop or when Desktop can't say. */
  thisMac: DesktopWorktable[] | null
  /** Null without a Cloud account, or when Cloud couldn't be asked. */
  directory: CloudDirectory | null
}

/** A Worktable Cloud tab asks with its own session. */
async function cloudTabDirectory(): Promise<CloudDirectory> {
  const response = await fetch("/api/worktables", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const listed = (await response.json()) as {
    worktables?: Array<HostedWorktable & { status?: string }>
    linked?: LinkedWorktable[]
  }
  return {
    cloudOrigin: window.location.origin,
    // A deleted Worktable is listed for its payer, with nothing to open.
    worktables: (listed.worktables ?? []).filter(
      (worktable) => worktable.status !== "deleted"
    ),
    linked: listed.linked ?? [],
  }
}

/**
 * Elsewhere the Worktable asks through its own Cloud sign-in. Null when it
 * has none, or when this person can't use it, as a team member can't.
 */
async function localDirectory(): Promise<CloudDirectory | null> {
  try {
    const listed = await fetchJSON<
      ({ signedIn: true } & CloudDirectory) | { signedIn: false }
    >("/api/linked/worktables")
    return listed.signedIn ? listed : null
  } catch (error) {
    // An older server has no list, and only the host's owner may ask.
    if (error instanceof HttpError && [403, 404].includes(error.status))
      return null
    throw error
  }
}

/**
 * The menu's one list request. A failed Cloud list leaves this Mac's
 * Worktables, so the menu is never worse than before.
 */
export async function loadWorktableMenu(
  surface: MenuSurface,
  cloudPage: boolean
): Promise<WorktableMenuData> {
  const directory = (cloudPage ? cloudTabDirectory() : localDirectory()).catch(
    (error: unknown) => {
      console.warn("[worktable menu] Cloud list unavailable:", error)
      return null
    }
  )
  const desktop =
    surface === "desktop" ? desktopWorktables() : Promise.resolve(null)
  const [thisMac, listed] = await Promise.all([desktop, directory])
  return {
    thisMac: thisMac?.worktables ?? null,
    // A Cloud page doesn't know this device's name; Desktop does.
    directory:
      listed && !listed.device && thisMac?.device
        ? { ...listed, device: thisMac.device }
        : listed,
  }
}

export type MenuRow =
  | {
      kind: "this-mac"
      id: string
      name: string
      linked: boolean
      current: boolean
    }
  | {
      kind: "device"
      id: string
      name: string
      device: string
      online: boolean
      /** Where it opens; absent when it can't be opened. */
      href?: string
    }
  | {
      kind: "hosted"
      id: string
      name: string
      current: boolean
      href: string
    }

export interface MenuGroup {
  label: "On this Mac" | "Other devices" | "Your devices" | "Worktable Cloud"
  rows: MenuRow[]
}

/** Only a web address may be opened from the menu. */
function webAddress(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

/** Whether an address reaches only the device it's on. */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    /^127\./.test(hostname)
  )
}

/**
 * The menu's groups, each only when it has entries. `localIds` are the
 * folders on this device: a linked row for one of them is listed as this
 * device's own, not as another device. `onDevice` says this page runs on the
 * device the list came through, so that device's loopback addresses open.
 */
export function worktableMenuGroups({
  surface,
  data,
  localIds,
  currentHostedId,
  onDevice,
}: {
  surface: MenuSurface
  data: WorktableMenuData
  localIds: readonly string[]
  currentHostedId: string | null
  onDevice: boolean
}): MenuGroup[] {
  const { thisMac, directory } = data
  const groups: MenuGroup[] = []
  if (thisMac?.length) {
    groups.push({
      label: "On this Mac",
      rows: thisMac.map((worktable) => ({ kind: "this-mac", ...worktable })),
    })
  }
  if (!directory) return groups
  const own = (row: LinkedWorktable) =>
    surface !== "cloud" &&
    !!row.localWorkspaceId &&
    localIds.includes(row.localWorkspaceId) &&
    // Only a known device name settles that a row is this device's own.
    row.device === directory.device
  const devices: MenuRow[] = directory.linked
    .filter((row) => !own(row))
    .map((row) => {
      const online = row.state === "online"
      const address = online ? webAddress(row.openUrl) : undefined
      // A loopback address opens only on its own device.
      const href =
        address &&
        isLoopbackHost(new URL(address).hostname) &&
        !(onDevice && !!directory.device && row.device === directory.device)
          ? undefined
          : address
      return {
        kind: "device",
        id: row.id,
        name: row.name,
        device: row.device,
        online,
        ...(href ? { href } : {}),
      }
    })
  const hosted: MenuRow[] = directory.worktables.map((worktable) => ({
    kind: "hosted",
    id: worktable.id,
    name: worktable.name,
    current: worktable.id === currentHostedId,
    href: `${directory.cloudOrigin}/t/${encodeURIComponent(worktable.id)}/`,
  }))
  const cloud: MenuGroup = { label: "Worktable Cloud", rows: hosted }
  if (surface === "cloud") {
    groups.push(cloud, { label: "Your devices", rows: devices })
  } else {
    groups.push({ label: "Other devices", rows: devices }, cloud)
  }
  return groups.filter((group) => group.rows.length > 0)
}
