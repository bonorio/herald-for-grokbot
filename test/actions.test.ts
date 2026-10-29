import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverDue } from "../src/worker/outbox";
import { apiKey, call, env, sessionCookie } from "./helpers";

let sent: { event: string; actor: string; action?: string; text?: string; notification: Record<string, unknown> }[];
beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("ok");
  });
});
afterEach(() => vi.restoreAllMocks());

const bot = async () => ({ authorization: `Bearer ${await apiKey()}` });
const owner = async () => ({ cookie: await sessionCookie(), origin: "https://herald.test" });
const settle = () => deliverDue({ ...env, GROK_BOT_WEBHOOK_URL: "https://grok.test/hook" });

const email = {
  sourceId: "comms",
  sender: "Communications Manager",
  title: "Jordan Lee wants to meet",
  body: "Sam Rivera introduced you; Jordan offered Thursday afternoon or Friday morning.",
  subject: {
    type: "email",
    from: "Jordan Lee",
    fromAddress: "jordan@acme.test",
    subject: "Intro: the owner <> Jordan",
    snippet: "Great to meet you. Thursday afternoon or Friday AM work for me.",
    account: "owner@example.test",
    receivedAt: "2026-10-27T15:00:00Z",
    url: "https://mail.google.com/mail/u/0/#inbox/abc",
  },
  dueAt: "2026-10-30T21:00:00Z",
  actions: [
    { id: "reply", label: "Reply", type: "reply", style: "primary", draft: "Hi Marc, Thursday at 2 works. the owner" },
    { id: "decline", label: "Not interested", type: "confirm" },
    { id: "open", label: "Open in Gmail", type: "open", url: "https://mail.google.com/mail/u/0/#inbox/abc" },
  ],
};

async function create(extra: Record<string, unknown> = {}) {
  const res = await call("/api/notifications", { method: "POST", headers: await bot(), json: { ...email, ...extra } });
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, unknown> & { id: string };
}

describe("actionable notifications", () => {
  it("stores the subject, actions and due date, and waits on the owner", async () => {
    const n = await create();
    expect(n).toMatchObject({
      flag: "awaiting",
      subject: { type: "email", from: "Jordan Lee", subject: "Intro: the owner <> Jordan" },
      dueAt: "2026-10-30T21:00:00.000Z",
      responseAction: null,
      outcome: null,
    });
    expect((n.actions as unknown[]).length).toBe(3);
  });

  it("a link-only notification still waits on the owner; one with no actions doesn't", async () => {
    expect((await create({ actions: [email.actions[2]] })).flag).toBe("awaiting");
    expect((await create({ actions: [] })).flag).toBe("none");
  });

  it("rejects bad actions", async () => {
    const headers = await bot();
    for (const actions of [
      [{ id: "go", label: "Go", type: "open" }],
      [{ id: "done", label: "Done", type: "confirm" }],
      [{ id: "a", label: "A", type: "confirm" }, { id: "a", label: "B", type: "confirm" }],
    ]) {
      const res = await call("/api/notifications", { method: "POST", headers, json: { ...email, actions } });
      expect(res.status).toBe(400);
    }
  });

  it("replies with edited text and tells Grok Bot which action", async () => {
    const n = await create();
    const headers = await owner();
    const empty = await call(`/api/notifications/${n.id}/respond`, { method: "POST", headers, json: { action: "reply" } });
    expect(empty.status).toBe(400);
    const ok = await call(`/api/notifications/${n.id}/respond`, {
      method: "POST",
      headers,
      json: { action: "reply", text: "Hi Marc, Friday 9am? the owner" },
    });
    expect(await ok.json()).toMatchObject({ status: "responded", flag: "none", responseAction: "reply", responseText: "Hi Marc, Friday 9am? the owner" });
    const again = await call(`/api/notifications/${n.id}/respond`, { method: "POST", headers, json: { action: "decline" } });
    expect(again.status).toBe(409);
    await settle();
    const event = sent.find((s) => s.notification.id === n.id);
    expect(event).toMatchObject({ event: "notification.responded", actor: "owner" });
    expect(event?.notification).toMatchObject({ responseAction: "reply", response: "Hi Marc, Friday 9am? the owner" });
  });

  it("a confirm action answers with its label; done is built in", async () => {
    const headers = await owner();
    const a = await create();
    const confirm = await call(`/api/notifications/${a.id}/respond`, { method: "POST", headers, json: { action: "decline" } });
    expect(await confirm.json()).toMatchObject({ responseAction: "decline", responseText: "Not interested" });

    const b = await create();
    const done = await call(`/api/notifications/${b.id}/respond`, { method: "POST", headers, json: { action: "done" } });
    expect(await done.json()).toMatchObject({ responseAction: "done", responseText: "Done", status: "responded" });

    const c = await create();
    const link = await call(`/api/notifications/${c.id}/respond`, { method: "POST", headers, json: { action: "open" } });
    expect(link.status).toBe(400);
  });

  it("the bot records what it did", async () => {
    const n = await create();
    const res = await call(`/api/notifications/${n.id}`, { method: "PATCH", headers: await bot(), json: { outcome: "Sent 3:42 PM" } });
    expect(await res.json()).toMatchObject({ outcome: "Sent 3:42 PM" });
  });
});

describe("topics and tasks", () => {
  it("a card that needs the owner gets a task from its title; a bot can name its own or opt out", async () => {
    expect(await create({ topic: "Work intros" })).toMatchObject({ topic: "Work intros", task: "Jordan Lee wants to meet" });
    expect((await create({ task: "Reply to Marc" })).task).toBe("Reply to Marc");
    expect((await create({ task: null })).task).toBeNull();
    const fyi = await call("/api/notifications", {
      method: "POST",
      headers: await bot(),
      json: { sourceId: "comms", sender: "Comms", title: "State Farm autopay", body: "Scheduled 11/12" },
    });
    expect(((await fyi.json()) as { task: unknown }).task).toBeNull();
  });

  it("dismissing the card completes the task, restoring reopens it", async () => {
    const n = await create();
    const headers = await owner();
    const dismissed = await call(`/api/notifications/${n.id}/dismiss`, { method: "POST", headers });
    expect(await dismissed.json()).toMatchObject({ status: "dismissed", task: "Jordan Lee wants to meet" });
    const restored = await call(`/api/notifications/${n.id}/restore`, { method: "POST", headers });
    expect(await restored.json()).toMatchObject({ status: "new" });
  });
});
