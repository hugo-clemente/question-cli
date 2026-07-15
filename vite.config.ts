import { defineConfig } from "vite-plus";

export default defineConfig({
  // Match the codebase's hand-formatting (~120 cols) so `vp fmt` enforces consistency
  // without rewrapping every line. docs/ holds generated planning artifacts — leave them alone.
  fmt: {
    printWidth: 120,
    ignorePatterns: ["docs/"],
  },
  // `vp pack` (tsdown/Rolldown) bundles the CLI entry. discord.js and @clack/prompts
  // stay external — they're runtime `dependencies`, installed by npm alongside the package.
  pack: {
    entry: ["src/cli.ts"],
    platform: "node",
    clean: true,
  },
});
