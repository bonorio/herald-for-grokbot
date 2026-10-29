import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverDue } from "../src/worker/outbox";
import { apiKey, call, env, ORIGIN, sessionCookie } from "./helpers";

let sent: { body: Record<string, any> }[];
beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    sent.push({ body: JSON.parse(String(init?.body)) });
    return new Response("ok");
  });
});
afterEach(() => vi.restoreAllMocks());

async function settle() {
  await new Promise((r) => setTimeout(r, 50));
  await deliverDue(env);
}

describe("requests to bots", () => {
  it("sends a request to Grok Bot and links the bot's answer", async () => {
    const key = await apiKey();
    const botId = `hermes-${crypto.randomUUID()}`;
    await call("/api/notifications", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      json: { source: "bot", sourceId: botId, sender: "Hermes", body: "Ready" },
    });

    // The main agent is pinned first.
    await call("/api/prefs/main-agent", { method: "PUT", headers: { cookie: await sessionCookie(), origin: ORIGIN }, json: { sourceId: botId } });
    const bots = (await (await call("/api/bots", { headers: { authorization: `Bearer ${key}` } })).json()) as {
      items: { sourceId: string; pinned?: boolean }[];
    };
    expect(bots.items[0]).toMatchObject({ sourceId: botId, pinned: true });

    await settle();
    sent = [];
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    const res = await call("/api/requests", { method: "POST", headers: owner, json: { to: botId, text: "Summarize today's inbox" } });
    expect(res.status).toBe(201);
    const request = (await res.json()) as { id: string; status: string };
    expect(request.status).toBe("sent");

    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      event: "request.created",
      actor: "owner",
      request: { id: request.id, to: { sourceId: botId, sender: "Hermes" }, text: "Summarize today's inbox", inReplyTo: null },
    });

    // The bot answers through Chief Of Staff's key.
    await call("/api/notifications", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      json: { source: "bot", sourceId: botId, sender: "Hermes", body: "3 things need you today", requestId: request.id },
    });
    const list = (await (await call(`/api/requests?to=${botId}`, { headers: owner })).json()) as {
      items: { id: string; status: string; delivery: string }[];
    };
    expect(list.items[0]).toMatchObject({ id: request.id, status: "answered", delivery: "delivered" });
  });

  it("reaches a bot that's been set up, and rejects unknown bots", async () => {
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    await call("/api/bots/concierge", { method: "PATCH", headers: { authorization: `Bearer ${await apiKey()}` }, json: { sender: "Concierge" } });
    expect((await call("/api/requests", { method: "POST", headers: owner, json: { to: "concierge", text: "Hi" } })).status).toBe(201);
    expect((await call("/api/requests", { method: "POST", headers: owner, json: { to: "nobody", text: "Hi" } })).status).toBe(404);
  });
});

describe("chat list previews", () => {
  it("shows whichever came last: the bot's post or the owner's request", async () => {
    const bot = { authorization: `Bearer ${await apiKey()}` };
    const owner = { cookie: await sessionCookie(), origin: "https://herald.test" };
    await call("/api/notifications", { method: "POST", headers: bot, json: { sourceId: "chef", sender: "Chef", title: "Menu ready", body: "Tacos Tuesday" } });
    let list = (await (await call("/api/bots", { headers: owner })).json()) as { items: { sourceId: string; last: unknown }[] };
    expect(list.items.find((b) => b.sourceId === "chef")?.last).toMatchObject({ text: "Menu ready", mine: false });
    await call("/api/requests", { method: "POST", headers: owner, json: { to: "chef", text: "Add a salad" } });
    list = (await (await call("/api/bots", { headers: owner })).json()) as typeof list;
    expect(list.items.find((b) => b.sourceId === "chef")?.last).toMatchObject({ text: "Add a salad", mine: true });
  });
});

describe("chat list order", () => {
  it("puts the conversation with the newest message either way first", async () => {
    const bot = { authorization: `Bearer ${await apiKey()}` };
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    const post = (sourceId: string, createdAt: string) =>
      call("/api/notifications", { method: "POST", headers: bot, json: { sourceId, sender: sourceId, body: "hi", createdAt } });
    await post("order-a", new Date(Date.now() - 86_400_000).toISOString());
    await post("order-b", new Date(Date.now() - 3_600_000).toISOString());
    await call("/api/requests", { method: "POST", headers: owner, json: { to: "order-a", text: "ping" } });
    const { items } = (await (await call("/api/bots", { headers: owner })).json()) as { items: { sourceId: string }[] };
    const ids = items.map((b) => b.sourceId).filter((id) => id.startsWith("order-"));
    expect(ids).toEqual(["order-a", "order-b"]);
  });

  it("doesn't move a conversation up when the bot is only renamed", async () => {
    const bot = { authorization: `Bearer ${await apiKey()}` };
    const owner = { cookie: await sessionCookie(), origin: ORIGIN };
    const post = (sourceId: string, createdAt: string) =>
      call("/api/notifications", { method: "POST", headers: bot, json: { sourceId, sender: sourceId, body: "hi", createdAt } });
    await post("rename-old", new Date(Date.now() - 2 * 86_400_000).toISOString());
    await post("rename-new", new Date(Date.now() - 86_400_000).toISOString());
    await call("/api/bots/rename-old", { method: "PATCH", headers: bot, json: { sender: "Renamed" } });
    const { items } = (await (await call("/api/bots", { headers: owner })).json()) as { items: { sourceId: string }[] };
    expect(items.map((b) => b.sourceId).filter((id) => id.startsWith("rename-"))).toEqual(["rename-new", "rename-old"]);
  });
});
