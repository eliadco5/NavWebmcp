import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Agent worktrees (.claude/worktrees/*) are full checkouts of other branches; their
    // tests/unit paths also match `vitest run tests/unit` and would run against this tree.
    exclude: [...configDefaults.exclude, ".claude/**"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
