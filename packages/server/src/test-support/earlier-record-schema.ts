// A collection schema as an earlier Worktable could save it: written straight
// to disk, past the checks a schema write makes now, such as the refusal of
// field keys records use for themselves.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RecordCollectionSchema } from "@worktable/types";
import { getSpacesBaseDir } from "../store.ts";
import { stringifyCanonicalYaml } from "../yaml.ts";

export async function writeEarlierRecordSchema(spaceId: string, schema: RecordCollectionSchema): Promise<void> {
  const path = join(getSpacesBaseDir(), spaceId, "records", schema.id, "schema.yaml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyCanonicalYaml(schema));
}
