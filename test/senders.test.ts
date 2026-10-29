import { describe, expect, it } from "vitest";
import { prune } from "../src/worker/outbox";
import { nowIso } from "../src/worker/util";
import { apiKey, call, env, ORIGIN, sessionCookie } from "./helpers";

async function post(key: string, fields: Record<string, unknown>) {
  const res = await call("/api/notifications", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    json: { source: "bot", body: "hi", ...fields },
  });
  return (await res.json()) as { id: string; sender: string };
}

async function get(key: string, id: string) {
  return (await (await call(`/api/notifications/${id}`, { headers: { authorization: `Bearer ${key}` } })).json()) as {
    sender: string;
    avatarUrl: string | null;
  };
}

describe("bot names", () => {
  it("a newer post renames the bot on every notification", async () => {
    const key = await apiKey();
    const sourceId = `scout-${crypto.randomUUID()}`;
    const first = await post(key, { sourceId, sender: "Scout", avatarUrl: "https://example.com/a.png" });
    await post(key, { sourceId, sender: "Ranger" });

    expect(await get(key, first.id)).toMatchObject({ sender: "Ranger", avatarUrl: "https://example.com/a.png" });
    const list = (await (await call(`/api/notifications?sourceId=${sourceId}`, { headers: { authorization: `Bearer ${key}` } })).json()) as {
      items: { sender: string }[];
    };
    expect(list.items.map((n) => n.sender)).toEqual(["Ranger", "Ranger"]);
    const bots = (await (await call("/api/bots", { headers: { authorization: `Bearer ${key}` } })).json()) as {
      items: { sourceId: string; sender: string }[];
    };
    expect(bots.items.find((b) => b.sourceId === sourceId)?.sender).toBe("Ranger");

    // Search finds old cards by the new name.
    const found = (await (await call(`/api/notifications?q=Ranger&sourceId=${sourceId}`, { headers: { authorization: `Bearer ${key}` } })).json()) as {
      items: unknown[];
    };
    expect(found.items).toHaveLength(2);
  });

  it("an import of older items doesn't undo a rename", async () => {
    const key = await apiKey();
    const sourceId = `atlas-${crypto.randomUUID()}`;
    const recent = await post(key, { sourceId, sender: "Atlas" });
    await post(key, { sourceId, sender: "Old Atlas", createdAt: "2026-01-01T00:00:00.000Z" });
    expect((await get(key, recent.id)).sender).toBe("Atlas");
  });

  it("renames on request, until the bot posts under another name", async () => {
    const key = await apiKey();
    const sourceId = `muse-${crypto.randomUUID()}`;
    const note = await post(key, { sourceId, sender: "Muse" });

    const res = await call(`/api/bots/${sourceId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${key}` },
      json: { sender: "Calliope" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sourceId, sender: "Calliope" });
    expect((await get(key, note.id)).sender).toBe("Calliope");

    await post(key, { sourceId, sender: "Muse 2" });
    expect((await get(key, note.id)).sender).toBe("Muse 2");

    const missing = await call("/api/bots/nobody", { method: "PATCH", headers: { authorization: `Bearer ${key}` }, json: { role: "X" } });
    expect(missing.status).toBe(404);
  });
});

describe("passkeys and sessions", () => {
  it("won't remove the last passkey", async () => {
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    await env.DB.prepare("DELETE FROM passkeys").run();
    await env.DB.prepare("INSERT INTO passkeys (id, public_key, created_at) VALUES ('pk1', 'x', ?), ('pk2', 'y', ?)")
      .bind(nowIso(), nowIso())
      .run();

    const renamed = await call("/api/passkeys/pk1", { method: "PATCH", headers: owner, json: { name: "iPhone" } });
    expect(renamed.status).toBe(200);
    expect((await call("/api/passkeys/pk1", { method: "DELETE", headers: owner })).status).toBe(200);
    expect((await call("/api/passkeys/pk2", { method: "DELETE", headers: owner })).status).toBe(409);
    expect((await call("/api/passkeys/nope", { method: "DELETE", headers: owner })).status).toBe(404);

    const list = (await (await call("/api/passkeys", { headers: owner })).json()) as { items: { id: string }[] };
    expect(list.items.map((p) => p.id)).toEqual(["pk2"]);
  });

  it("is session only", async () => {
    const key = await apiKey();
    expect((await call("/api/passkeys", { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
  });

  it("signs out other devices but not this one", async () => {
    const other = await sessionCookie();
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    const res = await call("/api/sessions/revoke-others", { method: "POST", headers: owner });
    expect(((await res.json()) as { revoked: number }).revoked).toBeGreaterThanOrEqual(1);
    expect((await call("/api/bots", { headers: { cookie: other } })).status).toBe(401);
    expect((await call("/api/bots", { headers: owner })).status).toBe(200);
  });
});

describe("housekeeping", () => {
  it("drops old deliveries and expired sessions but keeps requests", async () => {
    // Retention is tested on its own; with it off, this is the rest of the daily tidy-up.
    await env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('retention_days', 'null') ON CONFLICT (key) DO UPDATE SET value = 'null'").run();
    const old = "2026-01-01T00:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO webhook_outbox (id, event_id, body, status, next_attempt_at, created_at, delivered_at) VALUES
       ('o-old', 'e-old', '{"event":"notification.read"}', 'delivered', ?, ?, ?),
       ('o-req', 'e-req', '{"id":"e-req","event":"request.created"}', 'delivered', ?, ?, ?),
       ('o-new', 'e-new', '{"event":"notification.read"}', 'delivered', ?, ?, ?)`,
    )
      .bind(old, old, old, old, old, old, nowIso(), nowIso(), nowIso())
      .run();
    await env.DB.prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES ('gone', ?, ?)").bind(old, old).run();

    await prune(env);

    const { results } = await env.DB.prepare("SELECT id FROM webhook_outbox WHERE id LIKE 'o-%' ORDER BY id").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["o-new", "o-req"]);
    expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE id_hash = 'gone'").first()).toBeNull();
  });
});
