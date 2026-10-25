import { afterEach, expect, test } from "bun:test"
import {
  loadWorktableMenu,
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
    ["On this Mac", ["Studio [Link] ✓", "Client Work"]],
    [
      "Other devices",
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
  ).toEqual([["On this Mac", ["Studio [Link] ✓", "Client Work"]]])
})

test("Desktop showing a Cloud Worktable tells this Mac's linked rows by its device name", async () => {
  const tauri = globalThis as { __TAURI__?: unknown; window?: unknown }
  tauri.__TAURI__ = {
    core: {
      invoke: async (command: string) => {
        expect(command).toBe("desktop_workspace_worktables")
        return { schemaVersion: 1, worktables: thisMac, device: "this-mac" }
      },
    },
  }
  tauri.window = { location: { origin: "https://cloud.example" } }
  globalThis.fetch = (async () =>
    Response.json({
      ...directory(),
      worktables: [{ id: "hosted_team", name: "Team", status: "active" }],
    })) as unknown as typeof fetch
  try {
    const data = await loadWorktableMenu("desktop", true)
    expect(
      shown(
        worktableMenuGroups({
          surface: "desktop",
          data,
          localIds: thisMac.map((worktable) => worktable.id),
          currentHostedId: "hosted_team",
          onDevice: true,
        })
      ).map(([label, rows]) => [label, rows.length])
    ).toEqual([
      ["On this Mac", 2],
      // The copy on office-mac stays; this Mac's own Studio row doesn't.
      ["Other devices", 6],
      ["Worktable Cloud", 1],
    ])
    // Without a device name nothing counts as this Mac's own.
    expect(
      worktableMenuGroups({
        surface: "desktop",
        data: { ...data, directory: { ...data.directory!, device: undefined } },
        localIds: ["ws_studio"],
        currentHostedId: null,
        onDevice: true,
      })[1]!.rows.length
    ).toBe(7)
  } finally {
    delete tauri.__TAURI__
    delete tauri.window
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
      "Your devices",
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

  const listed = await loadWorktableMenu("local", false)
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
    ["Other devices", 6],
    ["Worktable Cloud", 2],
  ])
  expect(local(true)[0]![1].at(-1)).toBe(
    "scratch · this-mac → http://localhost:7481/"
  )
  expect(local(false)[0]![1].at(-1)).toBe("scratch · this-mac → -")

  // Signed out, refused to a team member, an older server, or Cloud
  // unavailable: no groups, so the menu stays as it was.
  for (const response of [
    () => Response.json({ signedIn: false }),
    () =>
      Response.json(
        { error: "Operator authority is required" },
        { status: 403 }
      ),
    () => new Response("Not found", { status: 404 }),
    () =>
      Response.json({ error: "Could not load Worktables" }, { status: 503 }),
  ]) {
    answer = response
    expect((await loadWorktableMenu("local", false)).directory).toBeNull()
  }
})
