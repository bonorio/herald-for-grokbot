import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Notification } from "../src/shared/types";
import { apiKey, call, env, outboxRows, sessionCookie } from "./helpers";

const DEFAULTS = [
  ["people", "People", "#0a84ff", "person"],
  ["work", "Work", "#5e5ce6", "briefcase"],
  ["money", "Money", "#34c759", "card"],
  ["calendar", "Calendar", "#ff9f0a", "calendar"],
  ["family", "Family", "#ff6482", "heart"],
  ["home", "Home", "#ac8e68", "house"],
  ["travel", "Travel", "#64d2ff", "plane"],
  ["shopping", "Shopping", "#ffd60a", "bag"],
  ["newsletters", "Newsletters", "#8e8e93", "news"],
];

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  // Each test starts from the migration's list and an empty inbox.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM webhook_outbox"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM category_aliases"),
    env.DB.prepare("DELETE FROM categories"),
    ...DEFAULTS.map(([id, name, color, icon], i) =>
      env.DB.prepare("INSERT INTO categories (id, name, color, icon, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
        id,
        name,
        color,
        icon,
        i + 1,
        new Date().toISOString(),
      ),
    ),
  ]);
});
afterEach(() => vi.restoreAllMocks());

const bot = async () => ({ authorization: `Bearer ${await apiKey()}` });
const owner = async () => ({ cookie: await sessionCookie(), origin: "https://herald.test" });

async function post(json: Record<string, unknown>) {
  const res = await call("/api/notifications", {
    method: "POST",
    headers: await bot(),
    json: { sourceId: "inbox", sender: "Email Triage", body: "Something came in", ...json },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Notification;
}

async function categories(): Promise<Category[]> {
  const res = await call("/api/categories", { headers: await bot() });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Category[] }).items;
}

async function edit(path: string, method: string, json?: unknown) {
  return call(`/api/categories${path}`, { method, headers: await owner(), json });
}

describe("categories", () => {
  it("starts with the default list, which bots can read", async () => {
    const list = await categories();
    expect(list.map((c) => c.id)).toEqual(["people", "work", "money", "calendar", "family", "home", "travel", "shopping", "newsletters"]);
    expect(list.every((c) => c.state === "active")).toBe(true);
  });

  it("resolves a category by id, name or alias", async () => {
    expect((await post({ category: "money" })).category).toBe("money");
    expect((await post({ category: "  MONEY " })).category).toBe("money");
    expect((await post({ category: null })).category).toBeNull();
  });

  it("files payments under Money and events under Calendar when no category is given", async () => {
    expect((await post({ subject: { type: "payment", payee: "Duke Energy", amount: "$84" } })).category).toBe("money");
    expect((await post({ subject: { type: "event", name: "Dentist" } })).category).toBe("calendar");
    expect((await post({ subject: { type: "event", name: "Dentist" }, category: "work" })).category).toBe("work");
  });

  it("turns an unknown name into one suggestion, however it's spelled", async () => {
    const a = await post({ category: "Kids' sports" });
    const b = await post({ category: "kids sports" });
    expect(a.category).toBe("kids-sports");
    expect(b.category).toBe("kids-sports");
    const suggestion = (await categories()).find((c) => c.id === "kids-sports");
    expect(suggestion).toMatchObject({ name: "Kids' sports", state: "suggested", count: 2 });
  });

  it("reads a legacy topic as a category", async () => {
    expect((await post({ topic: "Work" })).category).toBe("work");
    expect((await post({ topic: "HOA" })).category).toBe("hoa");
  });

  it("only the signed-in owner edits the list", async () => {
    const res = await call("/api/categories/work", { method: "PATCH", headers: await bot(), json: { name: "Job" } });
    expect(res.status).toBe(403);
  });

  it("keeps an old name as an alias after a rename", async () => {
    const res = await edit("/work", "PATCH", { name: "Job" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "work", name: "Job", aliases: ["work"] });
    expect((await post({ category: "Work" })).category).toBe("work");
    expect((await post({ category: "job" })).category).toBe("work");
  });

  it("refuses a duplicate name", async () => {
    expect((await edit("", "POST", { name: "money" })).status).toBe(409);
    expect((await edit("/work", "PATCH", { name: "Travel" })).status).toBe(409);
  });

  it("accepts a suggestion and puts it at the end of the list", async () => {
    await post({ category: "HOA" });
    const res = await edit("/hoa", "PATCH", { state: "active", icon: "house" });
    expect(await res.json()).toMatchObject({ id: "hoa", state: "active", icon: "house", position: 10 });
  });

  it("merges one category into another, moving its cards and its names", async () => {
    const card = await post({ category: "Maple Grove HOA" });
    expect(card.category).toBe("maple-grove-hoa");
    expect((await edit("/maple-grove-hoa/merge", "POST", { into: "home" })).status).toBe(200);
    const moved = (await (await call(`/api/notifications/${card.id}`, { headers: await bot() })).json()) as Notification;
    expect(moved.category).toBe("home");
    expect((await post({ category: "Maple Grove HOA" })).category).toBe("home");
    const list = await categories();
    expect(list.find((c) => c.id === "maple-grove-hoa")).toBeUndefined();
    expect(list.find((c) => c.id === "home")?.aliases).toEqual(["maple grove hoa", "maple-grove-hoa"]);
  });

  it("removes a category without suggesting it again", async () => {
    const card = await post({ category: "Promos" });
    expect((await edit("/promos", "DELETE")).status).toBe(200);
    const after = (await (await call(`/api/notifications/${card.id}`, { headers: await bot() })).json()) as Notification;
    expect(after.category).toBeNull();
    expect((await post({ category: "promos" })).category).toBeNull();
    expect((await categories()).find((c) => c.id === "promos")).toBeUndefined();
  });

  it("frees a removed name when the owner creates it again", async () => {
    await post({ category: "Promos" });
    await edit("/promos", "DELETE");
    expect((await edit("", "POST", { name: "Promos", color: "#FF0000" })).status).toBe(201);
    expect((await post({ category: "promos" })).category).toBe("promos");
  });

  it("reorders without leaving gaps", async () => {
    await edit("/newsletters", "PATCH", { position: 1 });
    expect((await categories()).slice(0, 3).map((c) => [c.id, c.position])).toEqual([
      ["newsletters", 1],
      ["people", 2],
      ["work", 3],
    ]);
    await edit("/newsletters", "PATCH", { position: 99 });
    const list = await categories();
    expect(list.map((c) => c.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(list.at(-1)?.id).toBe("newsletters");
  });

  it("tells Grok Bot when the owner changes the list", async () => {
    await edit("/work", "PATCH", { color: "#112233" });
    const rows = (await outboxRows()).results.filter((r) => r.event === "categories.updated");
    expect(rows).toHaveLength(1);
    const body = JSON.parse(rows[0]?.body as string) as { categories: Category[] };
    expect(body.categories.find((c) => c.id === "work")).toMatchObject({ color: "#112233" });
  });

  it("prefers a current name over an old id", async () => {
    await edit("/people", "PATCH", { name: "Friends" });
    await edit("/work", "PATCH", { name: "People" });
    expect((await post({ category: "People" })).category).toBe("work");
    expect((await post({ category: "Friends" })).category).toBe("people");
    await edit("/work", "PATCH", { name: "Job" });
    const res = await edit("", "POST", { name: "People" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "people-2", name: "People" });
    expect((await post({ category: "people" })).category).toBe("people-2");
  });

  it("adds a suggestion only with a card that uses it", async () => {
    const headers = await bot();
    const missing = await call("/api/notifications/nope", { method: "PATCH", headers, json: { category: "Typo" } });
    expect(missing.status).toBe(404);
    const first = await post({ category: "Real", idempotencyKey: "same" });
    const again = await call("/api/notifications", {
      method: "POST",
      headers,
      json: { sourceId: "inbox", sender: "Email Triage", body: "x", category: "Other typo", idempotencyKey: "same" },
    });
    expect(((await again.json()) as Notification).id).toBe(first.id);
    const ids = (await categories()).map((c) => c.id);
    expect(ids).toContain("real");
    expect(ids).not.toContain("typo");
    expect(ids).not.toContain("other-typo");
  });

  it("tells Grok Bot about a suggestion a service adds, but not one it added itself", async () => {
    await post({ category: "From Grok" });
    const service = { authorization: `Bearer ${await apiKey("service:mailer")}` };
    await call("/api/notifications", { method: "POST", headers: service, json: { sourceId: "mailer", sender: "Mailer", body: "x", category: "From mailer" } });
    const sent = (await outboxRows()).results.filter((r) => r.event === "categories.updated");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.actor).toBe("service:mailer");
  });

  it("filters the list by category, with none for uncategorized", async () => {
    await post({ category: "money", body: "a bill" });
    await post({ body: "loose" });
    const headers = await bot();
    const money = (await (await call("/api/notifications?category=money", { headers })).json()) as { items: Notification[] };
    expect(money.items.map((n) => n.body)).toEqual(["a bill"]);
    const none = (await (await call("/api/notifications?category=none", { headers })).json()) as { items: Notification[] };
    expect(none.items.map((n) => n.body)).toEqual(["loose"]);
  });
});

describe("lanes", () => {
  it("defaults to FYI, and to Needs you for actions or a legacy flag", async () => {
    expect(await post({})).toMatchObject({ lane: "fyi", urgent: false, flag: "none", task: null });
    expect(await post({ title: "Pick one", actions: [{ id: "ok", label: "OK", type: "confirm" }] })).toMatchObject({
      lane: "needs_you",
      flag: "awaiting",
      task: "Pick one",
    });
    expect(await post({ flag: "urgent" })).toMatchObject({ lane: "needs_you", urgent: true, flag: "urgent" });
    expect(await post({ lane: "handled", outcome: "Archived 23 promos" })).toMatchObject({ lane: "handled", flag: "none" });
  });

  it("needs the owner for a question or a to-do, even without a flag", async () => {
    expect((await post({ responsePrompt: { type: "yes_no" } })).lane).toBe("needs_you");
    expect((await post({ task: "Sign the form" })).lane).toBe("needs_you");
  });

  it("keeps the Tasks tab in step when a patch moves the lane", async () => {
    const n = await post({ title: "Book the dentist" });
    const headers = await bot();
    const up = await call(`/api/notifications/${n.id}`, { method: "PATCH", headers, json: { lane: "needs_you" } });
    expect(await up.json()).toMatchObject({ lane: "needs_you", task: "Book the dentist" });
    const down = await call(`/api/notifications/${n.id}`, { method: "PATCH", headers, json: { lane: "handled" } });
    expect(await down.json()).toMatchObject({ lane: "handled", task: null });
  });

  it("can be urgent without needing the owner", async () => {
    expect(await post({ lane: "fyi", urgent: true })).toMatchObject({ lane: "fyi", urgent: true, flag: "urgent" });
  });

  it("stays in Needs you once answered, with the legacy flag cleared", async () => {
    const n = await post({ lane: "needs_you", responsePrompt: { type: "yes_no" } });
    const res = await call(`/api/notifications/${n.id}/respond`, { method: "POST", headers: await owner(), json: { text: "yes" } });
    expect(await res.json()).toMatchObject({ lane: "needs_you", status: "responded", flag: "none" });
  });

  it("maps a legacy flag patch onto the lane", async () => {
    const n = await post({});
    const headers = await bot();
    const patched = await call(`/api/notifications/${n.id}`, { method: "PATCH", headers, json: { flag: "awaiting" } });
    expect(await patched.json()).toMatchObject({ lane: "needs_you", flag: "awaiting" });
    const moved = await call(`/api/notifications/${n.id}`, { method: "PATCH", headers, json: { lane: "handled", category: "Travel" } });
    expect(await moved.json()).toMatchObject({ lane: "handled", flag: "none", category: "travel" });
  });

  it("filters by lane", async () => {
    await post({ lane: "handled", body: "done for you" });
    await post({ body: "fyi" });
    const res = await call("/api/notifications?lane=handled", { headers: await bot() });
    expect(((await res.json()) as { items: Notification[] }).items.map((n) => n.body)).toEqual(["done for you"]);
  });
});

describe("stack summaries", () => {
  it("lets a bot write and clear a line about a category's stack", async () => {
    const headers = await bot();
    const res = await call("/api/categories/home/summary", { method: "PUT", headers, json: { text: "3 HOA emails: the vote closes Friday" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Category).summary).toMatchObject({ text: "3 HOA emails: the vote closes Friday" });
    expect((await categories()).find((c) => c.id === "home")?.summary?.text).toBe("3 HOA emails: the vote closes Friday");
    const cleared = await call("/api/categories/home/summary", { method: "DELETE", headers });
    expect(((await cleared.json()) as Category).summary).toBeNull();
    expect((await call("/api/categories/nope/summary", { method: "PUT", headers, json: { text: "x" } })).status).toBe(404);
  });

  it("doesn't send the summary to Grok Bot with the list", async () => {
    await call("/api/categories/home/summary", { method: "PUT", headers: await bot(), json: { text: "x" } });
    await edit("/home", "PATCH", { color: "#123456" });
    const row = (await outboxRows()).results.find((r) => r.event === "categories.updated");
    expect(JSON.parse(row?.body as string).categories[0]).not.toHaveProperty("summary");
  });
});

describe("stack summaries go stale with their stack", () => {
  const summarize = async () =>
    call("/api/categories/home/summary", { method: "PUT", headers: await bot(), json: { text: "Two home things" } });
  const summary = async () => (await categories()).find((c) => c.id === "home")?.summary ?? null;

  it("clears when a card arrives, even one backdated before the summary", async () => {
    await post({ category: "home" });
    await summarize();
    await post({ category: "home", createdAt: "2020-01-01T00:00:00Z" });
    expect(await summary()).toBeNull();
  });

  it("clears when a card leaves, changes lane or moves category, but not when it's read", async () => {
    const n = await post({ category: "home" });
    await summarize();
    await call(`/api/notifications/${n.id}/read`, { method: "POST", headers: await owner() });
    expect(await summary()).not.toBeNull();
    await call(`/api/notifications/${n.id}/dismiss`, { method: "POST", headers: await owner() });
    expect(await summary()).toBeNull();

    await summarize();
    await call(`/api/notifications/${n.id}/restore`, { method: "POST", headers: await owner() });
    expect(await summary()).toBeNull();

    await summarize();
    await call(`/api/notifications/${n.id}`, { method: "PATCH", headers: await bot(), json: { lane: "needs_you" } });
    expect(await summary()).toBeNull();

    await summarize();
    await call(`/api/notifications/${n.id}`, { method: "PATCH", headers: await bot(), json: { category: "work" } });
    expect(await summary()).toBeNull();
  });

  it("clears when a card is deleted", async () => {
    const n = await post({ category: "home" });
    await summarize();
    await call(`/api/notifications/${n.id}`, { method: "DELETE", headers: await bot() });
    expect(await summary()).toBeNull();
  });
});

describe("handoffs", () => {
  const handoff = (url: string, state = "waiting") => ({
    blocks: [{ type: "handoff", app: "1Password", title: "Sign in to Acme Rewards", site: "rewards.example.com", url, state }],
  });

  it("needs the owner while a step elsewhere is waiting, and links there by app link", async () => {
    const n = await post({ title: "Acme Rewards sign-in", ...handoff("onepassword://approve/abc") });
    expect(n.lane).toBe("needs_you");
    expect(n.blocks[0]).toMatchObject({ type: "handoff", state: "waiting", url: "onepassword://approve/abc" });
    expect((await post(handoff("https://grok.example/chat/1", "done"))).lane).toBe("fyi");
  });

  it("finishes the card when the bot marks the handoff done, and asks for one added later", async () => {
    const headers = await bot();
    const n = await post({ title: "Acme Rewards sign-in", ...handoff("https://my.1password.com/") });
    const done = await call(`/api/notifications/${n.id}`, {
      method: "PATCH",
      headers,
      json: { ...handoff("https://my.1password.com/", "done"), outcome: "Signed in · monthly scan set up" },
    });
    expect(await done.json()).toMatchObject({ status: "responded", outcome: "Signed in · monthly scan set up", lane: "needs_you" });

    const later = await post({ title: "Deal scan" });
    const asked = await call(`/api/notifications/${later.id}`, { method: "PATCH", headers, json: handoff("https://my.1password.com/") });
    expect(await asked.json()).toMatchObject({ lane: "needs_you", task: "Deal scan", status: "new" });
  });

  it("refuses links that run script or read files", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"]) {
      const res = await call("/api/notifications", {
        method: "POST",
        headers: await bot(),
        json: { sourceId: "inbox", sender: "Email Triage", body: "x", ...handoff(url) },
      });
      expect(res.status).toBe(400);
    }
  });
});
