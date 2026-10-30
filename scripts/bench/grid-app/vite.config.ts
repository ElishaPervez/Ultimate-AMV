/* Bench-only build of the real Scene Splitter grid (see main.tsx).
 *
 *   npx vite build --config scripts/bench/grid-app/vite.config.ts
 *   GRID_BENCH_PROFILING=1 npx vite build --config scripts/bench/grid-app/vite.config.ts
 *
 * Output goes to GRID_BENCH_OUT (default C:\tmp\amv-optimize-bench\w6\dist or
 * dist-prof). It defines VITE_AMV_GRID_BENCH=1, which is what lets the grid's
 * A/B switches (src/dev/gridPerfSwitches.ts) be read in this production-mode
 * build; real app builds never define it, so the switches compile out. */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import pkg from "../../../package.json";

const profiling = process.env.GRID_BENCH_PROFILING === "1";
const outDir =
  process.env.GRID_BENCH_OUT ??
  (profiling ? "C:/tmp/amv-optimize-bench/w6/dist-prof" : "C:/tmp/amv-optimize-bench/w6/dist");

export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    "import.meta.env.VITE_AMV_GRID_BENCH": JSON.stringify("1"),
  },
  resolve: {
    alias: profiling
      ? [{ find: /^react-dom\/client$/, replacement: path.resolve(__dirname, "../../../node_modules/react-dom/profiling.js") }]
      : [],
  },
  build: {
    outDir,
    emptyOutDir: true,
    minify: process.env.GRID_BENCH_MINIFY !== "0",
    sourcemap: false,
  },
});
