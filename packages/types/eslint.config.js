import js from "@eslint/js"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig([
  globalIgnores(["dist", "node_modules"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022 },
  },
  {
    // The web app's startup path imports this module; keep Zod out of it.
    files: ["src/constants.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["*"],
              allowTypeImports: true,
              message:
                "constants.ts must stay dependency-free; import types only.",
            },
          ],
        },
      ],
    },
  },
])
