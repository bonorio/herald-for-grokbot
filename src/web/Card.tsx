import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Disposition, isExpired, type Notification, promptOptions, type SwipeAction } from "../shared/types";
import { ActionBar, DueChip, isTransaction, SubjectView, TypeBadge } from "./Action";
import { useFiling } from "./categories";
import { needsYou, relativeTime } from "./group";
import { accentFor, CardProgress, TypingDots } from "./Rich";

const ACTION_LABELS: Record<string, string> = { approve: "Approve", deny: "Deny", yes: "Yes", no: "No" };
const ANSWERED_LABELS: Record<string, string> = { approve: "Approved", deny: "Denied", yes: "Yes", no: "No" };

/** Answer buttons with the affirmative one last, filled. */
export function answerButtons(n: Notification): string[] {
  if (!needsYou(n) || isExpired(n.responsePrompt)) return [];
  const options = promptOptions(n.responsePrompt);
  return n.responsePrompt?.type === "approval" || n.responsePrompt?.type === "yes_no" ? [...options].reverse() : options;
}

export function actionLabel(option: string): string {
  return ACTION_LABELS[option] ?? option;
}

export function answeredLabel(text: string): string {
  return ANSWERED_LABELS[text] ?? text;
}

export function Avatar({
  name,
  url,
  size = 38,
  color,
  working,
}: {
  name: string;
  url: string | null;
  size?: number;
  /** The bot's accent; otherwise one is picked from the name. */
  color?: string | null;
  /** Pulses a ring while the bot is busy. */
  working?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const accent = accentFor(name, color);
  const style = { width: size, height: size, fontSize: size * 0.42, "--accent": accent } as React.CSSProperties;
  const ring = working ? " is-working" : "";
  if (url && !broken) {
    return <img alt="" className={`avatar${ring}`} src={url} style={style} onError={() => setBroken(true)} />;
  }
  return (
    <div className={`avatar${ring}`} style={{ ...style, background: accent }}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </div>
  );
}

export function Pills({ n }: { n: Notification }) {
  if (n.status === "responded" || n.status === "dismissed") return null;
  return (
    <>
      {n.urgent ? <span className="pill pill-urgent">Urgent</span> : null}
      {n.lane === "needs_you" && !n.urgent && !isTransaction(n) ? <span className="pill pill-needs">Needs you</span> : null}
    </>
  );
}

/**
 * A question's options as buttons, the affirmative one last and filled. Taps
 * don't reach a card or swipe underneath.
 */
export function AnswerButtons({ n, onRespond }: { n: Notification; onRespond: (text: string) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const options = answerButtons(n);
  return (
    <div className="card-actions">
      {options.map((option, index) => (
        <button
          className={index === options.length - 1 ? "is-primary" : ""}
          disabled={!!busy}
          key={option}
          onClick={(e) => {
            e.stopPropagation();
            setBusy(option);
            onRespond(option)
              .catch(() => undefined)
              .finally(() => setBusy(null));
          }}
          onPointerDown={(e) => e.stopPropagation()}
          type="button"
        >
          {busy === option ? "…" : actionLabel(option)}
        </button>
      ))}
    </div>
  );
}

const SLIDE_MS = 200;
const COLLAPSE_MS = 220;
/** Past this share of the card's width a swipe acts; past the second, it takes the long action. */
const SHORT = 0.3;
const LONG = 0.62;

/** What a swipe does in one direction: a short pull, and optionally a longer one past a detent. */
export interface SwipeSide {
  label: string;
  run: () => void;
  /** The card leaves the list (dismiss, archive, snooze); otherwise it springs back. */
  leaves?: boolean;
  long?: { label: string; run: () => void; leaves?: boolean };
}

/**
 * Swipe left or right, with a second action past a detent on each side.
 * Moves the card directly (no re-render per frame), reveals the layer for
 * that side only in the gap the card leaves, marks the detent as it's
 * crossed, and once a sideways drag starts, stops iOS from turning it into
 * a page scroll.
 */
function useSwipe({ left, right }: { left?: SwipeSide; right?: SwipeSide }) {
  const enabled = !!(left || right);
  const wrap = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const underLeft = useRef<HTMLDivElement>(null);
  const underRight = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; lastX: number; lastT: number; v: number; id: number; active: boolean } | null>(null);
  /** The side whose long action is showing, if any. */
  const armed = useRef<"left" | "right" | null>(null);
  const suppressClick = useRef(false);
  const leaving = useRef(false);

  useEffect(() => {
    const el = card.current;
    if (!el || !enabled) return;
    const onTouchMove = (e: TouchEvent) => {
      if (drag.current?.active && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, [enabled]);

  function paint(dx: number, animate: boolean) {
    const c = card.current;
    if (!c) return;
    c.style.transition = animate ? "" : "none";
    c.style.transform = dx ? `translateX(${dx}px)` : "";
    // A swipe left uncovers the layer on the right, and the other way round.
    for (const [layer, gap] of [
      [underLeft.current, Math.max(0, -dx)],
      [underRight.current, Math.max(0, dx)],
    ] as const) {
      if (!layer) continue;
      layer.style.transition = animate ? "" : "none";
      layer.style.clipPath =
        layer === underLeft.current
          ? `inset(0 0 0 calc(100% - ${gap}px) round var(--radius))`
          : `inset(0 calc(100% - ${gap}px) 0 0 round var(--radius))`;
    }
  }

  /** Shows a side's long action once the drag passes its detent (null: neither), and ticks as it does. */
  function arm(side: "left" | "right" | null) {
    if (armed.current === side) return;
    armed.current = side;
    underLeft.current?.classList.toggle("is-long", side === "left");
    underRight.current?.classList.toggle("is-long", side === "right");
    // Android ticks; iPhone has no web haptics, so the label also pops (see .swipe-under.is-long) to make the detent felt by eye.
    if (side) navigator.vibrate?.(8);
  }

  function reset() {
    leaving.current = false;
    const w = wrap.current;
    if (w) w.style.cssText = "";
    arm(null);
    paint(0, false);
  }

  /** Slides the card off toward `direction`, folds its row away, then runs the action. */
  function leave(direction: -1 | 1, width: number, run: () => void) {
    leaving.current = true;
    paint(direction * (width + 40), true);
    const w = wrap.current;
    window.setTimeout(() => {
      if (w) {
        // Fold the row away so the list closes up smoothly.
        w.style.height = `${w.offsetHeight}px`;
        void w.offsetHeight;
        w.style.transition = `height ${COLLAPSE_MS}ms var(--ease), margin ${COLLAPSE_MS}ms var(--ease)`;
        w.style.height = "0px";
        w.style.marginBottom = "0px";
        w.style.overflow = "hidden";
      }
      window.setTimeout(() => {
        run();
        // If the card is still here (the request failed and it came back), show it again.
        window.setTimeout(() => wrap.current && leaving.current && reset(), 1500);
      }, COLLAPSE_MS);
    }, SLIDE_MS);
  }

  function finish(side: SwipeSide, direction: -1 | 1, long: boolean, width: number) {
    const action = long && side.long ? side.long : side;
    if (action.leaves) return leave(direction, width, action.run);
    paint(0, true);
    arm(null);
    action.run();
  }

  const handlers = enabled
    ? {
        onPointerDown(e: React.PointerEvent<HTMLElement>) {
          if (leaving.current || (e.pointerType === "mouse" && e.button !== 0)) return;
          drag.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastT: e.timeStamp, v: 0, id: e.pointerId, active: false };
          suppressClick.current = false;
        },
        onPointerMove(e: React.PointerEvent<HTMLElement>) {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const x = e.clientX - d.x;
          const y = e.clientY - d.y;
          if (!d.active) {
            // Decide the axis once: mostly vertical is a scroll, mostly sideways is a swipe.
            if (Math.abs(y) > 8 && Math.abs(y) >= Math.abs(x)) {
              drag.current = null;
              return;
            }
            if (Math.abs(x) < 8) return;
            d.active = true;
            suppressClick.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          const dt = Math.max(1, e.timeStamp - d.lastT);
          d.v = (e.clientX - d.lastX) / dt;
          d.lastX = e.clientX;
          d.lastT = e.timeStamp;
          const side = x < 0 ? left : right;
          // Resist dragging toward a side with nothing on it.
          paint(side ? x : x / 6, false);
          arm(side?.long && Math.abs(x) > e.currentTarget.offsetWidth * LONG ? (x < 0 ? "left" : "right") : null);
        },
        onPointerUp(e: React.PointerEvent<HTMLElement>) {
          const d = drag.current;
          drag.current = null;
          if (!d?.active) return;
          const width = e.currentTarget.offsetWidth;
          const x = e.clientX - d.x;
          const side = x < 0 ? left : right;
          const direction = x < 0 ? -1 : 1;
          // Far enough, or a quick flick that way. A flick never takes the long action.
          const far = Math.abs(x) > width * SHORT;
          const flick = Math.abs(x) > 30 && Math.sign(d.v) === direction && Math.abs(d.v) > 0.5;
          if (side && (far || flick)) finish(side, direction, Math.abs(x) > width * LONG, width);
          else {
            paint(0, true);
            arm(null);
          }
        },
        onPointerCancel() {
          if (drag.current?.active) paint(0, true);
          arm(null);
          drag.current = null;
        },
      }
    : {};

  return {
    refs: { wrap, card, underLeft, underRight },
    handlers,
    /** True right after a drag, so the click that follows is ignored. */
    wasDrag: () => {
      const value = suppressClick.current;
      suppressClick.current = false;
      return value;
    },
  };
}

/** What a long swipe left says it'll do, and what the card says while Grok Bot does it. */
export const DISPOSITION_LABELS: Record<Disposition, { label: string; doing: string }> = {
  archive: { label: "Archive", doing: "Archiving" },
  trash: { label: "Trash", doing: "Moving to trash" },
  read: { label: "Mark read", doing: "Marking read" },
  unsubscribe: { label: "Unsubscribe", doing: "Unsubscribing" },
};

/** "Gmail" for `gmail`; otherwise the provider as given. */
export function providerName(provider: string): string {
  return ({ gmail: "Gmail", gcal: "Calendar", outlook: "Outlook" } as Record<string, string>)[provider.toLowerCase()] ?? provider;
}

/** " in Gmail" for an email Grok Bot can find; empty otherwise. */
export function whereLabel(n: Notification): string {
  return n.subject?.type === "email" && n.subject.ref ? ` in ${providerName(n.subject.ref.provider)}` : "";
}

/** "Archive in Gmail": what a disposition does to this card's email, where. */
export function sourceLabel(n: Notification, disposition: Disposition): string {
  return `${DISPOSITION_LABELS[disposition].label}${whereLabel(n)}`;
}

/**
 * What a long swipe left does to this card's email: its category's choice, or
 * archive when it has none. Only for an email Grok Bot can find (it has a `ref`).
 */
export function sourceAction(n: Notification, category: { swipeAction: SwipeAction } | null): Disposition | null {
  if (n.subject?.type !== "email" || !n.subject.ref) return null;
  const action = category?.swipeAction ?? "archive";
  return action === "none" ? null : action;
}

interface CardProps {
  n: Notification;
  onOpen?: () => void;
  /** Swipe left. A long swipe passes what to do with the email at its source. */
  onDismiss?: (disposition?: Disposition | null) => void;
  /** Swipe right: pick when it comes back. */
  onSnooze?: () => void;
  /** A long swipe right on a card that needs you: marks it done. */
  onDone?: () => void;
  /** Shown under the body, e.g. "+3 more" on a collapsed stack. */
  footer?: ReactNode;
  /** Actions for the dismissed list instead of swipe. */
  trailing?: ReactNode;
  /** Answers straight from the card when the prompt has buttons. */
  onRespond?: (text: string, action?: string) => Promise<void>;
  /** Slides in: it arrived while the app was open. */
  fresh?: boolean;
  /** A collapsed stack's summary, shown instead of this card's own text. */
  summary?: string | null;
}

export function Card({ n, onOpen, onDismiss, onSnooze, onDone, footer, trailing, onRespond, fresh, summary }: CardProps) {
  const filing = useFiling(n);
  const atSource = sourceAction(n, filing.category);

  const left: SwipeSide | undefined = onDismiss
    ? {
        label: "Dismiss",
        run: () => onDismiss(null),
        leaves: true,
        long: atSource ? { label: sourceLabel(n, atSource), run: () => onDismiss(atSource), leaves: true } : undefined,
      }
    : undefined;
  const right: SwipeSide | undefined = onSnooze
    ? { label: "Snooze", run: onSnooze, long: onDone && needsYou(n) ? { label: "Done", run: onDone } : undefined }
    : undefined;
  const swipe = useSwipe({ left, right });
  const accent = filing.color;
  const transaction = isTransaction(n);
  const buttons = onRespond && !transaction ? answerButtons(n) : [];
  return (
    <div className={`swipe ${fresh ? "is-fresh" : ""}`} ref={swipe.refs.wrap} style={{ "--accent": accent } as React.CSSProperties}>
      {left ? (
        <div aria-hidden className={`swipe-under is-left ${left.long ? `has-long long-${atSource}` : ""}`} ref={swipe.refs.underLeft}>
          <span className="swipe-short">{left.label}</span>
          {left.long ? <span className="swipe-long">{left.long.label}</span> : null}
        </div>
      ) : null}
      {right ? (
        <div aria-hidden className={`swipe-under is-right ${right.long ? "has-long" : ""}`} ref={swipe.refs.underRight}>
          <span className="swipe-short">{right.label}</span>
          {right.long ? <span className="swipe-long">{right.long.label}</span> : null}
        </div>
      ) : null}
      <article
        className={`card glass ${n.status === "new" ? "is-unread" : ""} ${transaction ? "is-transaction" : ""} ${transaction && n.status === "responded" ? "is-done" : ""}`}
        ref={swipe.refs.card}
        {...swipe.handlers}
        onClick={() => {
          if (swipe.wasDrag()) return;
          onOpen?.();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && onOpen) {
            e.preventDefault();
            onOpen();
          }
        }}
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
        aria-label={`${filing.label}: ${summary ?? n.title ?? n.body}`}
      >
        <div className="card-sender-wrap">
          <TypeBadge n={n} />
        </div>
        <div className="card-main">
          <div className="card-row">
            <span className="card-sender">{filing.label}</span>
            <Pills n={n} />
            <time className="card-time" dateTime={n.createdAt}>
              {relativeTime(n.createdAt)}
            </time>
            {n.status === "new" ? <span className="unread-dot" aria-label="Unread" /> : null}
          </div>
          {summary ? (
            <div className="card-title stack-summary">{summary}</div>
          ) : (
            <>
            {n.title || (n.dueAt && n.status !== "responded") ? (
              <div className="card-title-row">
                {n.title ? <div className="card-title">{n.title}</div> : <span />}
                {n.dueAt && n.status !== "responded" && n.status !== "dismissed" ? <DueChip n={n} /> : null}
              </div>
            ) : null}
            {n.streaming && !n.body.trim() ? (
              <div className="card-body">
                <TypingDots />
              </div>
            ) : (
              <div className={`card-body ${n.streaming ? "is-streaming" : ""}`}>{n.summary && !n.title ? n.summary : n.body}</div>
            )}
            <CardProgress blocks={n.blocks} />
            {n.subject ? <SubjectView compact subject={n.subject} /> : null}
            {transaction ? (
              <ActionBar n={n} onRespond={onRespond} />
            ) : n.status === "responded" && n.responseText ? (
              <div className="card-reply">↩ {answeredLabel(n.responseText)}</div>
            ) : buttons.length > 0 ? (
              <AnswerButtons n={n} onRespond={(t) => onRespond?.(t) ?? Promise.resolve()} />
            ) : needsYou(n) && n.responsePrompt ? (
              <div className="card-actions">
                <button className="is-primary" onClick={(e) => (e.stopPropagation(), onOpen?.())} type="button">
                  Reply
                </button>
              </div>
            ) : null}
            </>
          )}
          {n.status === "dismissed" && n.disposition ? (
            <div className="card-source">
              ↳ {n.outcome ?? `${DISPOSITION_LABELS[n.disposition].doing}${whereLabel(n)}…`}
            </div>
          ) : null}
          {footer}
        </div>
        {trailing}
        {onDismiss ? (
          <button
            type="button"
            className="card-x"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(null);
            }}
          >
            ×
          </button>
        ) : null}
      </article>
    </div>
  );
}
