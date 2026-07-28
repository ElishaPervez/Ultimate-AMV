import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: false,
    watch: {
      // None of these hold frontend sources, so watching them buys nothing and
      // costs plenty: the linker holds target\debug\deps\*.dll open while it
      // writes, and the watcher trying to attach to it there kills the dev
      // server outright (EBUSY), taking `tauri dev` down with it. The bundled
      // python runtime is another 25k files nobody needs watched.
      ignored: [
        "**/src-tauri/**",
        "**/python/**",
        "**/backend/**",
      ],
    },
  },
});
