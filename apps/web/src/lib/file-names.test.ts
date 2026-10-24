import { describe, expect, it } from "bun:test"
import { renamedFileName } from "./file-names"

describe("renaming a file", () => {
  it("keeps the extension unless the new name gives one", () => {
    expect(renamedFileName("error.png", "Error")).toBe("Error.png")
    expect(renamedFileName("error.png", "signup error")).toBe("signup error.png")
    expect(renamedFileName("error.png", "error.jpg")).toBe("error.jpg")
    expect(renamedFileName("notes", "todo")).toBe("todo")
    // A leading dot is a name, not an extension.
    expect(renamedFileName("data.csv", ".hidden")).toBe(".hidden.csv")
  })
})
