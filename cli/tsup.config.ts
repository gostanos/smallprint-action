import { defineConfig } from "tsup";

export default defineConfig({
  entry: { smallprint: "src/main.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  minify: false,
  sourcemap: false,
  clean: true,
  outDir: "dist",
});
