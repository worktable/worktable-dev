import { afterEach, describe, expect, it } from "bun:test";
import { getExecutablePath } from "./paths.ts";

const originalEnv = { ...process.env };
const originalArgv = [...process.argv];

afterEach(() => {
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
});

describe("runtime paths", () => {
  it("uses the installed launcher when provided", () => {
    process.env["WORKTABLE_LAUNCHER"] = "/usr/local/bin/worktable";

    expect(getExecutablePath()).toBe("/usr/local/bin/worktable");
  });

  it("does not treat a relative argv entry as an executable path", () => {
    delete process.env["WORKTABLE_LAUNCHER"];
    process.argv[1] = "setup";

    expect(getExecutablePath()).toBe(process.execPath);
  });
});
