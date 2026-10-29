import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Bot, BotRequest, Notification } from "../shared/types";
import { request } from "./api";
import { ActionBar, DueChip, isTransaction, SubjectView } from "./Action";
import { AnswerButtons, answerButtons, Avatar } from "./Card";
import { daysBetween, needsYou } from "./group";
import { Blocks, RichText, TypingDots } from "./Rich";

export function useBots(tick: number, initial: Bot[] | null = null) {
  const [bots, setBots] = useState<Bot[] | null>(initial);
  useEffect(() => {
    request<{ items: Bot[] }>("/api/bots").then((r) => setBots(r.items), () => setBots((b) => b ?? []));
  }, [tick]);
  return bots;
}

export function chatHref(sourceId: string): string {
  return `#chat/${encodeURIComponent(sourceId)}`;
}

/** Like Messages: a time today, "Yesterday", a weekday this week, else a date. */
function listTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = -daysBetween(date, now);
  if (days <= 0) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

/** The centered time between messages: "Today 3:42 PM", "Yesterday 9:10 AM", "Mon, Oct 26 at 8:00 AM". */
function separatorTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = -daysBetween(date, now);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Every bot as a conversation, Messages-style: newest first, with the main agent pinned on top. */
export function ChatList({ bots }: { bots: Bot[] | null }) {
  if (!bots) return <div className="empty">Loading…</div>;
  return (
    <ul className="chat-list glass">
      {bots.map((bot) => {
        const typing = bot.status.state === "working";
        return (
          <li key={bot.sourceId}>
            <a className="chat-row" href={chatHref(bot.sourceId)}>
              <span aria-label={bot.unread ? "Unread" : undefined} className={`chat-unread ${bot.unread ? "is-on" : ""}`} />
              <Avatar color={bot.color} name={bot.sender} size={48} url={bot.avatarUrl} working={typing} />
              <span className="chat-main">
                <span className="chat-top">
                  <span className="chat-name">{bot.sender}</span>
                  <span className="chat-time">{bot.last ? listTime(bot.last.at) : ""}</span>
                  <span aria-hidden className="chat-chevron">
                    ›
                  </span>
                </span>
                <span className={`chat-preview ${typing ? "is-typing" : ""}`}>
                  {typing
                    ? (bot.status.text ?? "Typing…")
                    : bot.last
                      ? `${bot.last.mine ? "You: " : ""}${oneLine(bot.last.text)}`
                      : (bot.role ?? "Say hello")}
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** What the last thing you sent shows under it, like Delivered and Read in Messages. */
function receipt(r: BotRequest): { text: string; failed?: boolean } {
  if (r.status === "answered" || r.acknowledgedAt) return { text: "Read" };
  if (r.delivery === "delivered") return { text: "Delivered" };
  if (r.delivery === "dead") return { text: "Not Delivered", failed: true };
  if (r.delivery === "pending") return { text: "Sending…" };
  return { text: "Sent" };
}

/** A gap this long between messages gets a time above the next one. */
const SEPARATOR_MS = 15 * 60_000;
/** Messages from one side this close together sit in one group, with a tail on the last. */
const GROUP_MS = 2 * 60_000;

type Entry = { at: string; mine: true; request: BotRequest } | { at: string; mine: false; note: Notification };

interface Placed {
  entry: Entry;
  /** Show a centered time above it. */
  separator: boolean;
  /** The next message continues its group, so this one has no tail. */
  continued: boolean;
}

/** Times and tails, worked out from neighbors, as Messages does. */
function place(entries: Entry[]): Placed[] {
  return entries.map((entry, i) => {
    const prev = entries[i - 1];
    const next = entries[i + 1];
    const gap = (a: Entry, b: Entry) => new Date(b.at).getTime() - new Date(a.at).getTime();
    const separator = !prev || gap(prev, entry) > SEPARATOR_MS;
    const continued = !!next && next.mine === entry.mine && gap(entry, next) <= GROUP_MS;
    return { entry, separator, continued };
  });
}

/** One of your messages, quoting what it follows up on. The last one, or one that failed, says where it got to. */
function MyBubble({
  request: r,
  quoted,
  continued,
  last,
  onOpen,
}: {
  request: BotRequest;
  quoted: Notification | undefined;
  continued: boolean;
  last: boolean;
  onOpen: (n: Notification) => void;
}) {
  const status = receipt(r);
  return (
    <>
      <div className={`bubble-row is-mine ${continued ? "is-continued" : ""}`}>
        <div className="bubble">
          {quoted ? (
            <button className="bubble-quote" onClick={() => onOpen(quoted)} type="button">
              {oneLine(quoted.title ?? quoted.body, 90)}
            </button>
          ) : null}
          <div className="bubble-text">{r.text}</div>
        </div>
      </div>
      {last || status.failed ? <div className={`chat-receipt ${status.failed ? "is-failed" : ""}`}>{status.text}</div> : null}
    </>
  );
}

/** A bot's post: its text and cards, with whatever it asks of you answerable in place. */
function NoteBubble({
  n,
  continued,
  onOpen,
  onRespond,
  onToggle,
}: {
  n: Notification;
  continued: boolean;
  onOpen: (n: Notification) => void;
  onRespond: (text: string, action?: string) => Promise<void>;
  onToggle: (block: number, item: string, done: boolean) => Promise<void>;
}) {
  const transaction = isTransaction(n);
  const answers = !transaction && answerButtons(n).length > 0;
  const waitingElsewhere = n.blocks.some((b) => b.type === "handoff" && b.state === "waiting");
  return (
    <div className={`bubble-row ${continued ? "is-continued" : ""}`}>
      <div className="note-bubble">
        {n.title ? (
          <button className="note-open note-title" onClick={() => onOpen(n)} type="button">
            {n.title}
          </button>
        ) : null}
        {/* Tapping the text opens the whole notification, to reply, dismiss or see its details. */}
        <div className="note-body note-open" onClick={() => onOpen(n)} onKeyDown={(e) => e.key === "Enter" && onOpen(n)} role="button" tabIndex={0}>
          <RichText n={n} />
        </div>
        {n.status === "dismissed" ? <div className="note-flag">Dismissed</div> : null}
        <Blocks blocks={n.blocks} onToggle={onToggle} />
        {n.dueAt && n.status !== "responded" ? <DueChip n={n} /> : null}
        {n.subject ? <SubjectView compact subject={n.subject} /> : null}
        {transaction ? <ActionBar n={n} onRespond={onRespond} /> : null}
        {answers ? (
          <AnswerButtons n={n} onRespond={(t) => onRespond(t)} />
        ) : needsYou(n) && !transaction && !waitingElsewhere ? (
          <button className="note-open note-needs" onClick={() => onOpen(n)} type="button">
            Reply ›
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The bot's face and name in the middle of the thread's top bar, which stays put while the thread scrolls. */
export function ChatHeader({ bot }: { bot: Bot }) {
  const working = bot.status.state === "working";
  return (
    <div className="chat-header">
      {/* No pulsing ring at this size, where it reads as blur; the line below says it's working. */}
      <Avatar color={bot.color} name={bot.sender} size={34} url={bot.avatarUrl} />
      <div className="chat-header-name">{bot.sender}</div>
      <div className={`chat-header-sub ${working ? "is-working" : ""}`}>{working ? (bot.status.text ?? "Working…") : (bot.role ?? bot.status.text ?? "")}</div>
    </div>
  );
}

/** One bot's conversation, Messages-style: your requests in blue on the right, its posts on the left. */
export function ChatThread({
  bot,
  notes,
  tick,
  onOpen,
  replyTo,
  onClearReply,
  onToggle,
  onRespond,
  onRead,
}: {
  bot: Bot;
  notes: Notification[];
  tick: number;
  onOpen: (n: Notification) => void;
  /** A notification the next message follows up on. */
  replyTo: Notification | null;
  onClearReply: () => void;
  onToggle: (n: Notification, block: number, item: string, done: boolean) => Promise<void>;
  onRespond: (n: Notification, text: string, action?: string) => Promise<void>;
  /** Marks these read: whatever's unread in the thread once it's on screen, as Messages does. */
  onRead: (notes: Notification[]) => void;
}) {
  const [requests, setRequests] = useState<BotRequest[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);



  useEffect(() => {
    request<{ items: BotRequest[] }>(`/api/requests?to=${encodeURIComponent(bot.sourceId)}`).then(
      (r) => setRequests(r.items),
      () => undefined,
    );
  }, [bot.sourceId, tick]);

  const placed = useMemo(() => {
    const all: Entry[] = [
      ...requests.map((r) => ({ at: r.createdAt, mine: true as const, request: r })),
      ...notes.map((n) => ({ at: n.createdAt, mine: false as const, note: n })),
    ];
    // Oldest first; the latest 60 keep the page light.
    return place(all.sort((a, b) => a.at.localeCompare(b.at)).slice(-60));
  }, [requests, notes]);

  // What's unread among the messages on screen; read once the thread is in front of you, as Messages does.
  const unread = placed.flatMap(({ entry }) => (!entry.mine && entry.note.status === "new" && !entry.note.streaming ? [entry.note] : []));
  const unreadKey = unread.map((n) => n.id).join(",");
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  useEffect(() => {
    if (unread.length && visible) onRead(unread);
    // Keyed on the ids and visibility, so a refetch with the same unread notes doesn't send again.
  }, [unreadKey, visible]);

  const last = placed.at(-1)?.entry;
  const lastMine = [...placed].reverse().find((p) => p.entry.mine)?.entry;
  const streamingNote = notes.find((n) => n.streaming);
  // Typing dots while the bot says it's working, unless its reply is already streaming in.
  const typing = bot.status.state === "working" && !streamingNote;
  // The bot's own suggested replies, when it has the last word and isn't waiting on something else.
  // There are no stock ones: a generic "Do it" under a message that asks you to go elsewhere just loops.
  const chips =
    last && !last.mine && !last.note.streaming && !needsYou(last.note) && !isTransaction(last.note) && last.note.status !== "dismissed"
      ? last.note.quickReplies
      : [];
  const streamLength = streamingNote?.fullText?.length ?? 0;

  // Keep the newest message in view, above the composer and tab bar.
  useLayoutEffect(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [placed.length, typing, streamLength, chips.length]);

  async function send(value: string, inReplyTo: string | null) {
    if (!value.trim()) return false;
    setSending(true);
    setError(null);
    try {
      const created = await request<BotRequest>("/api/requests", {
        method: "POST",
        json: { to: bot.sourceId, text: value.trim(), ...(inReplyTo ? { inReplyTo } : {}) },
      });
      setRequests((list) => [created, ...list]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="thread" style={bot.color ? ({ "--accent": bot.color } as React.CSSProperties) : undefined}>
      {placed.length === 0 ? <div className="chat-empty">Ask {bot.sender} anything.</div> : null}
      {placed.map(({ entry, separator, continued }) => (
        <div className="chat-item" key={entry.mine ? entry.request.id : entry.note.id}>
          {separator ? <div className="chat-separator">{separatorTime(entry.at)}</div> : null}
          {entry.mine ? (
            <MyBubble
              continued={continued}
              last={entry === lastMine}
              onOpen={onOpen}
              quoted={entry.request.inReplyTo ? byId.get(entry.request.inReplyTo) : undefined}
              request={entry.request}
            />
          ) : (
            <NoteBubble
              continued={continued}
              n={entry.note}
              onOpen={onOpen}
              onRespond={(t, a) => onRespond(entry.note, t, a)}
              onToggle={(block, item, done) => onToggle(entry.note, block, item, done)}
            />
          )}
        </div>
      ))}
      {typing ? (
        <div className="bubble-row">
          <div className="note-bubble typing-bubble">
            <TypingDots label={`${bot.sender} is typing`} />
          </div>
        </div>
      ) : null}
      {chips.length && last && !last.mine ? (
        <div className="reply-chips">
          {chips.map((chip) => (
            <button className="chip" disabled={sending} key={chip} onClick={() => void send(chip, last.note.id)} type="button">
              {chip}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="composer chat-composer"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await send(text, replyTo?.id ?? null)) {
            setText("");
            onClearReply();
          }
        }}
      >
        {error ? <div className="error">{error}</div> : null}
        {replyTo ? (
          <div className="composer-quote">
            <span>
              Replying to <strong>{oneLine(replyTo.title ?? replyTo.body, 90)}</strong>
            </span>
            <button aria-label="Don't reply to it" className="icon-btn" onClick={onClearReply} type="button">
              ×
            </button>
          </div>
        ) : null}
        <div className="chat-input">
          <textarea
            aria-label={`Message ${bot.sender}`}
            enterKeyHint="send"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Message"
            ref={input}
            rows={1}
            value={text}
          />
          <button aria-label="Send" className="chat-send" disabled={!text.trim() || sending} type="submit">
            <svg aria-hidden fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" viewBox="0 0 24 24">
              <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
