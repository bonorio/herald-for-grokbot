import type { Env } from "./env";
import { nowIso, randomToken, toHex } from "./util";

/** `Name: value` is sent as that header; a bare value is sent as `Authorization`. */
export function parseAuthHeader(raw: string | undefined): [string, string] | null {
  if (!raw?.trim()) return null;
  const match = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(raw.trim());
  return match ? [match[1] as string, match[2] as string] : ["Authorization", raw.trim()];
}

/** Where Herald sends Grok Bot's webhooks, and how it proves they're from Herald. */
export interface Webhook {
  url: string;
  /** Extra header Grok Bot's endpoint wants, as `[name, value]`. */
  auth: [string, string] | null;
  /** Signs each body (`X-Herald-Signature: sha256=<hex HMAC>`); null when there's none. */
  secret: string | null;
  /** `app`: Grok Bot registered it after connecting in Settings; `env`: set as a Worker secret. */
  via: "app" | "env";
}

/**
 * The connection as stored. Connect makes a pending key and secret; they
 * replace the current ones only when Grok Bot registers with that key, so a
 * reconnect never breaks a working connection.
 */
interface Stored {
  url: string | null;
  authHeader: string | null;
  /** Signs deliveries; the one Grok Bot was given with `keyId`. */
  secret: string | null;
  /** The API key Grok Bot registered with; only it may change the webhook. */
  keyId: string | null;
  pendingSecret: string | null;
  pendingKeyId: string | null;
  connectedAt: string | null;
}

const EMPTY: Stored = { url: null, authHeader: null, secret: null, keyId: null, pendingSecret: null, pendingKeyId: null, connectedAt: null };

async function stored(env: Env): Promise<Stored> {
  const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'webhook'").first<{ value: string }>();
  return { ...EMPTY, ...(row ? (JSON.parse(row.value) as Partial<Stored>) : {}) };
}

async function save(env: Env, value: Stored): Promise<void> {
  await env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('webhook', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(value))
    .run();
}

/**
 * The webhook to deliver to: the one Grok Bot registered through the app,
 * else the Worker's GROK_BOT_WEBHOOK_URL. Null until there is one; deliveries
 * wait in the queue meanwhile.
 */
export async function getWebhook(env: Env): Promise<Webhook | null> {
  const app = await stored(env);
  if (app.url) return { url: app.url, auth: parseAuthHeader(app.authHeader ?? undefined), secret: app.secret, via: "app" };
  if (env.GROK_BOT_WEBHOOK_URL) {
    return { url: env.GROK_BOT_WEBHOOK_URL, auth: parseAuthHeader(env.GROK_BOT_WEBHOOK_AUTH_HEADER), secret: null, via: "env" };
  }
  return null;
}

/** `sha256=<hex>` of the body, keyed with the signing secret. */
export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))}`;
}

/**
 * Starts connecting Grok Bot with a newly issued key: a pending secret goes
 * with it. Webhooks keep going where they go, signed as before, until Grok
 * Bot registers with this key. An earlier pending key that never registered
 * is revoked.
 */
export async function startConnection(env: Env, keyId: string): Promise<string> {
  const current = await stored(env);
  const secret = randomToken("hws");
  if (current.pendingKeyId) await revokeKey(env, current.pendingKeyId);
  await save(env, { ...current, pendingSecret: secret, pendingKeyId: keyId });
  return secret;
}

/**
 * Grok Bot registers where it wants webhooks. With the pending key, that
 * completes a connection: its secret takes over and the previous key is
 * revoked. With the connected key, it just moves the webhook. Any other key
 * is refused, so an old or leaked key can't redirect webhooks.
 */
export async function registerWebhook(env: Env, keyId: string, url: string, authHeader: string | null): Promise<"ok" | "not-started" | "forbidden"> {
  const current = await stored(env);
  if (keyId === current.pendingKeyId && current.pendingSecret) {
    if (current.keyId) await revokeKey(env, current.keyId);
    await save(env, { url, authHeader, secret: current.pendingSecret, keyId, pendingSecret: null, pendingKeyId: null, connectedAt: nowIso() });
    return "ok";
  }
  if (keyId === current.keyId && current.secret) {
    await save(env, { ...current, url, authHeader });
    return "ok";
  }
  return current.pendingKeyId || current.keyId ? "forbidden" : "not-started";
}

/**
 * Stops webhooks to Grok Bot for good: forgets the URL and which keys may
 * register one, so only a new Connect from Settings can turn them back on.
 * Grok Bot's key still posts cards; revoke it under API keys to stop that.
 */
export async function disconnectWebhook(env: Env): Promise<void> {
  const current = await stored(env);
  if (current.pendingKeyId) await revokeKey(env, current.pendingKeyId);
  await save(env, EMPTY);
}

async function revokeKey(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").bind(nowIso(), id).run();
}

/** A URL's host, or the value itself if a hand-set one isn't a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

/** What Settings shows about the connection. Never the secret or the auth header. */
export async function connectionStatus(env: Env) {
  const app = await stored(env);
  const hook = await getWebhook(env);
  return {
    connected: !!hook,
    via: hook?.via ?? null,
    host: hook ? hostOf(hook.url) : null,
    signed: !!hook?.secret,
    connectedAt: app.connectedAt,
    /** Connect was started and Grok Bot hasn't registered with the new key yet. */
    pending: !!app.pendingKeyId,
  };
}

/**
 * The message the owner pastes into Grok Bot to connect it. It holds no
 * secrets: Grok Bot asks the owner for the API key and signing secret through
 * its own secure secrets box, and the owner copies them from Herald.
 */
export function connectionMessage(origin: string): string {
  return [
    "Connect to Herald, my phone app for what you find and do for me.",
    "",
    `Herald: ${origin}`,
    "",
    "1. Ask me for two secrets through your secure secrets box, never in this chat: HERALD_API_KEY and HERALD_SIGNING_SECRET. I'll copy them from Herald. Keep them only in that secrets box (you'll need both every time you talk to Herald), never in chat, memory or notes, and don't repeat them back to me.",
    `2. Read ${origin}/api/agent-guide.md with HERALD_API_KEY (Authorization: Bearer), and read it again before you post; follow it.`,
    "3. Choose your main agent: the one that coordinates the others. Herald pins it first in its Chat tab, so it's who I'll usually talk to. Use the one you already have; if you have none, create one called Chief of Staff.",
    `4. Set up a webhook routine for Herald's events, then register it: PUT ${origin}/api/connect/webhook with {"url": "<the routine's webhook URL>", "chatUrl": "<the link that opens your chat with me>", "mainAgent": {"sourceId": "<its id>", "name": "<its name>"}}. Only if the routine requires a header, add "authHeader": "<Name: value>". Herald sends it with every webhook. You made the routine, so get its webhook URL and header yourself if your tools can (the header straight from your secrets, without showing it). Only if you can't, ask me: the URL in this chat, the header through your secrets box as HERALD_WEBHOOK_AUTH, never in this chat, and tell me exactly where to find each one: which screen to open, what to tap, and that the header is the whole "Name: value" line (for example "Authorization: Bearer …").`,
    "5. Check every webhook: X-Herald-Signature is sha256=<hex HMAC-SHA256 of the raw body, keyed with HERALD_SIGNING_SECRET>. Drop any that don't match.",
    "6. Post as your main agent's sourceId for yourself, and as your other agents' own ids for theirs.",
    "7. Your webhook routine must act on every Herald event the guide lists, not only my requests and card taps: request.created, notification.responded, notification.dismissed (archive or trash in my mail when it has a disposition), notification.restored, notification.snoozed, notification.updated, scan.requested (scan now; an empty sources list means everything you watch for me), source.settings, categories.updated and main_agent.updated.",
    `8. As soon as you're connected, scan the inboxes and calendars you watch for me and report each one with PUT ${origin}/api/sources/{id}, as the guide says. If you don't know which to cover, ask me.`,
    "9. Whenever you need a value from me, say where it is: in Herald (I'll copy it from the Connect Grok Bot step) or in your own app (tell me the screen and the button), and whether it goes in your secrets box or this chat.",
    "10. Do all of this without stopping to ask permission, including briefing your other agents to post as their own ids and adding Herald to the routines that already watch my inboxes and calendars. Ask me only for a value you need or a choice only I can make.",
    "11. When everything's done, send me one short summary: connected (signed), your main agent, which agents now post to Herald, which inboxes and calendars you reported and how often you'll scan each, and anything left for me to do in Herald.",
  ].join("\n");
}
