import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverDue } from "../src/worker/outbox";
import { isQuiet, localClock, morningSummary } from "../src/worker/push";
import { apiKey, call, env, ORIGIN, outboxRows, sessionCookie } from "./helpers";

let sent: { url: string; body: string }[];
beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    sent.push({ url: String(input), body: String(init?.body) });
    return new Response("ok", { status: 201 });
  });
});
afterEach(() => vi.restoreAllMocks());

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A browser's push keys: its P-256 public key and auth secret. */
async function deviceKeys(): Promise<[string, string]> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return [b64u(raw), b64u(crypto.getRandomValues(new Uint8Array(16)))];
}

const auth = async () => ({ authorization: `Bearer ${await apiKey()}` });

describe("bot profiles", () => {
  it("sets up a bot before it posts, with role, color and status", async () => {
    const headers = await auth();
    const sourceId = `concierge-${crypto.randomUUID()}`;
    const res = await call(`/api/bots/${sourceId}`, {
      method: "PATCH",
      headers,
      json: { sender: "Concierge", role: "Restaurants and tickets", color: "#FF9F0A", status: { text: "Booking Friday dinner", state: "working" } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sourceId,
      sender: "Concierge",
      role: "Restaurants and tickets",
      color: "#ff9f0a",
      status: { text: "Booking Friday dinner", state: "working" },
    });
    const bots = (await (await call("/api/bots", { headers })).json()) as { items: { sourceId: string }[] };
    expect(bots.items.some((b) => b.sourceId === sourceId)).toBe(true);

    await call(`/api/bots/${sourceId}`, { method: "PATCH", headers, json: { status: null } });
    const bad = await call(`/api/bots/${sourceId}`, { method: "PATCH", headers, json: { color: "orange" } });
    expect(bad.status).toBe(400);
  });
});

describe("rich notifications", () => {
  it("stores Markdown, a summary, blocks and quick replies", async () => {
    const headers = await auth();
    const res = await call("/api/notifications", {
      method: "POST",
      headers,
      json: {
        sourceId: "travel",
        sender: "Travel Agent",
        body: "Two options for Denver",
        fullText: "## Options\n- **7:05** nonstop\n- 11:40 nonstop",
        bodyFormat: "markdown",
        summary: "Denver flight moved; pick one",
        blocks: [
          { type: "facts", items: [{ label: "Flight", value: "UA 1432" }] },
          { type: "table", columns: ["Time", "Price"], rows: [["7:05", "$0"], ["11:40", "$45"]], highlight: 0 },
          { type: "progress", label: "Rebooking", value: 0.4 },
          { type: "checklist", items: [{ id: "bag", text: "Check a bag" }] },
          { type: "link", url: "https://united.com", title: "Your trip" },
        ],
        quickReplies: ["Keep 7:05", "Tell me more"],
      },
    });
    expect(res.status).toBe(201);
    const n = (await res.json()) as { id: string; blocks: { type: string }[]; bodyFormat: string; quickReplies: string[] };
    expect(n.bodyFormat).toBe("markdown");
    expect(n.blocks.map((b) => b.type)).toEqual(["facts", "table", "progress", "checklist", "link"]);
    expect(n.quickReplies).toEqual(["Keep 7:05", "Tell me more"]);

    // A bot updates progress in place.
    const patched = await call(`/api/notifications/${n.id}`, {
      method: "PATCH",
      headers,
      json: { blocks: [{ type: "progress", label: "Rebooking", value: 1, detail: "Done" }] },
    });
    expect(((await patched.json()) as { blocks: { value: number }[] }).blocks[0]!.value).toBe(1);
  });

  it("lets the owner tick a checklist item and tells Grok Bot", async () => {
    const headers = await auth();
    const n = (await (
      await call("/api/notifications", {
        method: "POST",
        headers,
        json: { sourceId: "home", sender: "Home", body: "Before you leave", blocks: [{ type: "checklist", items: [{ id: "stove", text: "Stove off" }] }] },
      })
    ).json()) as { id: string };
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    const res = await call(`/api/notifications/${n.id}/checklist`, { method: "POST", headers: owner, json: { block: 0, item: "stove", done: true } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { blocks: { items: { done: boolean }[] }[] }).blocks[0]!.items[0]!.done).toBe(true);
    const again = await call(`/api/notifications/${n.id}/checklist`, { method: "POST", headers: owner, json: { block: 0, item: "stove", done: true } });
    expect(((await again.json()) as { changed: boolean }).changed).toBe(false);
    const rows = (await outboxRows()).results.filter((r) => r.notification_id === n.id && r.actor === "owner");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.body).checklist ?? JSON.parse(rows[0]!.body).notification.blocks).toBeTruthy();
  });

  it("streams a reply and logs only the finished one", async () => {
    const key = await apiKey("service:writer");
    const headers = { authorization: `Bearer ${key}` };
    const missingBody = await call("/api/notifications", { method: "POST", headers, json: { sourceId: "writer", sender: "Writer" } });
    expect(missingBody.status).toBe(400);
    const n = (await (
      await call("/api/notifications", { method: "POST", headers, json: { sourceId: "writer", sender: "Writer", streaming: true, bodyFormat: "markdown" } })
    ).json()) as { id: string; streaming: boolean };
    expect(n.streaming).toBe(true);

    await call(`/api/notifications/${n.id}/stream`, { method: "POST", headers, json: { append: "## Plan\n" } });
    const mid = (await (await call(`/api/notifications/${n.id}/stream`, { method: "POST", headers, json: { append: "Book the **7:05**." } })).json()) as {
      fullText: string;
      body: string;
      streaming: boolean;
    };
    expect(mid).toMatchObject({ fullText: "## Plan\nBook the **7:05**.", body: "Plan Book the 7:05.", streaming: true });

    const done = (await (await call(`/api/notifications/${n.id}/stream`, { method: "POST", headers, json: { done: true } })).json()) as {
      streaming: boolean;
    };
    expect(done.streaming).toBe(false);
    const late = await call(`/api/notifications/${n.id}/stream`, { method: "POST", headers, json: { append: "more" } });
    expect(late.status).toBe(409);

    const events = (await (await call(`/api/notifications/${n.id}/events`, { headers })).json()) as { items: { event: string }[] };
    expect(events.items.map((e) => e.event)).toEqual(["notification.created", "notification.updated"]);
  });
});

describe("requests and briefing", () => {
  it("records when Grok Bot picks a request up", async () => {
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    await call("/api/bots/chief-of-staff", { method: "PATCH", headers: { authorization: `Bearer ${await apiKey()}` }, json: { sender: "Chief Of Staff" } });
    const request = (await (await call("/api/requests", { method: "POST", headers: owner, json: { to: "chief-of-staff", text: "Plan my week" } })).json()) as {
      id: string;
    };
    const res = await call(`/api/requests/${request.id}/ack`, { method: "POST", headers: await auth(), json: { by: "Chief Of Staff" } });
    expect(await res.json()).toMatchObject({ id: request.id, acknowledgedBy: "Chief Of Staff" });
    expect((await call("/api/requests/nope/ack", { method: "POST", headers: await auth() })).status).toBe(404);
  });

  it("stores the Home briefing", async () => {
    const headers = await auth();
    expect(await (await call("/api/briefing", { headers })).json()).toBeNull();
    await call("/api/briefing", { method: "PUT", headers, json: { text: "Quiet morning. Travel is rebooking Denver." } });
    expect(await (await call("/api/briefing", { headers })).json()).toMatchObject({
      text: "Quiet morning. Travel is rebooking Denver.",
      actor: "grok-bot",
    });
  });
});

describe("quiet hours", () => {
  const quiet = { enabled: true, start: "22:00", end: "07:00", timeZone: "America/New_York" };

  it("knows when it is quiet, across midnight", () => {
    expect(isQuiet(quiet, new Date("2026-10-28T03:00:00Z"))).toBe(true); // 23:00 in New York
    expect(isQuiet(quiet, new Date("2026-10-28T10:30:00Z"))).toBe(true); // 06:30
    expect(isQuiet(quiet, new Date("2026-10-28T11:00:00Z"))).toBe(false); // 07:00
    expect(isQuiet({ ...quiet, enabled: false }, new Date("2026-10-28T03:00:00Z"))).toBe(false);
    expect(localClock(new Date("2026-10-28T11:00:00Z"), "America/New_York")).toEqual({ minutes: 420, date: "2026-10-28" });
  });

  it("is saved by the owner only and sends one morning summary", async () => {
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    expect((await call("/api/prefs/quiet-hours", { method: "PUT", headers: await auth(), json: quiet })).status).toBe(403);
    expect((await call("/api/prefs/quiet-hours", { method: "PUT", headers: owner, json: { ...quiet, timeZone: "Mars/Base" } })).status).toBe(400);
    expect((await call("/api/prefs/quiet-hours", { method: "PUT", headers: owner, json: quiet })).status).toBe(200);

    await env.DB.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES ('q', 'https://push.example/q', ?, ?, ?)")
      .bind(...(await deviceKeys()), new Date().toISOString())
      .run();
    // Quiet hours that end this minute, so what just came in counts as overnight.
    const now = new Date();
    const local = localClock(now, quiet.timeZone).minutes;
    const hhmm = (m: number) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, "0")}:${String((m + 1440) % 60).padStart(2, "0")}`;
    await call("/api/prefs/quiet-hours", { method: "PUT", headers: owner, json: { ...quiet, start: hhmm(local - 60), end: hhmm(local) } });
    await call("/api/notifications", { method: "POST", headers: await auth(), json: { sourceId: "night", sender: "Night Owl", body: "Backup finished" } });
    await new Promise((r) => setTimeout(r, 50));
    sent = [];
    await morningSummary(env, now);
    await morningSummary(env, now);
    const pushes = sent.filter((s) => s.url === "https://push.example/q");
    expect(pushes).toHaveLength(1);
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = 'q'").run();
    await deliverDue(env);
  });
});
