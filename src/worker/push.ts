import { ALERT_TYPES, type AlertType, alertHeading, alertType, type Kind, type QuietHours, type Subject } from "../shared/types";
import { OWNER_ACTOR } from "./auth";
import type { Env } from "./env";
import type { NotificationRow } from "./notifications";
import { base64url, nowIso } from "./util";
import { encryptPayload, vapidAuthorization } from "./webpush";

/** A stored row's subject and kind, for its alert type. */
function typed(row: { subject: string | null; kind: Kind }): { subject: Subject | null; kind: Kind } {
  return { subject: row.subject ? (JSON.parse(row.subject) as Subject) : null, kind: row.kind };
}

/** "3 emails, 1 payment". */
function typeCounts(items: { subject: Subject | null; kind: Kind }[]): string[] {
  const counts = new Map<AlertType, number>();
  for (const item of items) counts.set(alertType(item), (counts.get(alertType(item)) ?? 0) + 1);
  return [...counts].map(([type, n]) => `${n} ${(n === 1 ? ALERT_TYPES[type].label : ALERT_TYPES[type].plural).toLowerCase()}`);
}

/** Older than this at creation means an import of past notifications: no buzz. */
const FRESH_MS = 10 * 60 * 1000;
/** More new notifications than this in one write become a single summary push. */
const SUMMARY_OVER = 3;

interface Subscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Opens this notification when tapped. */
  id?: string;
  /** Replaces an earlier push with the same tag. */
  tag?: string;
  /** Home Screen badge count. */
  badge?: number;
  urgent?: boolean;
}

/**
 * The Web Push key pair: from the environment when it's set, otherwise
 * generated on first use and kept in the database, so a new install needs
 * no key setup. Once made, a pair never changes, or devices would have to
 * turn notifications on again.
 */
export async function pushKeys(env: Env): Promise<{ publicKey: string; privateJwk: JsonWebKey }> {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK) {
    return { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey };
  }
  const stored = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'vapid'").first<{ value: string }>();
  if (stored) return JSON.parse(stored.value) as { publicKey: string; privateJwk: JsonWebKey };
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const keys = {
    publicKey: base64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)),
    privateJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
  };
  // Two first uses at once: the first pair written wins, and both read it back.
  await env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('vapid', ?) ON CONFLICT (key) DO NOTHING").bind(JSON.stringify(keys)).run();
  return pushKeys(env);
}

/** Sends to every subscribed device. Expired subscriptions are removed. */
export async function sendPush(env: Env, message: PushMessage, send: typeof fetch = fetch) {
  const { results } = await env.DB.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions").all<Subscription>();
  if (results.length === 0) return { sent: 0, failed: 0 };
  const { publicKey, privateJwk } = await pushKeys(env);
  // Apple rejects VAPID subjects on localhost, so this must be the public site: as set, or as Herald last saw itself.
  const seen = env.PUBLIC_URL ? null : await env.DB.prepare("SELECT value FROM prefs WHERE key = 'public_url'").first<{ value: string }>();
  const subject = env.PUBLIC_URL || (seen ? (JSON.parse(seen.value) as string) : "https://herald.invalid");
  let sent = 0;
  let failed = 0;
  await Promise.all(
    results.map(async (sub) => {
      try {
        const body = await encryptPayload(sub, JSON.stringify(message));
        const response = await send(sub.endpoint, {
          method: "POST",
          headers: {
            authorization: await vapidAuthorization(sub.endpoint, privateJwk, publicKey, subject),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: "86400",
            urgency: message.urgent ? "high" : "normal",
            ...(message.tag ? { topic: topic(message.tag) } : {}),
          },
          body,
        });
        await response.body?.cancel();
        if (response.status === 404 || response.status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
          failed += 1;
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        sent += 1;
        await env.DB.prepare("UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?")
          .bind(nowIso(), sub.id)
          .run();
      } catch (error) {
        failed += 1;
        await env.DB.prepare("UPDATE push_subscriptions SET last_error = ? WHERE id = ?")
          .bind(error instanceof Error ? error.message.slice(0, 200) : "Push failed", sub.id)
          .run();
      }
    }),
  );
  return { sent, failed };
}

/** Push topics are at most 32 URL-safe characters. */
function topic(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

const DEFAULT_QUIET: QuietHours = { enabled: false, start: "22:00", end: "07:00", timeZone: "America/New_York" };

export async function getQuietHours(env: Env): Promise<QuietHours> {
  const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'quiet_hours'").first<{ value: string }>();
  return row ? { ...DEFAULT_QUIET, ...(JSON.parse(row.value) as Partial<QuietHours>) } : DEFAULT_QUIET;
}

/** Minutes since local midnight, and the local date, in `timeZone`. */
export function localClock(at: Date, timeZone: string): { minutes: number; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
}

const toMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** True inside quiet hours. The window may cross midnight. */
export function isQuiet(quiet: QuietHours, at = new Date()): boolean {
  if (!quiet.enabled) return false;
  const now = localClock(at, quiet.timeZone).minutes;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

interface PushRow extends NotificationRow {
  display_sender: string;
}

/** The banner line: the bot's summary if it wrote one, else the title and body. */
function bannerText(n: NotificationRow): string {
  if (n.summary) return n.summary;
  return n.title ? `${n.title}\n${n.body}` : n.body;
}

/**
 * Buzzes the phone for notifications created by bots and services. The owner's
 * own changes, imports of old items and anything already read stay quiet.
 * During quiet hours only urgent items buzz; the rest wait for the morning
 * summary. Replies still streaming buzz when they finish instead.
 */
/** Whether any device has notifications on; when none has, there's nothing to work out. */
async function anyDevice(env: Env): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM push_subscriptions LIMIT 1").first());
}

export async function pushForEvents(env: Env, eventIds: string[], send: typeof fetch = fetch) {
  if (eventIds.length === 0 || !(await anyDevice(env))) return;
  const { results } = await env.DB.prepare(
    `SELECT n.*, COALESCE(s.sender, n.sender) AS display_sender
     FROM events e JOIN notifications n ON n.id = e.notification_id LEFT JOIN senders s ON s.source_id = n.source_id
     WHERE e.id IN (${eventIds.map(() => "?").join(", ")})
       AND e.event = 'notification.created' AND e.actor <> ? AND n.status = 'new' AND n.streaming = 0
     ORDER BY n.created_at DESC`,
  )
    .bind(...eventIds, OWNER_ACTOR)
    .all<PushRow>();
  let fresh = results.filter((n) => Date.now() - new Date(n.created_at).getTime() < FRESH_MS);
  if (fresh.length && isQuiet(await getQuietHours(env))) fresh = fresh.filter((n) => !!n.urgent);
  if (fresh.length === 0) return;
  const badge = await unreadCount(env, fresh.length);
  if (fresh.length > SUMMARY_OVER) {
    await sendPush(
      env,
      {
        title: `${fresh.length} new notifications`,
        body: typeCounts(fresh.map(typed)).join(", "),
        tag: "summary",
        badge,
        urgent: fresh.some((n) => !!n.urgent),
      },
      send,
    );
    return;
  }
  for (const n of fresh) await pushOne(env, n, badge, send);
}

async function unreadCount(env: Env, fallback: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE status = 'new'").first<{ n: number }>();
  return row?.n ?? fallback;
}

/**
 * One push for one notification. When the same bot already has other unread
 * items from the last hour, the push replaces its earlier one and says how many.
 */
async function pushOne(env: Env, n: PushRow, badge: number, send: typeof fetch = fetch) {
  const type = alertType(typed(n));
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications
     WHERE COALESCE(json_extract(subject, '$.type'), kind) = ? AND status = 'new' AND created_at > ?`,
  )
    .bind(type, new Date(Date.now() - 3_600_000).toISOString())
    .first<{ n: number }>();
  const count = recent?.n ?? 1;
  await sendPush(
    env,
    {
      title: count > 1 ? `${ALERT_TYPES[type].plural} · ${count} new` : alertHeading(typed(n)),
      body: bannerText(n),
      id: n.id,
      tag: count > 1 ? `type-${type}` : n.id,
      badge,
      urgent: !!n.urgent,
    },
    send,
  );
}

/** A streamed reply finished: buzz now, as a new notification would have. */
export async function pushStreamed(env: Env, row: NotificationRow, send: typeof fetch = fetch) {
  if (row.status !== "new" || !(await anyDevice(env))) return;
  const created = await env.DB.prepare(
    `SELECT n.*, COALESCE(s.sender, n.sender) AS display_sender FROM notifications n
     JOIN events e ON e.notification_id = n.id AND e.event = 'notification.created' AND e.actor <> ?
     LEFT JOIN senders s ON s.source_id = n.source_id WHERE n.id = ?`,
  )
    .bind(OWNER_ACTOR, row.id)
    .first<PushRow>();
  if (!created || Date.now() - new Date(created.created_at).getTime() > 60 * 60_000) return;
  if (!created.urgent && isQuiet(await getQuietHours(env))) return;
  await pushOne(env, created, await unreadCount(env, 1), send);
}

/** A snoozed notification is back: buzz like a new one, unless it's quiet hours and it isn't urgent. */
export async function pushWoken(env: Env, rows: NotificationRow[], at = new Date(), send: typeof fetch = fetch) {
  if (rows.length === 0 || !(await anyDevice(env))) return;
  // The same moment the wake used, so the two never disagree about quiet hours.
  const quiet = isQuiet(await getQuietHours(env), at);
  const due = rows.filter((r) => r.urgent || !quiet);
  if (due.length === 0) return;
  const badge = await unreadCount(env, due.length);
  if (due.length > SUMMARY_OVER) {
    await sendPush(env, { title: `${due.length} snoozed cards are back`, body: due.map(bannerText).slice(0, 3).join(" · "), tag: "woken", badge }, send);
    return;
  }
  for (const n of due) {
    await sendPush(env, { title: "Snoozed · back now", body: bannerText(n), id: n.id, tag: n.id, badge, urgent: !!n.urgent }, send);
  }
}

/**
 * At the end of quiet hours, one push for what came in overnight. Runs from
 * the minute cron; sends at most once per local day.
 */
export async function morningSummary(env: Env, at = new Date(), send: typeof fetch = fetch, woken = 0): Promise<boolean> {
  const quiet = await getQuietHours(env);
  if (!quiet.enabled || !(await anyDevice(env))) return false;
  const local = localClock(at, quiet.timeZone);
  if (local.minutes !== toMinutes(quiet.end)) return false;
  const claimed = await env.DB.prepare(
    `INSERT INTO prefs (key, value) VALUES ('morning_summary_sent', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE prefs.value <> excluded.value`,
  )
    .bind(local.date)
    .run();
  if (claimed.meta.changes !== 1) return false;
  const length = (toMinutes(quiet.end) - toMinutes(quiet.start) + 1440) % 1440;
  const since = new Date(at.getTime() - length * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT n.subject, n.kind, n.lane FROM notifications n
     WHERE n.status = 'new' AND n.created_at >= ? ORDER BY n.created_at DESC`,
  )
    .bind(since)
    .all<{ subject: string | null; kind: Kind; lane: string }>();
  if (results.length === 0 && woken === 0) return false;
  const needs = results.filter((r) => r.lane === "needs_you").length;
  const types = typeCounts(results.map(typed));
  // Snoozed cards that waited out quiet hours ride along, so the morning is one buzz.
  const parts = [
    results.length ? `${results.length} new overnight${needs ? `, ${needs} need${needs === 1 ? "s" : ""} you` : ""}` : null,
    woken ? `${woken} snoozed back` : null,
  ].filter(Boolean);
  await sendPush(
    env,
    {
      title: "Good morning",
      body: `${parts.join(", ")}${types.length ? ` · ${types.join(", ")}` : ""}`,
      tag: "morning",
      badge: await unreadCount(env, results.length + woken),
    },
    send,
  );
  return true;
}
