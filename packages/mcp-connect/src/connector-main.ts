// Bundle entry for connect.mjs: run the connector and exit with its code.
// Kept apart from connector.ts so tests can import runConnector without
// side effects (Node has no import.meta.main to guard with).
import { runConnector } from "./connector.ts";

runConnector(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error((err as Error).stack ?? String(err));
    process.exit(1);
  }
);
