import { defineConfig } from "vite";

// Served by the Worker's static assets at /dash/
export default defineConfig({
  base: "/dash/",
  build: { outDir: "../worker/public/dash", emptyOutDir: true },
});
