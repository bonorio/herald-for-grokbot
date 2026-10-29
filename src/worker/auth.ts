import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import type { AppContext, Env } from "./env";
import { overLimit } from "./limiter";
import { addMs, base64url, fromBase64url, nowIso, randomToken, sha256 } from "./util";

const SESSION_COOKIE = "herald_session";
const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
/** Who the signed-in owner is in the audit log and in webhooks. */
export const OWNER_ACTOR = "owner";

/**
 * The WebAuthn user handle every passkey is saved under. It must never change
 * on an install, or devices file new passkeys as a second account. A new
 * install gets "herald-owner"; one that had passkeys before this was stored
 * keeps its original handle in this pref, set once by hand.
 */
async function passkeyUserId(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'passkey_user_id'").first<{ value: string }>();
  if (row) return JSON.parse(row.value) as string;
  await env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('passkey_user_id', ?) ON CONFLICT (key) DO NOTHING")
    .bind(JSON.stringify("herald-owner"))
    .run();
  return passkeyUserId(env);
}

/** A name as given, trimmed to something sensible, or null. */
export function cleanName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, 60) : null;
}

/** What the owner asked to be called, if they said. */
export async function getOwnerName(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'owner_name'").first<{ value: string }>();
  return row ? (JSON.parse(row.value) as string) : null;
}

function clientIp(c: Context<AppContext>): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}


function tooMany(c: Context<AppContext>) {
  c.header("retry-after", "60");
  return c.json({ error: "Too many requests; try again in a minute" }, 429);
}

/** Bearer API key or session cookie. Sets `actor`. Rate-limited per caller, and per IP when auth fails. */
export const authenticate: MiddlewareHandler<AppContext> = async (c, next) => {
  const result = await identify(c);
  if (!result.ok) {
    if (await overLimit(c.env, "auth", clientIp(c))) return tooMany(c);
    return c.json({ error: result.error }, result.status);
  }
  if (await overLimit(c.env, "api", result.limitKey)) return tooMany(c);
  return next();
};

async function identify(
  c: Context<AppContext>,
): Promise<{ ok: true; limitKey: string } | { ok: false; status: 401 | 403; error: string }> {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const key = await c.env.DB.prepare(
      "SELECT id, actor FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
    )
      .bind(await sha256(header.slice(7).trim()))
      .first<{ id: string; actor: string }>();
    if (!key) return { ok: false, status: 401, error: "Invalid or revoked API key" };
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(nowIso(), key.id).run(),
    );
    c.set("actor", key.actor);
    c.set("keyId", key.id);
    c.set("viaSession", false);
    return { ok: true, limitKey: `key:${key.id}` };
  }
  if (await hasSession(c)) {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOrigin(c)) {
      return { ok: false, status: 403, error: "Cross-origin request refused" };
    }
    c.set("actor", OWNER_ACTOR);
    c.set("keyId", null);
    c.set("viaSession", true);
    return { ok: true, limitKey: "session" };
  }
  return { ok: false, status: 401, error: "Authentication required" };
}

/** Key and webhook management: only the owner, signed in, may do it. */
export const requireSession: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get("viaSession")) return c.json({ error: "Sign in to the dashboard to do this" }, 403);
  return next();
};

function sameOrigin(c: Context<AppContext>): boolean {
  const origin = c.req.header("origin");
  return !origin || origin === new URL(c.req.url).origin;
}

/** The signed-in session's stored id, so it can be spared when signing out other devices. */
export async function currentSessionHash(c: Context<AppContext>): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? sha256(token) : null;
}

async function hasSession(c: Context<AppContext>): Promise<boolean> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return false;
  const row = await c.env.DB.prepare("SELECT 1 AS ok FROM sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(await sha256(token), nowIso())
    .first();
  return !!row;
}

async function startSession(c: Context<AppContext>) {
  const token = await createSessionToken(c.env);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
}

function relyingParty(c: Context<AppContext>) {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin, rpName: c.env.APP_NAME };
}

async function passkeyCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>();
  return row?.n ?? 0;
}

async function saveChallenge(env: Env, challenge: string, kind: "register" | "login") {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO auth_challenges (id, challenge, kind, expires_at) VALUES (?, ?, ?, ?)").bind(
      crypto.randomUUID(),
      challenge,
      kind,
      addMs(now, CHALLENGE_MS),
    ),
  ]);
}

/** Single use: a challenge is deleted as it is checked. */
function consumeChallenge(env: Env, kind: "register" | "login") {
  return async (challenge: string) => {
    const row = await env.DB.prepare(
      "DELETE FROM auth_challenges WHERE challenge = ? AND kind = ? AND expires_at > ? RETURNING id",
    )
      .bind(challenge, kind, nowIso())
      .first();
    return !!row;
  };
}

/** Codes `npm run setup` makes: lowercase letters and digits in dashed groups. */
const GENERATED_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A setup code as it'll be compared. A generated code is matched as typed on
 * a phone (capitals, spaces and dashes don't matter), which costs it nothing
 * since it has none of those. A code someone chose is matched exactly, so
 * its capitals and symbols still count.
 */
function comparable(code: string, generated: boolean): string {
  return generated ? code.toLowerCase().replace(/[^a-z0-9]/g, "") : code.trim();
}

/** Constant-time compare of the setup code. */
async function setupCodeMatches(env: Env, code: unknown): Promise<boolean> {
  if (!env.SETUP_CODE || typeof code !== "string") return false;
  const generated = GENERATED_CODE.test(env.SETUP_CODE.trim());
  const typed = comparable(code, generated);
  if (!typed) return false;
  const [a, b] = await Promise.all([sha256(typed), sha256(comparable(env.SETUP_CODE, generated))]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Registering is allowed with the setup code while no passkey exists, or
 * from a signed-in session (adding another device).
 */
async function mayRegister(c: Context<AppContext>, setupCode: unknown): Promise<boolean> {
  if (await hasSession(c)) return sameOrigin(c);
  return (await passkeyCount(c.env)) === 0 && (await setupCodeMatches(c.env, setupCode));
}

export const authRoutes = new Hono<AppContext>()
  .use(async (c, next) => {
    if (c.req.method !== "POST") return next();
    if (!sameOrigin(c)) return c.json({ error: "Cross-origin request refused" }, 403);
    // Caps setup-code and passkey attempts.
    if (await overLimit(c.env, "auth", clientIp(c))) return tooMany(c);
    return next();
  })
  .get("/status", async (c) => {
    return c.json({ signedIn: await hasSession(c), hasPasskey: (await passkeyCount(c.env)) > 0 });
  })
  .post("/register/options", async (c) => {
    const { setupCode, ownerName } = await c.req
      .json<{ setupCode?: string; ownerName?: string }>()
      .catch(() => ({ setupCode: undefined, ownerName: undefined }));
    if (!(await mayRegister(c, setupCode))) return c.json({ error: "Setup code required" }, 403);
    const { rpID, rpName } = relyingParty(c);
    const existing = await c.env.DB.prepare("SELECT id, transports FROM passkeys").all<{ id: string; transports: string | null }>();
    // The name the device shows for this passkey: the owner's, once they've given it.
    const name = cleanName(ownerName) ?? (await getOwnerName(c.env));
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: name ?? `${c.env.APP_NAME} owner`,
      userDisplayName: name ?? c.env.APP_NAME,
      userID: new TextEncoder().encode(await passkeyUserId(c.env)),
      attestationType: "none",
      excludeCredentials: existing.results.map((p) => ({
        id: p.id,
        transports: p.transports ? JSON.parse(p.transports) : undefined,
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    await saveChallenge(c.env, options.challenge, "register");
    return c.json(options);
  })
  .post("/register/verify", async (c) => {
    const body = await c.req.json<{ response: RegistrationResponseJSON; setupCode?: string; name?: string; ownerName?: string }>();
    if (!(await mayRegister(c, body.setupCode))) return c.json({ error: "Setup code required" }, 403);
    const { rpID, origin } = relyingParty(c);
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: consumeChallenge(c.env, "register"),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    }).catch((error: Error) => ({ verified: false as const, error }));
    if (!verification.verified || !("registrationInfo" in verification) || !verification.registrationInfo) {
      return c.json({ error: "Passkey could not be verified" }, 400);
    }
    const { credential } = verification.registrationInfo;
    await c.env.DB.prepare(
      "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        credential.id,
        base64url(credential.publicKey),
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        body.name?.slice(0, 80) ?? null,
        nowIso(),
      )
      .run();
    // First setup: the owner's name, if they gave one, so Home can greet them by it.
    const ownerName = cleanName(body.ownerName);
    if (ownerName) {
      await c.env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('owner_name', ?) ON CONFLICT (key) DO NOTHING")
        .bind(JSON.stringify(ownerName))
        .run();
    }
    if (!(await hasSession(c))) await startSession(c);
    return c.json({ ok: true });
  })
  .post("/login/options", async (c) => {
    const { rpID } = relyingParty(c);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    await saveChallenge(c.env, options.challenge, "login");
    return c.json(options);
  })
  .post("/login/verify", async (c) => {
    const { response } = await c.req.json<{ response: AuthenticationResponseJSON }>();
    const passkey = await c.env.DB.prepare("SELECT * FROM passkeys WHERE id = ?")
      .bind(response.id)
      .first<{ id: string; public_key: string; counter: number; transports: string | null }>();
    if (!passkey) return c.json({ error: "Unknown passkey" }, 400);
    const { rpID, origin } = relyingParty(c);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: consumeChallenge(c.env, "login"),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: passkey.id,
        publicKey: fromBase64url(passkey.public_key),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
    }).catch(() => ({ verified: false as const }));
    if (!verification.verified || !("authenticationInfo" in verification)) {
      return c.json({ error: "Sign-in failed" }, 400);
    }
    await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
      .bind(verification.authenticationInfo.newCounter, nowIso(), passkey.id)
      .run();
    await startSession(c);
    return c.json({ ok: true });
  })
  .post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

/** Stores a new session and returns its cookie value. */
export async function createSessionToken(env: Env): Promise<string> {
  const token = randomToken("ses");
  const now = nowIso();
  await env.DB.prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), now, addMs(now, SESSION_MS))
    .run();
  return token;
}

export { SESSION_COOKIE };
