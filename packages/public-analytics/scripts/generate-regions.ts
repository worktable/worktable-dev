/**
 * Rewrites the analytics region rules in each public site's vercel.json from
 * the shared list in @worktable/hosted-contract/analytics-region. Run
 * `bun run generate:analytics-regions` after editing the list.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { format } from "prettier"
import {
  ANALYTICS_REGION_SITES,
  analyticsRegionHeaderRules,
  isAnalyticsRegionHeaderRule,
} from "../src/region"

const root = resolve(import.meta.dir, "../../..")
for (const site of ANALYTICS_REGION_SITES) {
  const path = resolve(root, site)
  if (!existsSync(path)) continue
  const config = JSON.parse(readFileSync(path, "utf8")) as {
    headers?: unknown[]
  }
  config.headers = [
    ...(config.headers ?? []).filter(
      (rule) => !isAnalyticsRegionHeaderRule(rule)
    ),
    ...analyticsRegionHeaderRules(),
  ]
  writeFileSync(
    path,
    await format(JSON.stringify(config, null, 2), { filepath: path })
  )
  console.log(`Updated ${site}`)
}
