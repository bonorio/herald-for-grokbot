// Fills the local dev database with sample notifications from several bots.
// Run with the dev server up: bun scripts/seed-local.ts
import { $ } from "bun";

const base = process.env.HERALD_URL ?? "http://localhost:5173";
const hash = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex");
const now = new Date().toISOString();

const key = `hrd_dev_${crypto.randomUUID()}`;
await $`node scripts/wrangler.mjs d1 execute DB --local --command ${`
  INSERT INTO api_keys (id, name, actor, prefix, key_hash, created_at)
  VALUES ('${crypto.randomUUID()}', 'Dev seed', 'grok-bot', '${key.slice(0, 10)}', '${hash(key)}', '${now}');
`}`.quiet();

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const items = [
  { sourceId: "chief-of-staff", sender: "Chief Of Staff", title: "Morning brief ready", body: "3 meetings today, 2 decisions waiting on you, and the HOA vote closes Friday.", lane: "fyi", createdAt: ago(4) },
  { sourceId: "travel", sender: "Travel Agent", title: "Flight change for Denver", body: "United moved UA 1432 to 7:05 AM. Keep it or switch to the 11:40 AM nonstop?", lane: "needs_you", category: "travel", responsePrompt: { type: "options", options: ["Keep 7:05", "Switch to 11:40"] }, createdAt: ago(12) },
  { sourceId: "finance", sender: "Finance Bot", title: "Card charge flagged", body: "$1,240.00 at an electronics store in Ohio. Was this you?", lane: "needs_you", urgent: true, category: "money", responsePrompt: { type: "yes_no" }, createdAt: ago(25) },
  { sourceId: "research", sender: "Researcher", title: "Heat pump options", body: "Compared 4 cold-climate heat pumps for the basement. Mitsubishi Hyper-Heat leads on efficiency below 5°F.", fullText: "Compared 4 cold-climate heat pumps for the basement.\n\n1. Mitsubishi Hyper-Heat — best efficiency below 5°F\n2. Fujitsu XLTH — quietest\n3. Daikin Aurora — cheapest install\n4. Bosch IDS — best rebates\n\nFull sheet: https://example.com/heat-pumps", category: "home", createdAt: ago(48) },
  { sourceId: "inbox", sender: "Email Triage", title: "HOA vote closes Friday", body: "Ballot for the pool resurfacing. Board recommends yes.", category: "HOA", subject: { type: "email", from: "Maple Grove HOA", subject: "Pool resurfacing ballot" }, createdAt: ago(70) },
  { sourceId: "inbox", sender: "Email Triage", title: "HOA newsletter", body: "Fall cleanup is November 8; dumpsters by the clubhouse.", category: "HOA", subject: { type: "email", from: "Maple Grove HOA", subject: "November newsletter" }, createdAt: ago(60 * 27) },
  { sourceId: "inbox", sender: "Email Triage", title: "Your order shipped", body: "Two packages arrive Thursday.", category: "shopping", createdAt: ago(95) },
  { sourceId: "inbox", sender: "Email Triage", title: "Archived 23 promos", body: "Promotions from 14 senders went straight to the archive.", lane: "handled", category: "newsletters", createdAt: ago(100) },
  { sourceId: "home", sender: "Home Assistant", title: "Garage door open", body: "The garage door has been open for 30 minutes.", category: "home", urgent: true, createdAt: ago(130) },
  { sourceId: "inbox", sender: "Email Triage", body: "The contractor wants to start Monday. Reply with any constraints?", lane: "needs_you", category: "home", responsePrompt: { type: "text", placeholder: "Constraints for the contractor" }, createdAt: ago(60 * 27) },
  { source: "webhook", sourceId: "uptime", sender: "Uptime", body: "api.example.home is responding again after 3 minutes.", createdAt: ago(1) },
  { sourceId: "release", sender: "Release agent", body: "Deploy Herald 1.1 to production?", lane: "needs_you", category: "work", responsePrompt: { type: "approval" }, createdAt: ago(2) },
  { sourceId: "calendar", sender: "Calendar", body: "Dentist moved to Thursday 3:30 PM.", subject: { type: "event", name: "Dentist", startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }, createdAt: ago(60 * 50) },
];

const res = await fetch(`${base}/api/notifications/bulk`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ create: items }),
});
console.log("bulk", res.status, JSON.stringify(await res.json()).slice(0, 200));

// Chief Of Staff is the sample main agent, pinned first in Chat.
await $`node scripts/wrangler.mjs d1 execute DB --local --command ${"INSERT OR IGNORE INTO prefs (key, value) VALUES ('main_agent', '\"chief-of-staff\"')"}`.quiet();

console.log(`\nAPI key: ${key}`);
