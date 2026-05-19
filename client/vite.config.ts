import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const _dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // We invoke vite from the project root (via `vite --config client/vite.config.ts`),
  // so anchor root + build output back to the client/ folder. The output lives
  // at <root>/client/dist so AppKit's ServerPlugin.findStaticPath() picks it
  // up automatically in production - it probes dist/, client/dist/, build/,
  // public/, out/ in order. Picking client/dist also keeps the server's
  // build/index.mjs from being shadowed by the client bundle.
  root: _dir,
  build: {
    outDir: path.resolve(_dir, "dist"),
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(_dir, "src"),
    },
  },
});
