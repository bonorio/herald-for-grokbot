import { useEffect, useState } from "react";
import type { Bot, Category, ScanSource } from "../shared/types";
import { request } from "./api";
import { CategorySettings } from "./CategorySettings";
import { type Connection as Kit, ConnectionKit } from "./Connection";
import { disablePush, enablePush, isIos, isStandalone, pushState, type PushState } from "./push";
import { sinceLabel, sourceName } from "./Sources";

/** The guided setup, one screen per step. Each one checks for itself whether it's done. */
export const STEPS = ["welcome", "install", "notify", "connect", "sources", "categories", "done"] as const;
export type Step = (typeof STEPS)[number];

interface Connection {
  connected: boolean;
  via: "app" | "env" | null;
  host: string | null;
  /** A message was made and Grok Bot hasn't used it yet. */
  pending: boolean;
}

/**
 * Re-runs `load` every `ms` while the step is on screen, for something that
 * happens elsewhere (Grok Bot connecting), until `settled` says it has.
 */
function usePoll<T>(load: () => Promise<T>, ms: number, settled: (value: T) => boolean, key: string | null = null): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    // A new key is a new thing to watch: don't show the last one's answer meanwhile.
    setValue(null);
    const run = () =>
      load().then(
        (v) => {
          if (!live) return;
          setValue(v);
          if (!settled(v)) timer = window.setTimeout(run, ms);
        },
        () => live && (timer = window.setTimeout(run, ms)),
      );
    run();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // The loader is fixed for each step (or for each `key`); restarting on every render would hammer the API.
  }, [ms, key]);
  return value;
}

function Done({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboard-done">
      <span aria-hidden className="setup-check is-on">
        ✓
      </span>
      <span>{children}</span>
    </div>
  );
}

/** `onDraft` keeps the parent up to date as they type, so the name is saved on Next even if the field never blurs (iOS). */
function Welcome({ name, onDraft }: { name: string | null; onDraft: (name: string) => void }) {
  const [value, setValue] = useState(name ?? "");
  useEffect(() => setValue(name ?? ""), [name]);
  return (
    <>
      <h1>Welcome to Herald</h1>
      <p>
        Herald is where you see what Grok Bot finds in your inboxes and calendars, and act on it: the few things that need you, everything else
        stacked by topic, and what Grok Bot already handled.
      </p>
      <p>A few quick steps and it's ready. Each one takes a minute or less, and you can skip any and come back from Home.</p>
      <label className="onboard-field">
        <span>What should Herald call you? (optional)</span>
        <input
          autoComplete="given-name"
          enterKeyHint="next"
          onChange={(e) => {
            setValue(e.target.value);
            onDraft(e.target.value);
          }}
          placeholder="Your first name"
          value={value}
        />
      </label>
    </>
  );
}

function Install({ installed }: { installed: boolean }) {
  const phone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || isIos();
  return (
    <>
      <h1>Put Herald on your Home Screen</h1>
      <p>Herald works like an app once it's on your Home Screen: full screen, and on iPhone that's the only way it can send notifications.</p>
      {installed ? (
        <Done>Herald is on your Home Screen.</Done>
      ) : isIos() ? (
        <ol className="onboard-steps">
          <li>
            In Safari, tap the <strong>☰</strong> button to the left of the address, then <strong>Share</strong>. (On older iPhones, Share is
            the square with an arrow in Safari's toolbar.)
          </li>
          <li>
            Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </li>
          <li>
            Open <strong>Herald</strong> from your Home Screen and sign in with your passkey. Setup carries on there from the next step.
          </li>
        </ol>
      ) : phone ? (
        <ol className="onboard-steps">
          <li>
            In Chrome, tap the <strong>⋮</strong> menu, then <strong>Add to Home screen</strong> or <strong>Install app</strong>.
          </li>
          <li>Open Herald from your Home Screen; setup carries on there.</li>
        </ol>
      ) : (
        <p className="onboard-note">
          You're on a computer. Open this same address on your phone to add Herald there; you can do the other steps from here or from your phone.
        </p>
      )}
    </>
  );
}

function Notify() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    pushState().then((s) => setState(s.state), () => setState("unsupported"));
  }, []);
  async function turnOn() {
    setBusy(true);
    setMessage(null);
    try {
      await enablePush();
      setState("on");
      await request("/api/push/test", { method: "POST" });
      setMessage("Sent a test. It should buzz in a moment.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>Turn on notifications</h1>
      <p>Herald buzzes when something needs you. Only urgent things buzz during quiet hours, which you can set later in Settings.</p>
      {state === "on" ? (
        <>
          <Done>Notifications are on for this device.</Done>
          <button className="link-btn" onClick={() => void disablePush().then(() => setState("off"))} type="button">
            Turn off
          </button>
        </>
      ) : state === "off" ? (
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void turnOn()} type="button">
          {busy ? "Asking…" : "Turn on notifications"}
        </button>
      ) : state === "needs-install" ? (
        <p className="onboard-note">On iPhone, notifications need Herald on your Home Screen first. Go back a step, then open Herald from there.</p>
      ) : state === "denied" ? (
        <p className="onboard-note">Notifications are blocked for Herald. Allow them in your phone's Settings → Notifications → Herald, then come back.</p>
      ) : state === "server-off" ? (
        <p className="onboard-note">Notifications aren't set up on this Herald's server yet. You can skip this and turn them on later in Settings.</p>
      ) : state === "unsupported" ? (
        <p className="onboard-note">This browser can't get notifications. Turn them on from Herald on your phone instead.</p>
      ) : (
        <p className="onboard-note">Checking…</p>
      )}
      {message ? <p className="onboard-note">{message}</p> : null}
    </>
  );
}

/**
 * The kit (message, API key and signing secret) lives with the whole setup,
 * so going back and forth keeps the secrets to copy and doesn't issue a new
 * key that breaks what Grok Bot already has.
 */
function Connect({ kit, setKit, bots }: { kit: Kit | null; setKit: (kit: Kit) => void; bots: Bot[] | null }) {
  const main = bots?.find((b) => b.pinned);
  const [error, setError] = useState<string | null>(null);
  const connection = usePoll(() => request<Connection>("/api/connect"), 3000, (c) => c.connected && c.via === "app");
  const fromApp = connection?.connected && connection.via === "app";

  async function start() {
    setError(null);
    try {
      setKit(await request<Kit>("/api/connect", { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <h1>Connect Grok Bot</h1>
      <p>Grok Bot does the work: it scans your inboxes and posts here. Connecting takes one message and two secrets.</p>
      {fromApp ? (
        <>
          <Done>Grok Bot is connected. Updates go to {connection?.host}.</Done>
          {main ? (
            <Done>
              Your main agent is <strong>{main.sender}</strong>. It's pinned first in Chat; you can pick another in Settings.
            </Done>
          ) : null}
        </>
      ) : kit ? (
        <>
          <ConnectionKit connection={kit} />
          <p className="onboard-note onboard-waiting">
            <span aria-hidden className="onboard-spinner" /> Waiting for Grok Bot. This step ticks green as soon as it connects.
          </p>
        </>
      ) : connection?.pending ? (
        <>
          <p className="onboard-note onboard-waiting">
            <span aria-hidden className="onboard-spinner" /> Waiting for Grok Bot to finish connecting with what you already gave it…
          </p>
          <button className="link-btn" onClick={() => void start()} type="button">
            Lost the secrets? Make new ones (the old ones stop working)
          </button>
        </>
      ) : (
        <button className="btn btn-primary btn-block" onClick={() => void start()} type="button">
          Get the message and secrets
        </button>
      )}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}

/** Where a request to Grok Bot is; `unknown` when it couldn't be checked just now. */
type Delivery = { state: "sending" | "retrying" | "delivered" | "failed" | "not-connected" | "unknown"; error: string | null };

/** `sources` stay live through the app's connection, so this step just shows them as they arrive. */
function Sources({ sources }: { sources: ScanSource[] | null }) {
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<{ at: string; eventId: string | null } | "failed" | null>(null);
  const sent = asked && asked !== "failed" ? asked : null;
  // Whether the request reached Grok Bot, so it's clear whose turn it is. Checks go on through retries and
  // blips, and stop at a final answer (delivered or failed) or after ten minutes.
  const delivery = usePoll<Delivery | null>(
    () =>
      sent?.eventId
        ? request<Delivery>(`/api/deliveries/${sent.eventId}`).catch(() => ({ state: "unknown" as const, error: null }))
        : Promise.resolve(null),
    3000,
    (d) => !d || d.state === "delivered" || d.state === "failed" || (!!sent && Date.now() - new Date(sent.at).getTime() > 10 * 60_000),
    sent?.eventId ?? null,
  );

  async function ask() {
    setAsking(true);
    try {
      const r = await request<{ eventId: string | null }>("/api/sources/scan", { method: "POST" });
      setAsked({ at: new Date().toISOString(), eventId: r.eventId });
    } catch {
      setAsked("failed");
    } finally {
      setAsking(false);
    }
  }

  const time = sent ? new Date(sent.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  const status = !sent
    ? null
    : !sent.eventId
      ? "Nothing to ask: every inbox here is paused. Turn one back on in Settings."
      : !delivery
        ? "sending…"
        : {
            sending: "sending…",
            delivered: "Grok Bot received it. If nothing shows up in a minute, ask it in its chat to scan and report your inboxes to Herald.",
            retrying: `Grok Bot didn't take it yet (${delivery.error ?? "no answer"}); Herald will keep trying. Check its webhook routine.`,
            failed: `Couldn't reach Grok Bot (${delivery.error ?? "no answer"}). Check its webhook routine.`,
            "not-connected": "It'll go to Grok Bot once it's connected. Go back a step to connect it.",
            unknown: "Couldn't check whether Grok Bot got it.",
          }[delivery.state];

  return (
    <>
      <h1>Your inboxes and calendars</h1>
      <p>
        These show up as Grok Bot scans them for the first time. If nothing shows up, ask it to scan, or tell it in its chat which inboxes and
        calendars Herald should cover.
      </p>
      {sources?.length ? (
        <ul className="onboard-list">
          {sources.map((s) => (
            <li key={s.id}>
              <span aria-hidden className="setup-check is-on">
                ✓
              </span>
              <span>
                <strong>{sourceName(s)}</strong>
                <span className="muted"> {s.lastScanAt ? `scanned ${sinceLabel(s.lastScanAt)}` : "added"}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="onboard-note onboard-waiting">
          <span aria-hidden className="onboard-spinner" /> Waiting for Grok Bot's first scan…
        </p>
      )}
      <button
        className="btn btn-secondary btn-block"
        disabled={asking || (!!sent?.eventId && (!delivery || delivery.state === "sending"))}
        onClick={() => void ask()}
        type="button"
      >
        {asked === "failed" ? "Couldn't ask; try again" : sent ? "Ask again" : "Ask Grok Bot to scan now"}
      </button>
      {status ? (
        <p className="onboard-note">
          Asked at {time} · {status}
        </p>
      ) : null}
    </>
  );
}

function Categories({ categories, onChanged }: { categories: Category[] | null; onChanged: () => void }) {
  return (
    <>
      <h1>How should cards be sorted?</h1>
      <p>
        Grok Bot files every card under one of these, and cards in the same category stack together on Home. Keep the ones you want, remove the
        rest, and add your own. Grok Bot's suggestions appear at the top as it finds new topics.
      </p>
      <div className="onboard-categories">
        <CategorySettings categories={categories} onChanged={onChanged} />
      </div>
    </>
  );
}

function AllSet({ name }: { name: string | null }) {
  return (
    <>
      <h1>You're all set{name ? `, ${name}` : ""}</h1>
      <p>Here's how to use Herald:</p>
      <ul className="onboard-tips">
        <li>
          <strong>Swipe left</strong> to dismiss a card. Swipe further to archive the email in Gmail too.
        </li>
        <li>
          <strong>Swipe right</strong> to snooze it until later. Swipe further to mark it done.
        </li>
        <li>
          <strong>Chat</strong> is where you ask Grok Bot for anything, and answer what it asks you.
        </li>
        <li>Anything you skipped is under <strong>Finish setting up</strong> on Home.</li>
      </ul>
    </>
  );
}

/**
 * The guided first-run setup. It opens after the first passkey is saved and
 * from "Finish setting up" on Home, at the step the owner left off.
 */
export function Onboarding({
  bots,
  categories,
  name,
  sources,
  onCategoriesChanged,
  onName,
  onFinish,
}: {
  bots: Bot[] | null;
  categories: Category[] | null;
  sources: ScanSource[] | null;
  name: string | null;
  onCategoriesChanged: () => void;
  onName: (name: string | null) => void;
  onFinish: () => void;
}) {
  const [step, setStep] = useState<Step | null>(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [draftName, setDraftName] = useState<string | null>(null);
  const [kit, setKit] = useState<Kit | null>(null);

  // Pick up where they left off, on this device or another.
  useEffect(() => {
    request<{ step: string | null; installed: boolean }>("/api/setup").then(
      (s) => {
        setInstalled(isStandalone() || s.installed);
        if (isStandalone() && !s.installed) void request("/api/setup/installed", { method: "POST" }).catch(() => undefined);
        // Opened from the Home Screen for the first time: that step's done, so go on to the next.
        const saved = (STEPS as readonly string[]).includes(s.step ?? "") ? (s.step as Step) : "welcome";
        setStep(saved === "install" && isStandalone() ? "notify" : saved === "done" ? "welcome" : saved);
      },
      () => setStep("welcome"),
    );
  }, []);

  function go(next: Step) {
    // Leaving Welcome saves the name as typed.
    if (step === "welcome" && draftName !== null && draftName.trim() !== (name ?? "")) onName(draftName.trim() || null);
    setStep(next);
    window.scrollTo(0, 0);
    void request("/api/setup/step", { method: "PUT", json: { step: next } }).catch(() => undefined);
  }

  if (!step) return <div className="empty">Loading…</div>;
  const index = STEPS.indexOf(step);
  const next = STEPS[index + 1];
  const back = STEPS[index - 1];

  return (
    <div className="onboard">
      <div aria-label={`Step ${index + 1} of ${STEPS.length}`} className="onboard-dots" role="progressbar">
        {STEPS.map((s, i) => (
          <span className={i <= index ? "is-on" : ""} key={s} />
        ))}
      </div>
      <div className="onboard-body">
        {step === "welcome" ? <Welcome name={name} onDraft={setDraftName} /> : null}
        {step === "install" ? <Install installed={installed} /> : null}
        {step === "notify" ? <Notify /> : null}
        {step === "connect" ? <Connect bots={bots} kit={kit} setKit={setKit} /> : null}
        {step === "sources" ? <Sources sources={sources} /> : null}
        {step === "categories" ? <Categories categories={categories} onChanged={onCategoriesChanged} /> : null}
        {step === "done" ? <AllSet name={name} /> : null}
      </div>
      <div className="onboard-nav">
        {back ? (
          <button className="btn btn-secondary" onClick={() => go(back)} type="button">
            Back
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button className="btn btn-primary" onClick={() => go(next)} type="button">
            {step === "welcome" ? "Let's go" : "Next"}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => {
              void request("/api/setup/step", { method: "PUT", json: { step: "done" } }).catch(() => undefined);
              onFinish();
            }}
            type="button"
          >
            Go to Home
          </button>
        )}
      </div>
      {next && step !== "welcome" ? (
        <button className="link-btn onboard-later" onClick={onFinish} type="button">
          Finish later
        </button>
      ) : null}
    </div>
  );
}
