import { useEffect } from "react";
import type { Notification } from "../shared/types";

interface Choice {
  label: string;
  at: Date;
}

function at(base: Date, days: number, hour: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, 0, 0, 0);
}

/** Times worth snoozing to from `now`, soonest first, each at least half an hour away. */
export function snoozeChoices(n: Notification, now = new Date()): Choice[] {
  const choices: Choice[] = [];
  const later = new Date(now.getTime() + 3 * 3_600_000);
  if (later.getHours() < 21 && later.getDate() === now.getDate()) {
    later.setMinutes(later.getMinutes() < 30 ? 0 : 30, 0, 0);
    choices.push({ label: "Later today", at: later });
  }
  if (now.getHours() < 17) choices.push({ label: "This evening", at: at(now, 0, 18) });
  choices.push({ label: "Tomorrow morning", at: at(now, 1, 8) });
  // Saturday morning: this one, or the next one once the weekend has started.
  const weekend = now.getDay() === 6 || now.getDay() === 0;
  const toSaturday = (6 - now.getDay() + 7) % 7 || 7;
  choices.push({ label: weekend ? "Next weekend" : "This weekend", at: at(now, toSaturday, 9) });
  const toMonday = (8 - now.getDay()) % 7 || 7;
  choices.push({ label: "Next week", at: at(now, toMonday, 8) });
  // An hour before it's due, if that's still ahead.
  if (n.dueAt) {
    const before = new Date(new Date(n.dueAt).getTime() - 3_600_000);
    if (before.getTime() > now.getTime() + 30 * 60_000) choices.push({ label: "An hour before it's due", at: before });
  }
  // Soonest first; where two land on the same time (Sunday's "Next week" is tomorrow morning), the first label wins.
  const seen = new Set<number>();
  return choices
    .filter((c) => c.at.getTime() > now.getTime() + 30 * 60_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .filter((c) => !seen.has(c.at.getTime()) && seen.add(c.at.getTime()));
}

function when(date: Date, now = new Date()): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: date.getMinutes() ? "2-digit" : undefined });
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** "Snoozed until Sat 9 AM". */
export function snoozedLabel(iso: string): string {
  return `Snoozed until ${when(new Date(iso))}`;
}

/** Pick when a card comes back. */
export function SnoozeSheet({ n, onPick, onClose }: { n: Notification; onPick: (until: string) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div aria-label="Snooze until" className="sheet snooze-sheet" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="sheet-grabber" />
        <div className="snooze-head">
          <strong>Snooze</strong>
          <span className="muted">{n.title ?? n.body}</span>
        </div>
        <div className="snooze-list">
          {snoozeChoices(n).map((choice) => (
            <button className="snooze-choice" key={choice.label} onClick={() => onPick(choice.at.toISOString())} type="button">
              <span>{choice.label}</span>
              <span className="muted">{when(choice.at)}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-secondary btn-block" onClick={onClose} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
