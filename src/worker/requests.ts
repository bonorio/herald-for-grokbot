import type { Bot, BotRequest } from "../shared/types";
import { getPref, setPref } from "./prefs";
import type { SenderPatch } from "./schemas";
import type { Actor, Env } from "./env";
import { HttpError, NO_ECHO_ACTORS } from "./notifications";
import { nowIso, uuid } from "./util";

interface RequestRow {
  id: string;
  to_source_id: string;
  to_sender: string;
  text: string;
  in_reply_to: string | null;
  actor: string;
  event_id: string;
  status: BotRequest["status"];
  created_at: string;
  answered_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  delivery: BotRequest["delivery"];
}

function toDto(row: RequestRow): BotRequest {
  return {
    id: row.id,
    toSourceId: row.to_source_id,
    toSender: row.to_sender,
    text: row.text,
    inReplyTo: row.in_reply_to,
    actor: row.actor,
    status: row.status,
    delivery: row.delivery,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
  };
}

const SELECT = `SELECT r.*, o.status AS delivery FROM requests r LEFT JOIN webhook_outbox o ON o.event_id = r.event_id`;

interface SenderRow {
  source_id: string;
  sender: string;
  avatar_url: string | null;
  role: string | null;
  color: string | null;
  status_text: string | null;
  status_state: "working" | "idle" | null;
  status_at: string | null;
  last_at: string | null;
  /** Only read by {@link listBots}. */
  last_note?: string | null;
  /** `{"text","at"}` of the owner's newest request to it, as JSON; only read by {@link listBots}. */
  last_request?: string | null;
  unread: number | null;
}

/** Whichever came last: the bot's newest post or the owner's newest request to it. */
function lastMessage(r: SenderRow): Bot["last"] {
  const note = r.last_note && r.last_at ? { text: r.last_note, at: r.last_at, mine: false } : null;
  const request = r.last_request ? (JSON.parse(r.last_request) as { text: string; at: string }) : null;
  const mine = request ? { ...request, mine: true } : null;
  if (!note || !mine) return note ?? mine;
  return mine.at > note.at ? mine : note;
}

function toBot(r: SenderRow): Bot {
  return {
    sourceId: r.source_id,
    sender: r.sender,
    avatarUrl: r.avatar_url,
    role: r.role,
    color: r.color,
    status: { text: r.status_text, state: r.status_state, at: r.status_at },
    lastAt: r.last_at,
    last: lastMessage(r),
    unread: r.unread ?? 0,
  };
}

const SENDER_SELECT = `SELECT s.*, MAX(n.created_at) AS last_at, SUM(n.status = 'new') AS unread
  FROM senders s LEFT JOIN notifications n ON n.source_id = s.source_id`;

/**
 * Bots that have posted (or been set up) as conversations: whoever spoke last,
 * either way, first, with the main agent pinned on top. Each carries a preview.
 */
export async function listBots(env: Env): Promise<Bot[]> {
  const mainAgentId = getPref<string>(env, "main_agent");
  const { results } = await env.DB.prepare(
    `SELECT *, COALESCE(NULLIF(MAX(COALESCE(last_at, ''), COALESCE(json_extract(last_request, '$.at'), '')), ''), named_at) AS active_at FROM (
       SELECT s.*, MAX(n.created_at) AS last_at, SUM(n.status = 'new') AS unread,
         (SELECT COALESCE(NULLIF(TRIM(x.summary), ''), NULLIF(TRIM(x.title), ''), x.body) FROM notifications x
          WHERE x.source_id = s.source_id ORDER BY x.created_at DESC LIMIT 1) AS last_note,
         (SELECT json_object('text', r.text, 'at', r.created_at) FROM requests r
          WHERE r.to_source_id = s.source_id ORDER BY r.created_at DESC LIMIT 1) AS last_request
       FROM senders s LEFT JOIN notifications n ON n.source_id = s.source_id
       WHERE s.source = 'bot' GROUP BY s.source_id
     ) ORDER BY active_at DESC`,
  ).all<SenderRow>();
  const bots = results.map(toBot);
  const mainId = await mainAgentId;
  const main = bots.find((b) => b.sourceId === mainId);
  const rest = bots.filter((b) => b !== main);
  return main ? [{ ...main, pinned: true }, ...rest] : rest;
}

/**
 * Makes `sourceId` the main agent: pinned first in Chat, where messages go
 * when the owner doesn't pick a bot. Grok Bot names it when it connects (and
 * sets it up if it hasn't posted yet); one the owner picks by hand stays
 * until they change it.
 */
export async function setMainAgent(
  env: Env,
  agent: { sourceId: string; name?: string },
  by: "owner" | "grok-bot",
): Promise<Bot | null> {
  if (by === "grok-bot" && (await getPref<boolean>(env, "main_agent_by_owner"))) return null;
  const bot = agent.name ? await updateSender(env, agent.sourceId, { sender: agent.name }) : await getSender(env, agent.sourceId);
  // Only a bot can be pinned (not one of the owner's own services).
  const isBot = bot && (await env.DB.prepare("SELECT 1 FROM senders WHERE source_id = ? AND source = 'bot'").bind(agent.sourceId).first());
  if (!bot || !isBot) throw new HttpError(404, "No bot with that sourceId");
  // Both at once, so an owner's pick is never saved without the mark that keeps Grok Bot from undoing it.
  const set = (key: string, value: unknown) =>
    env.DB.prepare("INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(value));
  await env.DB.batch(by === "owner" ? [set("main_agent", agent.sourceId), set("main_agent_by_owner", true)] : [set("main_agent", agent.sourceId)]);
  return bot;
}

/** Hands the choice of main agent back to Grok Bot: its next connect names it again. */
export async function releaseMainAgent(env: Env): Promise<void> {
  await setPref(env, "main_agent_by_owner", null);
}

export async function getSender(env: Env, sourceId: string): Promise<Bot | null> {
  const row = await env.DB.prepare(`${SENDER_SELECT} WHERE s.source_id = ? GROUP BY s.source_id`)
    .bind(sourceId)
    .first<SenderRow>();
  return row ? toBot(row) : null;
}

/**
 * Updates a bot's profile and status. Renames apply to all of its
 * notifications at once; a later post under another name renames it again.
 * Naming a bot that hasn't posted yet sets it up, so it can be listed first.
 */
export async function updateSender(env: Env, sourceId: string, patch: SenderPatch): Promise<Bot> {
  const now = nowIso();
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.sender !== undefined) {
    set("sender", patch.sender);
    sets.push("named_at = MAX(named_at, ?)");
    params.push(now);
  }
  if (patch.avatarUrl !== undefined) set("avatar_url", patch.avatarUrl);
  if (patch.role !== undefined) set("role", patch.role);
  if (patch.color !== undefined) set("color", patch.color?.toLowerCase() ?? null);
  if (patch.status !== undefined) {
    set("status_text", patch.status?.text ?? null);
    set("status_state", patch.status?.state ?? null);
    set("status_at", patch.status ? now : null);
  }
  const result = await env.DB.prepare(`UPDATE senders SET ${sets.join(", ")} WHERE source_id = ?`)
    .bind(...params, sourceId)
    .run();
  if (result.meta.changes !== 1) {
    if (patch.sender === undefined) throw new HttpError(404, "No bot with that sourceId; include `sender` to set it up");
    await env.DB.prepare("INSERT INTO senders (source_id, source, sender, named_at) VALUES (?, 'bot', ?, ?) ON CONFLICT DO NOTHING")
      .bind(sourceId, patch.sender, now)
      .run();
    return updateSender(env, sourceId, patch);
  }
  return (await getSender(env, sourceId)) as Bot;
}

export async function listRequests(env: Env, to: string, limit = 100): Promise<BotRequest[]> {
  const { results } = await env.DB.prepare(`${SELECT} WHERE r.to_source_id = ? ORDER BY r.created_at DESC LIMIT ?`)
    .bind(to, limit)
    .all<RequestRow>();
  return results.map(toDto);
}

export async function getRequest(env: Env, id: string): Promise<BotRequest | null> {
  const row = await env.DB.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first<RequestRow>();
  return row ? toDto(row) : null;
}

/**
 * Records a request and queues a `request.created` webhook to Grok Bot, which
 * routes it to the bot named by `to`. The bot answers by posting a
 * notification with this request's id as `requestId`.
 */
export async function createRequest(
  env: Env,
  actor: Actor,
  input: { to: string; text: string; inReplyTo?: string },
): Promise<{ request: BotRequest; eventId: string }> {
  const bot = await getSender(env, input.to);
  if (!bot) throw new HttpError(404, "No bot with that sourceId");
  const id = uuid();
  const eventId = uuid();
  const now = nowIso();
  const request = {
    id,
    to: { sourceId: bot.sourceId, sender: bot.sender },
    text: input.text,
    inReplyTo: input.inReplyTo ?? null,
  };
  const statements = [
    env.DB.prepare(
      `INSERT INTO requests (id, to_source_id, to_sender, text, in_reply_to, actor, event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, bot.sourceId, bot.sender, input.text, request.inReplyTo, actor, eventId, now),
    // The audit log keys every event by its subject; for a request that is the request id.
    env.DB.prepare(
      "INSERT INTO events (id, notification_id, event, actor, payload, created_at) VALUES (?, ?, 'request.created', ?, ?, ?)",
    ).bind(eventId, id, actor, JSON.stringify({ request }), now),
  ];
  if (!NO_ECHO_ACTORS.has(actor)) {
    statements.push(
      env.DB.prepare("INSERT INTO webhook_outbox (id, event_id, body, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        uuid(),
        eventId,
        JSON.stringify({ id: eventId, event: "request.created", occurredAt: now, actor, request }),
        now,
        now,
      ),
    );
  }
  await env.DB.batch(statements);
  return { request: (await getRequest(env, id)) as BotRequest, eventId };
}

/** Grok Bot confirms it picked a request up; the thread shows who did. */
export async function acknowledgeRequest(env: Env, id: string, by: string | null): Promise<BotRequest> {
  const request = await getRequest(env, id);
  if (!request) throw new HttpError(404, "Request not found");
  await env.DB.prepare(
    "UPDATE requests SET acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(?, acknowledged_by) WHERE id = ?",
  )
    .bind(nowIso(), by, id)
    .run();
  return (await getRequest(env, id)) as BotRequest;
}
