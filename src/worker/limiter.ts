import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * A strict fixed-window counter, one instance per key (an IP or an API key).
 * Cloudflare's built-in rate limiter is approximate and per location, which is
 * too loose to guard the setup code.
 */
export class Limiter extends DurableObject<Env> {
  private windowStart = 0;
  private count = 0;

  /** Counts one hit; true while the key is within `limit` per `periodMs`. */
  async hit(limit: number, periodMs: number): Promise<boolean> {
    const now = Date.now();
    if (now - this.windowStart >= periodMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= limit;
  }
}

export const LIMITS = {
  /** Sign-in attempts and failed authentication, per IP. */
  auth: { limit: 10, periodMs: 60_000 },
  /** Authenticated API calls, per key or session. */
  api: { limit: 300, periodMs: 60_000 },
} as const;

/** True when `key` is over its limit. */
export async function overLimit(env: Env, kind: keyof typeof LIMITS, key: string): Promise<boolean> {
  const { limit, periodMs } = LIMITS[kind];
  return !(await env.LIMITER.getByName(`${kind}:${key}`).hit(limit, periodMs));
}
