import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.wrangler/**", "apps/worker/public/**", "**/*.d.ts", "docs/probe-data/**", "tools/one-xr/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // plain Node scripts (no TypeScript, so no implicit Node globals)
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", setTimeout: "readonly", clearTimeout: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // `this.sql`...`` is a statement-position tagged template throughout the Agents SDK
      "@typescript-eslint/no-unused-expressions": ["error", { allowTaggedTemplates: true }],
    },
  },
);
