import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The docs site is built first and shipped as static assets beside the demo, so one Worker serves both.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  publicDir: "../../apps/docs/dist",
  build: { rollupOptions: { input: "bank/index.html" } },
});
