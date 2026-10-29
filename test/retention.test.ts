import { describe, expect, it } from "vitest";
import { prune } from "../src/worker/outbox";
import { apiKey, call, env, sessionCookie } from "./helpers";

const owner = async () => ({ cookie: await sessionCookie(), origin: "https://herald.test" });
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function post(body: string) {
  const res = await call("/api/notifications", {
    method: "POST",
    headers: { authorization: `Bearer ${await apiKey()}` },
    json: { sourceId: "inbox", sender: "Email Triage", body },
  });
  return ((await res.json()) as { id: string }).id;
}

async function exists(id: string) {
  return !!(await env.DB.prepare("SELECT 1 FROM notifications WHERE id = ?").bind(id).first());
}

describe("retention", () => {
  it("deletes cards finished more than 30 days ago, with their log, but never cards still in the inbox", async () => {
    const headers = await owner();
    const old = await post("old and dismissed");
    const recent = await post("dismissed last week");
    const open = await post("old but still in the inbox");
    await call(`/api/notifications/${old}/dismiss`, { method: "POST", headers });
    await call(`/api/notifications/${recent}/dismiss`, { method: "POST", headers });
    await env.DB.batch([
      env.DB.prepare("UPDATE notifications SET dismissed_at = ? WHERE id = ?").bind(daysAgo(31), old),
      env.DB.prepare("UPDATE notifications SET dismissed_at = ? WHERE id = ?").bind(daysAgo(7), recent),
      env.DB.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").bind(daysAgo(200), open),
      env.DB.prepare("UPDATE events SET created_at = ? WHERE notification_id IN (?, ?)").bind(daysAgo(31), old, open),
    ]);

    await prune(env);
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(open)).toBe(true);
    const log = await env.DB.prepare("SELECT notification_id FROM events WHERE notification_id IN (?, ?)").bind(old, open).all();
    expect(log.results.map((r) => r.notification_id)).not.toContain(old);
    expect(log.results.map((r) => r.notification_id)).toContain(open);
  });

  it("keeps an old Chat message while the bot's reply to it is still around", async () => {
    const headers = await owner();
    await call("/api/bots/chief-of-staff", { method: "PATCH", headers: { authorization: `Bearer ${await apiKey()}` }, json: { sender: "Chief Of Staff" } });
    const sent = await call("/api/requests", { method: "POST", headers, json: { to: "chief-of-staff", text: "What's on Friday?" } });
    const request = (await sent.json()) as { id: string };
    const reply = await call("/api/notifications", {
      method: "POST",
      headers: { authorization: `Bearer ${await apiKey()}` },
      json: { sourceId: "chief-of-staff", sender: "Chief Of Staff", body: "Dentist at 3", requestId: request.id },
    });
    expect(reply.status).toBe(201);
    await env.DB.prepare("UPDATE requests SET created_at = ? WHERE id = ?").bind(daysAgo(40), request.id).run();
    await prune(env);
    expect(await env.DB.prepare("SELECT 1 FROM requests WHERE id = ?").bind(request.id).first()).not.toBeNull();
  });

  it("keeps everything when the owner says so, and only takes the offered choices", async () => {
    const headers = await owner();
    expect(await (await call("/api/prefs/retention", { headers })).json()).toEqual({ days: 30 });
    expect((await call("/api/prefs/retention", { method: "PUT", headers, json: { days: 12 } })).status).toBe(400);
    await call("/api/prefs/retention", { method: "PUT", headers, json: { days: null } });
    const id = await post("kept forever");
    await call(`/api/notifications/${id}/dismiss`, { method: "POST", headers });
    await env.DB.prepare("UPDATE notifications SET dismissed_at = ? WHERE id = ?").bind(daysAgo(400), id).run();
    await prune(env);
    expect(await exists(id)).toBe(true);
  });
});
