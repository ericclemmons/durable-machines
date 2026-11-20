import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The docs site is built first and shipped as static assets beside both examples, so one Worker serves them all.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // The examples and the inspector are workspace packages: share one React, one Kumo and one agents client.
  resolve: { dedupe: ["react", "react-dom", "@cloudflare/kumo", "agents"] },
  publicDir: "../docs/dist",
  environments: { client: { build: { rollupOptions: { input: ["bank/index.html", "ci/index.html"] } } } },
});
