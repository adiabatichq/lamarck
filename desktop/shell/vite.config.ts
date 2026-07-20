import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Electron production loads dist/index.html through file://, so emitted
  // assets must stay relative to that document instead of resolving at /.
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
  },
  test: {
    // Compiled copies of the suites land in build output; never collect them.
    exclude: ["**/node_modules/**", "dist/**", "dist-electron/**"],
  },
});
