import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  )
})

describe("public release smoke", () => {
  test("retries a failed latest installer even without an expected version", async () => {
    const root = await mkdtemp(join(tmpdir(), "worktable-public-smoke-test-"))
    tempRoots.push(root)
    const installer = join(root, "install.sh")
    const attempts = join(root, "attempts")

    await Bun.write(
      installer,
      `#!/bin/sh
set -eu
count=0
[ ! -f "$FAKE_ATTEMPTS_FILE" ] || count=$(cat "$FAKE_ATTEMPTS_FILE")
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_ATTEMPTS_FILE"
exit 1
`,
    )
    await chmod(installer, 0o755)

    const process = Bun.spawn(
      ["sh", "scripts/public-release-smoke.sh", "--latest"],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...Bun.env,
          FAKE_ATTEMPTS_FILE: attempts,
          WORKTABLE_PUBLIC_SMOKE_INSTALL_URL: `file://${installer}`,
          WORKTABLE_PUBLIC_SMOKE_RETRIES: "2",
          WORKTABLE_PUBLIC_SMOKE_RETRY_DELAY: "0",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    )

    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(await Bun.file(attempts).text()).toBe("2\n")
    expect(stderr).toContain("public install failed after 2 attempts.")
  })

  test("rejects a stale latest install before running the lifecycle smoke", async () => {
    const root = await mkdtemp(join(tmpdir(), "worktable-public-smoke-test-"))
    tempRoots.push(root)
    const installer = join(root, "install.sh")

    await Bun.write(
      installer,
      `#!/bin/sh
set -eu
install_dir=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      shift
      install_dir=$1
      ;;
  esac
  shift
done
mkdir -p "$install_dir"
printf '%s\\n' '#!/bin/sh' 'echo 0.0.39' > "$install_dir/worktable"
chmod +x "$install_dir/worktable"
`,
    )
    await chmod(installer, 0o755)

    const process = Bun.spawn(
      [
        "sh",
        "scripts/public-release-smoke.sh",
        "--latest",
        "--expect-version",
        "v0.0.40",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...Bun.env,
          WORKTABLE_PUBLIC_SMOKE_INSTALL_URL: `file://${installer}`,
          WORKTABLE_PUBLIC_SMOKE_RETRIES: "1",
          WORKTABLE_PUBLIC_SMOKE_RETRY_DELAY: "0",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    )

    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain(
      "Installed version '0.0.39' does not match expected '0.0.40'.",
    )
  })
})
