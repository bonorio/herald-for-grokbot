import { useContext } from "react";
import { type Bot, BRIEFING_HOURS, type Briefing, type Category, type Notification } from "../shared/types";
import { Avatar } from "./Card";
import { chatHref } from "./Chat";
import { CategoriesContext, headingOf } from "./categories";
import { needsYou, relativeTime } from "./group";

/** A briefing older than this is replaced by one Herald writes itself. */
const STALE_MS = BRIEFING_HOURS * 60 * 60 * 1000;

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Late night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function shortTitle(n: Notification): string {
  const text = (n.summary ?? n.title ?? n.body).replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 58)}…` : text;
}

/** What matters now, in a sentence or two: what needs the owner, then what the bots are doing. */
function writeBriefing(items: Notification[], bots: Bot[], categories: Map<string, Category>): string[] {
  const lines: string[] = [];
  const waiting = items.filter(needsYou);
  if (waiting.length) {
    const top = waiting[0] as Notification;
    lines.push(
      `${waiting.length} need${waiting.length === 1 ? "s" : ""} you. ${headingOf(top, categories)}: ${shortTitle(top)}` +
        (waiting.length > 1 ? ` and ${waiting.length - 1} more.` : "."),
    );
  }
  const working = bots.filter((b) => b.status.state === "working" && b.status.text);
  for (const bot of working.slice(0, 2)) lines.push(`${bot.sender} is ${lowerFirst(bot.status.text as string)}.`);
  if (lines.length === 0) {
    const unread = items.filter((n) => n.status === "new").length;
    lines.push(unread ? `${unread} new since you last looked. Nothing is waiting on you.` : "Nothing is waiting on you.");
  }
  return lines;
}

function lowerFirst(text: string): string {
  const trimmed = text.replace(/[.\s]+$/, "");
  return /^[A-Z][a-z]/.test(trimmed) ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1) : trimmed;
}

export function BriefingCard({
  briefing,
  items,
  bots,
  ownerName,
}: {
  briefing: Briefing | null;
  items: Notification[];
  bots: Bot[];
  /** Greets them by name when they've given one. */
  ownerName: string | null;
}) {
  const fresh = briefing && Date.now() - new Date(briefing.updatedAt).getTime() < STALE_MS;
  const categories = useContext(CategoriesContext);
  const lines = fresh ? [briefing.text] : writeBriefing(items, bots, categories);
  const working = bots.filter((b) => b.status.state === "working");
  return (
    <section aria-label="Briefing" className="briefing glass">
      <div className="briefing-head">
        <span className="briefing-hello">
          {greeting()}
          {ownerName ? `, ${ownerName}` : ""}
        </span>
        {working.length ? (
          <span className="briefing-working">
            {working.slice(0, 4).map((b) => (
              <a href={chatHref(b.sourceId)} key={b.sourceId} title={`${b.sender}: ${b.status.text ?? "working"}`}>
                <Avatar color={b.color} name={b.sender} size={22} url={b.avatarUrl} working />
              </a>
            ))}
          </span>
        ) : null}
      </div>
      {lines.map((line, i) => (
        <p className="briefing-text" key={i}>
          {line}
        </p>
      ))}
      <div className="briefing-meta">
        {fresh ? `${bots.find((b) => b.pinned)?.sender ?? "Grok Bot"} · ${relativeTime(briefing.updatedAt)}` : "Summarized by Herald"}
      </div>
    </section>
  );
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** The empty inbox, with a tally of the day. */
export function AllCaughtUp({ all }: { all: Notification[] }) {
  const came = all.filter((n) => isToday(n.createdAt)).length;
  const answered = all.filter((n) => isToday(n.respondedAt)).length;
  const cleared = all.filter((n) => n.status === "dismissed" && isToday(n.dismissedAt)).length;
  return (
    <div className="caught-up">
      <div aria-hidden className="caught-up-mark">
        <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </div>
      <h2>All caught up</h2>
      {came || answered || cleared ? (
        <p>
          Today {came} came in, you answered {answered} and cleared {cleared}.
        </p>
      ) : (
        <p>Nothing new today. Your bots will show up here.</p>
      )}
    </div>
  );
}
