import { describe, expect, it } from "bun:test"
import { buildBreadcrumbs } from "./breadcrumbs"
import type { Breadcrumb } from "./breadcrumbs"
import { buildTree } from "./tree"

function summary(crumbs: Breadcrumb[]) {
  return crumbs.map((crumb) => {
    if (crumb.kind === "link") return [crumb.label, crumb.target.to]
    if (crumb.kind === "folder") {
      return [crumb.label, crumb.folder.children.map((child) => child.label)]
    }
    return [crumb.label]
  })
}

describe("buildBreadcrumbs", () => {
  it("names a nested document like the sidebar and makes its folders open their contents", () => {
    const documents = {
      active: buildTree([
        { path: "guides", title: "Field Guides" },
        { path: "guides/on call/escalation", title: "Escalation policy" },
        { path: "guides/on call/handoff", title: "Handoff checklist" },
      ]),
      archived: [],
    }

    const crumbs = buildBreadcrumbs({
      pathname: "/spaces/platform/documents/guides/on%20call/escalation",
      spaceName: "Platform Engineering",
      documents,
    })

    expect(summary(crumbs)).toEqual([
      ["Platform Engineering", "/spaces/$spaceId"],
      ["Field Guides", ["On Call"]],
      ["On Call", ["Escalation policy", "Handoff checklist"]],
      ["Escalation policy"],
    ])
    expect(crumbs[2]).toMatchObject({
      kind: "folder",
      currentPath: "guides/on call/escalation",
    })
    expect(crumbs.map((crumb) => !!crumb.mobileHidden)).toEqual([
      false,
      true,
      false,
      false,
    ])
    // A page that names itself (HTML docs, drawings) keeps its live title.
    expect(
      buildBreadcrumbs({
        pathname: "/spaces/platform/documents/guides/on%20call/escalation",
        titleOverride: "Renamed",
        documents,
      }).at(-1)?.label
    ).toBe("Renamed")
  })

  it("keeps folders with nothing to open as plain text", () => {
    const pathname = "/spaces/platform/documents/old-notes/retro"
    const archivedOnly = buildBreadcrumbs({
      pathname,
      documents: {
        active: [],
        archived: buildTree([{ path: "old-notes/retro", archived: true }]),
      },
    })
    const loading = buildBreadcrumbs({ pathname })

    for (const crumbs of [archivedOnly, loading]) {
      expect(summary(crumbs)).toEqual([
        ["Platform", "/spaces/$spaceId"],
        ["Old Notes"],
        ["Retro"],
      ])
    }
  })

  it("links records and threads back to their lists", () => {
    expect(
      summary(
        buildBreadcrumbs({
          pathname: "/spaces/platform/records/incidents/inc-001",
          parentTitleOverride: "Incidents",
          titleOverride: "Elevated 5xx",
        })
      )
    ).toEqual([
      ["Platform", "/spaces/$spaceId"],
      ["Incidents", "/spaces/$spaceId/records/$"],
      ["Elevated 5xx"],
    ])
    expect(
      summary(
        buildBreadcrumbs({
          pathname: "/spaces/platform/threads/abc",
          titleOverride: "Launch plan",
        })
      )
    ).toEqual([
      ["Platform", "/spaces/$spaceId"],
      ["Threads", "/spaces/$spaceId/threads/$"],
      ["Launch plan"],
    ])
    // The thread list is the current page when no thread is selected.
    expect(
      summary(
        buildBreadcrumbs({
          pathname: "/spaces/platform/threads",
          titleOverride: "New thread",
        })
      )
    ).toEqual([["Platform", "/spaces/$spaceId"], ["Threads"], ["New thread"]])
    expect(
      summary(
        buildBreadcrumbs({
          pathname: "/threads/spaces/platform/abc",
          spaceName: "Platform Engineering",
          titleOverride: "Launch plan",
        })
      )
    ).toEqual([
      ["Platform Engineering", "/spaces/$spaceId"],
      ["Threads", "/threads/$"],
      ["Launch plan"],
    ])
  })
})
