import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotification } from "../src/worker/notifications";
import { deliverDue, parseAuthHeader, RETRY_DELAYS_MS } from "../src/worker/outbox";
import { apiKey, call, env } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const input = {
  sourceId: "x",
  sender: "X",
  body: "hello",
  kind: "update",
  flag: "none",
  status: "new",
} as const;

async function delivery(eventId: string) {
  return env.DB.prepare("SELECT status, attempts, next_attempt_at, last_error, last_status FROM webhook_outbox WHERE event_id = ?")
    .bind(eventId)
    .first<{ status: string; attempts: number; next_attempt_at: string; last_error: string | null; last_status: number | null }>();
}

describe("outbox", () => {
  it("retries with backoff until delivered", async () => {
    const { eventId } = await createNotification(env, "service:monitor", input);
    const failing = vi.fn(async () => new Response("down", { status: 503 }));
    await deliverDue(env, { eventIds: [eventId!], fetch: failing });
    let row = await delivery(eventId!);
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_status: 503, last_error: "HTTP 503" });
    const wait = new Date(row!.next_attempt_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(RETRY_DELAYS_MS[0]! - 5_000);

    // Not due yet: nothing is sent.
    await deliverDue(env, { eventIds: [eventId!], fetch: failing });
    expect(failing).toHaveBeenCalledTimes(1);

    await env.DB.prepare("UPDATE webhook_outbox SET next_attempt_at = ? WHERE event_id = ?").bind(new Date(0).toISOString(), eventId).run();
    const ok = vi.fn(async () => new Response("ok"));
    await deliverDue(env, { eventIds: [eventId!], fetch: ok });
    row = await delivery(eventId!);
    expect(row).toMatchObject({ status: "delivered", attempts: 2, last_error: null });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last retry", async () => {
    const { eventId } = await createNotification(env, "service:monitor", input);
    await env.DB.prepare("UPDATE webhook_outbox SET attempts = ? WHERE event_id = ?").bind(RETRY_DELAYS_MS.length, eventId).run();
    await deliverDue(env, { eventIds: [eventId!], fetch: async () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(await delivery(eventId!)).toMatchObject({ status: "dead", last_error: "ECONNREFUSED" });
  });

  it("holds Grok Bot deliveries until its URL is set", async () => {
    const { eventId } = await createNotification(env, "service:monitor", input);
    const send = vi.fn(async () => new Response("ok"));
    await deliverDue({ ...env, GROK_BOT_WEBHOOK_URL: undefined }, { eventIds: [eventId!], fetch: send });
    expect(send).not.toHaveBeenCalled();
    expect(await delivery(eventId!)).toMatchObject({ status: "pending", attempts: 0 });
    await deliverDue(env, { eventIds: [eventId!], fetch: send });
    expect(await delivery(eventId!)).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("never blocks a dashboard action when Grok Bot is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Grok Bot is down"));
    const key = await apiKey();
    const created = await call("/api/notifications", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      json: input,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const dismissed = await call(`/api/notifications/${id}/dismiss`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    expect(dismissed.status).toBe(200);
  });

  it("sends the configured auth header exactly as given", () => {
    expect(parseAuthHeader("Authorization: Bearer abc")).toEqual(["Authorization", "Bearer abc"]);
    expect(parseAuthHeader("X-Grok-Secret: s3cr3t:with:colons")).toEqual(["X-Grok-Secret", "s3cr3t:with:colons"]);
    expect(parseAuthHeader("Bearer abc")).toEqual(["Authorization", "Bearer abc"]);
    expect(parseAuthHeader("")).toBeNull();
  });
});
