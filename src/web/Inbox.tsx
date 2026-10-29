import { useContext, useEffect, useMemo, useState } from "react";
import { type Disposition, DONE_ACTION, isTransaction, type Notification, taskDone, UP_NEXT_DAYS } from "../shared/types";
import { CategoriesContext, useFiling } from "./categories";
import { answerButtons, Card } from "./Card";
import { daysBetween, groupByDay, matchesSearch, needsYou, type Stack, stackAll } from "./group";
import { AllCaughtUp } from "./Home";
import { snoozedLabel } from "./Snooze";
import { byDue } from "./Tasks";

interface InboxProps {
  items: Notification[];
  onOpen: (n: Notification) => void;
  /** A disposition also asks Grok Bot to do that to each email at its source. */
  onDismiss: (items: Notification[], disposition?: Disposition | null) => void;
  onSnooze: (n: Notification) => void;
  onRespond: (n: Notification, text: string, action?: string) => Promise<void>;
  loading: boolean;
  search: string;
  /** Everything, dismissed included, for the day's tally. */
  all: Notification[];
  /** Arrived while the app was open: these slide in. */
  freshIds: Set<string>;
}

type CardHandlers = Pick<InboxProps, "onOpen" | "onDismiss" | "onSnooze" | "onRespond" | "freshIds">;

/** Home shows this many cards that need the owner; the rest are on the Tasks tab. */
const NEEDS_SHOWN = 5;
/** Events starting in this window show under Up next. */
const UP_NEXT_MS = UP_NEXT_DAYS * 86_400_000;
/** A stack summary older than this is stale even if nothing in the stack changed. */
const SUMMARY_MS = 24 * 3_600_000;
const UP_NEXT_SHOWN = 3;

function OneCard({ n, onOpen, onDismiss, onSnooze, onRespond, freshIds }: CardHandlers & { n: Notification }) {
  return (
    <Card
      fresh={freshIds.has(n.id)}
      n={n}
      onDismiss={(disposition) => onDismiss([n], disposition)}
      onDone={() => void onRespond(n, "Done", DONE_ACTION).catch(() => undefined)}
      onOpen={() => onOpen(n)}
      onSnooze={taskDone(n) ? undefined : () => onSnooze(n)}
      onRespond={(t, a) => onRespond(n, t, a)}
    />
  );
}

/**
 * A category's cards as one stack. Collapsed, it shows a bot's summary of the
 * stack in place of the newest card's text. Herald clears the summary when
 * the stack changes, so one that's set still describes it. A newest card with
 * something to act on keeps its own face, buttons and all.
 */
function StackView({
  stack,
  expanded,
  onToggle,
  ...handlers
}: CardHandlers & { stack: Stack; expanded: boolean; onToggle: () => void }) {
  const [top, ...rest] = stack.items as [Notification, ...Notification[]];
  const filing = useFiling(top);
  if (rest.length === 0) return <OneCard n={top} {...handlers} />;
  const { onDismiss, onRespond, freshIds } = handlers;
  if (!expanded) {
    const summary = filing.category?.summary;
    const actionable = isTransaction(top) || answerButtons(top).length > 0 || !!top.dueAt;
    const current = summary && !actionable && Date.now() - new Date(summary.at).getTime() < SUMMARY_MS ? summary.text : null;
    return (
      <div className={`stack depth-${Math.min(rest.length, 2)}`}>
        <Card
          fresh={freshIds.has(top.id)}
          footer={
            <div className="stack-more">{current ? `${stack.items.length} cards` : `+${rest.length} more`}</div>
          }
          n={top}
          onDismiss={(disposition) => onDismiss(stack.items, disposition)}
          onOpen={onToggle}
          onRespond={(t, a) => onRespond(top, t, a)}
          summary={current}
        />
        <div aria-hidden className="stack-peek glass peek-1" />
        {rest.length > 1 ? <div aria-hidden className="stack-peek glass peek-2" /> : null}
      </div>
    );
  }
  return (
    <div className="stack-open">
      <div className="stack-head">
        <span className="stack-name">{filing.plural}</span>
        <button className="chip-btn" onClick={onToggle} type="button">
          Show less
        </button>
        <button className="chip-btn" onClick={() => onDismiss(stack.items)} type="button" aria-label="Clear all">
          Clear all
        </button>
      </div>
      {stack.items.map((n) => (
        <OneCard key={n.id} n={n} {...handlers} />
      ))}
    </div>
  );
}

/** "Now", "Today", "Tomorrow" or a weekday, and the start time. */
function eventWhen(iso: string, now: number): { day: string; time: string } {
  const date = new Date(iso);
  const days = daysBetween(date, new Date(now));
  const day =
    date.getTime() <= now ? "Now" : days === 0 ? "Today" : days === 1 ? "Tomorrow" : date.toLocaleDateString(undefined, { weekday: "short" });
  return { day, time: date.toLocaleTimeString(undefined, { hour: "numeric", minute: date.getMinutes() ? "2-digit" : undefined }) };
}

/** The current time, updated every minute, for views that age while left open. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The next few events from the calendar, at a glance. Built from cleared
 * cards too: clearing "Dentist moved to Thursday" clears the notice, not the
 * dentist. One row per event, from its newest card.
 */
function UpNext({ items, onOpen }: { items: Notification[]; onOpen: (n: Notification) => void }) {
  const now = useMinute();
  const events = useMemo(() => {
    const newest = new Map<string, { n: Notification; name: string; at: string; where: string | undefined }>();
    for (const n of items) {
      const event = n.subject;
      if (event?.type !== "event" || !event.startsAt) continue;
      const key = event.ref?.eventId ? `${event.ref.provider}|${event.ref.account ?? ""}|${event.ref.eventId}` : `${event.name}|${event.startsAt}`;
      const seen = newest.get(key);
      if (!seen || seen.n.createdAt < n.createdAt) newest.set(key, { n, name: event.name, at: event.startsAt, where: event.location });
    }
    return [...newest.values()]
      .filter((e) => {
        const at = new Date(e.at).getTime();
        return at >= now - 30 * 60_000 && at <= now + UP_NEXT_MS;
      })
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, UP_NEXT_SHOWN);
  }, [items, now]);
  if (events.length === 0) return null;
  return (
    <section aria-label="Up next" className="home-section">
      <h2 className="section-label">Up next</h2>
      <div className="up-next glass">
        {events.map(({ n, name, at, where }) => {
          const when = eventWhen(at, now);
          return (
            <button className="up-next-row" key={n.id} onClick={() => onOpen(n)} type="button">
              <span className="up-next-when">
                <span>{when.day}</span>
                <strong>{when.time}</strong>
              </span>
              <span className="up-next-what">
                <span className="up-next-name">{name}</span>
                {where ? <span className="muted">{where}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** What bots already took care of, folded into one line until opened. */
function Handled({ items, ...handlers }: CardHandlers & { items: Notification[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const latest = items[0] as Notification;
  return (
    <section aria-label="Handled for you" className="home-section">
      <button aria-expanded={open} className="handled glass" onClick={() => setOpen((v) => !v)} type="button">
        <span aria-hidden className="handled-check">
          ✓
        </span>
        <span className="handled-main">
          <strong>Handled for you · {items.length}</strong>
          <span className="muted">{latest.outcome ?? latest.title ?? latest.body}</span>
        </span>
        <span aria-hidden className="muted">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="handled-list">
          <div className="list-tools">
            <ClearAll count={items.length} onClear={() => handlers.onDismiss(items)} />
          </div>
          {items.map((n) => (
            <OneCard key={n.id} n={n} {...handlers} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Tap once to arm, again within a few seconds to clear. Undo is offered afterwards. */
function ClearAll({ count, onClear }: { count: number; onClear: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  if (count === 0) return null;
  return (
    <button
      className={`chip-btn clear-all ${armed ? "is-armed" : ""}`}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onClear();
      }}
      type="button"
    >
      {armed ? `Clear ${count}?` : "Clear all"}
    </button>
  );
}

/**
 * Home, top to bottom: what's coming up, what needs the owner (one card
 * each), everything else stacked by category, and what bots handled. A search
 * shows every match by day instead.
 */
export function Inbox({ items, onOpen, onDismiss, onSnooze, onRespond, loading, search, all, freshIds }: InboxProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const categories = useContext(CategoriesContext);
  const handlers: CardHandlers = { onOpen, onDismiss, onSnooze, onRespond, freshIds };

  const { needs, stacks, handled } = useMemo(() => {
    const needs = items.filter(needsYou).sort(byDue);
    const handled = items.filter((n) => n.lane === "handled");
    const rest = items.filter((n) => n.lane !== "handled" && !needsYou(n));
    return { needs, stacks: stackAll(rest, categories), handled };
  }, [items, categories]);
  const matches = useMemo(
    () => (search.trim() ? groupByDay(items.filter((n) => matchesSearch(n, search, categories))) : []),
    [items, search, categories],
  );

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (search.trim()) {
    if (matches.length === 0) return <div className="empty">{`Nothing matches “${search.trim()}”.`}</div>;
    return (
      <>
        {matches.map((day) => (
          <section className="day" key={day.key}>
            <h2 className="day-label">{day.label}</h2>
            {day.stacks.map(({ items: [n] }) => (n ? <OneCard key={n.id} n={n} {...handlers} /> : null))}
          </section>
        ))}
      </>
    );
  }

  if (items.length === 0)
    return loading ? (
      <div className="empty">Loading…</div>
    ) : (
      <>
        <UpNext items={all} onOpen={onOpen} />
        <AllCaughtUp all={all} />
      </>
    );

  const rest = stacks.flatMap((s) => s.items);
  return (
    <>
      <UpNext items={all} onOpen={onOpen} />
      {needs.length === 0 && stacks.length === 0 ? <AllCaughtUp all={all} /> : null}

      {needs.length ? (
        <section aria-label="Needs you" className="home-section">
          <h2 className="section-label">
            Needs you <span className="day-count">{needs.length}</span>
          </h2>
          {needs.slice(0, NEEDS_SHOWN).map((n) => (
            <OneCard key={n.id} n={n} {...handlers} />
          ))}
          {needs.length > NEEDS_SHOWN ? (
            <a className="more-link" href="#tasks">
              {needs.length - NEEDS_SHOWN} more in Tasks ›
            </a>
          ) : null}
        </section>
      ) : null}

      {stacks.length ? (
        <section aria-label="Updates" className="home-section">
          <div className="section-head">
            <h2 className="section-label">Updates</h2>
            <ClearAll count={rest.length} onClear={() => onDismiss(rest)} />
          </div>
          {stacks.map((stack) => (
            <StackView
              expanded={expanded.has(stack.key)}
              key={stack.key}
              onToggle={() => toggle(stack.key)}
              stack={stack}
              {...handlers}
            />
          ))}
        </section>
      ) : null}

      <Handled items={handled} {...handlers} />
    </>
  );
}

/** Out of the way: what's snoozed (soonest back first), then what's dismissed, by day. */
export function DismissedList({
  items,
  snoozed,
  onOpen,
  onRestore,
  onWake,
  loading,
  search,
}: {
  items: Notification[];
  snoozed: Notification[];
  onOpen: (n: Notification) => void;
  onRestore: (n: Notification) => void;
  onWake: (n: Notification) => void;
  loading: boolean;
  search: string;
}) {
  const categories = useContext(CategoriesContext);
  const days = useMemo(() => groupByDay(items.filter((n) => matchesSearch(n, search, categories))), [items, search, categories]);
  const later = useMemo(
    () =>
      snoozed
        .filter((n) => matchesSearch(n, search, categories))
        .sort((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? "")),
    [snoozed, search, categories],
  );
  if (days.length === 0 && later.length === 0) {
    return <div className="empty">{loading ? "Loading…" : search.trim() ? `Nothing matches “${search.trim()}”.` : "Nothing snoozed or dismissed."}</div>;
  }
  return (
    <>
      {later.length ? (
        <section className="day">
          <h2 className="day-label">Snoozed</h2>
          {later.map((n) => (
            <Card
              footer={<div className="card-source">{snoozedLabel(n.snoozedUntil as string)}</div>}
              key={n.id}
              n={n}
              onOpen={() => onOpen(n)}
              trailing={
                <button
                  className="chip-btn restore-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onWake(n);
                  }}
                  type="button"
                >
                  Now
                </button>
              }
            />
          ))}
        </section>
      ) : null}
      {days.map((day) => (
        <section className="day" key={day.key}>
          <h2 className="day-label">{day.label}</h2>
          {day.stacks.map(({ items: [n] }) =>
            n ? (
              <Card
                key={n.id}
                n={n}
                onOpen={() => onOpen(n)}
                trailing={
                  <button
                    className="chip-btn restore-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestore(n);
                    }}
                    type="button"
                  >
                    Restore
                  </button>
                }
              />
            ) : null,
          )}
        </section>
      ))}
    </>
  );
}
