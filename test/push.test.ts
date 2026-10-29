import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotification } from "../src/worker/notifications";
import { pushForEvents } from "../src/worker/push";
import { apiKey, call, env, ORIGIN, sessionCookie } from "./helpers";

const b64u = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** A fake phone: a real P-256 key pair and auth secret, like a browser's push subscription. */
async function device(endpoint: string) {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint, keys, publicRaw, auth, subscription: { endpoint, keys: { p256dh: b64u(publicRaw), auth: b64u(auth) } } };
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
}

/** Decrypts an RFC 8291 (aes128gcm) push body the way the phone would. */
async function decrypt(phone: Awaited<ReturnType<typeof device>>, body: ArrayBuffer): Promise<unknown> {
  const bytes = new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const idLength = bytes[20]!;
  const serverPublic = bytes.slice(21, 21 + idLength);
  const ciphertext = bytes.slice(21 + idLength);
  const serverKey = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, phone.keys.privateKey, 256);
  const text = new TextEncoder();
  const keyInfo = new Uint8Array([...text.encode("WebPush: info\0"), ...phone.publicRaw, ...serverPublic]);
  const ikm = await hkdf(phone.auth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext));
  const end = plain.lastIndexOf(2); // padding delimiter for the last record
  return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
}

let sent: { url: string; headers: Headers; body: ArrayBuffer }[];
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
  sent = [];
});
afterEach(() => vi.restoreAllMocks());

const fakeSend = (status = 201) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body as ArrayBuffer });
    return new Response(null, { status });
  }) as typeof fetch;

async function subscribe(phone: Awaited<ReturnType<typeof device>>) {
  const res = await call("/api/push/subscriptions", {
    method: "POST",
    headers: { cookie: await sessionCookie(), origin: ORIGIN },
    json: phone.subscription,
  });
  expect(res.status).toBe(201);
}

const base = { sourceId: "travel", sender: "Travel Agent", body: "Flight moved to 7:05", kind: "update", flag: "none", status: "new" } as const;

describe("push", () => {
  it("sends an encrypted, VAPID-signed push for a new bot notification", async () => {
    const phone = await device("https://push.test/phone-1");
    await subscribe(phone);
    const { eventId, row } = await createNotification(env, "grok-bot", { ...base, title: "Denver trip", flag: "urgent" });
    await pushForEvents(env, [eventId!], fakeSend());

    expect(sent).toHaveLength(1);
    const push = sent[0]!;
    expect(push.url).toBe("https://push.test/phone-1");
    expect(push.headers.get("content-encoding")).toBe("aes128gcm");
    expect(push.headers.get("urgency")).toBe("high");
    expect(push.headers.get("authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(push.headers.get("authorization")).toContain(`k=${env.VAPID_PUBLIC_KEY}`);

    // The VAPID token is for this push service and signed by our key.
    const jwt = /t=([^,]+)/.exec(push.headers.get("authorization")!)![1]!;
    const [h, c, sig] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(fromB64u(c)))).toMatchObject({ aud: "https://push.test" });
    const vapidKey = await crypto.subtle.importKey("raw", fromB64u(env.VAPID_PUBLIC_KEY!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapidKey, fromB64u(sig), new TextEncoder().encode(`${h}.${c}`));
    expect(valid).toBe(true);

    expect(await decrypt(phone, push.body)).toMatchObject({
      title: "Update",
      body: "Denver trip\nFlight moved to 7:05",
      id: row.id,
      urgent: true,
    });
  });

  it("stays quiet for the owner's own changes and for imported history", async () => {
    await subscribe(await device("https://push.test/phone-2"));
    const mine = await createNotification(env, "owner", base);
    const old = await createNotification(env, "grok-bot", { ...base, createdAt: "2026-01-01T00:00:00.000Z" });
    const read = await createNotification(env, "grok-bot", { ...base, status: "read" });
    await pushForEvents(env, [mine.eventId!, old.eventId!, read.eventId!], fakeSend());
    expect(sent).toHaveLength(0);
  });

  it("sends one summary for a burst", async () => {
    const phone = await device("https://push.test/phone-3");
    await subscribe(phone);
    const ids: string[] = [];
    for (const sender of ["A", "B", "C", "D", "E"]) {
      ids.push((await createNotification(env, "grok-bot", { ...base, sender })).eventId!);
    }
    await pushForEvents(env, ids, fakeSend());
    expect(sent).toHaveLength(1);
    expect(await decrypt(phone, sent[0]!.body)).toMatchObject({ title: "5 new notifications", tag: "summary" });
  });

  it("forgets devices the push service says are gone", async () => {
    await subscribe(await device("https://push.test/phone-4"));
    const { eventId } = await createNotification(env, "grok-bot", base);
    await pushForEvents(env, [eventId!], fakeSend(410));
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("only lets the signed-in dashboard manage subscriptions", async () => {
    const key = await apiKey();
    const res = await call("/api/push/subscriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      json: (await device("https://push.test/phone-5")).subscription,
    });
    expect(res.status).toBe(403);
  });
});

describe("rate limits", () => {
  it("caps sign-in attempts per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await call("/auth/register/options", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.7" },
        json: { setupCode: "wrong" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another IP is unaffected.
    const other = await call("/auth/register/options", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.8" },
      json: { setupCode: "wrong" },
    });
    expect(other.status).toBe(403);
  });

  it("caps failed API authentication per IP", async () => {
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await call("/api/notifications", {
        headers: { authorization: "Bearer hrd_guess", "cf-connecting-ip": "203.0.113.9" },
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
