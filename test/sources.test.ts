import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isQuiet, type ScanSource } from "../src/shared/types";
import { apiKey, call, env, outboxRows, sessionCookie } from "./helpers";

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  await env.DB.batch([env.DB.prepare("DELETE FROM sources"), env.DB.prepare("DELETE FROM webhook_outbox"), env.DB.prepare("DELETE FROM events")]);
});
afterEach(() => vi.restoreAllMocks());

const bot = async () => ({ authorization: `Bearer ${await apiKey()}` });
const owner = async () => ({ cookie: await sessionCookie(), origin: "https://herald.test" });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function report(id: string, json: Record<string, unknown>) {
  const res = await call(`/api/sources/${encodeURIComponent(id)}`, { method: "PUT", headers: await bot(), json });
  expect(res.status).toBe(200);
  return (await res.json()) as ScanSource;
}

const gmail = { kind: "email", label: "Gmail", provider: "gmail", account: "me@example.test" };

describe("inboxes and calendars", () => {
  it("records what the bot watches and how its last scan went", async () => {
    const at = ago(3);
    const source = await report("gmail:me", { ...gmail, lastScanAt: at, found: 4 });
    expect(source).toMatchObject({ id: "gmail:me", status: "ok", lastScanAt: new Date(at).toISOString(), lastFound: 4, cadenceMinutes: 15, paused: false, stale: false });
    await report("gcal:family", { kind: "calendar", label: "Family calendar", lastScanAt: at });
    const list = (await (await call("/api/sources", { headers: await owner() })).json()) as { items: ScanSource[] };
    expect(list.items.map((s) => s.id)).toEqual(["gmail:me", "gcal:family"]);
  });

  it("marks a source stale when it goes quiet or its scan fails, but not while paused", async () => {
    expect((await report("a", { ...gmail, lastScanAt: ago(45) })).stale).toBe(true);
    expect((await report("b", { ...gmail, lastScanAt: ago(1), error: "Token expired" })).stale).toBe(true);
    expect((await report("b", { ...gmail, lastScanAt: ago(1), error: "Token expired" })).lastError).toBe("Token expired");
    const paused = await call("/api/sources/a", { method: "PATCH", headers: await owner(), json: { paused: true } });
    expect(((await paused.json()) as ScanSource).stale).toBe(false);
    const base = { paused: false, status: "ok" as const, cadenceMinutes: 60, watchingSince: ago(500) };
    expect(isQuiet({ ...base, lastScanAt: ago(100) })).toBe(false);
    expect(isQuiet({ ...base, lastScanAt: ago(130) })).toBe(true);
    // Just put back on a schedule: not quiet until a whole new interval passes.
    expect(isQuiet({ ...base, lastScanAt: ago(3000), watchingSince: ago(1) })).toBe(false);
  });

  it("keeps the owner's settings when the bot reports again, and tells Grok Bot about changes", async () => {
    await report("gmail:me", gmail);
    const res = await call("/api/sources/gmail:me", { method: "PATCH", headers: await owner(), json: { cadenceMinutes: 60 } });
    expect(await res.json()).toMatchObject({ cadenceMinutes: 60 });
    expect((await report("gmail:me", { ...gmail, lastScanAt: ago(1) })).cadenceMinutes).toBe(60);
    const [sent] = (await outboxRows()).results.filter((r) => r.event === "source.settings");
    expect(JSON.parse(sent?.body as string)).toMatchObject({ source: { id: "gmail:me", cadenceMinutes: 60, paused: false } });
    expect((await call("/api/sources/gmail:me", { method: "PATCH", headers: await owner(), json: { cadenceMinutes: 7 } })).status).toBe(400);
    expect((await call("/api/sources/gmail:me", { method: "PATCH", headers: await bot(), json: { paused: true } })).status).toBe(403);
  });

  it("asks Grok Bot to scan now, and clears the request when the next scan comes in", async () => {
    await report("gmail:me", gmail);
    await report("gcal:family", { kind: "calendar", label: "Family calendar" });
    await call("/api/sources/gcal:family", { method: "PATCH", headers: await owner(), json: { paused: true } });
    const res = await call("/api/sources/scan", { method: "POST", headers: await owner() });
    expect(((await res.json()) as { items: ScanSource[] }).items.map((s) => s.id)).toEqual(["gmail:me"]);
    const [sent] = (await outboxRows()).results.filter((r) => r.event === "scan.requested");
    expect(JSON.parse(sent?.body as string)).toMatchObject({ sources: [{ id: "gmail:me", provider: "gmail" }] });

    const one = await call("/api/sources/scan", { method: "POST", headers: await owner(), json: { ids: ["gcal:family"] } });
    expect(((await one.json()) as { items: ScanSource[] }).items[0]?.scanRequestedAt).toBeTruthy();
    // A failed scan answers it too.
    const failed = await report("gcal:family", { kind: "calendar", label: "Family calendar", error: "Google sign-in expired" });
    expect(failed.scanRequestedAt).toBeNull();
    expect((await call("/api/sources/scan", { method: "POST", headers: await owner(), json: { ids: ["nope"] } })).status).toBe(404);
    expect((await call("/api/sources/scan", { method: "POST", headers: await owner(), json: { ids: ["gmail:me", "gmail:me"] } })).status).toBe(200);
  });

  it("forgets an unanswered Scan now after ten minutes, and counts only the latest scan's finds", async () => {
    await report("gmail:me", { ...gmail, lastScanAt: ago(2), found: 4 });
    await call("/api/sources/scan", { method: "POST", headers: await owner() });
    await env.DB.prepare("UPDATE sources SET scan_requested_at = ? WHERE id = 'gmail:me'").bind(ago(11)).run();
    const list = (await (await call("/api/sources", { headers: await bot() })).json()) as { items: ScanSource[] };
    expect(list.items[0]?.scanRequestedAt).toBeNull();
    expect((await report("gmail:me", { ...gmail, lastScanAt: ago(0) })).lastFound).toBeNull();
  });

  it("says whether a scan request reached Grok Bot", async () => {
    await report("gmail:me", gmail);
    const res = await call("/api/sources/scan", { method: "POST", headers: await owner() });
    const { eventId } = (await res.json()) as { eventId: string };
    expect(eventId).toBeTruthy();
    // The test Worker has a webhook URL, so it's on its way (or there already).
    const delivery = await call(`/api/deliveries/${eventId}`, { headers: await owner() });
    expect(((await delivery.json()) as { state: string }).state).toMatch(/^(sending|delivered)$/);

    // A failed attempt that will be retried says so, with why; one that gave up says failed.
    await env.DB.prepare("UPDATE webhook_outbox SET status = 'pending', attempts = 1, last_error = 'HTTP 401' WHERE event_id = ?").bind(eventId).run();
    expect(await (await call(`/api/deliveries/${eventId}`, { headers: await owner() })).json()).toMatchObject({ state: "retrying", error: "HTTP 401" });
    await env.DB.prepare("UPDATE webhook_outbox SET status = 'dead' WHERE event_id = ?").bind(eventId).run();
    expect(await (await call(`/api/deliveries/${eventId}`, { headers: await owner() })).json()).toMatchObject({ state: "failed" });
    expect((await call("/api/deliveries/nope", { headers: await owner() })).status).toBe(404);
  });

  it("asks nothing when every reported source is paused", async () => {
    await report("gmail:me", gmail);
    await call("/api/sources/gmail:me", { method: "PATCH", headers: await owner(), json: { paused: true } });
    const res = await call("/api/sources/scan", { method: "POST", headers: await owner() });
    expect(await res.json()).toMatchObject({ items: [], eventId: null });
  });

  it("forgets a source for the owner", async () => {
    await report("old", gmail);
    expect((await call("/api/sources/old", { method: "DELETE", headers: await owner() })).status).toBe(200);
    expect((await (await call("/api/sources", { headers: await bot() })).json()) as { items: unknown[] }).toEqual({ items: [] });
  });
});
