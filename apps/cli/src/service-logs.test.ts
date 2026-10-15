import { afterEach, describe, expect, test } from "bun:test"
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rotateLogIfLarge } from "./service-logs.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("service log rotation", () => {
  test("rotates a log its writer keeps open, keeping the newest copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-logs-"))
    dirs.push(dir)
    const log = join(dir, "service.err.log")
    // The service manager's descriptor: opened once, appending.
    const fd = openSync(log, "a")
    try {
      for (const round of ["first", "second", "third"]) {
        writeSync(fd, `${round} `.repeat(20))
        expect(rotateLogIfLarge(log, 64, 2)).toBe(true)
        expect(readFileSync(log, "utf8")).toBe("")
      }
      expect(readFileSync(`${log}.1`, "utf8")).toStartWith("third ")
      expect(readFileSync(`${log}.2`, "utf8")).toStartWith("second ")
      expect(existsSync(`${log}.3`)).toBe(false)

      // The writer carries on at the start of the emptied file.
      writeSync(fd, "after rotation\n")
      expect(readFileSync(log, "utf8")).toBe("after rotation\n")
      expect(rotateLogIfLarge(log, 64, 2)).toBe(false)
    } finally {
      closeSync(fd)
    }
  })
})
