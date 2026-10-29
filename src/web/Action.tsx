import { useEffect, useRef, useState } from "react";
import {
  type Action,
  type AlertType,
  alertType,
  answeringActions,
  DONE_ACTION,
  isTransaction,
  type Notification,
  type Subject,
} from "../shared/types";
import { CategoryGlyph, useFiling } from "./categories";

export { isTransaction };

const stop = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
};

export function Icon({ type, className = "subject-icon" }: { type: AlertType; className?: string }) {
  const paths: Record<AlertType, React.ReactNode> = {
    email: (
      <>
        <rect height="14" rx="2.5" width="18" x="3" y="5" />
        <path d="M3.5 7l8.5 6 8.5-6" />
      </>
    ),
    payment: (
      <>
        <rect height="14" rx="2.5" width="18" x="3" y="5" />
        <path d="M3 10h18M7 15h4" />
      </>
    ),
    event: (
      <>
        <rect height="15" rx="2.5" width="18" x="3" y="5" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </>
    ),
    question: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4M12 17h.01" />
      </>
    ),
    alert: (
      <>
        <path d="M10.3 4.6L2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z" />
        <path d="M12 9.5v4M12 17h.01" />
      </>
    ),
    result: (
      <>
        <rect height="18" rx="2.5" width="14" x="5" y="3" />
        <path d="M9 8h6M9 12h6M9 16h3.5" />
      </>
    ),
    update: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </>
    ),
  };
  return (
    <svg aria-hidden className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      {paths[type]}
    </svg>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function eventTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The email, bill or event a notification is about. `compact` keeps it to a few lines in the list. */
export function SubjectView({ subject, compact = false }: { subject: Subject; compact?: boolean }) {
  const link = subject.url;
  const body = (() => {
    switch (subject.type) {
      case "email":
        return (
          <>
            <div className="subject-line">
              <strong>{subject.from}</strong>
              {!compact && subject.fromAddress ? <span className="muted"> {subject.fromAddress}</span> : null}
            </div>
            <div className="subject-title">{subject.subject}</div>
            {subject.snippet ? <div className={`subject-snippet ${compact ? "is-clamped" : ""}`}>{subject.snippet}</div> : null}
            {subject.account || subject.receivedAt ? (
              <div className="subject-meta">
                {[subject.account, subject.receivedAt ? shortDate(subject.receivedAt) : null].filter(Boolean).join(" · ")}
              </div>
            ) : null}
          </>
        );
      case "payment":
        return (
          <>
            <div className="subject-line">
              {subject.amount ? <span className="subject-amount">{subject.amount}</span> : null}
              <span>
                {subject.amount ? "to " : ""}
                <strong>{subject.payee}</strong>
              </span>
            </div>
            {subject.account ? <div className="subject-meta">{subject.account}</div> : null}
          </>
        );
      case "event":
        return (
          <>
            <div className="subject-title">{subject.name}</div>
            {subject.startsAt || subject.location ? (
              <div className="subject-meta">
                {[subject.startsAt ? eventTime(subject.startsAt) : null, subject.location].filter(Boolean).join(" · ")}
              </div>
            ) : null}
          </>
        );
      default:
        return null;
    }
  })();
  return (
    <div className={`subject subject-${subject.type}`}>
      {compact ? null : <Icon type={subject.type} />}
      <div className="subject-main">{body}</div>
      {link && !compact ? (
        <a {...stop} aria-label="Open original" className="subject-open" href={link} rel="noreferrer" target="_blank">
          ↗
        </a>
      ) : null}
    </div>
  );
}

/**
 * The round icon a card leads with, in its category's color: the email, bill
 * or event it's about, else its category's icon, else its kind of alert.
 */
export function TypeBadge({ n, size = 38 }: { n: Notification; size?: number }) {
  const filing = useFiling(n);
  return (
    <div
      aria-label={filing.label}
      className="type-badge"
      role="img"
      style={{ width: size, height: size, "--type": filing.color } as React.CSSProperties}
    >
      {!n.subject && filing.category ? (
        <CategoryGlyph className="type-badge-icon" icon={filing.category.icon} />
      ) : (
        <Icon className="type-badge-icon" type={alertType(n)} />
      )}
    </div>
  );
}

/** "Due Fri", "Due today 5 PM", "Overdue". */
export function dueLabel(iso: string, now = new Date()): { text: string; tone: "over" | "soon" | "later" } {
  const due = new Date(iso);
  const ms = due.getTime() - now.getTime();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(due) - startOf(now)) / 86_400_000);
  const hasTime = due.getHours() !== 0 || due.getMinutes() !== 0;
  const time = hasTime ? ` ${due.toLocaleTimeString(undefined, { hour: "numeric", minute: due.getMinutes() ? "2-digit" : undefined })}` : "";
  if (ms < 0 && days < 0) return { text: "Overdue", tone: "over" };
  if (ms < 0) return { text: `Was due${time || " today"}`, tone: "over" };
  const tone = ms < 48 * 3_600_000 ? "soon" : "later";
  if (days === 0) return { text: `Due today${time}`, tone };
  if (days === 1) return { text: `Due tomorrow${time}`, tone };
  if (days < 7) return { text: `Due ${due.toLocaleDateString(undefined, { weekday: "short" })}`, tone };
  return { text: `Due ${shortDate(iso)}`, tone };
}

/** "Today 1 PM", "Tomorrow 1 PM", "Fri 1 PM", "Started 1 PM", "Past": when an event is, not a deadline. */
export function startsLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(now)) / 86_400_000);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: at.getMinutes() ? "2-digit" : undefined });
  if (days < 0) return "Past";
  if (at.getTime() < now.getTime()) return `Started ${time}`;
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${shortDate(iso)} ${time}`;
}

/** A deadline, or for a calendar event its start, which reads as a time rather than something due. */
export function DueChip({ n }: { n: Notification }) {
  if (n.subject?.type === "event" && n.subject.startsAt) return <span className="due">{startsLabel(n.subject.startsAt)}</span>;
  if (!n.dueAt) return null;
  const { text, tone } = dueLabel(n.dueAt);
  return <span className={`due due-${tone}`}>{text}</span>;
}

function whoFor(n: Notification): string {
  return n.subject?.type === "email" ? n.subject.from : n.sender;
}

/** What the owner did, and what the bot did about it. */
function Receipt({ n }: { n: Notification }) {
  const action = n.actions.find((a) => a.id === n.responseAction);
  const verb =
    n.responseAction === DONE_ACTION
      ? "Marked done"
      : action?.type === "reply"
        ? `Replied${n.subject?.type === "email" ? ` to ${n.subject.from}` : ""}`
        : (action?.label ?? n.responseText ?? "Answered");
  return (
    <div className="receipt">
      <div className="receipt-row">
        <span aria-hidden className="receipt-check">
          ✓
        </span>
        <span className="receipt-verb">{verb}</span>
      </div>
      {action?.type === "reply" && n.responseText ? (
        <div className="receipt-text">“{n.responseText.replace(/\s+/g, " ")}”</div>
      ) : null}
      {n.outcome || n.responseAction !== DONE_ACTION ? (
        <div className={`receipt-status ${n.outcome ? "is-final" : ""}`}>{n.outcome ?? "In progress"}</div>
      ) : null}
    </div>
  );
}

/**
 * The card's buttons. Reply opens a composer in place, filled with the bot's draft;
 * confirm answers in one tap; open follows a link. Done is always offered.
 */
export function ActionBar({
  n,
  onRespond,
  full = false,
}: {
  n: Notification;
  onRespond?: (text: string, action: string) => Promise<void>;
  /** In the detail sheet: bigger buttons and the composer open from the start. */
  full?: boolean;
}) {
  const [composing, setComposing] = useState<Action | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text, composing]);

  if (n.status === "responded") return <Receipt n={n} />;
  // An FYI about an email or bill has nothing to do; swipe it away like any card.
  if (n.status === "dismissed" || !onRespond || (n.actions.length === 0 && !n.task)) return null;

  async function run(action: string, value: string) {
    setBusy(action);
    setError(null);
    try {
      await onRespond?.(value, action);
      setComposing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function startReply(action: Action) {
    setComposing(action);
    setText(action.draft ?? "");
    window.setTimeout(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  if (composing) {
    return (
      <form
        {...stop}
        className="action-compose"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void run(composing.id, text.trim());
        }}
      >
        <div className="action-compose-to">
          {composing.draft ? "Draft" : "Reply"} to <strong>{whoFor(n)}</strong>
          {n.subject?.type === "email" ? <span className="muted"> · {n.sender} sends it</span> : null}
        </div>
        <textarea
          aria-label={`Reply to ${whoFor(n)}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            if (e.key === "Escape") setComposing(null);
          }}
          placeholder={composing.placeholder ?? "Write a reply"}
          ref={area}
          rows={3}
          value={text}
        />
        {error ? <div className="error">{error}</div> : null}
        <div className="action-row">
          <button className="act" disabled={!!busy} onClick={() => setComposing(null)} type="button">
            Cancel
          </button>
          <button className="act is-primary" disabled={!text.trim() || !!busy} type="submit">
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    );
  }

  const answering = answeringActions(n);
  return (
    <div {...stop} className={`action-bar ${full ? "is-full" : ""}`}>
      <div className="action-row">
        {n.actions.map((action) =>
          action.type === "open" ? (
            <a className="act is-link" href={action.url} key={action.id} rel="noreferrer" target="_blank">
              {action.label} ↗
            </a>
          ) : (
            <button
              className={`act ${action.style === "primary" ? "is-primary" : ""} ${action.style === "destructive" ? "is-danger" : ""}`}
              disabled={!!busy}
              key={action.id}
              onClick={() => (action.type === "reply" ? startReply(action) : void run(action.id, action.label))}
              type="button"
            >
              {busy === action.id ? "…" : action.label}
            </button>
          ),
        )}
        <button
          className={`act is-quiet ${answering.length === 0 ? "is-primary" : ""}`}
          disabled={!!busy}
          onClick={() => void run(DONE_ACTION, "Done")}
          type="button"
        >
          {busy === DONE_ACTION ? "…" : "Done"}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}
