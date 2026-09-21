/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_POSTHOG_PROJECT_TOKEN?: string
  readonly PUBLIC_POSTHOG_API_HOST?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
