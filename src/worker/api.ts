import { Hono } from "hono";
import { z } from "zod";
import { type Disposition, GROK_BOT_ACTOR, FLAGS, KINDS, LANES, RETENTION_CHOICES, SOURCES, STATUSES } from "../shared/types";
import { authenticate, cleanName, currentSessionHash, getOwnerName, OWNER_ACTOR, requireSession } from "./auth";
import { eventStatements } from "./events";
import { getPref, setPref } from "./prefs";
import { createCategory, type CategoryWrite, listCategories, mergeCategory, setSummary, updateCategory } from "./categories";
import type { AppContext } from "./env";
import { connectionMessage, connectionStatus, disconnectWebhook, getWebhook, registerWebhook, startConnection } from "./connect";
import { agentGuide } from "./guide";
import { deleteSource, listSources, reportSource, requestScan, setSourceSettings } from "./sources";
import {
  createMany,
  createNotification,
  deleteNotification,
  dismiss,
  getRow,
  HttpError,
  listNotifications,
  markRead,
  respond,
  restore,
  snooze,
  streamText,
  toDto,
  toggleChecklist,
  updateNotification,
  type WriteResult,
} from "./notifications";
import { afterCommit, deliverDue, outboxSummary, retentionDays, retryDead } from "./outbox";
import { getQuietHours, pushKeys, pushStreamed, sendPush } from "./push";
import { acknowledgeRequest, createRequest, listBots, listRequests, releaseMainAgent, setMainAgent, updateSender } from "./requests";
import {
  apiKeyCreateSchema,
  briefingSchema,
  bulkSchema,
  categoryCreateSchema,
  categoryMergeSchema,
  categoryPatchSchema,
  checklistToggleSchema,
  csvEnum,
  dismissManySchema,
  dismissSchema,
  grokLinkSchema,
  mainAgentSchema,
  idsSchema,
  snoozeSchema,
  scanRequestSchema,
  sourceReportSchema,
  sourceSettingsSchema,
  pushSubscriptionSchema,
  listQuerySchema,
  notificationCreateSchema,
  notificationPatchSchema,
  passkeyPatchSchema,
  requestCreateSchema,
  respondSchema,
  quietHoursSchema,
  senderPatchSchema,
  streamSchema,
  summarySchema,
} from "./schemas";
import { nowIso, randomToken, sha256, uuid } from "./util";

export class ValidationError extends Error {
  constructor(readonly issues: unknown) {
    super("Invalid request");
  }
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(result.error.issues);
  return result.data;
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

export const api = new Hono<AppContext>().use(authenticate);

/** Responds with the notification and kicks off its webhook, if anything changed. */
function written(c: { executionCtx: { waitUntil(promise: Promise<unknown>): void }; env: AppContext["Bindings"] }, result: WriteResult) {
  c.executionCtx.waitUntil(afterCommit(c.env, [result.eventId]));
  return { ...toDto(result.row), changed: result.eventId !== null };
}

api.get("/notifications", async (c) => {
  const query = parse(listQuerySchema, c.req.query());
  let filters;
  try {
    filters = {
      ...query,
      status: csvEnum(query.status, STATUSES),
      source: csvEnum(query.source, SOURCES),
      flag: csvEnum(query.flag, FLAGS),
      kind: csvEnum(query.kind, KINDS),
      lane: csvEnum(query.lane, LANES),
      category: query.category?.split(",").filter(Boolean),
      sourceId: query.sourceId?.split(",").filter(Boolean),
    };
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return c.json(await listNotifications(c.env, filters));
});

api.post("/notifications", async (c) => {
  const body = (await jsonBody(c.req.raw)) as Record<string, unknown>;
  const headerKey = c.req.header("idempotency-key")?.trim();
  const input = parse(notificationCreateSchema, headerKey ? { ...body, idempotencyKey: headerKey } : body);
  const result = await createNotification(c.env, c.get("actor"), input);
  return c.json(written(c, result), result.eventId ? 201 : 200);
});

/** A request body, or an empty object when there isn't one. */
async function optionalBody(request: Request): Promise<unknown> {
  return request.headers.get("content-type")?.includes("json") && request.headers.get("content-length") !== "0" ? jsonBody(request) : {};
}

/**
 * Reads, dismisses or restores many at once, e.g. opening a chat or "Clear all".
 * Each change is its own event, as if done one by one. A dismissal may carry a
 * `disposition` for every email in it, e.g. archiving a whole stack.
 */
for (const [path, action] of [
  ["read", (env, actor, id) => markRead(env, actor, id)],
  ["dismiss", (env, actor, id, disposition) => dismiss(env, actor, id, disposition ?? null)],
  ["restore", (env, actor, id) => restore(env, actor, id)],
] as const satisfies readonly (readonly [string, (env: AppContext["Bindings"], actor: string, id: string, disposition?: Disposition | null) => Promise<WriteResult>])[]) {
  api.post(`/notifications/${path}`, async (c) => {
    // Only a dismissal takes a disposition; read and restore refuse one rather than ignore it.
    const { ids, disposition } = parse(path === "dismiss" ? dismissManySchema : idsSchema.extend({ disposition: z.never().optional() }), await jsonBody(c.req.raw)) as {
      ids: string[];
      disposition?: Disposition | null;
    };
    const actor = c.get("actor");
    const eventIds: (string | null)[] = [];
    const results: { id: string; changed?: boolean; error?: string }[] = [];
    for (const id of new Set(ids)) {
      try {
        const result = await action(c.env, actor, id, disposition);
        eventIds.push(result.eventId);
        results.push({ id, changed: result.eventId !== null });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        results.push({ id, error: error.message });
      }
    }
    c.executionCtx.waitUntil(afterCommit(c.env, eventIds));
    return c.json({ results });
  });
}

api.post("/notifications/bulk", async (c) => {
  const body = parse(bulkSchema, await jsonBody(c.req.raw));
  const actor = c.get("actor");
  const created = await createMany(c.env, actor, body.create);
  const updated: { id: string; changed?: boolean; error?: string }[] = [];
  const eventIds = created.map((r) => r.eventId);
  for (const { id, ...patch } of body.update) {
    try {
      const result = await updateNotification(c.env, actor, id, patch);
      eventIds.push(result.eventId);
      updated.push({ id, changed: result.eventId !== null });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      updated.push({ id, error: error.message });
    }
  }
  c.executionCtx.waitUntil(afterCommit(c.env, eventIds));
  return c.json({
    created: created.map((r) => ({ id: r.row.id, idempotencyKey: r.row.idempotency_key, created: r.created })),
    updated,
  });
});

api.get("/notifications/:id", async (c) => {
  const row = await getRow(c.env, c.req.param("id"));
  if (!row) throw new HttpError(404, "Notification not found");
  return c.json(toDto(row));
});

api.patch("/notifications/:id", async (c) => {
  const patch = parse(notificationPatchSchema, await jsonBody(c.req.raw));
  return c.json(written(c, await updateNotification(c.env, c.get("actor"), c.req.param("id"), patch)));
});

api.delete("/notifications/:id", async (c) => {
  const result = await deleteNotification(c.env, c.get("actor"), c.req.param("id"));
  c.executionCtx.waitUntil(afterCommit(c.env, [result.eventId]));
  return c.json({ ok: true, id: result.row.id });
});

api.post("/notifications/:id/read", async (c) =>
  c.json(written(c, await markRead(c.env, c.get("actor"), c.req.param("id")))),
);
api.post("/notifications/:id/dismiss", async (c) => {
  const { disposition } = parse(dismissSchema, await optionalBody(c.req.raw));
  return c.json(written(c, await dismiss(c.env, c.get("actor"), c.req.param("id"), disposition ?? null)));
});
api.post("/notifications/:id/snooze", async (c) => {
  const { until } = parse(snoozeSchema, await jsonBody(c.req.raw));
  return c.json(written(c, await snooze(c.env, c.get("actor"), c.req.param("id"), until)));
});
api.post("/notifications/:id/restore", async (c) =>
  c.json(written(c, await restore(c.env, c.get("actor"), c.req.param("id")))),
);
api.post("/notifications/:id/respond", async (c) => {
  const input = parse(respondSchema, await jsonBody(c.req.raw));
  return c.json(written(c, await respond(c.env, c.get("actor"), c.req.param("id"), input)));
});

/**
 * Streams a reply into a notification created with `streaming: true`.
 * Open dashboards get each chunk at once; Grok Bot and the phone hear about it when `done`.
 */
api.post("/notifications/:id/stream", async (c) => {
  const chunk = parse(streamSchema, await jsonBody(c.req.raw));
  const result = await streamText(c.env, c.get("actor"), c.req.param("id"), chunk);
  const dto = toDto(result.row);
  const live = c.env.HUB.getByName("inbox").broadcast(
    JSON.stringify({ type: "stream", id: dto.id, body: dto.body, fullText: dto.fullText, streaming: dto.streaming }),
  );
  c.executionCtx.waitUntil(
    Promise.allSettled([live, chunk.done ? afterCommit(c.env, [result.eventId]) : null, chunk.done ? pushStreamed(c.env, result.row) : null]),
  );
  return c.json({ ...dto, changed: result.eventId !== null });
});

api.post("/notifications/:id/checklist", async (c) => {
  const input = parse(checklistToggleSchema, await jsonBody(c.req.raw));
  return c.json(written(c, await toggleChecklist(c.env, c.get("actor"), c.req.param("id"), input)));
});

api.get("/notifications/:id/events", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, event, actor, payload, created_at FROM events WHERE notification_id = ? ORDER BY created_at",
  )
    .bind(c.req.param("id"))
    .all<{ id: string; event: string; actor: string; payload: string; created_at: string }>();
  return c.json({
    items: results.map((e) => ({
      id: e.id,
      event: e.event,
      actor: e.actor,
      payload: JSON.parse(e.payload),
      createdAt: e.created_at,
    })),
  });
});

/**
 * What Grok Bot should read before posting: Herald's live instructions,
 * written from the current category list. The ETag changes when they do.
 */
api.get("/agent-guide.md", async (c) => {
  const text = await agentGuide(c.env, new URL(c.req.url).origin);
  const etag = `"${(await sha256(text)).slice(0, 16)}"`;
  // Revalidate every time, but a matching ETag (weak or in a list, as proxies send them) costs nothing to download.
  const headers = { etag, "cache-control": "private, no-cache" };
  const sent = (c.req.header("if-none-match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (sent.includes(etag) || sent.includes("*")) return c.body(null, 304, headers);
  return c.body(text, 200, { ...headers, "content-type": "text/markdown; charset=utf-8" });
});

// --- Categories: Herald owns the list; bots pick from it -----------------------

api.get("/categories", async (c) => c.json({ items: await listCategories(c.env) }));

/** Tells open dashboards and Grok Bot the list changed. A write that changed nothing has no event and tells no one. */
function categoriesWritten(c: { executionCtx: { waitUntil(promise: Promise<unknown>): void }; env: AppContext["Bindings"] }, result: CategoryWrite) {
  c.executionCtx.waitUntil(afterCommit(c.env, [result.eventId]));
  return result.category;
}

/** A bot's one line about a category's stack on Home, e.g. "4 HOA emails: the vote closes Friday". */
api.put("/categories/:id/summary", async (c) => {
  const { text } = parse(summarySchema, await jsonBody(c.req.raw));
  const category = await setSummary(c.env, c.req.param("id"), text);
  c.executionCtx.waitUntil(c.env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "changed" })));
  return c.json(category);
});

api.delete("/categories/:id/summary", async (c) => {
  const category = await setSummary(c.env, c.req.param("id"), null);
  c.executionCtx.waitUntil(c.env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "changed" })));
  return c.json(category);
});

// --- Connecting Grok Bot ---------------------------------------------------------

/** Where Grok Bot wants webhooks: an https URL (http only for a local dev machine). */
function webhookUrl(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "url is required");
  try {
    const url = new URL(value.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.toString();
  } catch {}
  throw new HttpError(400, "url must be an https URL");
}

/**
 * Grok Bot registers where it wants webhooks, with the key from the
 * connection message. Herald sends a `herald.connected` webhook to check it.
 */
api.put("/connect/webhook", async (c) => {
  // "chief-of-staff" is Grok Bot's key from before migration 0015, should one be used before it runs.
  if (c.get("actor") !== GROK_BOT_ACTOR && c.get("actor") !== "chief-of-staff") {
    throw new HttpError(403, "Only Grok Bot's own key can register its webhook");
  }
  const body = (await jsonBody(c.req.raw)) as { url?: unknown; authHeader?: unknown; chatUrl?: unknown; mainAgent?: unknown };
  // The link that opens Grok Bot's chat, for the Grok Bot ↗ button. Optional: one that isn't a usable link is ignored, never fatal.
  const chat = grokLinkSchema.safeParse({ url: body.chatUrl });
  const chatUrl = chat.success ? chat.data.url : null;
  const url = webhookUrl(body.url);
  const authHeader = typeof body.authHeader === "string" && body.authHeader.trim() ? body.authHeader.trim().slice(0, 500) : null;
  const registered = await registerWebhook(c.env, c.get("keyId") as string, url, authHeader);
  if (registered === "not-started") {
    throw new HttpError(409, "Start from Herald's Settings → Connect Grok Bot, then register with the key it gives you");
  }
  if (registered === "forbidden") throw new HttpError(403, "Register with the key from the latest Connect Grok Bot message");
  // A link the owner set by hand wins over Grok Bot's.
  if (chatUrl && !(await getPref<boolean>(c.env, "grok_link_by_owner"))) await setPref(c.env, "grok_link", chatUrl);
  // Its main agent, pinned in Chat: the one it named, set up now if it hasn't posted yet. Optional, never fatal.
  const main = mainAgentSchema.safeParse(body.mainAgent);
  if (main.success) await setMainAgent(c.env, main.data, "grok-bot").catch(() => null);
  // The owner made the connection, so this one goes to Grok Bot even though Grok Bot called.
  const { statements, eventId } = eventStatements(c.env, {
    subject: "connection",
    event: "herald.connected",
    actor: OWNER_ACTOR,
    payload: { herald: new URL(c.req.url).origin, guide: `${new URL(c.req.url).origin}/api/agent-guide.md` },
  });
  await c.env.DB.batch(statements);
  c.executionCtx.waitUntil(afterCommit(c.env, [eventId]));
  return c.json({ ok: true, ...(await connectionStatus(c.env)) });
});

// --- Inboxes and calendars: what Grok Bot watches and when it last looked -----

api.get("/sources", async (c) => c.json({ items: await listSources(c.env) }));

/** Grok Bot reports an inbox or calendar it watches, and how its last scan went. Sends no webhook. */
api.put("/sources/:id", async (c) => {
  const report = parse(sourceReportSchema, await jsonBody(c.req.raw));
  const source = await reportSource(c.env, c.req.param("id"), report);
  // Only the sources changed: open apps refetch those, not the whole inbox.
  c.executionCtx.waitUntil(c.env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "sources" })));
  return c.json(source);
});

// --- Bots and requests ------------------------------------------------------

api.get("/bots", async (c) => c.json({ items: await listBots(c.env) }));

/** Sets a bot's name, avatar, role, color or live status. A rename applies to all of its notifications at once. */
api.patch("/bots/:sourceId", async (c) => {
  const patch = parse(senderPatchSchema, await jsonBody(c.req.raw));
  const bot = await updateSender(c.env, c.req.param("sourceId"), patch);
  c.executionCtx.waitUntil(c.env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "changed" })));
  return c.json(bot);
});

api.get("/requests", async (c) => {
  const to = c.req.query("to");
  if (!to) throw new HttpError(400, "to is required");
  return c.json({ items: await listRequests(c.env, to) });
});

api.post("/requests", async (c) => {
  const input = parse(requestCreateSchema, await jsonBody(c.req.raw));
  const { request, eventId } = await createRequest(c.env, c.get("actor"), input);
  c.executionCtx.waitUntil(afterCommit(c.env, [eventId]));
  return c.json(request, 201);
});

/** Grok Bot confirms it picked a request up. `by` names the bot handling it. */
api.post("/requests/:id/ack", async (c) => {
  const body = c.req.header("content-type")?.includes("json") ? ((await jsonBody(c.req.raw)) as { by?: unknown }) : {};
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 100) : null;
  const request = await acknowledgeRequest(c.env, c.req.param("id"), by);
  c.executionCtx.waitUntil(c.env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "changed" })));
  return c.json(request);
});

// --- Briefing: the line at the top of Home ------------------------------------

api.get("/briefing", async (c) => {
  const row = await c.env.DB.prepare("SELECT text, actor, updated_at FROM briefing WHERE id = 1").first<{
    text: string;
    actor: string;
    updated_at: string;
  }>();
  return c.json(row ? { text: row.text, actor: row.actor, updatedAt: row.updated_at } : null);
});

api.put("/briefing", async (c) => {
  const { text } = parse(briefingSchema, await jsonBody(c.req.raw));
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO briefing (id, text, actor, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET text = excluded.text, actor = excluded.actor, updated_at = excluded.updated_at`,
  )
    .bind(text, c.get("actor"), now)
    .run();
  c.executionCtx.waitUntil(c.env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "changed" })));
  return c.json({ text, actor: c.get("actor"), updatedAt: now });
});

api.delete("/briefing", async (c) => {
  await c.env.DB.prepare("DELETE FROM briefing WHERE id = 1").run();
  c.executionCtx.waitUntil(c.env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "changed" })));
  return c.json({ ok: true });
});

/** Live updates for open dashboards. */
api.get("/live", async (c) => {
  if (c.req.header("upgrade") !== "websocket") throw new HttpError(400, "Expected a WebSocket");
  return c.env.HUB.getByName("inbox").fetch(c.req.raw);
});

// --- Admin: keys and outbox (signed-in dashboard only) ------------

const admin = new Hono<AppContext>().use(requireSession);

admin.get("/keys", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, actor, prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC",
  ).all();
  return c.json({ items: results });
});

async function issueKey(c: { env: AppContext["Bindings"] }, name: string, actor: string) {
  const key = randomToken("hrd");
  const id = uuid();
  await c.env.DB.prepare(
    "INSERT INTO api_keys (id, name, actor, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, name, actor, key.slice(0, 10), await sha256(key), nowIso())
    .run();
  return { id, name, actor, key };
}

admin.post("/keys", async (c) => {
  const input = parse(apiKeyCreateSchema, await jsonBody(c.req.raw));
  return c.json(await issueKey(c, input.name, input.actor), 201);
});

/** Issues a replacement and revokes the old key at once. */
admin.post("/keys/:id/rotate", async (c) => {
  const old = await c.env.DB.prepare("SELECT name, actor FROM api_keys WHERE id = ? AND revoked_at IS NULL")
    .bind(c.req.param("id"))
    .first<{ name: string; actor: string }>();
  if (!old) throw new HttpError(404, "Key not found");
  const issued = await issueKey(c, old.name, old.actor);
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(nowIso(), c.req.param("id")).run();
  return c.json(issued, 201);
});

admin.delete("/keys/:id", async (c) => {
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
    .bind(nowIso(), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

// --- Admin: passkeys and signed-in devices ------------------------------------

admin.get("/passkeys", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at",
  ).all();
  const sessions = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?")
    .bind(nowIso())
    .first<{ n: number }>();
  return c.json({ items: results, sessions: sessions?.n ?? 0 });
});

admin.patch("/passkeys/:id", async (c) => {
  const { name } = parse(passkeyPatchSchema, await jsonBody(c.req.raw));
  const result = await c.env.DB.prepare("UPDATE passkeys SET name = ? WHERE id = ?").bind(name, c.req.param("id")).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Passkey not found");
  return c.json({ ok: true });
});

/** Removes a passkey. The last one stays, so Herald can't lock its owner out. */
admin.delete("/passkeys/:id", async (c) => {
  const result = await c.env.DB.prepare(
    "DELETE FROM passkeys WHERE id = ? AND (SELECT COUNT(*) FROM passkeys) > 1",
  )
    .bind(c.req.param("id"))
    .run();
  if (result.meta.changes !== 1) {
    const exists = await c.env.DB.prepare("SELECT 1 FROM passkeys WHERE id = ?").bind(c.req.param("id")).first();
    throw exists ? new HttpError(409, "That's your only passkey; add another before removing it") : new HttpError(404, "Passkey not found");
  }
  return c.json({ ok: true });
});

/** Signs out every other device; this one stays signed in. */
admin.post("/sessions/revoke-others", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash <> ?")
    .bind((await currentSessionHash(c)) ?? "")
    .run();
  return c.json({ revoked: result.meta.changes });
});

// Only the owner edits the list. Bots add to it only as suggestions, by naming a category Herald doesn't know.
admin.post("/categories", async (c) => {
  const input = parse(categoryCreateSchema, await jsonBody(c.req.raw));
  return c.json(categoriesWritten(c, await createCategory(c.env, c.get("actor"), input)), 201);
});

admin.patch("/categories/:id", async (c) => {
  const patch = parse(categoryPatchSchema, await jsonBody(c.req.raw));
  return c.json(categoriesWritten(c, await updateCategory(c.env, c.get("actor"), c.req.param("id"), patch)));
});

admin.post("/categories/:id/merge", async (c) => {
  const { into } = parse(categoryMergeSchema, await jsonBody(c.req.raw));
  categoriesWritten(c, await mergeCategory(c.env, c.get("actor"), c.req.param("id"), into));
  return c.json({ ok: true });
});

/** Removes a category. Its cards become uncategorized, and a bot that names it again isn't offered it as a suggestion. */
admin.delete("/categories/:id", async (c) => {
  categoriesWritten(c, await mergeCategory(c.env, c.get("actor"), c.req.param("id"), null));
  return c.json({ ok: true });
});

/** What's left of first-run setup, for the checklist on Home. */
admin.get("/setup", async (c) => {
  const [connection, devices, sources, suggested, hidden, installed, step] = await Promise.all([
    connectionStatus(c.env),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE state = 'suggested'").first<{ n: number }>(),
    c.env.DB.prepare("SELECT 1 FROM prefs WHERE key = 'setup_hidden'").first(),
    c.env.DB.prepare("SELECT 1 FROM prefs WHERE key = 'setup_installed'").first(),
    c.env.DB.prepare("SELECT value FROM prefs WHERE key = 'setup_step'").first<{ value: string }>(),
  ]);
  return c.json({
    connected: connection.connected,
    devices: devices?.n ?? 0,
    sources: sources?.n ?? 0,
    suggestions: suggested?.n ?? 0,
    hidden: !!hidden,
    installed: !!installed,
    /** Where the guided setup was left, so it picks up there; null before it's started. */
    step: step ? (JSON.parse(step.value) as string) : null,
  });
});

/** Remembers which step of the guided setup the owner is on (`done` once they've been through it). */
admin.put("/setup/step", async (c) => {
  const { step } = (await jsonBody(c.req.raw)) as { step?: unknown };
  if (typeof step !== "string" || !/^[a-z-]{1,20}$/.test(step)) throw new HttpError(400, "step is required");
  await setPref(c.env, "setup_step", step);
  return c.json({ step });
});

/** Herald was opened from a Home Screen once, on some device; that step is done everywhere. */
admin.post("/setup/installed", async (c) => {
  await c.env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('setup_installed', 'true') ON CONFLICT (key) DO NOTHING").run();
  return c.json({ ok: true });
});

admin.post("/setup/hide", async (c) => {
  await c.env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('setup_hidden', 'true') ON CONFLICT (key) DO NOTHING").run();
  return c.json({ ok: true });
});

/** How long finished cards, Chat messages and logs are kept before they're deleted for good. */
admin.get("/prefs/retention", async (c) => c.json({ days: await retentionDays(c.env) }));
admin.put("/prefs/retention", async (c) => {
  const { days } = (await jsonBody(c.req.raw)) as { days?: unknown };
  if (!(RETENTION_CHOICES as readonly unknown[]).includes(days)) {
    throw new HttpError(400, `days must be one of ${RETENTION_CHOICES.map((d) => (d === null ? "null (keep everything)" : d)).join(", ")}`);
  }
  await c.env.DB.prepare(
    "INSERT INTO prefs (key, value) VALUES ('retention_days', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(days))
    .run();
  return c.json({ days });
});

/** What the owner is called, for the greeting on Home. Optional; Herald works without it. */
admin.get("/prefs/profile", async (c) => c.json({ name: await getOwnerName(c.env) }));
admin.put("/prefs/profile", async (c) => {
  const body = (await jsonBody(c.req.raw)) as { name?: unknown };
  const name = cleanName(body.name);
  await setPref(c.env, "owner_name", name);
  return c.json({ name });
});

/** Which agent is pinned first in Chat. Picked by hand, it stays until changed by hand. */
admin.put("/prefs/main-agent", async (c) => {
  const { sourceId } = parse(z.object({ sourceId: z.string().trim().min(1).max(100).nullable() }), await jsonBody(c.req.raw));
  // Null hands the choice back to Grok Bot.
  const bot = sourceId === null ? (await releaseMainAgent(c.env), null) : await setMainAgent(c.env, { sourceId }, "owner");
  // Grok Bot hears which agent the owner now treats as its coordinator.
  const { statements, eventId } = eventStatements(c.env, {
    subject: "main-agent",
    event: "main_agent.updated",
    actor: c.get("actor"),
    payload: { mainAgent: sourceId === null ? null : { sourceId, name: bot?.sender ?? null }, chosenBy: sourceId === null ? "grok-bot" : "owner" },
  });
  await c.env.DB.batch(statements);
  c.executionCtx.waitUntil(afterCommit(c.env, [eventId]));
  return c.json(bot);
});

/** Where "Grok Bot ↗" in a chat thread goes: Grok Bot's own chat, for steps that have to happen there. */
admin.get("/prefs/grok-link", async (c) => c.json({ url: await getPref<string>(c.env, "grok_link") }));
admin.put("/prefs/grok-link", async (c) => {
  const { url } = parse(grokLinkSchema, await jsonBody(c.req.raw));
  await setPref(c.env, "grok_link", url);
  // Set by hand, it stays until changed by hand; cleared, Grok Bot's link is welcome again.
  await setPref(c.env, "grok_link_by_owner", url ? true : null);
  return c.json({ url });
});

/** How often to scan an inbox or calendar, or pause it. Grok Bot hears `source.settings`. */
admin.patch("/sources/:id", async (c) => {
  const patch = parse(sourceSettingsSchema, await jsonBody(c.req.raw));
  const { source, eventId } = await setSourceSettings(c.env, c.get("actor"), c.req.param("id"), patch);
  c.executionCtx.waitUntil(afterCommit(c.env, [eventId]));
  return c.json(source);
});

/** Scan now, for some sources or every one that isn't paused. Grok Bot hears `scan.requested`. */
admin.post("/sources/scan", async (c) => {
  const { ids } = parse(scanRequestSchema, await optionalBody(c.req.raw));
  const { sources, eventId } = await requestScan(c.env, c.get("actor"), ids);
  c.executionCtx.waitUntil(afterCommit(c.env, [eventId]));
  // The event id lets the app show whether the request reached Grok Bot.
  return c.json({ items: sources, eventId });
});

/**
 * Whether one webhook reached Grok Bot, as one plain state, so the app can say
 * whether a wait is on Herald or on Grok Bot: `sending`, `retrying` (it
 * failed and will try again; `error` says why), `delivered`, `failed` (gave
 * up), or `not-connected` (no webhook registered, so it waits in the queue).
 */
admin.get("/deliveries/:eventId", async (c) => {
  const row = await c.env.DB.prepare("SELECT status, attempts, last_error, delivered_at FROM webhook_outbox WHERE event_id = ?")
    .bind(c.req.param("eventId"))
    .first<{ status: string; attempts: number; last_error: string | null; delivered_at: string | null }>();
  if (!row) throw new HttpError(404, "No delivery for that event");
  const state =
    row.status === "delivered"
      ? "delivered"
      : row.status === "dead"
        ? "failed"
        : row.attempts > 0
          ? "retrying"
          : (await getWebhook(c.env))
            ? "sending"
            : "not-connected";
  return c.json({ state, deliveredAt: row.delivered_at, error: row.last_error });
});

/** Forgets a source, e.g. an inbox Grok Bot no longer watches. It reappears if Grok Bot reports it again. */
admin.delete("/sources/:id", async (c) => {
  await deleteSource(c.env, c.req.param("id"));
  c.executionCtx.waitUntil(c.env.HUB.getByName("inbox").broadcast(JSON.stringify({ type: "sources" })));
  return c.json({ ok: true });
});

admin.get("/prefs/quiet-hours", async (c) => c.json(await getQuietHours(c.env)));
admin.put("/prefs/quiet-hours", async (c) => {
  const quiet = parse(quietHoursSchema, await jsonBody(c.req.raw));
  await c.env.DB.prepare(
    "INSERT INTO prefs (key, value) VALUES ('quiet_hours', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(quiet))
    .run();
  return c.json(quiet);
});

admin.get("/push", async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  return c.json({ configured: true, publicKey: (await pushKeys(c.env)).publicKey, devices: row?.n ?? 0 });
});

admin.post("/push/subscriptions", async (c) => {
  const sub = parse(pushSubscriptionSchema, await jsonBody(c.req.raw));
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, last_error = NULL`,
  )
    .bind(uuid(), sub.endpoint, sub.keys.p256dh, sub.keys.auth, c.req.header("user-agent")?.slice(0, 200) ?? null, nowIso())
    .run();
  return c.json({ ok: true }, 201);
});

admin.delete("/push/subscriptions", async (c) => {
  const { endpoint } = parse(pushSubscriptionSchema.pick({ endpoint: true }), await jsonBody(c.req.raw));
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  return c.json({ ok: true });
});

admin.post("/push/test", async (c) => {
  return c.json(await sendPush(c.env, { title: "Herald", body: "Notifications are on for this device.", tag: "test" }));
});

/** Whether Grok Bot is connected, where to, and whether webhooks are signed. Never the secrets. */
admin.get("/connect", async (c) => c.json(await connectionStatus(c.env)));

/**
 * Connect Grok Bot: a message for its chat (no secrets in it), plus a fresh
 * API key and signing secret for the owner to copy into Grok Bot's secure
 * secrets box when it asks. Shown once.
 */
admin.post("/connect", async (c) => {
  const origin = new URL(c.req.url).origin;
  const issued = await issueKey(c, "Grok Bot", GROK_BOT_ACTOR);
  const secret = await startConnection(c.env, issued.id);
  // The message has no secrets in it; the key and secret are shown to the owner to copy into Grok Bot's secrets box.
  return c.json({ message: connectionMessage(origin), apiKey: issued.key, signingSecret: secret, keyId: issued.id }, 201);
});

/** Stops sending webhooks to the registered URL (a Worker GROK_BOT_WEBHOOK_URL, if set, takes over). */
admin.delete("/connect/webhook", async (c) => {
  await disconnectWebhook(c.env);
  return c.json(await connectionStatus(c.env));
});

admin.get("/outbox", async (c) => c.json(await outboxSummary(c.env)));
admin.post("/outbox/retry", async (c) => {
  const requeued = await retryDead(c.env);
  c.executionCtx.waitUntil(deliverDue(c.env));
  return c.json({ requeued });
});

api.route("/", admin);
