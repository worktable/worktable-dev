import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { brotliCompress, constants, gzip } from "node:zlib"
import type { Plugin } from "vite"

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)
const COMPRESSIBLE = /^assets\/.+\.(?:js|css|svg|json|txt)$/

/**
 * Write Brotli (quality 11) and gzip (level 9) copies beside each hashed
 * asset. The server sends them as they are, so serving never compresses.
 * Small files and copies that would not be smaller are left out.
 */
export function precompressAssets(): Plugin {
  return {
    name: "worktable-precompress-assets",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    async writeBundle(options, bundle) {
      const outDir = options.dir!
      await Promise.all(
        Object.keys(bundle)
          .filter((file) => COMPRESSIBLE.test(file))
          .map(async (file) => {
            const path = join(outDir, file)
            const bytes = await readFile(path)
            if (bytes.length < 1024) return
            const [brotli, gzipped] = await Promise.all([
              brotliAsync(bytes, {
                params: {
                  [constants.BROTLI_PARAM_QUALITY]: 11,
                  [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
                },
              }),
              gzipAsync(bytes, { level: 9 }),
            ])
            if (brotli.length < bytes.length)
              await writeFile(`${path}.br`, brotli)
            if (gzipped.length < bytes.length)
              await writeFile(`${path}.gz`, gzipped)
          })
      )
    },
  }
}
