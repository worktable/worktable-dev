import { stageProductFonts } from "../../../scripts/product-fonts.ts"
import sharp from "sharp"
import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

test("bundled and compiled native drawing renderers resolve embedded fonts and viewer assets outside the source tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktable-drawing-bundle-"))
  try {
    const productSource = join(root, "product-font-source")
    await mkdir(productSource)
    const sourceFonts = fileURLToPath(
      new URL("../../../apps/desktop/ui/fonts", import.meta.url)
    )
    await copyFile(
      join(sourceFonts, "fraunces-variable-latin.woff2"),
      join(productSource, "general-sans-variable.woff2")
    )
    await copyFile(
      join(sourceFonts, "GeneralSans-LICENSE.txt"),
      join(productSource, "GeneralSans-LICENSE.txt")
    )
    const productFont = stageProductFonts(
      productSource,
      join(root, "preview-runtime")
    )
    const webp = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "red" },
    })
      .webp()
      .toBuffer()
    const entry = join(root, "main.ts")
    await writeFile(
      entry,
      `
import {productFontVersion} from ${JSON.stringify(fileURLToPath(new URL("./product-fonts.ts", import.meta.url)))}
import {renderDrawing} from ${JSON.stringify(fileURLToPath(new URL("./drawing-render.ts", import.meta.url)))}
import {PreviewBrowserPool,runWithPreviewBrowserPool} from ${JSON.stringify(fileURLToPath(new URL("./document-preview-browser.ts", import.meta.url)))}
import {launchPreviewBrowserProcess,resolveHeadlessPreviewExecutable} from ${JSON.stringify(fileURLToPath(new URL("./document-preview-process.ts", import.meta.url)))}
import {dirname} from 'node:path'
import {createRequire} from 'node:module' 
// Only a synthetic fixture: production launcher requires sandboxing. The scoped
// test launcher tests compiled assets without weakening production configuration.
const driverPath = ${JSON.stringify(join(dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "index.js"))}
const driver = createRequire(import.meta.url)(driverPath)
const pool = new PreviewBrowserPool({launch: () => launchPreviewBrowserProcess(driver,resolveHeadlessPreviewExecutable(driver,dirname(driverPath)),(command,env)=>Bun.spawn([...command,"--no-sandbox"],{stdin:"ignore",stdout:"ignore",stderr:"pipe",detached:true,env}))})
const store = {
  asset: {id:'asset',typeName:'asset',w:2,h:2,src:${JSON.stringify("data:image/webp;base64," + webp.toString("base64"))}},
  image: {id:'image',typeName:'shape',type:'image',x:0,y:0,rot:0,z:0,props:{w:200,h:100,assetId:'asset'}}
}
for (const [i,font] of ['sans','serif','mono','draw'].entries()) store[font] = {id:font,typeName:'shape',type:'text',x:0,y:120+i*50,rot:0,z:i+1,props:{text:'Bundled café Ελληνικά Привет Tiếng Việt',font,size:'m',color:'black'}}
const result = await runWithPreviewBrowserPool(pool,()=>renderDrawing({type:'worktable.quickdraw',version:1,title:'Bundled preview',snapshot:{document:{store}}}))
await pool.close()
if (!result.data.startsWith('iVBOR')) throw new Error('Missing PNG')
console.log(JSON.stringify({mimeType:result.mimeType,bytes:result.data.length,productFontVersion:productFontVersion()}))
`
    )
    for (const compiled of [false, true]) {
      const outputPath = compiled
        ? join(root, "drawing-preview")
        : join(root, "dist", "main.js")
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          entry,
          "--target",
          "bun",
          ...(compiled
            ? ["--compile", "--outfile", outputPath]
            : ["--outdir", join(root, "dist")]),
        ],
        { stdout: "pipe", stderr: "pipe" }
      )
      const buildOutput = await new Response(build.stderr).text()
      expect(await build.exited, buildOutput).toBe(0)
      const run = Bun.spawn(
        compiled ? [outputPath] : [process.execPath, outputPath],
        {
          cwd: tmpdir(),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            NODE_ENV: "test",
            WORKTABLE_RELEASE_DIR: root,
          },
        }
      )
      const output = await new Response(run.stdout).text()
      const errors = await new Response(run.stderr).text()
      expect(await run.exited, errors).toBe(0)
      const result = JSON.parse(output)
      expect(result.productFontVersion).toBe(productFont.font.sha256)
      expect(result.mimeType).toBe("image/png")
      expect(result.bytes).toBeGreaterThan(5000)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
