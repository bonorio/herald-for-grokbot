// Types shared by the Worker API and the web UI.

export const SOURCES = ["bot", "webhook"] as const;
export const KINDS = ["alert", "result", "question", "update"] as const;
export const FLAGS = ["none", "awaiting", "urgent"] as const;
export const STATUSES = ["new", "read", "dismissed", "responded"] as const;
export const PROMPT_TYPES = ["text", "approval", "yes_no", "options"] as const;
/** Limits on what a card carries; the API enforces them and the agent guide quotes them. */
export const LIMITS = { actions: 4, quickReplies: 4, blocks: 8 } as const;
/** Home shows events starting this many days ahead under Up next. Under a week, so a weekday name can't mean today. */
export const UP_NEXT_DAYS = 6;
/** A bot's briefing shows on Home this long before Herald writes its own. */
export const BRIEFING_HOURS = 12;

/** How long finished cards are kept, in days; null keeps everything. 30 unless the owner changes it. */
export const RETENTION_CHOICES = [30, 90, 365, null] as const;
export const DEFAULT_RETENTION_DAYS = 30;

/** How often the owner can have an inbox or calendar scanned, in minutes. */
export const CADENCES = [5, 15, 30, 60, 240] as const;
export const SOURCE_KINDS = ["email", "calendar", "other"] as const;

/** An inbox or calendar Grok Bot watches, as it reports it, with the owner's scan settings. */
export interface ScanSource {
  id: string;
  kind: (typeof SOURCE_KINDS)[number];
  provider: string | null;
  account: string | null;
  label: string;
  status: "ok" | "scanning" | "error";
  lastError: string | null;
  lastScanAt: string | null;
  nextScanAt: string | null;
  lastFound: number | null;
  cadenceMinutes: number;
  paused: boolean;
  /** Set while a Scan now waits for the bot's next report (for up to 10 minutes). */
  scanRequestedAt: string | null;
  /** When it went on its current schedule (unpaused or rescheduled), or else when it was first heard of. */
  watchingSince: string;
  /** Not paused, and no scan for twice its cadence (at least 30 minutes), or its last scan failed. */
  stale: boolean;
}

/** A source is quiet after twice its cadence without a scan, but never sooner than this. */
const MIN_QUIET_MS = 30 * 60_000;

/**
 * Not paused, and either its last scan failed or nothing's been heard for
 * twice its schedule since the later of its last scan and when it was put on
 * that schedule. Shared so the app can re-check on a timer, without a report.
 */
export function isQuiet(
  s: Pick<ScanSource, "paused" | "status" | "lastScanAt" | "cadenceMinutes" | "watchingSince">,
  now = Date.now(),
): boolean {
  if (s.paused) return false;
  if (s.status === "error") return true;
  const since = Math.max(new Date(s.watchingSince).getTime(), s.lastScanAt ? new Date(s.lastScanAt).getTime() : 0);
  return now - since > Math.max(2 * s.cadenceMinutes * 60_000, MIN_QUIET_MS);
}

/** What a dismissal asks Grok Bot to do with the email at its source. */
export const DISPOSITIONS = ["archive", "trash", "read", "unsubscribe"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
/** What a long swipe left does in a category; `none` makes it the same as a short one. */
export const SWIPE_ACTIONS = [...DISPOSITIONS, "none"] as const;
export type SwipeAction = (typeof SWIPE_ACTIONS)[number];

/** What a card wants from the owner: to act, to know, or nothing (a bot already handled it). */
export const LANES = ["needs_you", "fyi", "handled"] as const;
/** Icons a category can use. */
export const CATEGORY_ICONS = [
  "person",
  "briefcase",
  "card",
  "calendar",
  "heart",
  "house",
  "plane",
  "bag",
  "news",
  "tag",
  "bell",
  "star",
] as const;
export const EVENT_NAMES = [
  "notification.created",
  "notification.updated",
  "notification.read",
  "notification.dismissed",
  "notification.restored",
  "notification.snoozed",
  "notification.responded",
  "notification.deleted",
] as const;

export type Source = (typeof SOURCES)[number];
export type Kind = (typeof KINDS)[number];
export type Flag = (typeof FLAGS)[number];
export type Status = (typeof STATUSES)[number];
export type PromptType = (typeof PROMPT_TYPES)[number];
export type EventName = (typeof EVENT_NAMES)[number];
export type Lane = (typeof LANES)[number];
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

/** What a card is about. Herald owns the list; bots pick from it by id or name. */
export interface Category {
  id: string;
  name: string;
  /** `#rrggbb` */
  color: string;
  icon: CategoryIcon;
  position: number;
  /** `suggested`: a bot used a name Herald didn't know; the owner accepts, merges or removes it. */
  state: "active" | "suggested";
  /** Other names that land here, e.g. a merged category or an old name. */
  aliases: string[];
  /** Cards in it that aren't dismissed or snoozed. */
  count: number;
  /** What a long swipe left does to an email in this category. */
  swipeAction: SwipeAction;
  /** A bot's one line about the stack. Cleared when the stack changes. */
  summary: { text: string; at: string } | null;
}

export interface ResponsePrompt {
  type: PromptType;
  /** Button labels. Required for `options`; implied for `approval` and `yes_no`. */
  options?: string[];
  placeholder?: string;
  expiresAt?: string;
  correlationId?: string;
}

export interface Notification {
  id: string;
  source: Source;
  sourceId: string;
  sender: string;
  avatarUrl: string | null;
  title: string | null;
  body: string;
  fullText: string | null;
  url: string | null;
  /** What it wants from the owner. */
  lane: Lane;
  /** A category id, or null when uncategorized. */
  category: string | null;
  urgent: boolean;
  /** Deprecated: use `lane` and `category`. */
  kind: Kind;
  /** Deprecated: worked out from `lane`, `urgent` and `status`. */
  flag: Flag;
  status: Status;
  responsePrompt: ResponsePrompt | null;
  responseText: string | null;
  stackKey: string | null;
  idempotencyKey: string | null;
  /** Set when this notification answers a request sent from the Bots tab. */
  requestId: string | null;
  /** `markdown` renders `fullText` (or `body`) as Markdown. */
  bodyFormat: BodyFormat;
  /** One line for the push banner; falls back to the title and body. */
  summary: string | null;
  /** Typed cards shown under the text. */
  blocks: Block[];
  /** Replies offered as chips in the bot's thread. */
  quickReplies: string[];
  /** True while the bot is still writing; text arrives through the stream endpoint. */
  streaming: boolean;
  /** What this is about, e.g. the email that needs a reply. */
  subject: Subject | null;
  /** What the owner can do about it, as buttons on the card. */
  actions: Action[];
  /** When it has to be handled by. */
  dueAt: string | null;
  /** The action the owner took (`done` for the built-in Done). */
  responseAction: string | null;
  /** What the bot did afterwards, e.g. "Sent 3:42 PM". */
  outcome: string | null;
  /** Deprecated: send `category`. A topic is resolved to a category when the card is written. */
  topic: string | null;
  /** The to-do this card puts on the Tasks tab. Done once the card is answered or dismissed. */
  task: string | null;
  /** What its dismissal asked Grok Bot to do at the source, e.g. archive the email. */
  disposition: Disposition | null;
  /** Hidden until then; it comes back as new. */
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  dismissedAt: string | null;
  respondedAt: string | null;
}

export const BODY_FORMATS = ["text", "markdown"] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** Typed cards a bot can attach. Each has one fixed layout in the app. */
export type Block =
  | { type: "progress"; label?: string; value: number; detail?: string }
  | { type: "facts"; title?: string; items: { label: string; value: string }[] }
  | { type: "table"; title?: string; columns: string[]; rows: string[][]; highlight?: number }
  | { type: "checklist"; title?: string; items: { id: string; text: string; done: boolean }[] }
  | { type: "link"; url: string; title: string; description?: string; imageUrl?: string; site?: string }
  /**
   * A step the owner finishes somewhere else, e.g. approving a login in
   * 1Password or signing in inside Grok Bot's own chat. Herald never handles
   * the credential; it links there and shows whether it's done.
   */
  | { type: "handoff"; app: string; title: string; url: string; site?: string; detail?: string; state: "waiting" | "done" };

export const ACTION_TYPES = ["reply", "confirm", "open"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * A button on a card. `reply` opens a composer (pre-filled with `draft`),
 * `confirm` answers in one tap, `open` follows `url` and answers nothing.
 */
export interface Action {
  id: string;
  label: string;
  type: ActionType;
  style?: "primary" | "destructive";
  draft?: string;
  placeholder?: string;
  url?: string;
}

/** Every actionable card also offers Done, answered with this action id. */
export const DONE_ACTION = "done";

/**
 * Where the thing lives, so Grok Bot can act on it (archive the email,
 * decline the event). Herald only passes it along.
 */
export interface SourceRef {
  /** e.g. `gmail`, `gcal`. */
  provider: string;
  account?: string;
  threadId?: string;
  messageId?: string;
  eventId?: string;
}

/** The thing a notification is about. Each type has its own card header. */
export type Subject =
  | {
      type: "email";
      ref?: SourceRef;
      from: string;
      fromAddress?: string;
      subject: string;
      snippet?: string;
      /** Which inbox it came to. */
      account?: string;
      receivedAt?: string;
      url?: string;
    }
  | { type: "payment"; payee: string; amount?: string; account?: string; url?: string; ref?: SourceRef }
  | { type: "event"; name: string; startsAt?: string; location?: string; url?: string; ref?: SourceRef };

/** What kind of alert a notification is: what it's about, or else its kind. Shown instead of the bot. */
export const ALERT_TYPES = {
  email: { label: "Email", plural: "Emails" },
  payment: { label: "Payment", plural: "Payments" },
  event: { label: "Event", plural: "Events" },
  question: { label: "Question", plural: "Questions" },
  alert: { label: "Alert", plural: "Alerts" },
  result: { label: "Report", plural: "Reports" },
  update: { label: "Update", plural: "Updates" },
} as const;
export type AlertType = keyof typeof ALERT_TYPES;

export function alertType(n: { subject: Subject | null; kind: Kind }): AlertType {
  return n.subject?.type ?? n.kind;
}

/** "Email from Jordan Lee", "Payment to Alex Kim", or just the type. */
export function alertHeading(n: { subject: Subject | null; kind: Kind }): string {
  const s = n.subject;
  if (s?.type === "email") return `Email from ${s.from}`;
  if (s?.type === "payment") return `Payment to ${s.payee}`;
  return ALERT_TYPES[alertType(n)].label;
}

export function taskDone(n: { status: Status }): boolean {
  return n.status === "responded" || n.status === "dismissed";
}

/** On the Tasks tab: it has a to-do, or it's in the Needs you lane (done or not). */
export function isTask(n: { task: string | null; lane: Lane }): boolean {
  return !!n.task || n.lane === "needs_you";
}

/** The Tasks-tab line: the card's to-do, else its title or the start of its body. */
export function taskText(n: { task: string | null; title: string | null; body: string }): string {
  return n.task ?? (n.title?.trim() || n.body.slice(0, 160));
}

/** Waiting on the owner: in the Needs you lane and not yet answered or dismissed. */
export function needsYou(n: { lane: Lane; status: Status }): boolean {
  return n.lane === "needs_you" && !taskDone(n);
}

/** About something to handle: an email, a bill, an event, or anything with actions. */
export function isTransaction(n: { subject: Subject | null; actions: Action[] }): boolean {
  return !!n.subject || (n.actions?.length ?? 0) > 0;
}

/** Actions that answer the notification, i.e. everything but links. */
export function answeringActions(n: { actions: Action[] }): Action[] {
  return (n.actions ?? []).filter((a) => a.type !== "open");
}

export interface NotificationPage {
  items: Notification[];
  nextCursor: string | null;
}

/** Options a prompt offers as buttons; empty for free-text prompts. */
export function promptOptions(prompt: ResponsePrompt | null): string[] {
  if (!prompt) return [];
  if (prompt.type === "approval") return prompt.options ?? ["approve", "deny"];
  if (prompt.type === "yes_no") return prompt.options ?? ["yes", "no"];
  if (prompt.type === "options") return prompt.options ?? [];
  return [];
}

export function isExpired(prompt: ResponsePrompt | null, at = Date.now()): boolean {
  return !!prompt?.expiresAt && new Date(prompt.expiresAt).getTime() <= at;
}

/** A bot in the Chat tab. The main agent is pinned first. */
export interface Bot {
  sourceId: string;
  sender: string;
  avatarUrl: string | null;
  /** One line on what the bot does, e.g. "Flights, hotels and trips". */
  role: string | null;
  /** Accent color, `#rrggbb`. */
  color: string | null;
  /** What it's doing now; `working` shows typing dots in its thread. */
  status: { text: string | null; state: "working" | "idle" | null; at: string | null };
  lastAt: string | null;
  /** The latest message either way, for the chat list. `mine` when it's the owner's request. */
  last: { text: string; at: string; mine: boolean } | null;
  unread: number;
  pinned?: boolean;
}

export interface Briefing {
  text: string;
  actor: string;
  updatedAt: string;
}

export interface QuietHours {
  enabled: boolean;
  /** Local times, `HH:MM`. */
  start: string;
  end: string;
  timeZone: string;
}

/** The actor of Grok Bot's API key, whatever its agents are called. */
export const GROK_BOT_ACTOR = "grok-bot";

export interface BotRequest {
  id: string;
  toSourceId: string;
  toSender: string;
  text: string;
  inReplyTo: string | null;
  actor: string;
  status: "sent" | "answered";
  /** When Grok Bot confirmed it picked the request up, and who did. */
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  /** Delivery to Grok Bot: waiting, delivered or failed (null when not sent, e.g. its own requests). */
  delivery: "pending" | "delivered" | "dead" | null;
  createdAt: string;
  answeredAt: string | null;
}
