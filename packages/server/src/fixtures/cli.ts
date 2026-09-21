/**
 * Worktable Labs — fixture generator CLI (thin entrypoint over ./generate.ts).
 *
 *   bun run fixtures:generate [-- --only <name>]   # write fixtures/workspaces/<name>/
 *   bun run fixtures:verify                          # regenerate to temp, diff vs committed
 */
import { generate, verify } from "./generate.ts";

function parseOnly(argv: string[]): string | undefined {
  const i = argv.indexOf("--only");
  if (i >= 0) {
    const v = argv[i + 1];
    if (!v) throw new Error("--only requires a fixture name");
    return v;
  }
  return undefined;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const only = parseOnly(rest);
  switch (cmd) {
    case "generate":
      return generate(only);
    case "verify":
      return verify(only);
    default:
      console.error("Usage: fixtures <generate|verify> [--only <name>]");
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
