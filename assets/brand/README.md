# Worktable brand assets

This directory holds Worktable's shared SVG artwork.

## Sources and generated files

The human-edited geometry sources are:

- `worktable-icon-bare.svg`
- `worktable-wordmark.svg`

Static brand colors live under `themeConfig.brand` in
`packages/ui/src/theme/theme-config.ts`. Generated files include the filled and
blue SVG variants. Generator consumers are declared in
`scripts/generation-targets.json`. Do not edit generated outputs directly.

```sh
bun run generate:brand
bun run check:brand
bun run generate:theme
bun run check:theme
```

Brand generation also writes app favicons, PWA and Apple-touch images, Desktop
bootstrap art, and the MCPB icon. Packaged consumers use
`apps/web/public/pwa-512x512.png`, so regenerate before building Desktop or the
Claude extension.

The complete icon lockup preserves its optical proportions and offset. Resize
the whole asset; do not recenter or independently scale the inner mark.
