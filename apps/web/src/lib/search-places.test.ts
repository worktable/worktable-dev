import { describe, expect, it } from "bun:test"
import { matchPlaces } from "./search-places"

const places = [
  { id: "home", name: "Home" },
  { id: "settings", name: "Settings" },
  { id: "space:notes", name: "Field Notes" },
  { id: "space:studio", name: "Print Studio" },
  { id: "space:launch", name: "Launch Plan" },
]

describe("matchPlaces", () => {
  it("offers the places whose words the typed ones begin", () => {
    const names = (query: string) =>
      matchPlaces(places, query).map((place) => place.name)
    expect(names("set")).toEqual(["Settings"])
    expect(names("NOTES")).toEqual(["Field Notes"])
    // Each word typed starts some word of the name, in any order.
    expect(names("pl lau")).toEqual(["Launch Plan"])
    expect(names("s")).toEqual(["Settings", "Print Studio"])
    expect(names("ome")).toEqual([])
    expect(names("  ")).toEqual([])
  })

  it("stops at its limit, in the order given", () => {
    expect(matchPlaces(places, "s", 1).map((place) => place.id)).toEqual([
      "settings",
    ])
  })
})
