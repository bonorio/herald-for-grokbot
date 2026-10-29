import { existsSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Your own config once `npm run setup` has made it; the template until then.
const configPath = existsSync("wrangler.jsonc") ? "wrangler.jsonc" : "wrangler.example.jsonc";

export default defineConfig({
  plugins: [react(), cloudflare({ configPath })],
});
