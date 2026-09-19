import { defineConfig } from "vite";

// Served by the Worker's static assets at /
export default defineConfig({
  build: { outDir: "../worker/public", emptyOutDir: true },
});
