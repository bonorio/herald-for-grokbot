import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type Briefing, type Disposition, DONE_ACTION, isTask, type Notification, type ScanSource, taskDone } from "../shared/types";
import { actions, clearSnapshot, fetchAll, readSnapshot, request, writeSnapshot } from "./api";
import { answeredLabel, DISPOSITION_LABELS, whereLabel } from "./Card";
import { ChatHeader, ChatList, ChatThread, chatHref, useBots } from "./Chat";
import { CategoriesContext, useCategories } from "./categories";
import { BriefingCard } from "./Home";
import { BotsContext } from "./Rich";
import { Detail } from "./Detail";
import { DismissedList, Inbox } from "./Inbox";
import { SnoozeSheet, snoozedLabel } from "./Snooze";
import { Onboarding } from "./Onboarding";
import { SetupChecklist } from "./Setup";
import { QuietSources, useSources } from "./Sources";
import { Login } from "./Login";
import { isStandalone, setBadge } from "./push";
import { Settings } from "./Settings";
import { Tasks } from "./Tasks";

type View = "inbox" | "tasks" | "dismissed" | "settings" | "chats" | "chat" | "welcome";
const ACTIVE_QUERY = "status=new,read,responded";

/** `#tasks`, `#dismissed`, `#settings`, `#chat`, `#chat/<sourceId>`, or the inbox. The old `#bots` and `#bot/…` still work. */
function routeFromHash(): { view: View; botId: string | null } {
  const hash = window.location.hash.slice(1);
  const thread = /^(?:chat|bot)\/(.+)$/.exec(hash);
  if (thread) {
    try {
      return { view: "chat", botId: decodeURIComponent(thread[1] as string) };
    } catch {
      // A mangled link opens the chat list rather than nothing at all.
      return { view: "chats", botId: null };
    }
  }
  if (hash === "chat" || hash === "bots") return { view: "chats", botId: null };
  if (hash === "tasks" || hash === "dismissed" || hash === "settings" || hash === "welcome") return { view: hash, botId: null };
  return { view: "inbox", botId: null };
}

interface Toast {
  message: string;
  undo?: () => void;
  /** A second action, e.g. "Open" the thread a request went to. */
  action?: { label: string; run: () => void };
}

interface StreamMessage {
  type: "stream";
  id: string;
  body: string;
  fullText: string | null;
  streaming: boolean;
}

/**
 * True while a text field has focus, i.e. the on-screen keyboard is up, so
 * the tab bar can step aside instead of riding up on top of it.
 */
function useTyping(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const isText = (el: EventTarget | null) =>
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color"].includes(el.type));
    const onIn = (e: FocusEvent) => isText(e.target) && setTyping(true);
    // Focus can move straight from one field to another; only clear once nothing is focused.
    const onOut = () => window.setTimeout(() => setTyping(isText(document.activeElement)), 0);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return typing;
}

/** Hash navigation with a cross-fade where the browser supports view transitions. */
function navigate(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    doc.startViewTransition(() => flushSync(update));
  } else update();
}

/**
 * Reconnecting WebSocket. Streamed text goes to `onStream` as it arrives;
 * anything else calls `onChange` to refetch.
 */
function useLive(enabled: boolean, onChange: () => void, onStream: (message: StreamMessage) => void, onSources: () => void) {
  const callback = useRef(onChange);
  callback.current = onChange;
  const stream = useRef(onStream);
  stream.current = onStream;
  const sourcesChanged = useRef(onSources);
  sourcesChanged.current = onSources;
  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: number | undefined;
    let ping: number | undefined;
    let closed = false;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
      socket.onopen = () => {
        if (retry > 0) callback.current();
        retry = 0;
        ping = window.setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), 45_000);
      };
      socket.onmessage = (e) => {
        if (e.data === "pong") return;
        try {
          const message = JSON.parse(String(e.data)) as { type?: string };
          if (message.type === "stream") return stream.current(message as StreamMessage);
          // A scan report changes only the inboxes and calendars, so only they're refetched.
          if (message.type === "sources") return sourcesChanged.current();
        } catch {}
        callback.current();
      };
      socket.onclose = () => {
        window.clearInterval(ping);
        if (closed) return;
        timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    };
    connect();
    const onVisible = () => document.visibilityState === "visible" && callback.current();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearInterval(ping);
      socket?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}

function TabIcon({ d }: { d: string }) {
  return (
    <svg aria-hidden className="tab-icon" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24">
      <path d={d} />
    </svg>
  );
}

const cached = readSnapshot();

export function App() {
  const [auth, setAuth] = useState<{ signedIn: boolean; hasPasskey: boolean } | null>(null);
  const [{ view, botId }, setRoute] = useState(routeFromHash);
  const typing = useTyping();
  /** Bumped when only the inboxes and calendars changed. */
  const [sourcesTick, setSourcesTick] = useState(0);
  const [grokLink, setGrokLink] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string | null>(null);
  /** Bumped on each refetch so the Bots views refresh with the inbox. */
  const [tick, setTick] = useState(0);
  const [items, setItems] = useState<Notification[]>(cached?.items ?? []);
  const [dismissed, setDismissed] = useState<Notification[]>(cached?.dismissed ?? []);
  const [briefing, setBriefing] = useState<Briefing | null>(cached?.briefing ?? null);
  const [loading, setLoading] = useState(!cached);
  /** Ids seen so far; anything new after the first load slides in. */
  const seen = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [search, setSearch] = useState("");
  const [replyTo, setReplyTo] = useState<Notification | null>(null);
  /** The card whose snooze picker is open. */
  const [snoozing, setSnoozing] = useState<Notification | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  /** Ids dismissed locally whose request has not finished, so a refetch doesn't flash them back. */
  const hiding = useRef(new Set<string>());

  const checkAuth = useCallback(async () => {
    setAuth(await request<{ signedIn: boolean; hasPasskey: boolean }>("/auth/status"));
  }, []);
  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    const onHash = () =>
      navigate(() => {
        const next = routeFromHash();
        setRoute(next);
        // A thread opens at its newest message (it scrolls itself); every other view opens at the top.
        if (next.view !== "chat") window.scrollTo(0, 0);
      });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const showToast = useCallback((next: Toast) => {
    window.clearTimeout(toastTimer.current);
    setToast(next);
    // Long enough to reach Undo with a thumb after a swipe.
    toastTimer.current = window.setTimeout(() => setToast(null), next.undo ? 8000 : next.action ? 6000 : 5000);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [active, gone, brief] = await Promise.all([
        fetchAll(ACTIVE_QUERY),
        fetchAll("status=dismissed", 300),
        request<Briefing | null>("/api/briefing").catch(() => null),
      ]);
      if (seen.current) {
        const known = seen.current;
        const arrived = active.filter((n) => !known.has(n.id)).map((n) => n.id);
        if (arrived.length) setFreshIds(new Set(arrived));
      }
      seen.current = new Set([...active, ...gone].map((n) => n.id));
      setItems(active.filter((n) => !hiding.current.has(n.id)));
      setDismissed(gone);
      setBriefing(brief);
      setTick((t) => t + 1);
    } catch (e) {
      if ((e as { status?: number }).status === 401) void checkAuth();
      else showToast({ message: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [checkAuth, showToast]);

  const signedIn = !!auth?.signedIn;

  // Grok Bot can set its chat link when it connects, so it's refetched with the inbox.
  useEffect(() => {
    if (signedIn) request<{ url: string | null }>("/api/prefs/grok-link").then((r) => setGrokLink(r.url), () => undefined);
  }, [signedIn, tick]);

  // A tapped push opens its notification: by URL on a cold start, by message when the app is already open.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    if (id) {
      setOpenId(id);
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
    const onMessage = (e: MessageEvent<{ type?: string; id?: string }>) => {
      if (e.data?.type === "open" && e.data.id) {
        window.location.hash = "";
        setOpenId(e.data.id);
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (signedIn) setBadge(items.filter((n) => n.status === "new").length);
  }, [signedIn, items]);

  // Opening an unread notification marks it read, however it was opened.
  useEffect(() => {
    const target = openId ? items.find((n) => n.id === openId) : undefined;
    if (target?.status !== "new") return;
    setItems((list) => list.map((n) => (n.id === target.id ? { ...n, status: "read" } : n)));
    actions.read(target.id).then(replace, () => undefined);
  }, [openId, items]);
  useEffect(() => {
    if (signedIn) void reload();
  }, [signedIn, reload]);
  useEffect(() => {
    if (!signedIn) return;
    request<{ name: string | null }>("/api/prefs/profile").then((r) => setOwnerName(r.name), () => undefined);
    // Opened from the Home Screen in the middle of setup (on iPhone that's a fresh sign-in): carry on with it.
    if (isStandalone() && !window.location.hash) {
      request<{ step: string | null; hidden: boolean }>("/api/setup").then(
        (s) => {
          if (s.step && s.step !== "done" && !s.hidden) window.location.hash = "welcome";
        },
        () => undefined,
      );
    }
  }, [signedIn]);

  const loaded = useRef(new Set<string>());
  loaded.current = new Set([...items, ...dismissed].map((n) => n.id));

  // Coalesce bursts of live updates into one refetch.
  const pending = useRef<number | undefined>(undefined);
  useLive(
    signedIn,
    () => {
      window.clearTimeout(pending.current);
      pending.current = window.setTimeout(() => void reload(), 250);
    },
    (m) => {
      // Streamed text lands in place without a refetch; a reply we haven't loaded yet triggers one.
      if (!loaded.current.has(m.id)) return void reload();
      const patch = (list: Notification[]) =>
        list.map((n) => (n.id === m.id ? { ...n, body: m.body, fullText: m.fullText, streaming: m.streaming } : n));
      setItems(patch);
      setDismissed(patch);
    },
    () => setSourcesTick((t) => t + 1),
  );

  const replace = (updated: Notification) => {
    setItems((list) => list.map((n) => (n.id === updated.id ? updated : n)));
    setDismissed((list) => list.map((n) => (n.id === updated.id ? updated : n)));
  };

  /** Dismisses, optionally asking Grok Bot to do `disposition` to each email at its source. Undo reverses both. */
  async function dismissMany(targets: Notification[], disposition: Disposition | null = null, message?: string) {
    const ids = new Set(targets.map((n) => n.id));
    for (const id of ids) hiding.current.add(id);
    setItems((list) => list.filter((n) => !ids.has(n.id)));
    if (openId && ids.has(openId)) setOpenId(null);
    try {
      await actions.dismissMany(targets.map((n) => n.id), disposition);
      // Only emails Grok Bot can find get the disposition (the server checks too); the rest are just dismissed.
      const atSource = disposition ? targets.filter((n) => whereLabel(n)) : [];
      const places = new Set(atSource.map(whereLabel));
      const where = places.size === 1 ? [...places][0] : "";
      const count = (k: number) => (k === 1 ? "" : ` ${k}`);
      const rest = targets.length - atSource.length;
      showToast({
        message:
          message ??
          (disposition && atSource.length
            ? `${DISPOSITION_LABELS[disposition].doing}${count(atSource.length)}${where}${rest ? `, dismissed ${rest}` : ""}`
            : `Dismissed${count(targets.length)}`),
        undo: () => void restoreMany(targets),
      });
    } catch (e) {
      showToast({ message: `Couldn't dismiss: ${(e as Error).message}` });
    } finally {
      for (const id of ids) hiding.current.delete(id);
      void reload();
    }
  }

  /** Marks a thread's notes read as soon as it's open; a failure just leaves them unread. */
  function readMany(targets: Notification[]) {
    const ids = new Set(targets.map((n) => n.id));
    const at = new Date().toISOString();
    setItems((list) => list.map((n) => (ids.has(n.id) && n.status === "new" ? { ...n, status: "read", readAt: at } : n)));
    // The server takes 500 at a time.
    const all = [...ids];
    const batches = Array.from({ length: Math.ceil(all.length / 500) }, (_, i) => all.slice(i * 500, (i + 1) * 500));
    Promise.all(batches.map((batch) => actions.readMany(batch))).then(() => reload(), () => reload());
  }

  /** Hides a card until `until`; undo brings it straight back. */
  async function snoozeOne(n: Notification, until: string) {
    setSnoozing(null);
    setItems((list) => list.map((m) => (m.id === n.id ? { ...m, snoozedUntil: until } : m)));
    if (openId === n.id) setOpenId(null);
    try {
      replace(await actions.snooze(n.id, until));
      showToast({ message: snoozedLabel(until), undo: () => void wake(n) });
    } catch (e) {
      showToast({ message: `Couldn't snooze: ${(e as Error).message}` });
      void reload();
    }
  }

  async function wake(n: Notification) {
    setToast(null);
    try {
      replace(await actions.snooze(n.id, null));
    } catch (e) {
      showToast({ message: (e as Error).message });
    }
  }

  async function restoreMany(targets: Notification[]) {
    setToast(null);
    try {
      await actions.restoreMany(targets.map((n) => n.id));
    } catch (e) {
      showToast({ message: `Couldn't restore: ${(e as Error).message}` });
    }
    void reload();
  }

  async function respondTo(n: Notification, text: string, action?: string) {
    try {
      replace(await actions.respond(n.id, text, action));
      showToast({ message: respondedToast(n, text, action) });
    } catch (e) {
      showToast({ message: (e as Error).message });
      throw e;
    }
  }

  /** Checking a task off dismisses its card; unchecking brings the card back. */
  async function checkTask(n: Notification, done: boolean) {
    if (done) {
      setDismissed((list) => [{ ...n, status: "dismissed", dismissedAt: new Date().toISOString() }, ...list]);
      await dismissMany([n], null, "Task done");
    } else await restoreMany([n]);
  }

  function open(n: Notification) {
    setOpenId(n.id);
  }

  async function toggleItem(n: Notification, block: number, item: string, done: boolean) {
    try {
      replace(await actions.checklist(n.id, block, item, done));
    } catch (e) {
      showToast({ message: (e as Error).message });
    }
  }

  async function signOut() {
    await request("/auth/logout", { method: "POST" });
    clearSnapshot();
    setItems([]);
    window.location.hash = "";
    await checkAuth();
  }

  const bots = useBots(tick, cached?.bots ?? null);
  const botMap = useMemo(() => new Map((bots ?? []).map((b) => [b.sourceId, b])), [bots]);
  const categories = useCategories(tick, cached?.categories ?? null);
  const sourceState = useSources(`${tick}:${sourcesTick}`);
  const [sources, setSources] = sourceState;
  const categoryMap = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);

  // Keep a copy for an instant start next time.
  useEffect(() => {
    if (signedIn && !loading && bots && categories) {
      writeSnapshot({ items: items.slice(0, 300), dismissed: dismissed.slice(0, 100), bots, categories, briefing });
    }
  }, [signedIn, loading, items, dismissed, bots, categories, briefing]);

  if (!auth) return <div className="empty">Loading…</div>;
  if (!auth.signedIn) {
    return (
      <Login
        hasPasskey={auth.hasPasskey}
        onSignedIn={() => {
          // The very first passkey: walk them through the rest of setup.
          if (!auth.hasPasskey) window.location.hash = "welcome";
          void checkAuth();
        }}
      />
    );
  }

  if (view === "welcome") {
    return (
      <CategoriesContext.Provider value={categoryMap}>
        {/* Inside the app frame, for the same safe-area padding as every other screen. */}
        <div className="app view-welcome">
          <Onboarding
            bots={bots}
            categories={categories}
            sources={sources}
            name={ownerName}
            onCategoriesChanged={() => void reload()}
            onFinish={() => (window.location.hash = "")}
            onName={(name) =>
              void request<{ name: string | null }>("/api/prefs/profile", { method: "PUT", json: { name } }).then(
                (r) => setOwnerName(r.name),
                () => undefined,
              )
            }
          />
        </div>
      </CategoriesContext.Provider>
    );
  }

  const openItem = openId ? (items.find((n) => n.id === openId) ?? dismissed.find((n) => n.id === openId)) : undefined;
  // Snoozed cards wait in the Dismissed view until they're back; the cron brings them back as new.
  // The server clears snoozedUntil when it wakes a card, so this doesn't flicker at the boundary.
  const snoozed = items.filter((n) => n.snoozedUntil);
  const awake = snoozed.length ? items.filter((n) => !n.snoozedUntil) : items;
  const unread = awake.filter((n) => n.status === "new").length;
  const openTasks = awake.filter((n) => isTask(n) && !taskDone(n)).length;
  const bot = view === "chat" ? (bots?.find((b) => b.sourceId === botId) ?? null) : null;
  const unreadChats = (bots ?? []).filter((b) => b.unread > 0).length;
  const titles: Record<View, string> = {
    inbox: "Herald",
    tasks: "Tasks",
    dismissed: "Dismissed",
    settings: "Settings",
    chats: "Chat",
    welcome: "Herald",
    chat: bot?.sender ?? "Chat",
  };

  return (
    <BotsContext.Provider value={botMap}>
    <CategoriesContext.Provider value={categoryMap}>
    <div className={`app view-${view} ${typing ? "is-typing" : ""}`}>
      <header className="top">
        {view === "dismissed" ? (
          <a className="back" href="#">
            ‹ Inbox
          </a>
        ) : view === "chat" ? (
          <a aria-label="Back to Chat" className="back icon-only" href="#chat">
            <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" viewBox="0 0 24 24" width="18">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </a>
        ) : (
          <span />
        )}
        {bot ? <ChatHeader bot={bot} /> : null}
        <div className="top-actions">
          {/* Some steps (signing in, approving a login) happen in Grok Bot's own chat; this goes straight there. */}
          {bot && grokLink ? (
            <a aria-label="Open in Grok Bot" className="top-link icon-only" href={grokLink} rel="noreferrer" target="_blank">
              <svg aria-hidden fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24" width="17">
                <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
              </svg>
            </a>
          ) : null}
          {view === "inbox" ? (
            <a className="top-link" href="#dismissed">
              Dismissed
            </a>
          ) : null}
        </div>
      </header>
      {/* A thread has its own header with the bot's face, as in Messages. */}
      {view === "chat" ? null : (
        <h1 className="large-title">
          {titles[view]}
          {view === "inbox" && unread ? <span className="title-count">{unread} new</span> : null}
          {view === "tasks" && openTasks ? <span className="title-count">{openTasks} to do</span> : null}
        </h1>
      )}

      {view === "inbox" && !search.trim() ? <SetupChecklist tick={tick} /> : null}
      {view === "inbox" && !search.trim() ? (
        <BriefingCard bots={bots ?? []} briefing={briefing} items={awake} ownerName={ownerName} />
      ) : null}
      {view === "inbox" && !search.trim() && sources ? (
        <QuietSources
          onScan={(s) =>
            void request<{ items: ScanSource[] }>("/api/sources/scan", { method: "POST", json: { ids: [s.id] } }).then(
              (r) => setSources((list) => (list ?? []).map((x) => r.items.find((y) => y.id === x.id) ?? x)),
              (e: Error) => showToast({ message: e.message }),
            )
          }
          sources={sources}
        />
      ) : null}

      {view === "inbox" || view === "dismissed" ? (
        <div className="search">
          <input
            aria-label="Search"
            enterKeyHint="search"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            type="search"
            value={search}
          />
        </div>
      ) : null}

      <main>
        {view === "settings" ? (
          <Settings
            categories={categories}
            onSourcesChanged={setSources}
            sources={sources}
            sourcesError={sourceState[2]}
            onSourcesRetry={() => setSourcesTick((t) => t + 1)}
            grokLink={grokLink}
            onCategoriesChanged={() => void reload()}
            onGrokLink={setGrokLink}
            onOwnerName={setOwnerName}
            ownerName={ownerName}
            bots={bots}
            onBotsChanged={() => void reload()}
            onSignOut={signOut}
          />
        ) : view === "dismissed" ? (
          <DismissedList
            items={dismissed}
            loading={loading}
            onOpen={open}
            onRestore={(n) => void restoreMany([n])}
            onWake={(n) => void wake(n)}
            search={search}
            snoozed={snoozed}
          />
        ) : view === "tasks" ? (
          <Tasks all={[...awake, ...dismissed]} loading={loading} onCheck={checkTask} onOpen={open} />
        ) : view === "chats" ? (
          <ChatList bots={bots} />
        ) : view === "chat" ? (
          bot ? (
            <ChatThread
              bot={bot}
              key={bot.sourceId}
              notes={[...items, ...dismissed].filter((n) => n.sourceId === bot.sourceId)}
              onClearReply={() => setReplyTo(null)}
              onOpen={open}
              onRead={readMany}
              onRespond={respondTo}
              onToggle={toggleItem}
              replyTo={replyTo?.sourceId === bot.sourceId ? replyTo : null}
              tick={tick}
            />
          ) : (
            <div className="empty">{bots ? "That bot isn't here." : "Loading…"}</div>
          )
        ) : (
          <Inbox
            all={[...awake, ...dismissed]}
            freshIds={freshIds}
            items={awake}
            loading={loading}
            onDismiss={(targets, disposition) => void dismissMany(targets, disposition ?? null)}
            onSnooze={setSnoozing}
            onOpen={open}
            onRespond={respondTo}
            search={search}
          />
        )}
      </main>

      <nav className="tabbar" aria-label="Sections">
        <a className={view === "inbox" || view === "dismissed" ? "is-active" : ""} href="#">
          <TabIcon d="M4 13h4l2 3h4l2-3h4M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
          Inbox{unread ? <span className="tab-badge">{unread}</span> : null}
        </a>
        <a className={view === "tasks" ? "is-active" : ""} href="#tasks">
          <TabIcon d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
          Tasks{openTasks ? <span className="tab-badge">{openTasks}</span> : null}
        </a>
        <a className={view === "chats" || view === "chat" ? "is-active" : ""} href="#chat">
          <TabIcon d="M12 4.5c-4.7 0-8.5 3.1-8.5 7 0 2.1 1.1 4 2.9 5.3-.2 1.3-.9 2.5-1.9 3.4 1.9 0 3.6-.7 4.8-1.7.9.2 1.8.3 2.7.3 4.7 0 8.5-3.1 8.5-7s-3.8-7.3-8.5-7.3z" />
          Chat{unreadChats ? <span className="tab-badge">{unreadChats}</span> : null}
        </a>
        <a className={view === "settings" ? "is-active" : ""} href="#settings">
          <TabIcon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.3-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.3 1 2-3.4z" />
          Settings
        </a>
      </nav>

      {openItem ? (
        <Detail
          n={openItem}
          onClose={() => setOpenId(null)}
          onDismiss={(disposition) => void dismissMany([openItem], disposition ?? null)}
          onSnooze={() => setSnoozing(openItem)}
          onFollowUp={
            openItem.source === "bot"
              ? () => {
                  setReplyTo(openItem);
                  setOpenId(null);
                  window.location.hash = chatHref(openItem.sourceId);
                }
              : undefined
          }
          onRespond={(text, action) => respondTo(openItem, text, action)}
          onRestore={() => {
            setOpenId(null);
            void restoreMany([openItem]);
          }}
          onToggle={(block, item, done) => toggleItem(openItem, block, item, done)}
        />
      ) : null}

      {snoozing ? <SnoozeSheet n={snoozing} onClose={() => setSnoozing(null)} onPick={(until) => void snoozeOne(snoozing, until)} /> : null}

      {toast ? (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo ? (
            <button className="toast-undo" onClick={toast.undo} type="button">
              Undo
            </button>
          ) : null}
          {toast.action ? (
            <button
              className="toast-undo"
              onClick={() => {
                setToast(null);
                toast.action?.run();
              }}
              type="button"
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
    </CategoriesContext.Provider>
    </BotsContext.Provider>
  );
}

/** "Reply sent", "Marked done", "Approved". */
function respondedToast(n: Notification, text: string, action?: string): string {
  if (action === DONE_ACTION) return "Marked done";
  const chosen = n.actions.find((a) => a.id === action);
  if (chosen?.type === "reply") return "Reply sent";
  return chosen?.label ?? answeredLabel(text);
}
