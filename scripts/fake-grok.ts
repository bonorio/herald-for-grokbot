// Stands in for Grok Bot locally: logs every webhook Herald sends.
// Run with: bun scripts/fake-grok.ts
const port = Number(process.env.PORT ?? 8788);
Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = await request.json().catch(() => null);
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        auth: request.headers.get("authorization"),
        eventId: request.headers.get("x-herald-event-id"),
        attempt: request.headers.get("x-herald-delivery-attempt"),
        event: body?.event,
        actor: body?.actor,
        id: body?.notification?.id,
        status: body?.notification?.status,
        response: body?.notification?.response,
      }),
    );
    return Response.json({ ok: true });
  },
});
console.log(`fake Grok Bot listening on http://127.0.0.1:${port}/grok`);
