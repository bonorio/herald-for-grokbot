import { z } from "zod";
import {
  ACTION_TYPES,
  BODY_FORMATS,
  CATEGORY_ICONS,
  DISPOSITIONS,
  DONE_ACTION,
  FLAGS,
  KINDS,
  LANES,
  LIMITS,
  CADENCES,
  SOURCE_KINDS,
  PROMPT_TYPES,
  SOURCES,
  STATUSES,
  SWIPE_ACTIONS,
} from "../shared/types";

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

/** A web link or an app's own link (e.g. `onepassword://…`), but never one that runs script or reads files. */
const appUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const scheme = new URL(value).protocol;
      return /^[a-z][a-z0-9+.-]*:$/.test(scheme) && !["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(scheme);
    } catch {
      return false;
    }
  }, "must be a web or app link");

const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());

export const responsePromptSchema = z
  .object({
    type: z.enum(PROMPT_TYPES),
    options: z.array(z.string().trim().min(1).max(60)).min(1).max(6).optional(),
    placeholder: z.string().max(120).optional(),
    expiresAt: isoDate.optional(),
    correlationId: z.string().trim().min(1).max(100).optional(),
  })
  .refine((p) => p.type !== "options" || (p.options?.length ?? 0) > 0, {
    message: "options prompts need at least one option",
    path: ["options"],
  });

const short = (max: number) => z.string().trim().min(1).max(max);

export const blockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    label: short(80).optional(),
    value: z.number().min(0).max(1),
    detail: short(160).optional(),
  }),
  z.object({
    type: z.literal("facts"),
    title: short(80).optional(),
    items: z.array(z.object({ label: short(40), value: short(200) })).min(1).max(12),
  }),
  z.object({
    type: z.literal("table"),
    title: short(80).optional(),
    columns: z.array(short(40)).min(1).max(6),
    rows: z.array(z.array(z.string().max(120)).max(6)).max(30),
    /** A row to set off, e.g. the recommended option. */
    highlight: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("checklist"),
    title: short(80).optional(),
    items: z.array(z.object({ id: short(40), text: short(200), done: z.boolean().default(false) })).min(1).max(30),
  }),
  z.object({
    type: z.literal("link"),
    url: httpUrl,
    title: short(200),
    description: short(400).optional(),
    imageUrl: httpUrl.optional(),
    site: short(60).optional(),
  }),
  z.object({
    type: z.literal("handoff"),
    /** Where to go, e.g. "1Password" or "Grok Bot". */
    app: short(40),
    /** What it's for, e.g. "Sign in to Acme Rewards". */
    title: short(120),
    /** Opens the place to act: the approval, or the right conversation. */
    url: appUrl,
    site: short(100).optional(),
    detail: short(200).optional(),
    state: z.enum(["waiting", "done"]).default("waiting"),
  }),
]);

export const actionSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "must be lowercase letters, digits, - or _"),
    label: short(24),
    type: z.enum(ACTION_TYPES),
    style: z.enum(["primary", "destructive"]).optional(),
    /** For `reply`: text the composer starts with. */
    draft: z.string().max(4000).optional(),
    placeholder: short(120).optional(),
    /** Required for `open`. */
    url: httpUrl.optional(),
  })
  .refine((a) => a.type !== "open" || a.url, { message: "open actions need a url", path: ["url"] })
  .refine((a) => a.id !== DONE_ACTION, { message: `"${DONE_ACTION}" is built in`, path: ["id"] });

const actionsSchema = z
  .array(actionSchema)
  .max(LIMITS.actions)
  .refine((list) => new Set(list.map((a) => a.id)).size === list.length, "action ids must be unique");

/** Where the email or event lives, so Grok Bot can act on it. */
const sourceRefSchema = z.object({
  provider: short(40),
  account: short(200).optional(),
  threadId: short(200).optional(),
  messageId: short(300).optional(),
  eventId: short(300).optional(),
});

export const subjectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email"),
    from: short(120),
    fromAddress: short(200).optional(),
    subject: short(300),
    snippet: short(600).optional(),
    account: short(200).optional(),
    receivedAt: isoDate.optional(),
    url: httpUrl.optional(),
    ref: sourceRefSchema.optional(),
  }),
  z.object({
    type: z.literal("payment"),
    payee: short(120),
    amount: short(40).optional(),
    account: short(120).optional(),
    url: httpUrl.optional(),
    ref: sourceRefSchema.optional(),
  }),
  z.object({
    type: z.literal("event"),
    name: short(200),
    startsAt: isoDate.optional(),
    location: short(200).optional(),
    url: httpUrl.optional(),
    ref: sourceRefSchema.optional(),
  }),
]);

const fields = {
  sourceId: z.string().trim().min(1).max(100),
  sender: z.string().trim().min(1).max(100),
  avatarUrl: httpUrl.nullable(),
  title: z.string().trim().max(200).nullable(),
  body: z.string().max(2000),
  fullText: z.string().max(100_000).nullable(),
  url: httpUrl.nullable(),
  lane: z.enum(LANES),
  /** A category id or name from GET /api/categories. An unknown name is added as a suggestion. */
  category: short(40).nullable(),
  urgent: z.boolean(),
  kind: z.enum(KINDS),
  flag: z.enum(FLAGS),
  status: z.enum(STATUSES),
  responsePrompt: responsePromptSchema.nullable(),
  responseText: z.string().max(4000).nullable(),
  stackKey: z.string().trim().min(1).max(200).nullable(),
  bodyFormat: z.enum(BODY_FORMATS),
  summary: z.string().trim().max(200).nullable(),
  blocks: z.array(blockSchema).max(LIMITS.blocks),
  quickReplies: z.array(short(40)).max(LIMITS.quickReplies),
  subject: subjectSchema.nullable(),
  actions: actionsSchema,
  dueAt: isoDate.nullable(),
  outcome: z.string().trim().max(200).nullable(),
  topic: short(40).nullable(),
  task: short(160).nullable(),
};

export const notificationCreateSchema = z.object({
  source: z.enum(SOURCES).optional(),
  sourceId: fields.sourceId,
  sender: fields.sender,
  avatarUrl: fields.avatarUrl.optional(),
  title: fields.title.optional(),
  /** Required unless `streaming`. */
  body: fields.body.default(""),
  fullText: fields.fullText.optional(),
  url: fields.url.optional(),
  /** Defaults to `needs_you` when the card has actions or a legacy `flag`, else `fyi`. */
  lane: fields.lane.optional(),
  category: fields.category.optional(),
  urgent: fields.urgent.optional(),
  /** Deprecated: use `lane` and `category`. */
  kind: fields.kind.default("update"),
  /** Deprecated: use `lane` and `urgent`. `awaiting` and `urgent` put the card in `needs_you`. */
  flag: fields.flag.default("none"),
  status: fields.status.default("new"),
  responsePrompt: fields.responsePrompt.optional(),
  responseText: fields.responseText.optional(),
  stackKey: fields.stackKey.optional(),
  bodyFormat: fields.bodyFormat.optional(),
  summary: fields.summary.optional(),
  blocks: fields.blocks.optional(),
  quickReplies: fields.quickReplies.optional(),
  subject: fields.subject.optional(),
  actions: fields.actions.optional(),
  dueAt: fields.dueAt.optional(),
  outcome: fields.outcome.optional(),
  /** Deprecated: use `category`. Resolved to a category when `category` isn't given. */
  topic: fields.topic.optional(),
  /** Defaults to the title for a `needs_you` card; `null` for no task. */
  task: fields.task.optional(),
  /** Create it empty-ish and send the text through the stream endpoint. */
  streaming: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  /** The Bots-tab request this answers. */
  requestId: z.string().trim().min(1).max(100).optional(),
  /** For imports: keep the original timestamps. */
  createdAt: isoDate.optional(),
  dismissedAt: isoDate.optional(),
  respondedAt: isoDate.optional(),
}).refine((n) => n.body.trim() !== "" || n.streaming, { message: "body is required", path: ["body"] });
export type NotificationCreate = z.infer<typeof notificationCreateSchema>;

export const notificationPatchSchema = z
  .object({
    sourceId: fields.sourceId,
    sender: fields.sender,
    avatarUrl: fields.avatarUrl,
    title: fields.title,
    body: fields.body.min(1),
    fullText: fields.fullText,
    url: fields.url,
    lane: fields.lane,
    category: fields.category,
    urgent: fields.urgent,
    kind: fields.kind,
    flag: fields.flag,
    status: fields.status,
    responsePrompt: fields.responsePrompt,
    responseText: fields.responseText,
    stackKey: fields.stackKey,
    bodyFormat: fields.bodyFormat,
    summary: fields.summary,
    blocks: fields.blocks,
    quickReplies: fields.quickReplies,
    subject: fields.subject,
    actions: fields.actions,
    dueAt: fields.dueAt,
    outcome: fields.outcome,
    topic: fields.topic,
    task: fields.task,
  })
  .partial()
  .strict();
export type NotificationPatch = z.infer<typeof notificationPatchSchema>;

export const respondSchema = z
  .object({
    /** Required for prompts and `reply` actions; a `confirm` action answers with its label. */
    text: z.string().trim().min(1).max(4000).optional(),
    /** An action id from `actions`, or `done`. */
    action: z.string().trim().min(1).max(40).optional(),
  })
  .refine((r) => r.text !== undefined || r.action !== undefined, { message: "text is required", path: ["text"] });

export const requestCreateSchema = z.object({
  /** The bot's `sourceId` (agent id). */
  to: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(4000),
  /** A notification this request follows up on. */
  inReplyTo: z.string().trim().min(1).max(100).optional(),
});

export const senderPatchSchema = z
  .object({
    sender: fields.sender,
    avatarUrl: fields.avatarUrl,
    role: z.string().trim().max(120).nullable(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb")
      .nullable(),
    status: z
      .object({ text: z.string().trim().max(160).nullable().optional(), state: z.enum(["working", "idle"]).nullable().optional() })
      .nullable(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");
export type SenderPatch = z.infer<typeof senderPatchSchema>;

export const streamSchema = z
  .object({
    /** Text to add to the end. */
    append: z.string().max(20_000).optional(),
    /** Replaces everything written so far. */
    text: z.string().max(100_000).optional(),
    /** The reply is complete: stops the typing dots and sends the push. */
    done: z.boolean().optional(),
  })
  .refine((s) => s.append !== undefined || s.text !== undefined || s.done, "Nothing to stream");

export const checklistToggleSchema = z.object({
  block: z.number().int().min(0),
  item: z.string().min(1).max(40),
  done: z.boolean(),
});

export const briefingSchema = z.object({ text: z.string().trim().min(1).max(400) });

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM");
export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  start: clock,
  end: clock,
  timeZone: z.string().min(1).max(64).refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "unknown time zone"),
});

const categoryFields = {
  name: short(40).refine((v) => /[a-z0-9]/i.test(v), "needs a letter or digit"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb"),
  icon: z.enum(CATEGORY_ICONS),
};

export const categoryCreateSchema = z.object({
  name: categoryFields.name,
  color: categoryFields.color.optional(),
  icon: categoryFields.icon.optional(),
});

export const categoryPatchSchema = z
  .object({
    name: categoryFields.name,
    color: categoryFields.color,
    icon: categoryFields.icon,
    /** 1-based place among active categories. */
    position: z.number().int().min(1),
    /** Accepts a suggestion. */
    state: z.literal("active"),
    /** What a long swipe left does to an email in this category. */
    swipeAction: z.enum(SWIPE_ACTIONS),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");

export const summarySchema = z.object({ text: z.string().trim().min(1).max(200) });

/** `into: null` removes the category; its cards become uncategorized. */
export const categoryMergeSchema = z.object({ into: z.string().trim().min(1).max(40).nullable() });

/** Grok Bot's main agent: the one pinned in Chat and messaged by default. */
export const mainAgentSchema = z.object({ sourceId: fields.sourceId, name: fields.sender.optional() });

/** The link that opens Grok Bot's own chat (a web or app link); null clears it. */
export const grokLinkSchema = z.object({ url: appUrl.nullable() });

/** A bot's report about an inbox or calendar it watches. */
export const sourceReportSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  label: short(80),
  provider: short(40).nullable().optional(),
  account: short(200).nullable().optional(),
  status: z.enum(["ok", "scanning", "error"]).optional(),
  error: z.string().trim().max(300).nullable().optional(),
  lastScanAt: isoDate.nullable().optional(),
  nextScanAt: isoDate.nullable().optional(),
  found: z.number().int().min(0).nullable().optional(),
});

/** The owner's scan settings for one source. */
export const sourceSettingsSchema = z
  .object({
    cadenceMinutes: z.number().int().refine((m) => (CADENCES as readonly number[]).includes(m), `must be one of ${CADENCES.join(", ")}`),
    paused: z.boolean(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");

export const scanRequestSchema = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(50).optional() });

export const passkeyPatchSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

/** A dismissal that also asks Grok Bot to do this at the source, e.g. archive the email. */
export const dismissSchema = z.object({ disposition: z.enum(DISPOSITIONS).nullable().optional() });
export const dismissManySchema = idsSchema.extend({ disposition: z.enum(DISPOSITIONS).nullable().optional() });

/** `until: null` wakes it now. */
export const snoozeSchema = z.object({
  until: isoDate.refine((v) => new Date(v).getTime() > Date.now(), "must be in the future").nullable(),
});

export const bulkSchema = z
  .object({
    create: z.array(notificationCreateSchema).max(500).default([]),
    update: z
      .array(notificationPatchSchema.extend({ id: z.string().min(1) }))
      .max(500)
      .default([]),
  })
  .refine((b) => b.create.length + b.update.length > 0, "Nothing to do");

export const listQuerySchema = z.object({
  status: z.string().optional(),
  source: z.string().optional(),
  sourceId: z.string().optional(),
  flag: z.string().optional(),
  kind: z.string().optional(),
  lane: z.string().optional(),
  /** Comma-separated category ids; `none` for uncategorized. */
  category: z.string().optional(),
  since: isoDate.optional(),
  updatedSince: isoDate.optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Comma-separated filter values, checked against the allowed set. */
export function csvEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((v) => v.trim()).filter(Boolean);
  for (const part of parts) {
    if (!allowed.includes(part as T)) throw new Error(`Unknown value "${part}"`);
  }
  return parts as T[];
}

export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine((v) => v.startsWith("https://"), "endpoint must be https"),
  keys: z.object({ p256dh: z.string().min(80).max(120), auth: z.string().min(16).max(40) }),
});

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  actor: z
    .string()
    .trim()
    .regex(/^(grok-bot|service:[a-z0-9][a-z0-9._-]{0,63})$/, "actor must be grok-bot or service:<name>"),
});
