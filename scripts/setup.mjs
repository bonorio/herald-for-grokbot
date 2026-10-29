#!/usr/bin/env node
// Sets up your own Herald in your own Cloudflare account, start to finish:
// signs in to Cloudflare, creates the database, applies the schema, deploys,
// and sets a one-time setup code. Run it again any time; it reuses what's there.
//
//   npm run setup              do it
//   npm run setup -- --dry-run show what it would do, change nothing
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const DRY = process.argv.includes("--dry-run");
const CONFIG = "wrangler.jsonc";
const TEMPLATE = "wrangler.example.jsonc";

const say = (text = "") => console.log(text);
const step = (n, text) => say(`\n\x1b[1m${n}. ${text}\x1b[0m`);
const fail = (text) => {
  console.error(`\n\x1b[31m${text}\x1b[0m`);
  process.exit(1);
};

/** Runs wrangler and returns what it printed, or shows it live with `inherit`. */
function wrangler(args, { inherit = false, input } = {}) {
  // whoami, listing and a SELECT only read, so a dry run does them for real.
  if (DRY && !["whoami", "d1 list", "d1 execute"].some((safe) => args.join(" ").startsWith(safe))) {
    say(`   would run: wrangler ${args.join(" ")}`);
    return "";
  }
  if (inherit) {
    const result = spawnSync("npx", ["wrangler", ...args], { stdio: "inherit", env: { ...process.env, CI: "1" } });
    if (result.status !== 0) fail(`wrangler ${args[0]} failed; see above.`);
    return "";
  }
  try {
    return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", input, env: { ...process.env, CI: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    if (args[0] === "whoami") throw error;
    fail(`wrangler ${args.slice(0, 2).join(" ")} failed:\n${error.stderr || error.stdout || error.message}`);
  }
}

/** A setup code that's easy to type on a phone: four groups of four. */
function setupCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g).join("-");
}

/**
 * Rows from a read-only query on the remote database, or none if it can't be
 * read (a database with no tables yet, a hiccup). Never fails setup.
 */
function query(database, sql) {
  try {
    const out = execFileSync("npx", ["wrangler", "d1", "execute", database, "--remote", "--json", "--command", sql], {
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out)[0]?.results ?? [];
  } catch {
    return null;
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (question, fallback) => (await rl.question(`   ${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;

say("\x1b[1mHerald setup\x1b[0m");
say("Everything goes into your own Cloudflare account; your data stays there. The free plan is enough.");
if (DRY) say("Dry run: nothing will change.");

step(1, "Cloudflare account");
let account;
try {
  account = wrangler(["whoami"]);
} catch {
  account = "";
}
if (!/You are logged in/i.test(account)) {
  if (DRY) fail("Not signed in to Cloudflare. Run without --dry-run to sign in.");
  say("   Opening Cloudflare to sign in…");
  wrangler(["login"], { inherit: true });
} else {
  say("   Signed in.");
}

step(2, "Name");
if (!existsSync(CONFIG)) {
  if (!DRY) copyFileSync(TEMPLATE, CONFIG);
  say(`   Made ${CONFIG} from ${TEMPLATE}. It stays out of git.`);
}
let config = readFileSync(existsSync(CONFIG) ? CONFIG : TEMPLATE, "utf8");
const current = (/"name":\s*"([^"]+)"/.exec(config) ?? [])[1] ?? "herald";
const name = (await ask("Worker and database name (lowercase, dashes)", current)).toLowerCase();
if (!/^[a-z][a-z0-9-]{1,62}$/.test(name)) fail("Use lowercase letters, digits and dashes.");

step(3, "Database");
const listed = JSON.parse(wrangler(["d1", "list", "--json"]) || "[]");
let databaseId = listed.find((db) => db.name === name)?.uuid;
/** An existing database may already have a passkey (this run is an update); a new one can't. */
const existed = !!databaseId;
if (databaseId) {
  // Reuse it only if it's empty or already Herald's, never someone else's database that shares the name.
  const tables = query(name, "SELECT name FROM sqlite_master WHERE type = 'table'");
  if (tables === null) fail(`Couldn't look inside your database "${name}". Check your Cloudflare sign-in and run setup again.`);
  const names = tables.map((t) => t.name);
  if (names.some((t) => !t.startsWith("_cf") && !t.startsWith("sqlite_") && t !== "d1_migrations") && !names.includes("notifications")) {
    fail(`Your account already has a database called "${name}" that isn't Herald's. Run setup again and pick another name.`);
  }
  say(`   Using your existing database "${name}".`);
} else {
  const created = wrangler(["d1", "create", name]);
  databaseId = (/"database_id":\s*"([0-9a-f-]{36})"/.exec(created) ?? /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(created) ?? [])[1];
  if (!databaseId && !DRY) fail(`Couldn't read the new database's id from wrangler:\n${created}`);
  say(DRY ? `   Would create a new database "${name}".` : `   Created database "${name}".`);
}
config = config
  .replace(/("name":\s*")[^"]+(")/, `$1${name}$2`)
  .replace(/("database_name":\s*")[^"]+(")/, `$1${name}$2`)
  .replace(/("database_id":\s*")[^"]+(")/, `$1${databaseId ?? "00000000-0000-0000-0000-000000000000"}$2`);
if (!DRY) writeFileSync(CONFIG, config);

step(4, "Schema");
wrangler(["d1", "migrations", "apply", name, "--remote"], { inherit: true });

// Already set up (this is an update): a passkey exists, so a setup code would do nothing. Checked before
// deploying, and a check that can't be read counts as not set up, so it can never stop a deploy halfway.
const signedUp = existed && (query(name, "SELECT COUNT(*) AS n FROM passkeys")?.[0]?.n ?? 0) > 0;
const address = () => url || "your Worker's URL (wrangler printed it above)";

step(5, "Deploy");
let url = "";
if (DRY) {
  say("   would run: npm run deploy");
} else {
  const deployed = spawnSync("npm", ["run", "deploy"], { encoding: "utf8", env: { ...process.env, CI: "1" } });
  process.stdout.write(deployed.stdout);
  if (deployed.status !== 0) fail(`Deploy failed:\n${deployed.stderr}`);
  url = (/https:\/\/[^\s]+\.workers\.dev/.exec(deployed.stdout) ?? [])[0] ?? "";
}

if (signedUp) {
  // An old code can never come back to life: it's removed once there's a passkey.
  if (!DRY) {
    try {
      execFileSync("npx", ["wrangler", "secret", "delete", "SETUP_CODE", "--name", name], { input: "y\n", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    } catch {
      // Already gone.
    }
  }
  rl.close();
  if (DRY) {
    say("\n\x1b[1mDry run done.\x1b[0m You're already set up, so a real run would update Herald and skip the setup code.");
  } else {
    say(`\n\x1b[1mDone. Herald is updated.\x1b[0m`);
    say(`   You're already set up, so there's no setup code to enter. Open ${address()} and sign in with your passkey.`);
    say('   Anything left to do is under "Finish setting up" on Home.');
  }
  process.exit(0);
}

step(6, "Setup code");
const code = DRY ? "(a new code)" : setupCode();
wrangler(["secret", "put", "SETUP_CODE", "--name", name], { input: `${code}\n` });
if (!DRY) say("   Set. It only works until your first passkey exists.");

rl.close();
say(`\n\x1b[1mDone.\x1b[0m`);
say(`   1. On your phone, open ${address()}`);
say(`   2. Enter the setup code: ${code}`);
say("   3. Save a passkey. Herald then walks you through the rest: your Home Screen, notifications,");
say("      connecting Grok Bot, your inboxes and your categories.");
say("   Keep the setup code private until you've saved your passkey.");
