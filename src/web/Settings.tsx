import { useCallback, useEffect, useState } from "react";
import { type Bot, type Category, type QuietHours, RETENTION_CHOICES, type ScanSource } from "../shared/types";
import { SourceSettings } from "./Sources";
import { request } from "./api";
import { CategorySettings } from "./CategorySettings";
import { type Connection as Kit, ConnectionKit, Copy } from "./Connection";
import { fullTime } from "./group";
import { registerPasskey } from "./Login";
import { disablePush, enablePush, type PushState, pushState } from "./push";

interface ApiKey {
  id: string;
  name: string;
  actor: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface Passkey {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}
interface Connection {
  connected: boolean;
  via: "app" | "env" | null;
  host: string | null;
  signed: boolean;
  connectedAt: string | null;
  pending: boolean;
}
interface Outbox {
  configured: boolean;
  counts: { status: string; n: number }[];
  failing: {
    id: string;
    status: string;
    attempts: number;
    last_error: string | null;
    next_attempt_at: string;
    event: string;
  }[];
}

/** Closing the kit loses the secrets for good, so it asks once more first. */
function DoneWithKit({ onDone }: { onDone: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button className={`btn btn-secondary ${armed ? "danger" : ""}`} onClick={() => (armed ? onDone() : setArmed(true))} type="button">
      {armed ? "Grok Bot has both secrets? Tap again to close" : "Done"}
    </button>
  );
}

/** A secret shown once, with a copy button. */
function Reveal({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  return (
    <div className="reveal glass">
      <div className="reveal-label">{label}</div>
      <code className="reveal-value">{value}</code>
      <div className="row">
        <Copy className="btn btn-primary" value={value} />
        <button className="btn btn-secondary" onClick={onDone} type="button">
          Done
        </button>
      </div>
      <p className="hint">This is the only time it is shown. Paste it straight into its destination.</p>
    </div>
  );
}

const PUSH_NOTES: Record<PushState, string> = {
  unsupported: "This browser can't receive push notifications.",
  "needs-install": "On iPhone, add Herald to your Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on here.",
  "server-off": "Push isn't configured on the server yet.",
  denied: "Notifications are blocked for Herald. Allow them in Settings → Notifications → Herald.",
  off: "Get a notification on this device when a bot or service posts something new.",
  on: "This device gets a notification for each new item.",
};

function PushSection() {
  const [state, setState] = useState<{ state: PushState; devices: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(() => {
    pushState().then(setState, (e: Error) => setMessage(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  async function run(task: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await task();
      if (done) setMessage(done);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  return (
    <section className="group">
      <h2 className="group-title">Notifications</h2>
      <p className="group-note">
        {state ? PUSH_NOTES[state.state] : "Checking…"}
        {state && state.devices > 0 ? ` ${state.devices} device${state.devices === 1 ? "" : "s"} signed up.` : ""}
      </p>
      <div className="row">
        {state?.state === "off" ? (
          <button className="btn btn-primary" disabled={busy} onClick={() => run(enablePush, "Notifications are on.")} type="button">
            Turn on notifications
          </button>
        ) : null}
        {state?.state === "on" ? (
          <>
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => run(() => request("/api/push/test", { method: "POST" }), "Test sent.")}
              type="button"
            >
              Send a test
            </button>
            <button className="btn btn-secondary danger" disabled={busy} onClick={() => run(disablePush)} type="button">
              Turn off on this device
            </button>
          </>
        ) : null}
      </div>
      {message ? <p className="notice">{message}</p> : null}
    </section>
  );
}

/** Quiet hours: only urgent items buzz; the rest arrive as one summary when they end. */
function QuietSection() {
  const [quiet, setQuiet] = useState<QuietHours | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    request<QuietHours>("/api/prefs/quiet-hours").then(setQuiet, (e: Error) => setError(e.message));
  }, []);

  async function save(next: QuietHours) {
    setQuiet(next);
    setSaved(false);
    setError(null);
    try {
      // Always this device's zone, so the hours mean what they say where the owner is.
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setQuiet(await request<QuietHours>("/api/prefs/quiet-hours", { method: "PUT", json: { ...next, timeZone } }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="group">
      <h2 className="group-title">Quiet hours</h2>
      <p className="group-note">
        Only urgent items buzz your phone. Everything else waits, and you get one summary when quiet hours end.
      </p>
      {error ? <div className="error">{error}</div> : null}
      {quiet ? (
        <div className="item glass quiet">
          <label className="switch-row">
            <span>Quiet hours</span>
            <input checked={quiet.enabled} onChange={(e) => void save({ ...quiet, enabled: e.target.checked })} role="switch" type="checkbox" />
          </label>
          <div className={`quiet-times ${quiet.enabled ? "" : "is-off"}`}>
            <label>
              From
              <input disabled={!quiet.enabled} onChange={(e) => e.target.value && void save({ ...quiet, start: e.target.value })} type="time" value={quiet.start} />
            </label>
            <label>
              Until
              <input disabled={!quiet.enabled} onChange={(e) => e.target.value && void save({ ...quiet, end: e.target.value })} type="time" value={quiet.end} />
            </label>
          </div>
          {saved ? <div className="item-sub">Saved · {quiet.timeZone.replace(/_/g, " ")}</div> : null}
        </div>
      ) : null}
    </section>
  );
}

function when(value: string | null) {
  return value ? fullTime(value) : "never";
}

/** How long finished cards and logs are kept. */
function RetentionSection() {
  const [days, setDays] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    request<{ days: number | null }>("/api/prefs/retention").then((r) => setDays(r.days), (e: Error) => setError(e.message));
  }, []);
  const label = (d: number | null) => (d === null ? "Keep everything" : d === 365 ? "After a year" : `After ${d} days`);
  return (
    <section className="group">
      <h2 className="group-title">Your data</h2>
      <p className="group-note">
        Herald keeps your cards in your own Cloudflare database. Cards you've answered or dismissed, Chat messages and their logs are deleted for
        good once they're this old. Cards still in your inbox are never deleted.
      </p>
      {error ? <div className="error">{error}</div> : null}
      {days !== undefined ? (
        <label className="swipe-pick item glass">
          <span>Delete finished cards</span>
          <select
            onChange={(e) => {
              const next = e.target.value === "never" ? null : Number(e.target.value);
              setError(null);
              request<{ days: number | null }>("/api/prefs/retention", { method: "PUT", json: { days: next } }).then(
                (r) => setDays(r.days),
                (err: Error) => setError(err.message),
              );
            }}
            value={days === null ? "never" : String(days)}
          >
            {RETENTION_CHOICES.map((d) => (
              <option key={String(d)} value={d === null ? "never" : String(d)}>
                {label(d)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </section>
  );
}

/** What Home calls the owner. Optional. */
function NameSection({ name, onSaved }: { name: string | null; onSaved: (name: string | null) => void }) {
  const [value, setValue] = useState(name ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(name ?? ""), [name]);
  return (
    <section className="group">
      <h2 className="group-title">Your name</h2>
      <form
        className="row category-add"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void request<{ name: string | null }>("/api/prefs/profile", { method: "PUT", json: { name: value.trim() || null } }).then(
            (r) => onSaved(r.name),
            (e: Error) => setError(e.message),
          );
        }}
      >
        <input aria-label="Your name" autoComplete="given-name" onChange={(e) => setValue(e.target.value)} placeholder="What Home calls you" value={value} />
        <button className="btn btn-secondary" disabled={value.trim() === (name ?? "")} type="submit">
          Save
        </button>
      </form>
      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}

/** Which of Grok Bot's agents is pinned first in Chat and gets messages by default. */
function MainAgent({ bots, onChanged }: { bots: Bot[] | null; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const main = bots?.find((b) => b.pinned) ?? null;
  if (!bots?.length) return null;
  return (
    <div className="main-agent">
      <label className="swipe-pick item glass">
        <span>
          <strong>Main agent</strong>
          <span className="muted"> · pinned first in Chat</span>
        </span>
        <select
          onChange={(e) => {
            setError(null);
            request("/api/prefs/main-agent", { method: "PUT", json: { sourceId: e.target.value || null } }).then(onChanged, (err: Error) => setError(err.message));
          }}
          value={main?.sourceId ?? ""}
        >
          <option value="">{main ? "Let Grok Bot choose" : "Grok Bot names it when it connects"}</option>
          {bots.map((b) => (
            <option key={b.sourceId} value={b.sourceId}>
              {b.sender}
            </option>
          ))}
        </select>
      </label>
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}

/**
 * The link "Grok Bot ↗" in each chat thread opens: Grok Bot's own chat, for
 * steps that happen there. Grok Bot sends it when it connects; setting it by
 * hand is the fallback.
 */
function ChatLink({ url, onSaved }: { url: string | null; onSaved: (url: string | null) => void }) {
  const [value, setValue] = useState(url ?? "");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setValue(url ?? ""), [url]);
  async function save(next: string | null) {
    setMessage(null);
    try {
      const saved = await request<{ url: string | null }>("/api/prefs/grok-link", { method: "PUT", json: { url: next } });
      onSaved(saved.url);
      setMessage(saved.url ? "Saved. Each chat now has a Grok Bot ↗ button." : "Cleared.");
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <div className="chat-link">
      <p className="group-note">
        {url ? (
          <>
            <strong>Chat link:</strong> set. Each chat here has a <strong>Grok Bot ↗</strong> button that opens Grok Bot, for steps like signing in
            that happen there.{" "}
            <a href={url} rel="noreferrer" target="_blank">
              Try it ↗
            </a>
          </>
        ) : (
          <>
            <strong>Chat link:</strong> not set yet. Grok Bot sends it when it connects, and then each chat here gets a{" "}
            <strong>Grok Bot ↗</strong> button for steps that happen in Grok Bot, like signing in.
          </>
        )}
      </p>
      <details>
        <summary>Set it yourself</summary>
        <p className="group-note">
          Ask Grok Bot: "What link opens our chat?" Or, in Grok Bot, open your chat, look for <strong>Share</strong> or the <strong>⋯</strong>{" "}
          menu, and copy its link. Paste it here. A web address or an app link both work.
        </p>
        <form
          className="row category-add"
          onSubmit={(e) => {
            e.preventDefault();
            void save(value.trim() || null);
          }}
        >
          <input aria-label="Grok Bot chat link" inputMode="url" onChange={(e) => setValue(e.target.value)} placeholder="Paste the chat link" value={value} />
          <button className="btn btn-secondary" disabled={value.trim() === (url ?? "")} type="submit">
            Save
          </button>
        </form>
        {message ? <p className="notice">{message}</p> : null}
      </details>
    </div>
  );
}

export function Settings({
  categories,
  grokLink,
  onCategoriesChanged,
  onGrokLink,
  onSignOut,
  sources,
  sourcesError,
  onSourcesChanged,
  onSourcesRetry,
  ownerName,
  onOwnerName,
  bots,
  onBotsChanged,
}: {
  bots: Bot[] | null;
  onBotsChanged: () => void;
  ownerName: string | null;
  onOwnerName: (name: string | null) => void;
  sources: ScanSource[] | null;
  sourcesError: string | null;
  onSourcesChanged: (sources: ScanSource[]) => void;
  onSourcesRetry: () => void;
  categories: Category[] | null;
  grokLink: string | null;
  onCategoriesChanged: () => void;
  onGrokLink: (url: string | null) => void;
  onSignOut: () => void;
}) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Grok Bot gets its key from Connect Grok Bot; this is for your own services.
  const [keyName, setKeyName] = useState("");
  const [keyActor, setKeyActor] = useState("service:");
  const actorValid = /^(grok-bot|service:[a-z0-9][a-z0-9._-]{0,63})$/.test(keyActor.trim());
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [kit, setKit] = useState<Kit | null>(null);
  const [passkeys, setPasskeys] = useState<{ items: Passkey[]; sessions: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [k, o, p, conn] = await Promise.all([
        request<{ items: ApiKey[] }>("/api/keys"),
        request<Outbox>("/api/outbox"),
        request<{ items: Passkey[]; sessions: number }>("/api/passkeys"),
        request<Connection>("/api/connect"),
      ]);
      setKeys(k.items);
      setOutbox(o);
      setPasskeys(p);
      setConnection(conn);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act<T>(task: () => Promise<T>, after?: (result: T) => void) {
    setError(null);
    try {
      const result = await task();
      after?.(result);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const origin = window.location.origin;
  const count = (status: string) => outbox?.counts.find((c) => c.status === status)?.n ?? 0;

  return (
    <div className="settings">
      {secret ? <Reveal label={secret.label} onDone={() => setSecret(null)} value={secret.value} /> : null}
      {kit ? (
        <div className="reveal glass">
          <div className="reveal-label">Connect Grok Bot. These are shown only once.</div>
          <ConnectionKit connection={kit} />
          <DoneWithKit onDone={() => setKit(null)} />
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <NameSection name={ownerName} onSaved={onOwnerName} />
      <SourceSettings loadError={sourcesError} onChanged={onSourcesChanged} onRetry={onSourcesRetry} sources={sources} />
      <CategorySettings categories={categories} onChanged={onCategoriesChanged} />
      <PushSection />
      <QuietSection />
      <RetentionSection />

      <section className="group">
        <h2 className="group-title">API keys</h2>
        <p className="group-note">
          For Grok Bot and your own services (one key each; actor <code>service:name</code> for a service). Base URL <code>{origin}</code> · spec{" "}
          <a href="/api/openapi.json" rel="noreferrer" target="_blank">
            /api/openapi.json
          </a>
        </p>
        {keys.map((k) => (
          <div className={`item glass ${k.revoked_at ? "is-revoked" : ""}`} key={k.id}>
            <div className="item-main">
              <div className="item-title">
                {k.name} <span className="muted">· {k.actor}</span>
              </div>
              <div className="item-sub">
                <code>{k.prefix}…</code> · {k.revoked_at ? `revoked ${when(k.revoked_at)}` : `last used ${when(k.last_used_at)}`}
              </div>
            </div>
            {k.revoked_at ? null : (
              <div className="item-actions">
                <button
                  className="chip-btn"
                  onClick={() =>
                    act(
                      () => request<{ key: string }>(`/api/keys/${k.id}/rotate`, { method: "POST" }),
                      (r) => setSecret({ label: `New key for ${k.name} (the old one stopped working)`, value: r.key }),
                    )
                  }
                  type="button"
                >
                  Rotate
                </button>
                <button
                  className="chip-btn danger"
                  onClick={() => confirm(`Revoke ${k.name}? It stops working immediately.`) && act(() => request(`/api/keys/${k.id}`, { method: "DELETE" }))}
                  type="button"
                >
                  Revoke
                </button>
              </div>
            )}
          </div>
        ))}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () => request<{ key: string }>("/api/keys", { method: "POST", json: { name: keyName, actor: keyActor } }),
              (r) => setSecret({ label: `API key for ${keyName}`, value: r.key }),
            );
          }}
        >
          <input aria-label="Key name" onChange={(e) => setKeyName(e.target.value)} placeholder="Name, e.g. Home Assistant" value={keyName} />
          <input aria-label="Actor" onChange={(e) => setKeyActor(e.target.value)} placeholder="service:name, or grok-bot" value={keyActor} />
          <button className="btn btn-secondary" disabled={!keyName.trim() || !actorValid} type="submit">
            New key
          </button>
        </form>
      </section>

      <section className="group">
        <h2 className="group-title">Grok Bot</h2>
        <p className="group-note">
          {connection?.connected
            ? `Connected: webhooks go to ${connection.host}${connection.signed ? ", signed" : ""}${connection.connectedAt ? ` · since ${when(connection.connectedAt)}` : ""}.`
            : "Not connected. Connect Grok Bot, paste the message into its chat, and copy the two secrets into its secrets box when it asks."}
          {connection?.pending ? " Waiting for Grok Bot to register with the newest key; until it does, nothing changes." : ""}
        </p>
        <div className="row">
          <button
            className="btn btn-primary"
            onClick={() =>
              void act(
                () => request<Kit>("/api/connect", { method: "POST" }),
                (r) => {
                  setKit(r);
                  // It shows at the top of Settings.
                  window.scrollTo({ top: 0, behavior: "smooth" });
                },
              )
            }
            type="button"
          >
            {connection?.connected ? "Reconnect Grok Bot" : "Connect Grok Bot"}
          </button>
          {connection?.via === "app" ? (
            <button
              className="btn btn-secondary danger"
              onClick={() => confirm("Stop sending webhooks to Grok Bot?") && void act(() => request("/api/connect/webhook", { method: "DELETE" }))}
              type="button"
            >
              Disconnect
            </button>
          ) : null}
        </div>
        <MainAgent bots={bots} onChanged={onBotsChanged} />
        <ChatLink onSaved={onGrokLink} url={grokLink} />
        {outbox ? (
          <>
            <p className="group-note">
              {outbox.configured ? "" : "Deliveries are waiting until Grok Bot registers its webhook. "}Delivered {count("delivered")} · waiting{" "}
              {count("pending")} · failed {count("dead")}
            </p>
            {outbox.failing.slice(0, 5).map((f) => (
              <div className="item glass" key={f.id}>
                <div className="item-main">
                  <div className="item-title">
                    {f.event}
                  </div>
                  <div className="item-sub">
                    {f.status === "dead" ? "gave up" : `retry ${when(f.next_attempt_at)}`} after {f.attempts} attempts · {f.last_error}
                  </div>
                </div>
              </div>
            ))}
            {outbox.failing.length > 5 ? (
              <p className="group-note">and {outbox.failing.length - 5} more retrying</p>
            ) : null}
            {count("dead") > 0 ? (
              <button className="btn btn-secondary" onClick={() => act(() => request("/api/outbox/retry", { method: "POST" }))} type="button">
                Retry failed deliveries
              </button>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="group">
        <h2 className="group-title">Passkeys</h2>
        <p className="group-note">
          Each passkey can sign in to Herald. Keep one on a second device so losing your phone doesn't lock you out.
        </p>
        {passkeys?.items.map((p) => (
          <div className="item glass" key={p.id}>
            <div className="item-main">
              <div className="item-title">{p.name ?? "Passkey"}</div>
              <div className="item-sub">
                added {when(p.created_at)} · last used {when(p.last_used_at)}
              </div>
            </div>
            <div className="item-actions">
              <button
                className="chip-btn"
                onClick={() => {
                  const name = prompt("Name this passkey", p.name ?? "")?.trim();
                  if (name) void act(() => request(`/api/passkeys/${encodeURIComponent(p.id)}`, { method: "PATCH", json: { name } }));
                }}
                type="button"
              >
                Rename
              </button>
              {passkeys.items.length > 1 ? (
                <button
                  className="chip-btn danger"
                  onClick={() =>
                    confirm(`Remove ${p.name ?? "this passkey"}? It can no longer sign in.`) &&
                    act(() => request(`/api/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }))
                  }
                  type="button"
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        ))}
        <div className="row">
          <button
            className="btn btn-secondary"
            onClick={() =>
              act(
                () => registerPasskey(),
                () => setNotice("Passkey added."),
              )
            }
            type="button"
          >
            Add a passkey
          </button>
        </div>
      </section>

      <section className="group">
        <h2 className="group-title">Signed in</h2>
        <p className="group-note">
          {passkeys ? `${passkeys.sessions} signed-in ${passkeys.sessions === 1 ? "session" : "sessions"}, including this one.` : null}
        </p>
        <div className="row">
          {passkeys && passkeys.sessions > 1 ? (
            <button
              className="btn btn-secondary"
              onClick={() =>
                confirm("Sign out every other device? This one stays signed in.") &&
                act(
                  () => request<{ revoked: number }>("/api/sessions/revoke-others", { method: "POST" }),
                  (r) => setNotice(`Signed out ${r.revoked} other ${r.revoked === 1 ? "session" : "sessions"}.`),
                )
              }
              type="button"
            >
              Sign out other devices
            </button>
          ) : null}
          <button className="btn btn-secondary danger" onClick={onSignOut} type="button">
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
