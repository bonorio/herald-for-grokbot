import type { Hub } from "./hub";
import type { Limiter } from "./limiter";

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace<Hub>;
  LIMITER: DurableObjectNamespace<Limiter>;
  ASSETS?: Fetcher;
  APP_NAME: string;
  /** One-time code that allows registering the first passkey. */
  SETUP_CODE?: string;
  GROK_BOT_WEBHOOK_URL?: string;
  /** Sent exactly as given, e.g. `Authorization: Bearer …`. A value without a colon is sent as `Authorization`. */
  GROK_BOT_WEBHOOK_AUTH_HEADER?: string;
  /** The site's public origin; also the VAPID contact. */
  PUBLIC_URL?: string;
  /** Web Push application server key (base64url, uncompressed P-256 point). */
  VAPID_PUBLIC_KEY?: string;
  /** The matching private key as a JWK JSON string. */
  VAPID_PRIVATE_JWK?: string;
}

/** Who made a change: `owner`, `grok-bot`, or `service:<name>`. */
export type Actor = string;

export type AppContext = {
  Bindings: Env;
  /** `keyId`: the API key that made the call, when one did. */
  Variables: { actor: Actor; viaSession: boolean; keyId: string | null };
};
