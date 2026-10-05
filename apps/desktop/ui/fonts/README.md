# Desktop shell fonts

Development loads General Sans directly from the [Fontshare API](https://www.fontshare.com/fonts/general-sans). The font file is not included in public source. Initial loading requires internet access; the existing system-font fallback is used when it is unavailable. The development server replaces only `general-sans.css`; the other fonts remain local.

Packaged Desktop builds use local fonts for offline startup. Before building from public source, run the provisioning command below. It obtains the unmodified General Sans variable WOFF2 from Fontshare under its [ITF Free Font License](https://www.fontshare.com/licenses/itf-ffl) and writes `general-sans-variable.woff2` here. Keep that file out of public Git and source archives. Packaging checks that the required WOFF2 files are present. Obtaining the font does not grant unrestricted redistribution rights; follow its own terms when distributing builds.

- `fraunces-variable-latin.woff2` is the Latin subset of Fraunces from Google Fonts. Its [SIL Open Font License 1.1](Fraunces-OFL.txt) and copyright notice are included here.
- `jetbrains-mono-variable-latin.woff2` is the Latin subset of JetBrains Mono from Google Fonts. Its [SIL Open Font License 1.1](JetBrainsMono-OFL.txt) and copyright notice are included here.

Font files retain their own licenses and are not relicensed by the application.

The same supplied General Sans file is packaged under `preview-runtime/fonts/`
for the drawing editor, authored HTML previews, and agent captures. The server
serves it from a trusted same-origin endpoint; preview jobs never fetch Fontshare.
CLI/server release assembly requires this local asset and retains its license,
source URL and SHA-256 identity. Desktop verifies its shell and preview copies
match. Development can omit the file and use the documented shared fallback.

For a reproducible clean-checkout build, run this from the repository root:

```sh
bun scripts/provision-product-font.ts
```

This explicit build step downloads the reviewed variable WOFF2 from Fontshare,
checks its pinned SHA-256, and atomically writes the ignored local file. It never
replaces an existing differing file. CI artifact builds use the same command;
release assembly and runtime preview requests never download fonts.
