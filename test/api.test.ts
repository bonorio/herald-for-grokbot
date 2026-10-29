import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverDue } from "../src/worker/outbox";
import { apiKey, call, env, ORIGIN, sessionCookie } from "./helpers";

let key: string;
let sent: { url: string; headers: Headers; body: Record<string, unknown> }[];

beforeEach(async () => {
  key = await apiKey();
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response("ok");
  });
});
afterEach(() => vi.restoreAllMocks());

const auth = () => ({ authorization: `Bearer ${key}` });
/** the owner at the dashboard. */
const owner = async () => ({ cookie: await sessionCookie(), origin: ORIGIN });

async function create(fields: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await call("/api/notifications", {
    method: "POST",
    headers: { ...auth(), ...headers },
    json: { sourceId: "researcher", sender: "Researcher", body: "Found 3 new papers", ...fields },
  });
  return { res, json: (await res.json()) as Record<string, any> };
}

/** Lets after-request delivery finish, then delivers anything still due. */
async function settle() {
  await new Promise((r) => setTimeout(r, 50));
  await deliverDue(env);
}

async function eventsFor(id: string) {
  const { results } = await env.DB.prepare(
    `SELECT e.event, e.actor, o.status AS delivery FROM events e
     LEFT JOIN webhook_outbox o ON o.event_id = e.id
     WHERE e.notification_id = ? ORDER BY e.created_at`,
  )
    .bind(id)
    .all<{ event: string; actor: string; delivery: string }>();
  return results;
}

describe("auth", () => {
  it("rejects missing and revoked keys", async () => {
    expect((await call("/api/notifications")).status).toBe(401);
    await env.DB.prepare("UPDATE api_keys SET revoked_at = ?").bind(new Date().toISOString()).run();
    expect((await call("/api/notifications", { headers: auth() })).status).toBe(401);
  });

  it("records owner as the actor for the signed-in dashboard", async () => {
    const { json } = await create();
    const cookie = await sessionCookie();
    const res = await call(`/api/notifications/${json.id}/dismiss`, { method: "POST", headers: { cookie, origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect((await eventsFor(json.id)).map((e) => e.actor)).toEqual(["grok-bot", "owner"]);
  });

  it("lets a service post with its own key", async () => {
    const serviceKey = await apiKey("service:uptime");
    const res = await call("/api/notifications", {
      method: "POST",
      headers: { authorization: `Bearer ${serviceKey}` },
      json: { sourceId: "uptime", sender: "Uptime", body: "Site is back up" },
    });
    const json = (await res.json()) as { id: string; source: string };
    expect(res.status).toBe(201);
    expect(json.source).toBe("webhook");
    expect((await eventsFor(json.id)).map((e) => e.actor)).toEqual(["service:uptime"]);
  });

  it("refuses cross-origin writes with a session cookie", async () => {
    const { json } = await create();
    const res = await call(`/api/notifications/${json.id}/dismiss`, {
      method: "POST",
      headers: { cookie: await sessionCookie(), origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("keeps key management to the dashboard session", async () => {
    expect((await call("/api/keys", { headers: auth() })).status).toBe(403);
    const cookie = await sessionCookie();
    const created = await call("/api/keys", {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
      json: { name: "Grok Bot", actor: "grok-bot" },
    });
    const issued = (await created.json()) as { id: string; key: string };
    expect(issued.key).toMatch(/^hrd_/);
    expect((await call("/api/notifications", { headers: { authorization: `Bearer ${issued.key}` } })).status).toBe(200);

    const rotated = (await (
      await call(`/api/keys/${issued.id}/rotate`, { method: "POST", headers: { cookie, origin: ORIGIN } })
    ).json()) as { key: string };
    expect((await call("/api/notifications", { headers: { authorization: `Bearer ${issued.key}` } })).status).toBe(401);
    expect((await call("/api/notifications", { headers: { authorization: `Bearer ${rotated.key}` } })).status).toBe(200);
  });
});

describe("CRUD", () => {
  it("creates, reads, updates and deletes", async () => {
    const { res, json } = await create({ kind: "question", flag: "awaiting", title: "Pick a venue" });
    expect(res.status).toBe(201);
    expect(json).toMatchObject({ source: "bot", sourceId: "researcher", status: "new", flag: "awaiting", changed: true });

    const got = await call(`/api/notifications/${json.id}`, { headers: auth() });
    expect(await got.json()).toMatchObject({ id: json.id, title: "Pick a venue" });

    const patched = await call(`/api/notifications/${json.id}`, { method: "PATCH", headers: auth(), json: { flag: "urgent" } });
    expect(await patched.json()).toMatchObject({ flag: "urgent", changed: true });

    const same = await call(`/api/notifications/${json.id}`, { method: "PATCH", headers: auth(), json: { flag: "urgent" } });
    expect(await same.json()).toMatchObject({ changed: false });

    expect((await call(`/api/notifications/${json.id}`, { method: "DELETE", headers: auth() })).status).toBe(200);
    expect((await call(`/api/notifications/${json.id}`, { headers: auth() })).status).toBe(404);

    await settle();
    expect((await eventsFor(json.id)).map((e) => e.event)).toEqual([
      "notification.created",
      "notification.updated",
      "notification.deleted",
    ]);
  });

  it("validates input", async () => {
    const { res, json } = await create({ kind: "nope", url: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(json.issues.map((i: { path: string[] }) => i.path[0]).sort()).toEqual(["kind", "url"]);
  });

  it("returns the existing notification for a repeated idempotency key", async () => {
    const first = await create({}, { "idempotency-key": "import-1" });
    const second = await create({}, { "idempotency-key": "import-1" });
    expect(second.res.status).toBe(200);
    expect(second.json).toMatchObject({ id: first.json.id, changed: false });
    expect(await eventsFor(first.json.id)).toHaveLength(1);
  });
});

describe("actions", () => {
  it("sends exactly one webhook for a dismiss, even when repeated", async () => {
    const { json } = await create();
    await settle();
    sent = [];
    const headers = await owner();
    const first = await call(`/api/notifications/${json.id}/dismiss`, { method: "POST", headers });
    const again = await call(`/api/notifications/${json.id}/dismiss`, { method: "POST", headers });
    expect(await first.json()).toMatchObject({ status: "dismissed", changed: true });
    expect(await again.json()).toMatchObject({ status: "dismissed", changed: false });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ event: "notification.dismissed", actor: "owner" });
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer grok-test-secret");
    expect(sent[0]!.headers.get("x-herald-event-id")).toBe(sent[0]!.body.id);
  });

  it("doesn't send Chief Of Staff's own changes back to Grok Bot", async () => {
    const { json } = await create();
    await call(`/api/notifications/${json.id}/read`, { method: "POST", headers: auth() });
    await call(`/api/notifications/${json.id}/dismiss`, { method: "POST", headers: await owner() });
    const serviceKey = await apiKey("service:uptime");
    const service = await call("/api/notifications", {
      method: "POST",
      headers: { authorization: `Bearer ${serviceKey}` },
      json: { sourceId: "uptime", sender: "Uptime", body: "Back up" },
    });
    await settle();
    // Every change is still in the audit log...
    expect((await eventsFor(json.id)).map((e) => [e.event, e.actor, e.delivery])).toEqual([
      ["notification.created", "grok-bot", null],
      ["notification.read", "grok-bot", null],
      ["notification.dismissed", "owner", "delivered"],
    ]);
    // ...but only the owner's and other services' changes reach Grok Bot.
    const serviceId = ((await service.json()) as { id: string }).id;
    expect(sent.map((s) => [s.body.event, s.body.actor])).toEqual(
      expect.arrayContaining([
        ["notification.dismissed", "owner"],
        ["notification.created", "service:uptime"],
      ]),
    );
    expect(sent.some((s) => s.body.actor === "grok-bot")).toBe(false);
    expect((await eventsFor(serviceId)).map((e) => e.delivery)).toEqual(["delivered"]);
  });

  it("records one dismissal when several arrive at once", async () => {
    const { json } = await create();
    const headers = await owner();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(`/api/notifications/${json.id}/dismiss`, { method: "POST", headers })),
    );
    const changed = await Promise.all(results.map(async (r) => ((await r.json()) as { changed: boolean }).changed));
    expect(changed.filter(Boolean)).toHaveLength(1);
    await settle();
    expect((await eventsFor(json.id)).map((e) => [e.event, e.delivery])).toEqual([
      ["notification.created", null],
      ["notification.dismissed", "delivered"],
    ]);
  });

  it("dismisses and restores many at once", async () => {
    const a = await create();
    const b = await create();
    await call(`/api/notifications/${b.json.id}/dismiss`, { method: "POST", headers: auth() });
    const headers = await owner();
    const res = await call("/api/notifications/dismiss", { method: "POST", headers, json: { ids: [a.json.id, b.json.id, "missing"] } });
    expect(await res.json()).toEqual({
      results: [
        { id: a.json.id, changed: true },
        { id: b.json.id, changed: false },
        { id: "missing", error: "Notification not found" },
      ],
    });
    const back = await call("/api/notifications/restore", { method: "POST", headers, json: { ids: [a.json.id, b.json.id] } });
    expect(((await back.json()) as { results: { changed: boolean }[] }).results.map((r) => r.changed)).toEqual([true, true]);
    await settle();
    expect((await eventsFor(a.json.id)).map((e) => [e.event, e.actor])).toEqual([
      ["notification.created", "grok-bot"],
      ["notification.dismissed", "owner"],
      ["notification.restored", "owner"],
    ]);
  });

  it("restores to the status before dismissal", async () => {
    const { json } = await create();
    await call(`/api/notifications/${json.id}/read`, { method: "POST", headers: auth() });
    await call(`/api/notifications/${json.id}/dismiss`, { method: "POST", headers: auth() });
    const restored = await call(`/api/notifications/${json.id}/restore`, { method: "POST", headers: auth() });
    expect(await restored.json()).toMatchObject({ status: "read", dismissedAt: null, changed: true });
    const again = await call(`/api/notifications/${json.id}/restore`, { method: "POST", headers: auth() });
    expect(await again.json()).toMatchObject({ changed: false });
  });

  it("only marks new notifications read", async () => {
    const { json } = await create();
    const read = await call(`/api/notifications/${json.id}/read`, { method: "POST", headers: auth() });
    expect(await read.json()).toMatchObject({ status: "read", changed: true });
    const again = await call(`/api/notifications/${json.id}/read`, { method: "POST", headers: auth() });
    expect(await again.json()).toMatchObject({ changed: false });
  });

  it("saves a response once and sends one webhook", async () => {
    const { json } = await create({
      kind: "question",
      flag: "awaiting",
      responsePrompt: { type: "options", options: ["Tuesday", "Thursday"] },
    });
    await settle();
    sent = [];
    const headers = await owner();
    const bad = await call(`/api/notifications/${json.id}/respond`, { method: "POST", headers, json: { text: "Friday" } });
    expect(bad.status).toBe(400);
    const ok = await call(`/api/notifications/${json.id}/respond`, { method: "POST", headers, json: { text: "thursday" } });
    expect(await ok.json()).toMatchObject({ status: "responded", flag: "none", responseText: "Thursday" });
    const same = await call(`/api/notifications/${json.id}/respond`, { method: "POST", headers, json: { text: "Thursday" } });
    expect(await same.json()).toMatchObject({ changed: false });
    const other = await call(`/api/notifications/${json.id}/respond`, { method: "POST", headers, json: { text: "Tuesday" } });
    expect(other.status).toBe(409);
    await settle();
    expect(sent.map((s) => s.body.event)).toEqual(["notification.responded"]);
    expect((sent[0]!.body.notification as Record<string, unknown>).response).toBe("Thursday");
  });

  it("refuses responses to an expired prompt", async () => {
    const { json } = await create({ responsePrompt: { type: "text", expiresAt: "2020-01-01T00:00:00Z" } });
    const res = await call(`/api/notifications/${json.id}/respond`, { method: "POST", headers: auth(), json: { text: "hi" } });
    expect(res.status).toBe(409);
  });
});

describe("listing", () => {
  it("filters, searches and pages", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { json } = await create({
        sourceId: `bot-${tag}`,
        body: `${tag} item ${i}`,
        flag: i === 0 ? "urgent" : "none",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      });
      ids.push(json.id);
    }
    await call(`/api/notifications/${ids[1]}/dismiss`, { method: "POST", headers: auth() });

    const list = async (query: string) =>
      (await (await call(`/api/notifications?sourceId=bot-${tag}&${query}`, { headers: auth() })).json()) as {
        items: { id: string }[];
        nextCursor: string | null;
      };

    expect((await list("")).items.map((n) => n.id)).toEqual([...ids].reverse());
    expect((await list("flag=urgent")).items.map((n) => n.id)).toEqual([ids[0]]);
    expect((await list("status=new,read")).items).toHaveLength(4);
    expect((await list(`q=${tag}%20item%203`)).items.map((n) => n.id)).toEqual([ids[3]]);
    expect((await list("since=2026-01-01T00:03:00Z")).items).toHaveLength(2);

    const page1 = await list("limit=2");
    const page2 = await list(`limit=2&cursor=${page1.nextCursor}`);
    const page3 = await list(`limit=2&cursor=${page2.nextCursor}`);
    expect([...page1.items, ...page2.items, ...page3.items].map((n) => n.id)).toEqual([...ids].reverse());
    expect(page3.nextCursor).toBeNull();

    expect((await call("/api/notifications?status=bogus", { headers: auth() })).status).toBe(400);
  });
});

describe("bulk", () => {
  it("imports with original timestamps and statuses, skipping known keys", async () => {
    const tag = crypto.randomUUID();
    const existing = await create({}, { "idempotency-key": `${tag}-0` });
    const res = await call("/api/notifications/bulk", {
      method: "POST",
      headers: auth(),
      json: {
        create: [
          { sourceId: "a", sender: "A", body: "zero", idempotencyKey: `${tag}-0` },
          {
            sourceId: "a",
            sender: "A",
            body: "one",
            idempotencyKey: `${tag}-1`,
            status: "dismissed",
            createdAt: "2026-10-01T12:00:00Z",
          },
          { sourceId: "b", sender: "B", body: "two", status: "responded", responseText: "done" },
        ],
        update: [
          { id: existing.json.id, flag: "urgent" },
          { id: "missing", flag: "urgent" },
        ],
      },
    });
    const json = (await res.json()) as { created: { id: string; created: boolean }[]; updated: Record<string, unknown>[] };
    expect(res.status).toBe(200);
    expect(json.created.map((c) => c.created)).toEqual([false, true, true]);
    expect(json.created[0]!.id).toBe(existing.json.id);
    expect(json.updated).toEqual([
      { id: existing.json.id, changed: true },
      { id: "missing", error: "Notification not found" },
    ]);
    const imported = (await (await call(`/api/notifications/${json.created[1]!.id}`, { headers: auth() })).json()) as Record<string, unknown>;
    expect(imported).toMatchObject({ status: "dismissed", createdAt: "2026-10-01T12:00:00.000Z" });
    expect(imported.dismissedAt).toBeTruthy();
  });
});

describe("openapi", () => {
  it("serves the spec without auth", async () => {
    const res = await call("/api/openapi.json");
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toContain("/api/notifications/{id}/respond");
  });
});
