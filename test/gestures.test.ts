import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Notification } from "../src/shared/types";
import { wakeSnoozed } from "../src/worker/notifications";
import { apiKey, call, env, outboxRows, sessionCookie } from "./helpers";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
});
afterEach(() => vi.restoreAllMocks());

const bot = async () => ({ authorization: `Bearer ${await apiKey()}` });
const owner = async () => ({ cookie: await sessionCookie(), origin: "https://herald.test" });

const ref = { provider: "gmail", account: "me@example.test", threadId: "t-1", messageId: "m-1" };

async function post(json: Record<string, unknown> = {}) {
  const res = await call("/api/notifications", {
    method: "POST",
    headers: await bot(),
    json: {
      sourceId: "inbox",
      sender: "Email Triage",
      body: "Weekly digest",
      category: "newsletters",
      subject: { type: "email", from: "News Co", subject: "This week", ref },
      ...json,
    },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Notification;
}

async function webhook(id: string, event: string) {
  const rows = (await outboxRows()).results.filter((r) => r.notification_id === id && r.event === event);
  return rows.map((r) => JSON.parse(r.body) as Record<string, unknown> & { notification: Notification });
}

describe("dismissing with a disposition", () => {
  it("carries the source reference and asks Grok Bot to archive, then to undo it", async () => {
    const n = await post();
    expect(n.subject).toMatchObject({ ref });
    const headers = await owner();
    const dismissed = await call(`/api/notifications/${n.id}/dismiss`, { method: "POST", headers, json: { disposition: "archive" } });
    expect(await dismissed.json()).toMatchObject({ status: "dismissed", disposition: "archive" });
    const [sent] = await webhook(n.id, "notification.dismissed");
    expect(sent).toMatchObject({ disposition: "archive", notification: { disposition: "archive", subject: { ref } } });

    const restored = await call(`/api/notifications/${n.id}/restore`, { method: "POST", headers });
    expect(await restored.json()).toMatchObject({ status: "new", disposition: null });
    const [undo] = await webhook(n.id, "notification.restored");
    expect(undo).toMatchObject({ undo: { disposition: "archive" } });
  });

  it("dismisses without a disposition as before, with or without a body", async () => {
    const a = await post();
    const b = await post();
    const headers = await owner();
    expect(await (await call(`/api/notifications/${a.id}/dismiss`, { method: "POST", headers })).json()).toMatchObject({ disposition: null });
    expect(await (await call(`/api/notifications/${b.id}/dismiss`, { method: "POST", headers, json: {} })).json()).toMatchObject({ disposition: null });
    const [undo] = await (async () => {
      await call(`/api/notifications/${a.id}/restore`, { method: "POST", headers });
      return webhook(a.id, "notification.restored");
    })();
    expect(undo).toMatchObject({ undo: null });
  });

  it("archives a whole stack at once", async () => {
    const a = await post();
    const b = await post();
    await call("/api/notifications/dismiss", { method: "POST", headers: await owner(), json: { ids: [a.id, b.id], disposition: "trash" } });
    for (const id of [a.id, b.id]) expect((await webhook(id, "notification.dismissed"))[0]).toMatchObject({ disposition: "trash" });
  });

  it("refuses an unknown disposition", async () => {
    const n = await post();
    const res = await call(`/api/notifications/${n.id}/dismiss`, { method: "POST", headers: await owner(), json: { disposition: "shred" } });
    expect(res.status).toBe(400);
  });
});

describe("snoozing", () => {
  const later = () => new Date(Date.now() + 3_600_000).toISOString();

  it("hides it until then and tells Grok Bot, then brings it back as new", async () => {
    const n = await post();
    const until = later();
    const res = await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers: await owner(), json: { until } });
    expect(await res.json()).toMatchObject({ snoozedUntil: until, status: "read" });
    expect((await webhook(n.id, "notification.snoozed"))[0]).toMatchObject({ until });

    await env.DB.prepare("UPDATE notifications SET snoozed_until = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), n.id).run();
    const woken = await wakeSnoozed(env);
    expect(woken.map((w) => w.row.id)).toContain(n.id);
    const back = (await (await call(`/api/notifications/${n.id}`, { headers: await bot() })).json()) as Notification;
    expect(back).toMatchObject({ snoozedUntil: null, status: "new" });
  });

  it("wakes now with until null, and refuses a time in the past or a dismissed card", async () => {
    const headers = await owner();
    const n = await post();
    await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: later() } });
    expect(await (await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: null } })).json()).toMatchObject({
      snoozedUntil: null,
      status: "new",
    });
    const past = await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: "2020-01-01T00:00:00Z" } });
    expect(past.status).toBe(400);
    await call(`/api/notifications/${n.id}/dismiss`, { method: "POST", headers });
    expect((await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: later() } })).status).toBe(409);
  });
});

describe("long swipe per category", () => {
  it("archives by default, trashes newsletters, and can be changed by the owner", async () => {
    const list = (await (await call("/api/categories", { headers: await bot() })).json()) as { items: Category[] };
    expect(list.items.find((c) => c.id === "work")?.swipeAction).toBe("archive");
    expect(list.items.find((c) => c.id === "newsletters")?.swipeAction).toBe("trash");
    const res = await call("/api/categories/work", { method: "PATCH", headers: await owner(), json: { swipeAction: "read" } });
    expect(((await res.json()) as Category).swipeAction).toBe("read");
  });
});

describe("review fixes", () => {
  it("only asks to archive emails it can find, even when a whole stack is swiped", async () => {
    const email = await post();
    const bill = await post({ subject: { type: "payment", payee: "Duke Energy" } });
    await call("/api/notifications/dismiss", { method: "POST", headers: await owner(), json: { ids: [email.id, bill.id], disposition: "archive" } });
    expect((await webhook(email.id, "notification.dismissed"))[0]).toMatchObject({ disposition: "archive" });
    expect((await webhook(bill.id, "notification.dismissed"))[0]).toMatchObject({ disposition: null });
  });

  it("clears an old outcome when archiving, and the archive's outcome when it's undone", async () => {
    const n = await post({ outcome: "Draft sent 3:42 PM" });
    const headers = await owner();
    const dismissed = await call(`/api/notifications/${n.id}/dismiss`, { method: "POST", headers, json: { disposition: "archive" } });
    expect(await dismissed.json()).toMatchObject({ outcome: null });
    await call(`/api/notifications/${n.id}`, { method: "PATCH", headers: await bot(), json: { outcome: "Archived in Gmail" } });
    const restored = await call(`/api/notifications/${n.id}/restore`, { method: "POST", headers });
    expect(await restored.json()).toMatchObject({ outcome: null, disposition: null });
  });

  it("puts a card back as it was when a snooze is undone", async () => {
    const n = await post();
    const headers = await owner();
    await call(`/api/notifications/${n.id}/read`, { method: "POST", headers });
    await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: new Date(Date.now() + 3_600_000).toISOString() } });
    const undone = await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: null } });
    expect(await undone.json()).toMatchObject({ status: "read", snoozedUntil: null });
  });

  it("never wakes a card that was handled while snoozed", async () => {
    const n = await post({ lane: "needs_you", responsePrompt: { type: "yes_no" } });
    const headers = await owner();
    await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: new Date(Date.now() + 3_600_000).toISOString() } });
    const answered = await call(`/api/notifications/${n.id}/respond`, { method: "POST", headers, json: { text: "yes" } });
    expect(await answered.json()).toMatchObject({ status: "responded", snoozedUntil: null });
    expect((await wakeSnoozed(env)).map((w) => w.row.id)).not.toContain(n.id);
  });

  it("wakes only urgent cards during quiet hours", async () => {
    const calm = await post();
    const urgent = await post({ urgent: true });
    const headers = await owner();
    for (const n of [calm, urgent]) {
      await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: new Date(Date.now() + 3_600_000).toISOString() } });
      await env.DB.prepare("UPDATE notifications SET snoozed_until = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), n.id).run();
    }
    const woken = (await wakeSnoozed(env, { urgentOnly: true })).map((w) => w.row.id);
    expect(woken).toContain(urgent.id);
    expect(woken).not.toContain(calm.id);
  });

  it("refuses a disposition on read or restore, but still ignores other extra keys there", async () => {
    const n = await post();
    const headers = await owner();
    const res = await call("/api/notifications/restore", { method: "POST", headers, json: { ids: [n.id], disposition: "trash" } });
    expect(res.status).toBe(400);
    expect((await call("/api/notifications/read", { method: "POST", headers, json: { ids: [n.id], source: "x" } })).status).toBe(200);
  });

  it("refuses to snooze a card that's already answered", async () => {
    const n = await post({ lane: "needs_you", responsePrompt: { type: "yes_no" } });
    const headers = await owner();
    await call(`/api/notifications/${n.id}/respond`, { method: "POST", headers, json: { text: "yes" } });
    const res = await call(`/api/notifications/${n.id}/snooze`, { method: "POST", headers, json: { until: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(res.status).toBe(409);
  });
});

describe("Grok Bot link", () => {
  it("saves a web or app link for the owner only, and refuses script links", async () => {
    const headers = await owner();
    expect(await (await call("/api/prefs/grok-link", { headers })).json()).toEqual({ url: null });
    const saved = await call("/api/prefs/grok-link", { method: "PUT", headers, json: { url: "grokbot://chat/chief-of-staff" } });
    expect(await saved.json()).toEqual({ url: "grokbot://chat/chief-of-staff" });
    expect(await (await call("/api/prefs/grok-link", { headers })).json()).toEqual({ url: "grokbot://chat/chief-of-staff" });
    expect((await call("/api/prefs/grok-link", { method: "PUT", headers, json: { url: "javascript:alert(1)" } })).status).toBe(400);
    expect((await call("/api/prefs/grok-link", { headers: await bot() })).status).toBe(403);
    await call("/api/prefs/grok-link", { method: "PUT", headers, json: { url: null } });
    expect(await (await call("/api/prefs/grok-link", { headers })).json()).toEqual({ url: null });
  });
});
