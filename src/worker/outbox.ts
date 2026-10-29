import { getWebhook, sign, type Webhook } from "./connect";

export { parseAuthHeader } from "./connect";
import type { Env } from "./env";
import { DEFAULT_RETENTION_DAYS } from "../shared/types";
import { pushForEvents } from "./push";
import { addMs, nowIso } from "./util";

/** Wait before retry N (1-based). After the last one the delivery is marked dead (~2.5 days in all). */
export const RETRY_DELAYS_MS = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 43_200_000, 86_400_000,
];
const LOCK_MS = 60_000;
const TIMEOUT_MS = 10_000;

interface OutboxRow {
  id: string;
  event_id: string;
  body: string;
  attempts: number;
}

/** Headers for one delivery: who it's from, which event, and a signature when there's a signing secret. */
async function deliveryHeaders(hook: Webhook, row: OutboxRow): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Herald-Webhooks/1",
    "x-herald-event-id": row.event_id,
    "x-herald-delivery-attempt": String(row.attempts + 1),
  };
  if (hook.auth) headers[hook.auth[0]] = hook.auth[1];
  if (hook.secret) headers["x-herald-signature"] = await sign(hook.secret, row.body);
  return headers;
}

export interface DeliverOptions {
  /** Only deliver these events (right after a write); otherwise everything that is due. */
  eventIds?: string[];
  limit?: number;
  fetch?: typeof fetch;
}

/** Sends due deliveries once each. Never throws for a failed delivery. */
export async function deliverDue(env: Env, options: DeliverOptions = {}): Promise<{ delivered: number; failed: number }> {
  const now = nowIso();
  const eventIds = options.eventIds;
  if (eventIds && eventIds.length === 0) return { delivered: 0, failed: 0 };
  const scope = eventIds ? `AND event_id IN (${eventIds.map(() => "?").join(", ")})` : "";
  // Until Grok Bot has a webhook, deliveries wait in the queue without using up retries.
  const hook = await getWebhook(env);
  if (!hook) return { delivered: 0, failed: 0 };
  const { results } = await env.DB.prepare(
    `SELECT id, event_id, body, attempts FROM webhook_outbox
     WHERE status = 'pending' AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?) ${scope}
     ORDER BY created_at LIMIT ?`,
  )
    .bind(now, now, ...(eventIds ?? []), options.limit ?? 50)
    .all<OutboxRow>();

  let delivered = 0;
  let failed = 0;
  /** Requests show their delivery in the Bots tab, so open dashboards hear when it changes. */
  let requestsChanged = false;
  const send = options.fetch ?? fetch;
  for (const row of results) {
    const claim = await env.DB.prepare(
      `UPDATE webhook_outbox SET locked_until = ?
       WHERE id = ? AND status = 'pending' AND (locked_until IS NULL OR locked_until < ?)`,
    )
      .bind(addMs(nowIso(), LOCK_MS), row.id, nowIso())
      .run();
    if (claim.meta.changes !== 1) continue;

    let status: number | null = null;
    let error: string | null = null;
    try {
      const response = await send(hook.url, {
        method: "POST",
        headers: await deliveryHeaders(hook, row),
        body: row.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
      await response.body?.cancel();
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : "Delivery failed";
    }

    const attempts = row.attempts + 1;
    if (row.body.includes('"event":"request.created"')) requestsChanged = true;
    if (!error) {
      delivered += 1;
      await env.DB.prepare(
        `UPDATE webhook_outbox SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL,
         delivered_at = ?, locked_until = NULL WHERE id = ?`,
      )
        .bind(attempts, status, nowIso(), row.id)
        .run();
      continue;
    }
    failed += 1;
    const delay = RETRY_DELAYS_MS[attempts - 1];
    await env.DB.prepare(
      `UPDATE webhook_outbox SET status = ?, attempts = ?, last_status = ?, last_error = ?,
       next_attempt_at = ?, locked_until = NULL WHERE id = ?`,
    )
      .bind(delay === undefined ? "dead" : "pending", attempts, status, error, addMs(nowIso(), delay ?? 0), row.id)
      .run();
  }
  if (requestsChanged) {
    await env.HUB.getByName("inbox")
      .broadcast(JSON.stringify({ type: "delivery" }))
      .catch(() => undefined);
  }
  return { delivered, failed };
}

const DAY_MS = 86_400_000;

/** Days to keep finished cards, Chat messages and logs: the owner's choice, else 30. Null keeps everything. */
export async function retentionDays(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'retention_days'").first<{ value: string }>();
  return row ? (JSON.parse(row.value) as number | null) : DEFAULT_RETENTION_DAYS;
}

/**
 * Deletes for good what's older than the retention period: cards finished
 * (answered or dismissed) before then, Chat messages sent before then, and
 * log entries and webhooks no longer about anything kept. Cards still in the
 * inbox are never deleted, however old.
 */
async function expire(env: Env, days: number): Promise<void> {
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM notifications WHERE status IN ('responded', 'dismissed')
       AND COALESCE(CASE status WHEN 'dismissed' THEN dismissed_at ELSE responded_at END, updated_at) < ?`,
    ).bind(cutoff),
    // A message a kept card answers stays, so the thread never shows a reply to nothing.
    env.DB.prepare(
      "DELETE FROM requests WHERE created_at < ? AND id NOT IN (SELECT request_id FROM notifications WHERE request_id IS NOT NULL)",
    ).bind(cutoff),
    // Old entries about what's gone: expired cards and messages, and changes to the categories, sources or connection.
    env.DB.prepare(
      `DELETE FROM events WHERE created_at < ?
       AND notification_id NOT IN (SELECT id FROM notifications) AND notification_id NOT IN (SELECT id FROM requests)`,
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM webhook_outbox WHERE event_id NOT IN (SELECT id FROM events)"),
  ]);
}

/**
 * Daily housekeeping: deletes what's past the retention period, delivered
 * webhooks after 30 days, and expired sessions and sign-in challenges.
 */
export async function prune(env: Env): Promise<void> {
  const now = Date.now();
  // A retention run that fails is retried tomorrow; it mustn't stop the rest of the tidy-up.
  try {
    const days = await retentionDays(env);
    if (days) await expire(env, days);
  } catch (error) {
    console.error("Retention failed", error);
  }
  await env.DB.batch([
    // Requests keep theirs: the Bots tab shows each one's delivery.
    env.DB.prepare(
      `DELETE FROM webhook_outbox WHERE status = 'delivered' AND delivered_at < ?
       AND body NOT LIKE '%"event":"request.created"%'`,
    ).bind(
      new Date(now - 30 * DAY_MS).toISOString(),
    ),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date(now).toISOString()),
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(new Date(now).toISOString()),
  ]);
}

/** Run after a write commits: tell open dashboards, buzz the phone, and try the new deliveries right away. */
export async function afterCommit(env: Env, eventIds: (string | null)[]): Promise<void> {
  const ids = eventIds.filter((id): id is string => !!id);
  if (ids.length === 0) return;
  await Promise.allSettled([
    env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "changed", eventIds: ids })),
    pushForEvents(env, ids),
    deliverDue(env, { eventIds: ids }),
  ]);
}

export async function outboxSummary(env: Env) {
  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM webhook_outbox GROUP BY status",
  ).all<{ status: string; n: number }>();
  const failing = await env.DB.prepare(
    `SELECT o.id, o.status, o.attempts, o.last_status, o.last_error, o.next_attempt_at, o.created_at,
            e.event, e.notification_id
     FROM webhook_outbox o JOIN events e ON e.id = o.event_id
     WHERE o.status = 'dead' OR (o.status = 'pending' AND o.attempts > 0)
     ORDER BY o.created_at DESC LIMIT 50`,
  ).all();
  return {
    configured: !!(await getWebhook(env)),
    counts: counts.results,
    failing: failing.results,
  };
}

/** Puts dead deliveries back in the queue. */
export async function retryDead(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    "UPDATE webhook_outbox SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE status = 'dead'",
  )
    .bind(nowIso())
    .run();
  return result.meta.changes;
}
