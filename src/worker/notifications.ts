import {
  type Action,
  answeringActions,
  type Block,
  DONE_ACTION,
  type EventName,
  type Flag,
  GROK_BOT_ACTOR,
  isExpired,
  type Disposition,
  type Lane,
  type Notification,
  type NotificationPage,
  promptOptions,
  type ResponsePrompt,
  type Status,
  type Subject,
  taskDone,
} from "../shared/types";
import { announceSuggestions, type Resolution, resolveCategories, suggestionStatement } from "./categories";
import type { Actor, Env } from "./env";
import type { NotificationCreate, NotificationPatch } from "./schemas";
import { base64url, fromBase64url, nowIso, uuid } from "./util";

export interface NotificationRow {
  id: string;
  source: Notification["source"];
  source_id: string;
  sender: string;
  avatar_url: string | null;
  title: string | null;
  body: string;
  full_text: string | null;
  url: string | null;
  lane: Lane;
  category: string | null;
  urgent: number;
  kind: Notification["kind"];
  flag: Notification["flag"];
  status: Status;
  response_prompt: string | null;
  response_text: string | null;
  stack_key: string | null;
  idempotency_key: string | null;
  request_id: string | null;
  body_format: Notification["bodyFormat"];
  summary: string | null;
  blocks: string | null;
  quick_replies: string | null;
  streaming: number;
  subject: string | null;
  actions: string | null;
  due_at: string | null;
  response_action: string | null;
  outcome: string | null;
  topic: string | null;
  task: string | null;
  disposition: Notification["disposition"];
  snoozed_until: string | null;
  status_before_snooze: Status | null;
  status_before_dismiss: Status | null;
  version: number;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  dismissed_at: string | null;
  responded_at: string | null;
  /** The agent's current name and avatar from `senders`, when read with {@link SELECT_ROW}. */
  current_sender?: string | null;
  current_avatar?: string | null;
}

/** Notifications with their sender's current name; `n.*` keeps every stored column. */
const SELECT_ROW = `SELECT n.*, s.sender AS current_sender, s.avatar_url AS current_avatar
  FROM notifications n LEFT JOIN senders s ON s.source_id = n.source_id`;

/** Columns a change may write. `id`, `version` and `created_at` are handled separately. */
const MUTABLE = [
  "source_id",
  "sender",
  "avatar_url",
  "title",
  "body",
  "full_text",
  "url",
  "lane",
  "category",
  "urgent",
  "kind",
  "flag",
  "status",
  "response_prompt",
  "response_text",
  "stack_key",
  "body_format",
  "summary",
  "blocks",
  "quick_replies",
  "streaming",
  "subject",
  "actions",
  "due_at",
  "response_action",
  "outcome",
  "topic",
  "task",
  "disposition",
  "snoozed_until",
  "status_before_snooze",
  "status_before_dismiss",
  "updated_at",
  "read_at",
  "dismissed_at",
  "responded_at",
] as const satisfies readonly (keyof NotificationRow)[];

const INSERT_COLUMNS = [
  "id",
  "source",
  "idempotency_key",
  "request_id",
  "version",
  "created_at",
  ...MUTABLE,
] as const satisfies readonly (keyof NotificationRow)[];

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function toDto(row: NotificationRow): Notification {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    sender: row.current_sender ?? row.sender,
    avatarUrl: row.current_avatar ?? row.avatar_url,
    title: row.title,
    body: row.body,
    fullText: row.full_text,
    url: row.url,
    lane: row.lane,
    category: row.category,
    urgent: !!row.urgent,
    kind: row.kind,
    flag: row.flag,
    status: row.status,
    responsePrompt: row.response_prompt ? (JSON.parse(row.response_prompt) as ResponsePrompt) : null,
    responseText: row.response_text,
    stackKey: row.stack_key,
    idempotencyKey: row.idempotency_key,
    requestId: row.request_id,
    bodyFormat: row.body_format ?? "text",
    summary: row.summary,
    blocks: row.blocks ? (JSON.parse(row.blocks) as Block[]) : [],
    quickReplies: row.quick_replies ? (JSON.parse(row.quick_replies) as string[]) : [],
    streaming: !!row.streaming,
    subject: row.subject ? (JSON.parse(row.subject) as Subject) : null,
    actions: row.actions ? (JSON.parse(row.actions) as Action[]) : [],
    dueAt: row.due_at,
    responseAction: row.response_action,
    outcome: row.outcome,
    topic: row.topic,
    task: row.task,
    disposition: row.disposition ?? null,
    snoozedUntil: row.snoozed_until ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    respondedAt: row.responded_at,
  };
}

/** The `notification` object in webhooks to Grok Bot. */
export function webhookNotification(row: NotificationRow) {
  const dto = toDto(row);
  return {
    id: dto.id,
    source: dto.source,
    sourceId: dto.sourceId,
    sender: dto.sender,
    avatarUrl: dto.avatarUrl,
    title: dto.title,
    body: dto.body,
    url: dto.url,
    lane: dto.lane,
    category: dto.category,
    urgent: dto.urgent,
    kind: dto.kind,
    flag: dto.flag,
    status: dto.status,
    response: dto.responseText,
    responseAction: dto.responseAction,
    responsePrompt: dto.responsePrompt,
    stackKey: dto.stackKey,
    requestId: dto.requestId,
    bodyFormat: dto.bodyFormat,
    fullText: dto.fullText,
    summary: dto.summary,
    blocks: dto.blocks,
    streaming: dto.streaming,
    subject: dto.subject,
    actions: dto.actions,
    dueAt: dto.dueAt,
    outcome: dto.outcome,
    topic: dto.topic,
    task: dto.task,
    disposition: dto.disposition,
    snoozedUntil: dto.snoozedUntil,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    dismissedAt: dto.dismissedAt,
    respondedAt: dto.respondedAt,
  };
}

// --- Writing ----------------------------------------------------------------

interface ChangeRecord {
  event: EventName;
  actor: Actor;
  row: NotificationRow;
  extra?: Record<string, unknown>;
}

/**
 * Grok Bot already knows about changes it made with its own key, so they are
 * logged but not sent back to it.
 */
export const NO_ECHO_ACTORS: ReadonlySet<string> = new Set([GROK_BOT_ACTOR, "chief-of-staff"]);

/**
 * Statements that log the change and queue its webhooks. They only run when
 * the statement before them changed a row, so a lost race records nothing.
 */
function changeStatements(env: Env, change: ChangeRecord): { statements: D1PreparedStatement[]; eventId: string } {
  const eventId = uuid();
  const occurredAt = nowIso();
  const notification = webhookNotification(change.row);
  const db = env.DB;
  const statements = [
    db
      .prepare(
        `INSERT INTO events (id, notification_id, event, actor, payload, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      )
      .bind(
        eventId,
        change.row.id,
        change.event,
        change.actor,
        JSON.stringify({ notification, ...change.extra }),
        occurredAt,
      ),
  ];
  if (!NO_ECHO_ACTORS.has(change.actor)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO webhook_outbox (id, event_id, body, next_attempt_at, created_at)
           SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`,
        )
        .bind(
          uuid(),
          eventId,
          // Event details (a reply's text, a dismissal's disposition, an undo, a snooze time) ride along.
          JSON.stringify({ id: eventId, event: change.event, occurredAt, actor: change.actor, ...change.extra, notification }),
          occurredAt,
          occurredAt,
          eventId,
        ),
    );
  }
  return { statements, eventId };
}

export interface CreateOptions {
  source?: Notification["source"];
}

export interface WriteResult {
  row: NotificationRow;
  /** Set when something changed; its webhooks are queued. */
  eventId: string | null;
}

/**
 * The legacy `flag`, kept for older clients: urgent or waiting while the card
 * needs the owner, cleared once it's answered.
 */
export function legacyFlag(row: Pick<NotificationRow, "lane" | "urgent" | "status">): Flag {
  if (row.status === "responded") return "none";
  if (row.urgent) return "urgent";
  return row.lane === "needs_you" ? "awaiting" : "none";
}

/** The lane a write asks for, reading the legacy `flag` when `lane` isn't given. */
function laneFrom(input: Pick<NotificationCreate, "lane" | "flag" | "actions" | "responsePrompt" | "task" | "blocks">): Lane {
  if (input.lane) return input.lane;
  // Anything that asks for an answer, waits on a step elsewhere or puts a to-do on the Tasks tab needs the owner.
  const handoff = input.blocks?.some((b) => b.type === "handoff" && b.state === "waiting");
  if (input.flag === "awaiting" || input.flag === "urgent" || input.actions?.length || input.responsePrompt || input.task || handoff) return "needs_you";
  return "fyi";
}

/** The Tasks-tab line for a card that needs the owner: its title, else the start of its body. */
function defaultTask(row: Pick<NotificationRow, "title" | "body">): string {
  return row.title?.trim() || row.body.slice(0, 160);
}

/**
 * A stack summary describes the stack as the bot saw it, so any change to
 * what's in it clears the summary until the bot writes a new one. Runs only
 * if the notification is (still) at `version`, i.e. the write went through.
 */
function clearSummaries(env: Env, categories: (string | null)[], row: Pick<NotificationRow, "id" | "version">): D1PreparedStatement[] {
  const ids = [...new Set(categories.filter((c): c is string => !!c))];
  if (ids.length === 0) return [];
  return [
    env.DB.prepare(
      `UPDATE categories SET summary = NULL, summary_at = NULL
       WHERE id IN (${ids.map(() => "?").join(", ")}) AND summary IS NOT NULL
         AND EXISTS (SELECT 1 FROM notifications WHERE id = ? AND version = ?)`,
    ).bind(...ids, row.id, row.version),
  ];
}

/** Whether a change moves a card in or out of a stack: its category, lane, or whether it's dismissed or done. */
function changesStack(before: NotificationRow, after: NotificationRow): boolean {
  return (
    before.category !== after.category ||
    before.lane !== after.lane ||
    (before.status === "dismissed") !== (after.status === "dismissed") ||
    (before.status === "responded") !== (after.status === "responded")
  );
}

/** Adds the suggested category a written card names, once the card is in. */
function suggestionFor(env: Env, row: NotificationRow, resolution: Resolution): D1PreparedStatement[] {
  const suggestion = row.category ? resolution.suggestions.get(row.category) : undefined;
  return suggestion ? [suggestionStatement(env, suggestion, row.id)] : [];
}

/**
 * The category name a new card asks for: `category` (null for none), else the
 * legacy `topic`, else one implied by what it's about. A payment goes to
 * Money and an event to Calendar, wherever the owner has renamed or merged them.
 */
export function categoryKey(input: Pick<NotificationCreate, "category" | "topic" | "subject">): string | null {
  if (input.category !== undefined) return input.category;
  if (input.topic) return input.topic;
  if (input.subject?.type === "payment") return "money";
  if (input.subject?.type === "event") return "calendar";
  return null;
}

export function buildRow(
  actor: Actor,
  input: NotificationCreate,
  options: CreateOptions = {},
  resolution: Resolution = { ids: new Map(), suggestions: new Map() },
): NotificationRow {
  const now = nowIso();
  const createdAt = input.createdAt ?? now;
  const status = input.status;
  const lane = laneFrom(input);
  const urgent = input.urgent ?? input.flag === "urgent";
  return {
    id: uuid(),
    source: input.source ?? options.source ?? (actor.startsWith("service:") ? "webhook" : "bot"),
    source_id: input.sourceId,
    sender: input.sender,
    avatar_url: input.avatarUrl ?? null,
    title: input.title ?? null,
    body: input.body,
    full_text: input.fullText ?? null,
    url: input.url ?? null,
    lane,
    category: resolution.ids.get(categoryKey(input) ?? "") ?? null,
    urgent: urgent ? 1 : 0,
    kind: input.kind,
    flag: legacyFlag({ lane, urgent: urgent ? 1 : 0, status }),
    status,
    response_prompt: input.responsePrompt ? JSON.stringify(input.responsePrompt) : null,
    response_text: input.responseText ?? null,
    stack_key: input.stackKey ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    request_id: input.requestId ?? null,
    body_format: input.bodyFormat ?? "text",
    summary: input.summary ?? null,
    blocks: input.blocks?.length ? JSON.stringify(input.blocks) : null,
    quick_replies: input.quickReplies?.length ? JSON.stringify(input.quickReplies) : null,
    streaming: input.streaming ? 1 : 0,
    subject: input.subject ? JSON.stringify(input.subject) : null,
    actions: input.actions?.length ? JSON.stringify(input.actions) : null,
    due_at: input.dueAt ?? null,
    response_action: null,
    outcome: input.outcome ?? null,
    topic: input.topic ?? null,
    task: input.task !== undefined ? input.task : lane === "needs_you" ? defaultTask({ title: input.title ?? null, body: input.body }) : null,
    disposition: null,
    snoozed_until: null,
    status_before_snooze: null,
    status_before_dismiss: status === "dismissed" ? "read" : null,
    version: 0,
    created_at: createdAt,
    updated_at: now,
    read_at: status === "new" ? null : createdAt,
    dismissed_at: status === "dismissed" ? (input.dismissedAt ?? now) : (input.dismissedAt ?? null),
    responded_at: status === "responded" ? (input.respondedAt ?? now) : (input.respondedAt ?? null),
  };
}

/** Marks the request a new notification answers. Runs after the notification's own statements. */
function answerStatement(env: Env, row: NotificationRow): D1PreparedStatement[] {
  if (!row.request_id) return [];
  return [
    env.DB.prepare(
      `UPDATE requests SET status = 'answered', answered_at = ?
       WHERE id = ? AND status = 'sent' AND EXISTS (SELECT 1 FROM notifications WHERE id = ?)`,
    ).bind(row.created_at, row.request_id, row.id),
  ];
}

/**
 * Keeps the agent's name and avatar in `senders` current: the newest post
 * names it. Runs after the insert and only if the insert happened.
 */
function senderStatement(env: Env, row: NotificationRow): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO senders (source_id, source, sender, avatar_url, named_at)
     SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notifications WHERE id = ?)
     ON CONFLICT (source_id) DO UPDATE SET
       sender = CASE WHEN excluded.named_at >= senders.named_at THEN excluded.sender ELSE senders.sender END,
       avatar_url = CASE WHEN excluded.named_at >= senders.named_at
                    THEN COALESCE(excluded.avatar_url, senders.avatar_url)
                    ELSE COALESCE(senders.avatar_url, excluded.avatar_url) END,
       named_at = MAX(senders.named_at, excluded.named_at)`,
  ).bind(row.source_id, row.source, row.sender, row.avatar_url, row.created_at, row.id);
}

function insertStatement(env: Env, row: NotificationRow): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO notifications (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT DO NOTHING`,
  ).bind(...INSERT_COLUMNS.map((column) => row[column]));
}

/**
 * Creates a notification, or returns the existing one when its
 * idempotency key was already used (`eventId` is then null).
 */
export async function createNotification(
  env: Env,
  actor: Actor,
  input: NotificationCreate,
  options: CreateOptions = {},
): Promise<WriteResult> {
  const resolution = await resolveCategories(env, [categoryKey(input)]);
  const row = buildRow(actor, input, options, resolution);
  const { statements, eventId } = changeStatements(env, { event: "notification.created", actor, row });
  const [insert] = await env.DB.batch([
    insertStatement(env, row),
    ...statements,
    ...answerStatement(env, row),
    senderStatement(env, row),
    ...suggestionFor(env, row, resolution),
    ...clearSummaries(env, [row.category], row),
  ]);
  if (insert?.meta.changes === 1) {
    await announceSuggestions(env, actor, resolution.suggestions);
    return { row: (await getRow(env, row.id)) ?? row, eventId };
  }
  const existing = input.idempotencyKey ? await getByIdempotencyKey(env, input.idempotencyKey) : null;
  if (!existing) throw new Error("Insert failed");
  return { row: existing, eventId: null };
}

/** Creates many notifications in one transaction. Existing idempotency keys are skipped. */
export async function createMany(env: Env, actor: Actor, inputs: NotificationCreate[]) {
  const resolution = await resolveCategories(env, inputs.map(categoryKey));
  const rows = inputs.map((input) => buildRow(actor, input, {}, resolution));
  const statements: D1PreparedStatement[] = [];
  const eventIds: string[] = [];
  const insertAt: number[] = [];
  for (const row of rows) {
    const change = changeStatements(env, { event: "notification.created", actor, row });
    insertAt.push(statements.length);
    statements.push(
      insertStatement(env, row),
      ...change.statements,
      ...answerStatement(env, row),
      senderStatement(env, row),
      ...suggestionFor(env, row, resolution),
      ...clearSummaries(env, [row.category], row),
    );
    eventIds.push(change.eventId);
  }
  const results = statements.length ? await env.DB.batch(statements) : [];
  await announceSuggestions(env, actor, resolution.suggestions);
  const out: { row: NotificationRow; created: boolean; eventId: string | null }[] = [];
  for (const [index, row] of rows.entries()) {
    const created = results[insertAt[index] as number]?.meta.changes === 1;
    if (created) {
      out.push({ row, created, eventId: eventIds[index] ?? null });
      continue;
    }
    const existing = row.idempotency_key ? await getByIdempotencyKey(env, row.idempotency_key) : null;
    if (!existing) throw new Error("Insert failed");
    out.push({ row: existing, created, eventId: null });
  }
  return out;
}

type Transition = (row: NotificationRow) =>
  | { next: NotificationRow; event: EventName; extra?: Record<string, unknown> }
  | null;

/**
 * Applies `transition` to the current row. A null transition means nothing
 * changes, so no event or webhook is recorded. Retries if another write won.
 */
async function mutate(
  env: Env,
  actor: Actor,
  id: string,
  transition: Transition,
  /** More statements for the same batch, run after the change is logged. */
  after: (next: NotificationRow) => D1PreparedStatement[] = () => [],
): Promise<WriteResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await getRow(env, id);
    if (!row) throw new HttpError(404, "Notification not found");
    const result = transition(row);
    if (!result) return { row, eventId: null };
    const next = { ...result.next, version: row.version + 1, updated_at: nowIso() };
    next.flag = legacyFlag(next);
    // However it got there: a card that's handled isn't snoozed, and only a dismissed one has a disposition.
    if (next.status === "dismissed" || next.status === "responded") {
      next.snoozed_until = null;
      next.status_before_snooze = null;
    }
    if (next.status !== "dismissed") next.disposition = null;
    const update = env.DB.prepare(
      `UPDATE notifications SET ${MUTABLE.map((c) => `${c} = ?`).join(", ")}, version = ?
       WHERE id = ? AND version = ?`,
    ).bind(...MUTABLE.map((c) => next[c]), next.version, id, row.version);
    const { statements, eventId } = changeStatements(env, {
      event: result.event,
      actor,
      row: next,
      extra: result.extra,
    });
    const restack = changesStack(row, next) ? clearSummaries(env, [row.category, next.category], next) : [];
    const [applied] = await env.DB.batch([update, ...statements, ...after(next), ...restack]);
    if (applied?.meta.changes === 1) return { row: next, eventId };
  }
  throw new HttpError(409, "Notification is changing too fast; try again");
}

export function markRead(env: Env, actor: Actor, id: string) {
  return mutate(env, actor, id, (row) =>
    row.status === "new"
      ? { next: { ...row, status: "read", read_at: nowIso() }, event: "notification.read" }
      : null,
  );
}

/**
 * Dismisses a notification. A `disposition` also asks Grok Bot to do that to
 * the email at its source (archive, trash, mark read, unsubscribe); it rides
 * on the `notification.dismissed` webhook.
 */
export function dismiss(env: Env, actor: Actor, id: string, disposition: Disposition | null = null) {
  return mutate(env, actor, id, (row) => {
    if (row.status === "dismissed") return null;
    // Only an email Grok Bot can find has anything to act on at its source.
    const subject = row.subject ? (JSON.parse(row.subject) as Subject) : null;
    const atSource = subject?.type === "email" && subject.ref ? disposition : null;
    return {
      next: {
        ...row,
        status: "dismissed",
        status_before_dismiss: row.status,
        dismissed_at: nowIso(),
        disposition: atSource,
        // Grok Bot reports what it did at the source here; an older outcome would read as that.
        outcome: atSource ? null : row.outcome,
      },
      event: "notification.dismissed",
      extra: { disposition: atSource },
    };
  });
}

/** Brings a dismissed notification back. If its dismissal did something at the source, the webhook's `undo` asks Grok Bot to reverse it. */
export function restore(env: Env, actor: Actor, id: string) {
  return mutate(env, actor, id, (row) =>
    row.status === "dismissed"
      ? {
          next: {
            ...row,
            status: row.status_before_dismiss ?? "read",
            status_before_dismiss: null,
            dismissed_at: null,
            disposition: null,
            // "Archived in Gmail" no longer holds once the archive is undone.
            outcome: row.disposition ? null : row.outcome,
          },
          event: "notification.restored",
          extra: { undo: row.disposition ? { disposition: row.disposition } : null },
        }
      : null,
  );
}

/**
 * Hides a notification until `until` (see {@link wakeSnoozed}); null wakes it
 * now, as it was before the snooze, e.g. for Undo. Grok Bot hears
 * `notification.snoozed` and may snooze the email at its source too.
 */
export function snooze(env: Env, actor: Actor, id: string, until: string | null, options: { asNew?: boolean } = {}) {
  return mutate(env, actor, id, (row) => {
    if (row.snoozed_until === until) return null;
    if (until && (row.status === "dismissed" || row.status === "responded")) throw new HttpError(409, "It's already handled");
    if (until) {
      return {
        next: {
          ...row,
          snoozed_until: until,
          status_before_snooze: row.snoozed_until ? row.status_before_snooze : row.status,
          status: row.status === "new" ? "read" : row.status,
          read_at: row.read_at ?? nowIso(),
        },
        event: "notification.snoozed",
        extra: { until },
      };
    }
    // Its time came: it's back as new. Woken early: it's as it was.
    const status = options.asNew ? "new" : (row.status_before_snooze ?? row.status);
    return {
      next: { ...row, snoozed_until: null, status_before_snooze: null, status, read_at: status === "new" ? null : row.read_at },
      event: "notification.snoozed",
      extra: { until: null },
    };
  });
}

/**
 * Brings back, as new, notifications whose snooze is over. Run every minute
 * by the cron. During quiet hours only urgent ones wake; the rest wait for
 * quiet hours to end, so they come back with a buzz rather than silently.
 */
export async function wakeSnoozed(env: Env, options: { urgentOnly?: boolean; limit?: number } = {}): Promise<WriteResult[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM notifications
     WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? AND status NOT IN ('dismissed', 'responded') ${options.urgentOnly ? "AND urgent = 1" : ""}
     LIMIT ?`,
  )
    .bind(nowIso(), options.limit ?? 50)
    .all<{ id: string }>();
  const woken: WriteResult[] = [];
  for (const { id } of results) {
    try {
      woken.push(await snooze(env, "herald", id, null, { asNew: true }));
    } catch (error) {
      // One card failing mustn't keep the ones already woken from being announced; it's retried next minute.
      if (!(error instanceof HttpError)) console.error("Couldn't wake", id, error);
    }
  }
  return woken.filter((w) => w.eventId);
}

/**
 * Answers a notification: with text for a prompt, or with one of its actions.
 * A `confirm` action answers with its label; `done` with "Done" unless text is given.
 */
export function respond(env: Env, actor: Actor, id: string, input: { text?: string; action?: string }) {
  return mutate(env, actor, id, (row) => {
    const prompt = row.response_prompt ? (JSON.parse(row.response_prompt) as ResponsePrompt) : null;
    const actions = row.actions ? (JSON.parse(row.actions) as Action[]) : [];
    let text: string;
    const action = input.action ?? null;
    const answered = row.response_text !== null && !!row.responded_at;
    if (action === DONE_ACTION) {
      text = input.text ?? "Done";
    } else if (action !== null) {
      const chosen = answeringActions({ actions }).find((a) => a.id === action);
      if (!chosen) throw new HttpError(400, `Unknown action "${action}"`);
      if (chosen.type === "reply" && !input.text) throw new HttpError(400, "text is required for a reply");
      text = chosen.type === "reply" ? (input.text as string) : chosen.label;
    } else {
      const options = promptOptions(prompt);
      const raw = input.text ?? "";
      text = options.find((o) => o.toLowerCase() === raw.toLowerCase()) ?? raw;
      if (!answered && options.length > 0 && !options.includes(text)) {
        throw new HttpError(400, `Response must be one of: ${options.join(", ")}`);
      }
    }
    if (answered) {
      if (row.response_text === text && row.response_action === action) return null;
      throw new HttpError(409, "Already responded");
    }
    if (action === null && isExpired(prompt)) throw new HttpError(409, "This prompt has expired");
    const respondedAt = nowIso();
    return {
      next: {
        ...row,
        status: "responded",
        flag: "none",
        response_text: text,
        response_action: action,
        responded_at: respondedAt,
        read_at: row.read_at ?? respondedAt,
        dismissed_at: null,
        status_before_dismiss: null,
      },
      event: "notification.responded",
      extra: { text, action },
    };
  });
}

export async function updateNotification(env: Env, actor: Actor, id: string, patch: NotificationPatch) {
  // A legacy `topic` moves the card to that category unless `category` is given too.
  const categoryName = patch.category !== undefined ? patch.category : patch.topic;
  const resolution = await resolveCategories(env, [categoryName]);
  const category = categoryName != null ? (resolution.ids.get(categoryName) ?? null) : categoryName;
  const result = await mutate(env, actor, id, (row) => {
    const next: NotificationRow = { ...row };
    const changes: Record<string, [unknown, unknown]> = {};
    const set = <K extends keyof NotificationRow>(column: K, value: NotificationRow[K], field: string) => {
      if (row[column] === value) return;
      changes[field] = [row[column], value];
      next[column] = value;
    };
    if (patch.sourceId !== undefined) set("source_id", patch.sourceId, "sourceId");
    if (patch.sender !== undefined) set("sender", patch.sender, "sender");
    if (patch.avatarUrl !== undefined) set("avatar_url", patch.avatarUrl, "avatarUrl");
    if (patch.title !== undefined) set("title", patch.title, "title");
    if (patch.body !== undefined) set("body", patch.body, "body");
    if (patch.fullText !== undefined) set("full_text", patch.fullText, "fullText");
    if (patch.url !== undefined) set("url", patch.url, "url");
    if (patch.kind !== undefined) set("kind", patch.kind, "kind");
    // A legacy flag sets the lane and urgency it stands for, unless they're given too.
    if (patch.lane !== undefined) set("lane", patch.lane, "lane");
    else if (patch.flag !== undefined) set("lane", patch.flag === "none" ? "fyi" : "needs_you", "lane");
    if (patch.urgent !== undefined) set("urgent", patch.urgent ? 1 : 0, "urgent");
    else if (patch.flag !== undefined) set("urgent", patch.flag === "urgent" ? 1 : 0, "urgent");
    if (category !== undefined) set("category", category, "category");
    // The Tasks tab follows the lane: a card that comes to need the owner gets a to-do, one that stops doesn't.
    if (patch.task === undefined && next.lane !== row.lane) {
      if (next.lane === "needs_you" && !next.task) set("task", defaultTask(next), "task");
      if (next.lane !== "needs_you" && next.task && !taskDone(row)) set("task", null, "task");
    }
    if (patch.responseText !== undefined) set("response_text", patch.responseText, "responseText");
    if (patch.stackKey !== undefined) set("stack_key", patch.stackKey, "stackKey");
    if (patch.bodyFormat !== undefined) set("body_format", patch.bodyFormat, "bodyFormat");
    if (patch.summary !== undefined) set("summary", patch.summary, "summary");
    if (patch.blocks !== undefined) {
      set("blocks", patch.blocks.length ? JSON.stringify(patch.blocks) : null, "blocks");
      // A handoff drives its card: one that starts waiting brings the card to Needs you, and once
      // every handoff is done the card is done too, unless the patch says otherwise.
      const waiting = (blocks: Block[]) => blocks.some((b) => b.type === "handoff" && b.state === "waiting");
      const before = row.blocks ? (JSON.parse(row.blocks) as Block[]) : [];
      if (waiting(patch.blocks) && patch.lane === undefined && next.lane !== "needs_you" && !taskDone(next)) {
        set("lane", "needs_you", "lane");
        if (patch.task === undefined && !next.task) set("task", defaultTask(next), "task");
      } else if (waiting(before) && !waiting(patch.blocks) && patch.status === undefined && !taskDone(next)) {
        const now = nowIso();
        set("status", "responded", "status");
        next.responded_at = now;
        next.read_at = row.read_at ?? now;
      }
    }
    if (patch.quickReplies !== undefined) {
      set("quick_replies", patch.quickReplies.length ? JSON.stringify(patch.quickReplies) : null, "quickReplies");
    }
    if (patch.subject !== undefined) set("subject", patch.subject ? JSON.stringify(patch.subject) : null, "subject");
    if (patch.actions !== undefined) set("actions", patch.actions.length ? JSON.stringify(patch.actions) : null, "actions");
    if (patch.dueAt !== undefined) set("due_at", patch.dueAt, "dueAt");
    if (patch.outcome !== undefined) set("outcome", patch.outcome, "outcome");
    if (patch.topic !== undefined) set("topic", patch.topic, "topic");
    if (patch.task !== undefined) set("task", patch.task, "task");
    if (patch.responsePrompt !== undefined) {
      set("response_prompt", patch.responsePrompt ? JSON.stringify(patch.responsePrompt) : null, "responsePrompt");
    }
    if (patch.status !== undefined && patch.status !== row.status) {
      const now = nowIso();
      set("status", patch.status, "status");
      if (patch.status === "dismissed") {
        next.status_before_dismiss = row.status;
        next.dismissed_at = now;
      } else {
        next.status_before_dismiss = null;
        next.dismissed_at = null;
      }
      if (patch.status !== "new") next.read_at = row.read_at ?? now;
      else next.read_at = null;
      if (patch.status === "responded") next.responded_at = row.responded_at ?? now;
    }
    if (Object.keys(changes).length === 0) return null;
    return { next, event: "notification.updated", extra: { changes } };
  }, (next) => suggestionFor(env, next, resolution));
  if (result.eventId) await announceSuggestions(env, actor, resolution.suggestions);
  return result;
}

/** The card preview for streamed text: the first lines, without Markdown marks. */
export function previewOf(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[#>*_`~|]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 280 ? `${plain.slice(0, 279)}…` : plain;
}

/**
 * Writes streamed text into `fullText` (and a preview into `body`). Chunks
 * are not events: only the final `done` is logged and sent as a webhook.
 */
export async function streamText(
  env: Env,
  actor: Actor,
  id: string,
  chunk: { append?: string; text?: string; done?: boolean },
): Promise<WriteResult> {
  if (!chunk.done) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await getRow(env, id);
      if (!row) throw new HttpError(404, "Notification not found");
      if (!row.streaming) throw new HttpError(409, "This notification has finished streaming");
      const text = chunk.text ?? `${row.full_text ?? ""}${chunk.append ?? ""}`;
      if (text.length > 100_000) throw new HttpError(400, "Streamed text is too long");
      const next = { ...row, full_text: text, body: previewOf(text) || row.body, version: row.version + 1, updated_at: nowIso() };
      const applied = await env.DB.prepare(
        "UPDATE notifications SET full_text = ?, body = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      )
        .bind(next.full_text, next.body, next.version, next.updated_at, id, row.version)
        .run();
      if (applied.meta.changes === 1) return { row: next, eventId: null };
    }
    throw new HttpError(409, "Notification is changing too fast; try again");
  }
  return mutate(env, actor, id, (row) => {
    const text = chunk.text ?? `${row.full_text ?? ""}${chunk.append ?? ""}`;
    if (!row.streaming && text === (row.full_text ?? "")) return null;
    return {
      next: { ...row, full_text: text, body: previewOf(text) || row.body, streaming: 0 },
      event: "notification.updated",
      extra: { changes: { streaming: [true, false] } },
    };
  });
}

/** Ticks or unticks one checklist item. Grok Bot hears about it as `notification.updated`. */
export function toggleChecklist(env: Env, actor: Actor, id: string, input: { block: number; item: string; done: boolean }) {
  return mutate(env, actor, id, (row) => {
    const blocks = row.blocks ? (JSON.parse(row.blocks) as Block[]) : [];
    const block = blocks[input.block];
    if (block?.type !== "checklist") throw new HttpError(404, "No checklist there");
    const item = block.items.find((i) => i.id === input.item);
    if (!item) throw new HttpError(404, "No such checklist item");
    if (item.done === input.done) return null;
    item.done = input.done;
    return {
      next: { ...row, blocks: JSON.stringify(blocks) },
      event: "notification.updated",
      extra: { changes: { checklist: { block: input.block, item: input.item, done: input.done } } },
    };
  });
}

export async function deleteNotification(env: Env, actor: Actor, id: string): Promise<WriteResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await getRow(env, id);
    if (!row) throw new HttpError(404, "Notification not found");
    const { statements, eventId } = changeStatements(env, { event: "notification.deleted", actor, row });
    const [deleted] = await env.DB.batch([
      env.DB.prepare("DELETE FROM notifications WHERE id = ? AND version = ?").bind(id, row.version),
      ...statements,
      // Its stack lost a card; this runs only once the card is gone.
      ...(row.category
        ? [
            env.DB.prepare(
              "UPDATE categories SET summary = NULL, summary_at = NULL WHERE id = ? AND NOT EXISTS (SELECT 1 FROM notifications WHERE id = ?)",
            ).bind(row.category, id),
          ]
        : []),
    ]);
    if (deleted?.meta.changes === 1) return { row, eventId };
  }
  throw new HttpError(409, "Notification is changing too fast; try again");
}

// --- Reading ----------------------------------------------------------------

export function getRow(env: Env, id: string) {
  return env.DB.prepare(`${SELECT_ROW} WHERE n.id = ?`).bind(id).first<NotificationRow>();
}

export function getByIdempotencyKey(env: Env, key: string) {
  return env.DB.prepare(`${SELECT_ROW} WHERE n.idempotency_key = ?`).bind(key).first<NotificationRow>();
}

export interface ListFilters {
  status?: string[];
  source?: string[];
  sourceId?: string[];
  flag?: string[];
  kind?: string[];
  lane?: string[];
  /** Category ids; `none` matches uncategorized cards. */
  category?: string[];
  since?: string;
  updatedSince?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

function encodeCursor(row: NotificationRow): string {
  return base64url(new TextEncoder().encode(JSON.stringify([row.created_at, row.id])));
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64url(cursor)));
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
      return [value[0], value[1]];
    }
  } catch {}
  throw new HttpError(400, "Invalid cursor");
}

/** Newest first, by `createdAt` then `id`. */
export async function listNotifications(env: Env, filters: ListFilters): Promise<NotificationPage> {
  const where: string[] = [];
  const params: unknown[] = [];
  const inList = (column: string, values?: string[]) => {
    if (!values?.length) return;
    where.push(`n.${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };
  inList("status", filters.status);
  inList("source", filters.source);
  inList("source_id", filters.sourceId);
  inList("flag", filters.flag);
  inList("kind", filters.kind);
  inList("lane", filters.lane);
  if (filters.category?.length) {
    const ids = filters.category.filter((c) => c !== "none");
    const terms = ids.length ? [`n.category IN (${ids.map(() => "?").join(", ")})`] : [];
    if (ids.length < filters.category.length) terms.push("n.category IS NULL");
    where.push(`(${terms.join(" OR ")})`);
    params.push(...ids);
  }
  if (filters.since) {
    where.push("n.created_at >= ?");
    params.push(filters.since);
  }
  if (filters.updatedSince) {
    where.push("n.updated_at >= ?");
    params.push(filters.updatedSince);
  }
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const columns = ["n.title", "n.body", "n.full_text", "n.sender", "s.sender", "n.response_text"];
    where.push(`(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...columns.map(() => like));
  }
  if (filters.cursor) {
    const [createdAt, id] = decodeCursor(filters.cursor);
    where.push("(n.created_at < ? OR (n.created_at = ? AND n.id < ?))");
    params.push(createdAt, createdAt, id);
  }
  const sql = `${SELECT_ROW} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY n.created_at DESC, n.id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql)
    .bind(...params, filters.limit + 1)
    .all<NotificationRow>();
  const page = results.slice(0, filters.limit);
  const last = page.at(-1);
  return {
    items: page.map(toDto),
    nextCursor: results.length > filters.limit && last ? encodeCursor(last) : null,
  };
}
