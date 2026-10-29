import { z } from "zod";
import { CATEGORY_ICONS, DISPOSITIONS, EVENT_NAMES, FLAGS, KINDS, LANES, SOURCES, STATUSES, SWIPE_ACTIONS } from "../shared/types";
import {
  bulkSchema,
  categoryCreateSchema,
  categoryMergeSchema,
  categoryPatchSchema,
  requestCreateSchema,
  senderPatchSchema,
  streamSchema,
  summarySchema,
  checklistToggleSchema,
  briefingSchema,
  dismissManySchema,
  dismissSchema,
  idsSchema,
  notificationCreateSchema,
  snoozeSchema,
  scanRequestSchema,
  sourceReportSchema,
  sourceSettingsSchema,
  notificationPatchSchema,
  actionSchema,
  respondSchema,
  subjectSchema,
  responsePromptSchema,
} from "./schemas";

const schema = (s: z.ZodType) => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  return rest;
};

const nullableString = { type: ["string", "null"] };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (s: object) => ({ "application/json": { schema: s } });
const error = { description: "Error", content: json(ref("Error")) };
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };

function action(summary: string, description: string, body?: object) {
  return {
    post: {
      tags: ["Actions"],
      summary,
      description,
      parameters: [idParam],
      ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
      responses: { "200": { description: "The notification", content: json(ref("NotificationResult")) }, "404": error },
    },
  };
}

export function openApiSpec(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Herald",
      version: "1.0.0",
      description: [
        "A notification center for one owner. Every write records an actor taken from the API key or session.",
        "Bots: read GET /api/agent-guide.md before posting. It is Herald's live instructions (lanes, the category list, handoffs, what to do with each webhook) and changes when Herald does.",
        "Writes by the owner and by services send a webhook to Grok Bot through a retrying outbox;",
        "writes made with Grok Bot's own key (actor grok-bot) are logged but not sent back.",
        "",
        "Actions are idempotent: dismissing an already dismissed notification changes nothing,",
        "returns `changed: false`, and sends no webhook.",
      ].join("\n"),
    },
    servers: [{ url: origin }],
    security: [{ bearer: [] }],
    tags: [
      { name: "Notifications" },
      { name: "Actions" },
      { name: "Sources", description: "The inboxes and calendars Grok Bot scans. Grok Bot reports each scan; the owner sets the schedule and can ask for a scan now." },
      {
        name: "Categories",
        description:
          "What a card is about. Herald owns the list: read it, and send `category` as an id or name from it. A name Herald doesn't know is added as a suggestion the owner accepts, merges or removes. Only the signed-in owner edits the list.",
      },
      { name: "Bots", description: "Requests the owner sends to a bot from the Chat tab." },
    ],
    paths: {
      "/api/notifications": {
        get: {
          tags: ["Notifications"],
          summary: "List notifications, newest first",
          parameters: [
            { name: "status", in: "query", schema: { type: "string" }, description: `Comma-separated: ${STATUSES.join(", ")}` },
            { name: "source", in: "query", schema: { type: "string" }, description: `Comma-separated: ${SOURCES.join(", ")}` },
            { name: "sourceId", in: "query", schema: { type: "string" }, description: "Comma-separated agent ids or service names" },
            { name: "flag", in: "query", schema: { type: "string" }, description: `Comma-separated: ${FLAGS.join(", ")}` },
            { name: "kind", in: "query", schema: { type: "string" }, description: `Comma-separated: ${KINDS.join(", ")}` },
            { name: "lane", in: "query", schema: { type: "string" }, description: `Comma-separated: ${LANES.join(", ")}` },
            { name: "category", in: "query", schema: { type: "string" }, description: "Comma-separated category ids; `none` for uncategorized" },
            { name: "since", in: "query", schema: { type: "string", format: "date-time" }, description: "Created at or after" },
            { name: "updatedSince", in: "query", schema: { type: "string", format: "date-time" }, description: "Changed at or after; use for sync" },
            { name: "q", in: "query", schema: { type: "string" }, description: "Search title, body, full text, sender and response" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "`nextCursor` from the previous page" },
          ],
          responses: {
            "200": {
              description: "A page",
              content: json({
                type: "object",
                properties: { items: { type: "array", items: ref("Notification") }, nextCursor: nullableString },
              }),
            },
          },
        },
        post: {
          tags: ["Notifications"],
          summary: "Create a notification",
          description: "Send `Idempotency-Key` (or `idempotencyKey` in the body) to make retries safe; a repeat returns the existing notification with status 200.",
          parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string", maxLength: 200 } }],
          requestBody: { required: true, content: json(ref("NotificationCreate")) },
          responses: {
            "201": { description: "Created", content: json(ref("NotificationResult")) },
            "200": { description: "Already existed (same idempotency key)", content: json(ref("NotificationResult")) },
            "400": error,
          },
        },
      },
      "/api/notifications/bulk": {
        post: {
          tags: ["Notifications"],
          summary: "Create and update many notifications (imports)",
          description: "Up to 500 creates and 500 updates. Creates run in one transaction; creates whose idempotency key exists are skipped. Imports may set `status`, `createdAt`, `dismissedAt` and `respondedAt`.",
          requestBody: { required: true, content: json(schema(bulkSchema)) },
          responses: {
            "200": {
              description: "Results in request order",
              content: json({
                type: "object",
                properties: {
                  created: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, idempotencyKey: nullableString, created: { type: "boolean" } },
                    },
                  },
                  updated: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, changed: { type: "boolean" }, error: { type: "string" } },
                    },
                  },
                },
              }),
            },
            "400": error,
          },
        },
      },
      "/api/notifications/dismiss": {
        post: {
          tags: ["Actions"],
          summary: "Dismiss many",
          description: "Up to 500 ids. Each one is dismissed and sent as its own event, as if done one by one. A `disposition` applies to each, e.g. archiving a whole stack.",
          requestBody: { required: true, content: json(schema(dismissManySchema)) },
          responses: { "200": { description: "One result per id: `changed`, or `error`" }, "400": error },
        },
      },
      "/api/notifications/read": {
        post: {
          tags: ["Actions"],
          summary: "Mark many read",
          description: "Up to 500 ids, e.g. everything in a chat thread when it's opened. Only `new` ones change.",
          requestBody: { required: true, content: json(schema(idsSchema)) },
          responses: { "200": { description: "One result per id: `changed`, or `error`" }, "400": error },
        },
      },
      "/api/notifications/restore": {
        post: {
          tags: ["Actions"],
          summary: "Restore many",
          requestBody: { required: true, content: json(schema(idsSchema)) },
          responses: { "200": { description: "One result per id: `changed`, or `error`" }, "400": error },
        },
      },
      "/api/agent-guide.md": {
        get: {
          tags: ["Bots"],
          summary: "Herald's live instructions for bots, as Markdown",
          description: "Written from the current category list and features. Send `If-None-Match` with the last ETag to skip it when unchanged (304).",
          responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } }, "304": { description: "Unchanged" } },
        },
      },
      "/api/sources": {
        get: {
          tags: ["Sources"],
          summary: "The inboxes and calendars Grok Bot watches, with each one's last scan, schedule and whether it's gone quiet",
          responses: { "200": { description: "`items`" } },
        },
      },
      "/api/sources/{id}": {
        put: {
          tags: ["Sources"],
          summary: "Report a source and its last scan (bots)",
          description: "Creates the source or updates it. Leaves the owner's `cadenceMinutes` and `paused` alone. A newer `lastScanAt` answers a pending Scan now. Sends no webhook.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Stable, e.g. `gmail:me@example.com`" }],
          requestBody: { required: true, content: json(schema(sourceReportSchema)) },
          responses: { "200": { description: "The source" }, "400": error },
        },
        patch: {
          tags: ["Sources"],
          summary: "Set how often it's scanned, or pause it (owner only)",
          description: "Sends `source.settings`.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: json(schema(sourceSettingsSchema)) },
          responses: { "200": { description: "The source" }, "404": error },
        },
        delete: {
          tags: ["Sources"],
          summary: "Forget a source (owner only)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Forgotten" }, "404": error },
        },
      },
      "/api/sources/scan": {
        post: {
          tags: ["Sources"],
          summary: "Scan now (owner only)",
          description: "Sends `scan.requested` with the sources to scan: those in `ids`, or every one that isn't paused.",
          requestBody: { content: json(schema(scanRequestSchema)) },
          responses: { "200": { description: "`items`: the sources asked to scan" }, "404": error },
        },
      },
      "/api/categories": {
        get: {
          tags: ["Categories"],
          summary: "The category list: active ones in the owner's order, then suggestions",
          responses: { "200": { description: "`items`", content: json({ type: "object", properties: { items: { type: "array", items: ref("Category") } } }) } },
        },
        post: {
          tags: ["Categories"],
          summary: "Add a category (owner only)",
          requestBody: { required: true, content: json(schema(categoryCreateSchema)) },
          responses: { "201": { description: "The category", content: json(ref("Category")) }, "409": error },
        },
      },
      "/api/categories/{id}": {
        patch: {
          tags: ["Categories"],
          summary: "Rename, recolor, move or accept a suggestion (owner only)",
          description: "A rename keeps the old name as an alias, so cards that still name it land here. Sends `categories.updated`.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: json(schema(categoryPatchSchema)) },
          responses: { "200": { description: "The category", content: json(ref("Category")) }, "404": error, "409": error },
        },
        delete: {
          tags: ["Categories"],
          summary: "Remove a category (owner only)",
          description: "Its cards become uncategorized. A card that names it again stays uncategorized rather than suggesting it.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Removed" }, "404": error },
        },
      },
      "/api/categories/{id}/summary": {
        put: {
          tags: ["Categories"],
          summary: "Write one line about a category's stack on Home",
          description:
            "E.g. \"4 HOA emails: the vote closes Friday\". Shown on the collapsed stack for up to a day. Herald clears it when the stack changes (a card arrives, leaves, or moves lane or category), so write it after posting the cards. Sends no webhook.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: json(schema(summarySchema)) },
          responses: { "200": { description: "The category", content: json(ref("Category")) }, "404": error },
        },
        delete: {
          tags: ["Categories"],
          summary: "Clear a stack's summary",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "The category", content: json(ref("Category")) }, "404": error },
        },
      },
      "/api/categories/{id}/merge": {
        post: {
          tags: ["Categories"],
          summary: "Merge a category into another (owner only)",
          description: "Moves its cards into `into` and deletes it; its id and name become aliases of `into`.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: json(schema(categoryMergeSchema)) },
          responses: { "200": { description: "Merged" }, "404": error },
        },
      },
      "/api/bots": {
        get: {
          tags: ["Bots"],
          summary: "Bots that have posted, newest first; the main agent is pinned on top",
          responses: { "200": { description: "`items`: sourceId, sender, avatarUrl, lastAt, unread, pinned" } },
        },
      },
      "/api/bots/{sourceId}": {
        patch: {
          tags: ["Bots"],
          summary: "Set a bot's name, avatar, role, color or live status",
          description:
            "Every notification from this agent id shows its current name and avatar, so a rename applies everywhere at once. A post with a newer `createdAt` also renames it. `status.state: working` shows a pulsing ring and typing dots in its thread; `status: null` clears it. Including `sender` sets up a bot that hasn't posted yet. Sends no webhook.",
          parameters: [{ name: "sourceId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: json(schema(senderPatchSchema)) },
          responses: { "200": { description: "The bot" }, "400": error, "404": error },
        },
      },
      "/api/requests": {
        get: {
          tags: ["Bots"],
          summary: "Requests sent to one bot, newest first",
          parameters: [{ name: "to", in: "query", required: true, schema: { type: "string" }, description: "The bot's sourceId" }],
          responses: { "200": { description: "`items`, each with `status` (sent/answered) and `delivery` to Grok Bot" } },
        },
        post: {
          tags: ["Bots"],
          summary: "Send a request to a bot",
          description:
            "Sends a `request.created` webhook to Grok Bot naming the bot in `request.to.sourceId`. The bot answers by creating a notification with `requestId` set to this request's id, which marks it answered.",
          requestBody: { required: true, content: json(schema(requestCreateSchema)) },
          responses: { "201": { description: "The request" }, "404": error },
        },
      },
      "/api/notifications/{id}": {
        get: {
          tags: ["Notifications"],
          summary: "Get a notification",
          parameters: [idParam],
          responses: { "200": { description: "The notification", content: json(ref("Notification")) }, "404": error },
        },
        patch: {
          tags: ["Notifications"],
          summary: "Update fields",
          description: "Sends `notification.updated`. Prefer the action endpoints for read, dismiss, restore and respond.",
          parameters: [idParam],
          requestBody: { required: true, content: json(ref("NotificationPatch")) },
          responses: { "200": { description: "Updated", content: json(ref("NotificationResult")) }, "400": error, "404": error },
        },
        delete: {
          tags: ["Notifications"],
          summary: "Delete permanently",
          description: "Sends `notification.deleted`. The audit log keeps its events.",
          parameters: [idParam],
          responses: { "200": { description: "Deleted" }, "404": error },
        },
      },
      "/api/notifications/{id}/read": action("Mark read", "Only changes a `new` notification."),
      "/api/notifications/{id}/dismiss": action(
        "Dismiss",
        `Hides it from the inbox. Restore brings it back. Optional \`disposition\` (${DISPOSITIONS.join(", ")}) asks Grok Bot to do that to the email at its source; the webhook carries it with \`subject.ref\`. Grok Bot should then PATCH \`outcome\`, e.g. "Archived in Gmail".`,
        schema(dismissSchema),
      ),
      "/api/notifications/{id}/snooze": action(
        "Snooze",
        "Hides it until `until`, when it comes back as new and buzzes; `until: null` wakes it now. Sends `notification.snoozed` with `until`, so Grok Bot can snooze the email at its source too.",
        schema(snoozeSchema),
      ),
      "/api/notifications/{id}/restore": action(
        "Restore a dismissed notification",
        "Returns it to its status before dismissal. If the dismissal had a disposition, the webhook's `undo: {disposition}` asks Grok Bot to reverse it (e.g. move the email back to the inbox).",
      ),
      "/api/notifications/{id}/stream": {
        post: {
          tags: ["Notifications"],
          summary: "Stream a reply into a notification created with `streaming: true`",
          description:
            "`append` adds text to `fullText`, `text` replaces it, and `done` finishes it. Open dashboards show each chunk at once. Only `done` is logged, sent as a `notification.updated` webhook and pushed to the phone.",
          parameters: [idParam],
          requestBody: { required: true, content: json(schema(streamSchema)) },
          responses: { "200": { description: "The notification" }, "404": error, "409": error },
        },
      },
      "/api/notifications/{id}/checklist": {
        post: {
          tags: ["Notifications"],
          summary: "Tick or untick a checklist item",
          description: "Sends `notification.updated` with `changes.checklist = {block, item, done}`.",
          parameters: [idParam],
          requestBody: { required: true, content: json(schema(checklistToggleSchema)) },
          responses: { "200": { description: "The notification", content: json(ref("Notification")) }, "404": error },
        },
      },
      "/api/requests/{id}/ack": {
        post: {
          tags: ["Bots"],
          summary: "Confirm a request was picked up",
          description: "The owner's thread shows \"Picked up by …\". Optional body `{ \"by\": \"Travel Agent\" }`.",
          parameters: [idParam],
          responses: { "200": { description: "The request" }, "404": error },
        },
      },
      "/api/briefing": {
        get: { tags: ["Bots"], summary: "The line at the top of Home, or null", responses: { "200": { description: "`{text, actor, updatedAt}` or null" } } },
        put: {
          tags: ["Bots"],
          summary: "Set the Home briefing",
          description: "One or two sentences on what matters now. After 12 hours Herald replaces it with its own summary.",
          requestBody: { required: true, content: json(schema(briefingSchema)) },
          responses: { "200": { description: "The briefing" }, "400": error },
        },
        delete: { tags: ["Bots"], summary: "Clear the Home briefing", responses: { "200": { description: "Cleared" } } },
      },
      "/api/notifications/{id}/respond": action(
        "Respond",
        "Saves the response, sets status `responded` and clears the flag. With `action`, answers with one of the notification's `actions` (a `reply` needs `text`; a `confirm` answers with its label) or the built-in `done`. Without it, when `responsePrompt` has options, `text` must be one of them. 409 if expired or already answered differently.",
        schema(respondSchema),
      ),
      "/api/notifications/{id}/events": {
        get: {
          tags: ["Notifications"],
          summary: "Audit log for one notification",
          parameters: [idParam],
          responses: { "200": { description: "Events, oldest first" } },
        },
      }
    },
    webhooks: {
      requestCreated: {
        post: {
          summary: "The owner sent a request to a bot from the Chat tab",
          description: "Route `request.text` to the bot named by `request.to.sourceId`. Answer with POST /api/notifications including `requestId`.",
          requestBody: {
            content: json({
              type: "object",
              properties: {
                id: { type: "string" },
                event: { const: "request.created" },
                occurredAt: { type: "string", format: "date-time" },
                actor: { type: "string" },
                request: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    to: { type: "object", properties: { sourceId: { type: "string" }, sender: { type: "string" } } },
                    text: { type: "string" },
                    inReplyTo: nullableString,
                  },
                },
              },
            }),
          },
          responses: { "200": { description: "Any 2xx acknowledges" } },
        },
      },
      scanRequested: {
        post: {
          summary: "The owner tapped Scan now",
          description: "Scan each of `sources` (`{id, kind, provider, account}`) now, then report it with PUT /api/sources/{id}. An empty list means everything you watch (none has been reported yet).",
          responses: { "200": { description: "Any 2xx acknowledges" } },
        },
      },
      sourceSettings: {
        post: {
          summary: "The owner changed a source's schedule",
          description: "`source: {id, kind, provider, account, cadenceMinutes, paused}`. Scan on the new schedule; not at all while paused.",
          responses: { "200": { description: "Any 2xx acknowledges" } },
        },
      },
      categoriesUpdated: {
        post: {
          summary: "The owner changed the category list",
          description: "Carries the whole list. Pick categories from it from now on.",
          requestBody: {
            content: json({
              type: "object",
              properties: {
                id: { type: "string" },
                event: { const: "categories.updated" },
                occurredAt: { type: "string", format: "date-time" },
                actor: { type: "string" },
                categories: { type: "array", items: ref("Category") },
              },
            }),
          },
          responses: { "200": { description: "Any 2xx acknowledges" } },
        },
      },
      notificationEvent: {
        post: {
          summary: "Sent to Grok Bot on changes by the owner and by services (not its own)",
          description: "Delivered at least once with retries. Ignore repeats of the same `id` (also in the `X-Herald-Event-Id` header).",
          requestBody: { content: json(ref("WebhookEvent")) },
          responses: { "200": { description: "Any 2xx acknowledges" } },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "API key from Herald Settings" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, issues: {} } },
        ResponsePrompt: schema(responsePromptSchema),
        Category: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable across renames" },
            name: { type: "string" },
            color: { type: "string", description: "#rrggbb" },
            icon: { enum: CATEGORY_ICONS },
            position: { type: "integer" },
            state: { enum: ["active", "suggested"] },
            aliases: { type: "array", items: { type: "string" }, description: "Other names that land here" },
            swipeAction: { enum: SWIPE_ACTIONS, description: "What a long swipe left does to an email in this category" },
            count: { type: "integer", description: "Cards in it that aren't dismissed" },
            summary: {
              oneOf: [{ type: "object", properties: { text: { type: "string" }, at: { type: "string", format: "date-time" } } }, { type: "null" }],
              description: "A bot's line about the stack",
            },
          },
        },
        NotificationCreate: schema(notificationCreateSchema),
        NotificationPatch: schema(notificationPatchSchema),
        Notification: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            source: { enum: SOURCES },
            sourceId: { type: "string" },
            sender: { type: "string" },
            avatarUrl: nullableString,
            title: nullableString,
            body: { type: "string" },
            fullText: nullableString,
            url: nullableString,
            lane: {
              enum: LANES,
              description:
                "What it wants from the owner: `needs_you` (act on it; it's on the task list), `fyi` (worth knowing; stacks by category), `handled` (a bot already dealt with it; shown as a receipt).",
            },
            category: { ...nullableString, description: "A category id, or null when uncategorized" },
            urgent: { type: "boolean" },
            kind: { enum: KINDS, deprecated: true },
            flag: { enum: FLAGS, deprecated: true, description: "Worked out from `lane`, `urgent` and `status`" },
            status: { enum: STATUSES },
            responsePrompt: { oneOf: [ref("ResponsePrompt"), { type: "null" }] },
            responseText: nullableString,
            stackKey: nullableString,
            idempotencyKey: nullableString,
            requestId: nullableString,
            subject: { description: "What it's about: an email, a payment or an event. Each has its own card header.", oneOf: [schema(subjectSchema), { type: "null" }] },
            actions: { type: "array", description: "Buttons on the card. Any action puts it in `needs_you` unless `lane` says otherwise.", items: schema(actionSchema) },
            dueAt: nullableString,
            responseAction: { ...nullableString, description: "The action the owner took, or `done`" },
            disposition: { enum: [...DISPOSITIONS, null], description: "What its dismissal asked Grok Bot to do at the source" },
            snoozedUntil: { ...nullableString, description: "Hidden until then; it comes back as new" },
            topic: { ...nullableString, deprecated: true, description: "Send `category` instead; a topic is read as a category name." },
            task: { ...nullableString, description: "The to-do on the owner's Tasks tab. Set automatically from the title for a `needs_you` card; send null for none. Done when the owner answers or dismisses the card." },
            outcome: { ...nullableString, description: "What the bot did afterwards, e.g. \"Sent 3:42 PM\". Set it with PATCH." },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            readAt: nullableString,
            dismissedAt: nullableString,
            respondedAt: nullableString,
          },
        },
        NotificationResult: {
          allOf: [
            ref("Notification"),
            {
              type: "object",
              properties: { changed: { type: "boolean", description: "False when the call changed nothing and sent no webhook" } },
            },
          ],
        },
        WebhookEvent: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable event id for deduplication" },
            event: {
              enum: [...EVENT_NAMES, "request.created", "categories.updated", "scan.requested", "source.settings", "herald.connected", "main_agent.updated"],
            },
            occurredAt: { type: "string", format: "date-time" },
            actor: { type: "string", description: "owner | grok-bot | service:<name> | herald (a snooze ending)" },
            text: { type: "string", description: "notification.responded: the answer" },
            action: { type: ["string", "null"], description: "notification.responded: the action id, or `done`" },
            disposition: { enum: [...DISPOSITIONS, null], description: "notification.dismissed: what to do at the source" },
            undo: { description: "notification.restored: `{disposition}` to reverse at the source, or null" },
            until: { type: ["string", "null"], description: "notification.snoozed: when it comes back; null when it's back" },
            changes: { description: "notification.updated: what changed" },
            notification: {
              type: "object",
              properties: {
                id: { type: "string" },
                source: { type: "string" },
                sourceId: { type: "string" },
                sender: { type: "string" },
                avatarUrl: nullableString,
                title: nullableString,
                body: { type: "string" },
                url: nullableString,
                lane: { enum: LANES },
                category: nullableString,
                urgent: { type: "boolean" },
                kind: { type: "string" },
                flag: { type: "string" },
                status: { type: "string" },
                response: nullableString,
                responsePrompt: {},
                stackKey: nullableString,
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
                dismissedAt: nullableString,
                respondedAt: nullableString,
              },
            },
          },
        },
      },
    },
  };
}
