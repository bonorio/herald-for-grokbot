import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "../src/worker/connect";
import { deliverDue } from "../src/worker/outbox";
import { apiKey, call, env, sessionCookie } from "./helpers";

let sent: { url: string; headers: Headers; body: string }[];
beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
    return new Response("ok");
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare(
    "DELETE FROM prefs WHERE key IN ('webhook', 'grok_link', 'grok_link_by_owner', 'main_agent', 'main_agent_by_owner')",
  ).run();
});

const owner = async () => ({ cookie: await sessionCookie(), origin: "https://herald.test" });

/** Connects the way the owner and Grok Bot would: Settings, then the pasted message. */
async function connect() {
  const res = await call("/api/connect", { method: "POST", headers: await owner() });
  expect(res.status).toBe(201);
  const { message, apiKey: key, signingSecret: secret } = (await res.json()) as { message: string; apiKey: string; signingSecret: string };
  return { message, key, secret };
}

describe("connecting Grok Bot", () => {
  it("hands the owner a message with no secrets in it, and the key and secret to copy separately", async () => {
    const { message, key, secret } = await connect();
    expect(key).toMatch(/^hrd_/);
    expect(secret).toMatch(/^hws_/);
    // Chat transcripts last; the secrets go through Grok Bot's secure secrets box instead.
    expect(message).not.toContain(key);
    expect(message).not.toContain(secret);
    expect(message).toContain("HERALD_API_KEY");
    expect(message).toContain("HERALD_SIGNING_SECRET");
    // The routine's own header, if it needs one, goes through the secrets box too.
    expect(message).toContain("HERALD_WEBHOOK_AUTH");
    // And it tells the owner where to find what it asks for.
    expect(message).toContain("get its webhook URL and header yourself");
    // Its routine handles every event, and it reports inboxes as soon as it's connected.
    expect(message).toContain("scan.requested (scan now; an empty sources list means everything");
    expect(message).toContain("As soon as you're connected, scan the inboxes");
    // It finishes the whole job, then says what it did.
    expect(message).toContain("without stopping to ask permission");
    expect(message).toContain("When everything's done, send me one short summary");
    expect(message).toContain("tell me exactly where to find each one");
    expect(message).toContain("https://herald.test/api/agent-guide.md");
    expect(message).toContain("PUT https://herald.test/api/connect/webhook");
  });

  it("lets Grok Bot register its webhook, then signs every delivery to it", async () => {
    const { key, secret } = await connect();
    const res = await call("/api/connect/webhook", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}` },
      json: { url: "https://grok.example/hooks/herald", authHeader: "X-Token: abc" },
    });
    expect(await res.json()).toMatchObject({ ok: true, connected: true, via: "app", host: "grok.example", signed: true });
    await deliverDue(env);
    const hello = sent.find((s) => s.body.includes('"event":"herald.connected"'));
    expect(hello?.url).toBe("https://grok.example/hooks/herald");
    expect(hello?.headers.get("x-token")).toBe("abc");
    // Grok Bot checks it the same way.
    expect(hello?.headers.get("x-herald-signature")).toBe(await sign(secret, hello?.body as string));
  });

  it("takes Grok Bot's chat link along with its webhook, for the Grok Bot button", async () => {
    const { key, message } = await connect();
    expect(message).toContain('"chatUrl"');
    const headers = { authorization: `Bearer ${key}` };
    const res = await call("/api/connect/webhook", {
      method: "PUT",
      headers,
      json: { url: "https://grok.example/h", chatUrl: "grokbot://chat/chief-of-staff" },
    });
    expect(res.status).toBe(200);
    expect(await (await call("/api/prefs/grok-link", { headers: await owner() })).json()).toEqual({ url: "grokbot://chat/chief-of-staff" });
    // A chat link that isn't usable is ignored, never fatal: the webhook still registers.
    const bad = await call("/api/connect/webhook", { method: "PUT", headers, json: { url: "https://grok.example/h", chatUrl: "javascript:alert(1)" } });
    expect(bad.status).toBe(200);
    expect(await (await call("/api/prefs/grok-link", { headers: await owner() })).json()).toEqual({ url: "grokbot://chat/chief-of-staff" });

    // One the owner set by hand wins over Grok Bot's, until they clear it.
    await call("/api/prefs/grok-link", { method: "PUT", headers: await owner(), json: { url: "https://mine.example/chat" } });
    await call("/api/connect/webhook", { method: "PUT", headers, json: { url: "https://grok.example/h", chatUrl: "grokbot://chat/other" } });
    expect(await (await call("/api/prefs/grok-link", { headers: await owner() })).json()).toEqual({ url: "https://mine.example/chat" });
  });

  it("pins the main agent Grok Bot names, setting it up if it hasn't posted, unless the owner chose one", async () => {
    const { key, message } = await connect();
    expect(message).toContain("Choose your main agent");
    expect(message).toContain('"mainAgent"');
    const headers = { authorization: `Bearer ${key}` };
    await call("/api/connect/webhook", {
      method: "PUT",
      headers,
      json: { url: "https://grok.example/h", mainAgent: { sourceId: "cos", name: "Chief of Staff" } },
    });
    const bots = (await (await call("/api/bots", { headers: await owner() })).json()) as { items: { sourceId: string; sender: string; pinned?: boolean }[] };
    expect(bots.items[0]).toMatchObject({ sourceId: "cos", sender: "Chief of Staff", pinned: true });
    expect(await (await call("/api/agent-guide.md", { headers })).text()).toContain("is `cos`; post as it");

    // The owner picks another; Grok Bot reconnecting doesn't undo that.
    await call("/api/bots/travel", { method: "PATCH", headers, json: { sender: "Travel Agent" } });
    expect((await call("/api/prefs/main-agent", { method: "PUT", headers: await owner(), json: { sourceId: "travel" } })).status).toBe(200);
    await call("/api/connect/webhook", { method: "PUT", headers, json: { url: "https://grok.example/h", mainAgent: { sourceId: "cos" } } });
    const after = (await (await call("/api/bots", { headers: await owner() })).json()) as { items: { sourceId: string; pinned?: boolean }[] };
    expect(after.items[0]).toMatchObject({ sourceId: "travel", pinned: true });
    expect((await call("/api/prefs/main-agent", { method: "PUT", headers: await owner(), json: { sourceId: "nobody" } })).status).toBe(404);

    // Handing it back lets Grok Bot name one again.
    await call("/api/prefs/main-agent", { method: "PUT", headers: await owner(), json: { sourceId: null } });
    await call("/api/connect/webhook", { method: "PUT", headers, json: { url: "https://grok.example/h", mainAgent: { sourceId: "cos" } } });
    const back = (await (await call("/api/bots", { headers: await owner() })).json()) as { items: { sourceId: string; pinned?: boolean }[] };
    expect(back.items[0]).toMatchObject({ sourceId: "cos", pinned: true });
  });

  it("never lets a main agent it can't set up break the connection, nor pins a service", async () => {
    const { key } = await connect();
    const headers = { authorization: `Bearer ${key}` };
    const res = await call("/api/connect/webhook", { method: "PUT", headers, json: { url: "https://grok.example/h", mainAgent: { sourceId: "ghost" } } });
    expect(res.status).toBe(200);
    await call("/api/notifications", {
      method: "POST",
      headers: { authorization: `Bearer ${await apiKey("service:mailer")}` },
      json: { sourceId: "mailer", sender: "Mailer", body: "x" },
    });
    expect((await call("/api/prefs/main-agent", { method: "PUT", headers: await owner(), json: { sourceId: "mailer" } })).status).toBe(404);
  });

  it("refuses other keys, unsafe URLs, and registering before the owner starts", async () => {
    const early = await call("/api/connect/webhook", {
      method: "PUT",
      headers: { authorization: `Bearer ${await apiKey()}` },
      json: { url: "https://grok.example/h" },
    });
    expect(early.status).toBe(409);
    const { key } = await connect();
    const service = await call("/api/connect/webhook", {
      method: "PUT",
      headers: { authorization: `Bearer ${await apiKey("service:mailer")}` },
      json: { url: "https://grok.example/h" },
    });
    expect(service.status).toBe(403);
    for (const url of ["http://grok.example/h", "javascript:alert(1)", "not a url"]) {
      const res = await call("/api/connect/webhook", { method: "PUT", headers: { authorization: `Bearer ${key}` }, json: { url } });
      expect(res.status).toBe(400);
    }
  });

  it("keeps a working connection until Grok Bot registers with the new key, then retires the old one", async () => {
    const first = await connect();
    const register = (key: string, url: string) =>
      call("/api/connect/webhook", { method: "PUT", headers: { authorization: `Bearer ${key}` }, json: { url } });
    expect((await register(first.key, "https://grok.example/a")).status).toBe(200);

    const second = await connect();
    // Not registered yet: deliveries still go out signed with the first secret.
    await call("/api/categories/work", { method: "PATCH", headers: await owner(), json: { color: "#123456" } });
    await deliverDue(env);
    const before = sent.find((s) => s.body.includes('"event":"categories.updated"'));
    expect(before?.headers.get("x-herald-signature")).toBe(await sign(first.secret, before?.body as string));

    expect((await register(second.key, "https://grok.example/b")).status).toBe(200);
    // The first key is revoked, so it can't move the webhook or post any more.
    expect((await register(first.key, "https://evil.example/")).status).toBe(401);
    expect((await call("/api/connect", { headers: await owner() }).then((r) => r.json())) as { host: string }).toMatchObject({ host: "grok.example" });
  });

  it("refuses a key that isn't the connected or pending one", async () => {
    const { key } = await connect();
    await call("/api/connect/webhook", { method: "PUT", headers: { authorization: `Bearer ${key}` }, json: { url: "https://grok.example/a" } });
    const other = await apiKey();
    const res = await call("/api/connect/webhook", { method: "PUT", headers: { authorization: `Bearer ${other}` }, json: { url: "https://evil.example/" } });
    expect(res.status).toBe(403);
  });

  it("stays disconnected until the owner connects again", async () => {
    const { key } = await connect();
    await call("/api/connect/webhook", { method: "PUT", headers: { authorization: `Bearer ${key}` }, json: { url: "https://grok.example/a" } });
    await call("/api/connect/webhook", { method: "DELETE", headers: await owner() });
    const again = await call("/api/connect/webhook", { method: "PUT", headers: { authorization: `Bearer ${key}` }, json: { url: "https://grok.example/a" } });
    expect(again.status).toBe(409);
  });

  it("shows the connection without its secrets, and disconnects", async () => {
    const { key } = await connect();
    await call("/api/connect/webhook", { method: "PUT", headers: { authorization: `Bearer ${key}` }, json: { url: "https://grok.example/h" } });
    const status = await (await call("/api/connect", { headers: await owner() })).text();
    expect(status).not.toContain("hws_");
    expect(JSON.parse(status)).toMatchObject({ connected: true, host: "grok.example" });
    const off = await call("/api/connect/webhook", { method: "DELETE", headers: await owner() });
    // The test Worker also has GROK_BOT_WEBHOOK_URL set, which takes over.
    expect(await off.json()).toMatchObject({ via: "env" });
  });
});
