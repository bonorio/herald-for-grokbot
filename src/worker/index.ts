import { Hono } from "hono";
import { api, ValidationError } from "./api";
import { authRoutes } from "./auth";
import type { AppContext, Env } from "./env";
import { HttpError, wakeSnoozed } from "./notifications";
import { openApiSpec } from "./openapi";
import { afterCommit, deliverDue, prune } from "./outbox";
import { getQuietHours, isQuiet, morningSummary, pushWoken } from "./push";

export { Hub } from "./hub";
export { Limiter } from "./limiter";

const app = new Hono<AppContext>();

/** This Worker's public origin, remembered from requests, once known. */
let knownOrigin: string | null = null;

app.use(async (c, next) => {
  // Herald learns its own address from its first https visit, for the push contact, so setup needn't set PUBLIC_URL.
  // The first one sticks, so a preview URL or a second hostname visited later doesn't move it.
  const origin = new URL(c.req.url).origin;
  if (!c.env.PUBLIC_URL && origin !== knownOrigin && origin.startsWith("https://")) {
    knownOrigin = origin;
    c.executionCtx.waitUntil(
      c.env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('public_url', ?) ON CONFLICT (key) DO NOTHING")
        .bind(JSON.stringify(origin))
        .run(),
    );
  }
  await next();
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/")) {
    // A route that set its own caching (the agent guide revalidates by ETag) keeps it.
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  }
});

app.get("/api/openapi.json", (c) => c.json(openApiSpec(new URL(c.req.url).origin)));
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", api);
app.route("/auth", authRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  if (error instanceof ValidationError) return c.json({ error: error.message, issues: error.issues }, 400);
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Internal error" }, 500);
});

export default {
  fetch: app.fetch,
  /**
   * Every minute: bring back snoozed notifications, retry webhook deliveries
   * that are due, and send the morning summary when quiet hours end. Once a
   * day, at 09:00 UTC: tidy up.
   */
  async scheduled(controller, env, ctx) {
    const at = new Date(controller.scheduledTime);
    // Wake snoozed cards first, so the morning summary can count them and the owner gets one buzz.
    ctx.waitUntil(
      (async () => {
        const woken = await wakeSnoozed(env, { urgentOnly: isQuiet(await getQuietHours(env), at) });
        await afterCommit(env, woken.map((w) => w.eventId));
        const summarized = await morningSummary(env, at, fetch, woken.length);
        if (!summarized) await pushWoken(env, woken.map((w) => w.row), at);
      })().catch((error) => console.error("Waking snoozed cards failed", error)),
    );
    ctx.waitUntil(deliverDue(env, { limit: 200 }));
    if (at.getUTCHours() === 9 && at.getUTCMinutes() === 0) ctx.waitUntil(prune(env));
  },
} satisfies ExportedHandler<Env>;
