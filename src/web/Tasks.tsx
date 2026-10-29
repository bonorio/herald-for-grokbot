import { useMemo, useState } from "react";
import { DONE_ACTION, isTask, type Notification, taskDone, taskText } from "../shared/types";
import { DueChip, TypeBadge } from "./Action";
import { useFiling } from "./categories";

/** Open tasks: soonest due first, then urgent, then newest. */
export function byDue(a: Notification, b: Notification): number {
  if (a.dueAt || b.dueAt) {
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    if (a.dueAt !== b.dueAt) return a.dueAt.localeCompare(b.dueAt);
  }
  const urgent = Number(b.urgent) - Number(a.urgent);
  return urgent || b.createdAt.localeCompare(a.createdAt);
}

function finishedAt(n: Notification): string {
  return n.respondedAt ?? n.dismissedAt ?? n.updatedAt;
}

/** How it got done, when it wasn't just checked off. */
function doneHow(n: Notification): string | null {
  if (n.status !== "responded" || n.responseAction === DONE_ACTION) return null;
  const action = n.actions.find((a) => a.id === n.responseAction);
  if (action?.type === "reply") return "Replied";
  return action?.label ?? n.responseText;
}

const DONE_SHOWN = 20;
const DONE_DAYS = 7;

function TaskRow({
  n,
  onCheck,
  onOpen,
}: {
  n: Notification;
  onCheck: (n: Notification, done: boolean) => Promise<void>;
  onOpen: (n: Notification) => void;
}) {
  const done = taskDone(n);
  const [busy, setBusy] = useState(false);
  // Answered on the card: it stays done, since there's nothing to take back.
  const locked = n.status === "responded";
  const how = doneHow(n);
  const filing = useFiling(n);
  return (
    <li className={`task ${done ? "is-done" : ""}`}>
      <button
        aria-checked={done}
        aria-label={done ? `Mark “${taskText(n)}” not done` : `Mark “${taskText(n)}” done`}
        className="task-check"
        disabled={busy || locked}
        onClick={() => {
          setBusy(true);
          onCheck(n, !done).finally(() => setBusy(false));
        }}
        role="checkbox"
        type="button"
      >
        <svg aria-hidden fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" viewBox="0 0 24 24">
          <path d="M6 12.5l4 4L18 8" />
        </svg>
      </button>
      <button className="task-main" onClick={() => onOpen(n)} type="button">
        <span className="task-text">{taskText(n)}</span>
        <span className="task-meta">
          <TypeBadge n={n} size={16} />
          <span>{filing.label}</span>
          {how ? <span className="task-how">· {how}</span> : null}
          {!done && n.dueAt ? <DueChip n={n} /> : null}
          {!done && n.urgent ? <span className="pill pill-urgent">Urgent</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * Everything a card asked the owner to do. Checking a task off dismisses its card
 * and dismissing the card checks it off; answering on the card completes it too.
 */
export function Tasks({
  all,
  loading,
  onCheck,
  onOpen,
}: {
  all: Notification[];
  loading: boolean;
  onCheck: (n: Notification, done: boolean) => Promise<void>;
  onOpen: (n: Notification) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const { open, done } = useMemo(() => {
    const withTask = all.filter(isTask);
    const since = Date.now() - DONE_DAYS * 86_400_000;
    return {
      open: withTask.filter((n) => !taskDone(n)).sort(byDue),
      done: withTask
        .filter((n) => taskDone(n) && new Date(finishedAt(n)).getTime() > since)
        .sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)))
        .slice(0, DONE_SHOWN),
    };
  }, [all]);

  return (
    <>
      {open.length ? (
        <ul className="task-list glass">
          {open.map((n) => (
            <TaskRow key={n.id} n={n} onCheck={onCheck} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <div className="caught-up">
          <div aria-hidden className="caught-up-mark">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </div>
          <h2>{loading ? "Loading…" : "Nothing to do"}</h2>
          {loading ? null : <p>When a card needs you, it shows up here.</p>}
        </div>
      )}

      {done.length ? (
        <section className="day">
          <button className="day-label task-done-toggle" onClick={() => setShowDone((v) => !v)} type="button">
            Done <span className="day-count">{done.length}</span> {showDone ? "▾" : "▸"}
          </button>
          {showDone ? (
            <ul className="task-list glass">
              {done.map((n) => (
                <TaskRow key={n.id} n={n} onCheck={onCheck} onOpen={onOpen} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
