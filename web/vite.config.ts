import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The panel is served by the daemon from `web/dist` at `/`, so assets must be
 * referenced by absolute path (`/assets/…`) — a relative base would 404 on a
 * deep link such as `/sessions/<id>` when the SPA fallback serves index.html.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
