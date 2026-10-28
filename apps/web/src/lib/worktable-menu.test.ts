import { afterEach, expect, test } from "bun:test"
import {
  loadCloudDirectory,
  worktableMenuGroups,
  type CloudDirectory,
  type MenuGroup,
} from "./worktable-menu"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const linked = (
  id: string,
  extra: Partial<CloudDirectory["linked"][number]> = {}
) => ({
  id: `wl_${id.padEnd(32, "0")}`,
  name: id,
  device: "office-mac",
  state: "online",
  openUrl: `https://${id}.example/`,
  ...extra,
})

const directory = (device?: string): CloudDirectory => ({
  cloudOrigin: "https://cloud.example",
  ...(device ? { device } : {}),
  worktables: [
    { id: "hosted_team", name: "Team" },
    { id: "hosted_lab", name: "Lab" },
  ],
  linked: [
    // This Mac's own linked folder, and a copy of it on another device.
    linked("studio", { device: "this-mac", localWorkspaceId: "ws_studio" }),
    linked("copy", { localWorkspaceId: "ws_studio" }),
    linked("home", { device: "home-server" }),
    linked("office", { state: "offline" }),
    linked("unsafe", { openUrl: "javascript:alert(1)" }),
    // Loopback addresses: another device's, and another folder on this Mac.
    linked("laptop", { device: "laptop", openUrl: "http://127.0.0.1:7480/" }),
    linked("scratch", {
      device: "this-mac",
      openUrl: "http://localhost:7481/",
    }),
  ],
})

/** What a person reads in each group, and what each row does. */
const shown = (groups: MenuGroup[]) =>
  groups.map(({ label, rows }) => [
    label,
    rows.map((row) =>
      row.kind === "device"
        ? `${row.name} · ${row.online ? row.device : "Offline"} → ${row.href ?? "-"}`
        : row.kind === "hosted"
          ? `${row.name}${row.current ? " ✓" : ""} → ${row.href}`
          : `${row.name}${row.linked ? " [Link]" : ""}${row.current ? " ✓" : ""}`
    ),
  ])

const thisMac = [
  { id: "ws_studio", name: "Studio", linked: true, current: true },
  { id: "ws_client", name: "Client Work", linked: false, current: false },
]

test("Desktop lists this Mac, then other devices, then Cloud, each only when it has entries", () => {
  expect(
    shown(
      worktableMenuGroups({
        surface: "desktop",
        data: { thisMac, directory: directory("this-mac") },
        localIds: thisMac.map((worktable) => worktable.id),
        currentHostedId: null,
        onDevice: true,
      })
    )
  ).toEqual([
    ["On This Mac", ["Studio [Link] ✓", "Client Work"]],
    [
      "Other Devices",
      [
        "copy · office-mac → https://copy.example/",
        "home · home-server → https://home.example/",
        // Offline rows, addresses that aren't web pages, and another
        // device's loopback address don't open; this Mac's own does.
        "office · Offline → -",
        "unsafe · office-mac → -",
        "laptop · laptop → -",
        "scratch · this-mac → http://localhost:7481/",
      ],
    ],
    [
      "Worktable Cloud",
      [
        "Team → https://cloud.example/t/hosted_team/",
        "Lab → https://cloud.example/t/hosted_lab/",
      ],
    ],
  ])

  // Without a Cloud account the menu shows only this Mac, as before.
  expect(
    shown(
      worktableMenuGroups({
        surface: "desktop",
        data: { thisMac, directory: null },
        localIds: ["ws_studio", "ws_client"],
        currentHostedId: null,
        onDevice: true,
      })
    )
  ).toEqual([["On This Mac", ["Studio [Link] ✓", "Client Work"]]])
})

test("a Cloud tab uses its own session and omits deleted Worktables", async () => {
  const scope = globalThis as { window?: unknown }
  scope.window = { location: { origin: "https://cloud.example" } }
  globalThis.fetch = (async (input, init) => {
    expect(input).toBe("/api/worktables")
    expect(init?.credentials).toBe("same-origin")
    return Response.json({
      worktables: [
        { id: "hosted_team", name: "Team", status: "active" },
        { id: "hosted_deleted", name: "Deleted", status: "deleted" },
      ],
      linked: directory().linked,
    })
  }) as typeof fetch
  try {
    expect(await loadCloudDirectory(true)).toEqual({
      cloudOrigin: "https://cloud.example",
      worktables: [{ id: "hosted_team", name: "Team", status: "active" }],
      linked: directory().linked,
    })
    globalThis.fetch = (async () =>
      new Response("Unavailable", { status: 503 })) as typeof fetch
    await expect(loadCloudDirectory(true)).rejects.toThrow("HTTP 503")
  } finally {
    delete scope.window
  }
})

test("a Cloud tab lists Cloud first with this Worktable checked, then every device", () => {
  const { linked } = directory()
  const groups = worktableMenuGroups({
    surface: "cloud",
    data: {
      thisMac: null,
      directory: { ...directory(), linked: [linked[0]!, linked.at(-1)!] },
    },
    localIds: ["ws_studio"],
    currentHostedId: "hosted_lab",
    onDevice: false,
  })
  expect(shown(groups)).toEqual([
    [
      "Worktable Cloud",
      [
        "Team → https://cloud.example/t/hosted_team/",
        "Lab ✓ → https://cloud.example/t/hosted_lab/",
      ],
    ],
    [
      "Your Devices",
      [
        "studio · this-mac → https://studio.example/",
        // A loopback address works only on its device, which a Cloud tab
        // can't tell it's on.
        "scratch · this-mac → -",
      ],
    ],
  ])
})

test("a local page asks once through its Cloud sign-in, and keeps today's menu without one", async () => {
  const asked: string[] = []
  let answer: () => Response = () =>
    Response.json({ signedIn: true, ...directory("this-mac") })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(new URL(String(input), "http://127.0.0.1:7480").pathname)
    return answer()
  }) as typeof fetch

  const listed = { thisMac: null, directory: await loadCloudDirectory(false) }
  expect(asked).toEqual(["/api/linked/worktables"])
  expect(listed.thisMac).toBeNull()
  // A page in a browser lists itself above the groups, so its own linked
  // row isn't another device. This device's loopback address opens only
  // from a page on this device, not from one reached over the network.
  const local = (onDevice: boolean) =>
    shown(
      worktableMenuGroups({
        surface: "local",
        data: listed,
        localIds: ["ws_studio"],
        currentHostedId: null,
        onDevice,
      })
    )
  expect(local(true).map(([label, rows]) => [label, rows.length])).toEqual([
    ["Other Devices", 6],
    ["Worktable Cloud", 2],
  ])
  expect(local(true)[0]![1].at(-1)).toBe(
    "scratch · this-mac → http://localhost:7481/"
  )
  expect(local(false)[0]![1].at(-1)).toBe("scratch · this-mac → -")

  // Signed out, refused to a team member, or an older server legitimately
  // have no directory. A transient failure must remain retryable.
  for (const response of [
    () => Response.json({ signedIn: false }),
    () =>
      Response.json(
        { error: "Operator authority is required" },
        { status: 403 }
      ),
    () => new Response("Not found", { status: 404 }),
  ]) {
    answer = response
    expect(await loadCloudDirectory(false)).toBeNull()
  }
  answer = () =>
    Response.json({ error: "Could not load Worktables" }, { status: 503 })
  await expect(loadCloudDirectory(false)).rejects.toThrow(
    "Could not load Worktables"
  )
  answer = () => Response.json({ signedIn: true, ...directory("this-mac") })
  expect(await loadCloudDirectory(false)).toMatchObject(directory("this-mac"))
})
