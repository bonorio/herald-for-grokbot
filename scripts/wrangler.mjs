#!/usr/bin/env node
// Runs wrangler against your own config (wrangler.jsonc, written by
// `npm run setup`) or, before setup, the template. D1 commands can then name
// the database by its binding, DB, whatever you called it.
//
//   node scripts/wrangler.mjs d1 migrations apply DB --local
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const config = existsSync("wrangler.jsonc") ? "wrangler.jsonc" : "wrangler.example.jsonc";
const result = spawnSync("npx", ["wrangler", ...process.argv.slice(2), "--config", config], { stdio: "inherit" });
process.exit(result.status ?? 1);
