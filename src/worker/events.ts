import type { Actor, Env } from "./env";
import { NO_ECHO_ACTORS } from "./notifications";
import { nowIso, uuid } from "./util";

/**
 * Logs an event that isn't about one notification (the category list, an
 * inbox's settings, a scan request) and queues its webhook to Grok Bot,
 * unless Grok Bot made the change itself. `subject` keys it in the audit log.
 */
export function eventStatements(
  env: Env,
  change: { subject: string; event: string; actor: Actor; payload: Record<string, unknown> },
): { statements: D1PreparedStatement[]; eventId: string } {
  const eventId = uuid();
  const now = nowIso();
  const statements = [
    env.DB.prepare("INSERT INTO events (id, notification_id, event, actor, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      eventId,
      change.subject,
      change.event,
      change.actor,
      JSON.stringify(change.payload),
      now,
    ),
  ];
  if (!NO_ECHO_ACTORS.has(change.actor)) {
    statements.push(
      env.DB.prepare("INSERT INTO webhook_outbox (id, event_id, body, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        uuid(),
        eventId,
        JSON.stringify({ id: eventId, event: change.event, occurredAt: now, actor: change.actor, ...change.payload }),
        now,
        now,
      ),
    );
  }
  return { statements, eventId };
}
