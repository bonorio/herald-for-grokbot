import { env as rawEnv, exports } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/worker/env";
import { createSessionToken } from "../src/worker/auth";
import { nowIso, randomToken, sha256, uuid } from "../src/worker/util";

export const env = rawEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

export const ORIGIN = "https://herald.test";

/** Calls the Worker the way a client would. */
export function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return (exports as unknown as { default: Fetcher }).default.fetch(`${ORIGIN}${path}`, { ...init, headers, body });
}

export async function apiKey(actor = "grok-bot"): Promise<string> {
  const key = randomToken("hrd");
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, actor, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(uuid(), "test", actor, key.slice(0, 10), await sha256(key), nowIso())
    .run();
  return key;
}

export async function sessionCookie(): Promise<string> {
  return `herald_session=${await createSessionToken(env)}`;
}

export function outboxRows() {
  return env.DB.prepare(
    `SELECT o.*, e.event, e.actor, e.notification_id FROM webhook_outbox o JOIN events e ON e.id = o.event_id
     ORDER BY o.created_at`,
  ).all<Record<string, unknown> & { body: string; event: string; status: string }>();
}
