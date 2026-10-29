import { ALERT_TYPES, alertType, type Category, needsYou, type Notification } from "../shared/types";
import { filingOf } from "./categories";

export { needsYou };

export interface Stack {
  key: string;
  items: Notification[];
}

export interface Day {
  key: string;
  label: string;
  stacks: Stack[];
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Calendar days from `now` to `date`: 0 today, 1 tomorrow, -1 yesterday. Rounds, so DST shifts don't skew it. */
export function daysBetween(date: Date, now = new Date()): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(date) - start(now)) / 86_400_000);
}

export function dayLabel(date: Date, now = new Date()): string {
  const days = -daysBetween(date, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * Cards stack by category, across days. A card that needs the owner stays on
 * its own, so its buttons are never hidden under another card.
 */
export function stackKeyOf(n: Notification, categories: Map<string, Category>): string {
  return needsYou(n) ? `one|${n.id}` : `in|${filingOf(n, categories).key}`;
}

/** Case-insensitive match on everything a card shows. */
export function matchesSearch(n: Notification, query: string, categories: Map<string, Category> = new Map()): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const subject = n.subject ? Object.values(n.subject).join(" ") : null;
  const words = [filingOf(n, categories).plural, ALERT_TYPES[alertType(n)].plural, n.topic];
  return [...words, n.task, n.sender, n.title, n.body, n.fullText, n.responseText, subject].some((v) =>
    v?.toLowerCase().includes(q),
  );
}

/**
 * Stacks newest-first notifications that share a category, wherever they
 * fall in the list. Each stack sits where its newest item would.
 */
export function stackAll(items: Notification[], categories: Map<string, Category>): Stack[] {
  const stacks = new Map<string, Stack>();
  for (const item of items) {
    const key = stackKeyOf(item, categories);
    const existing = stacks.get(key);
    if (existing) existing.items.push(item);
    else stacks.set(key, { key, items: [item] });
  }
  return [...stacks.values()];
}

/**
 * Groups newest-first notifications under day headings. With `categories`,
 * cards stack first, and each stack goes under the day of its newest card.
 */
export function groupByDay(items: Notification[], categories?: Map<string, Category>): Day[] {
  const stacks = categories ? stackAll(items, categories) : items.map((item) => ({ key: item.id, items: [item] }));
  const days: Day[] = [];
  for (const stack of stacks) {
    const created = new Date((stack.items[0] as Notification).createdAt);
    const key = dayKey(created);
    let day = days.at(-1);
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(created), stacks: [] };
      days.push(day);
    }
    day.stacks.push(stack);
  }
  return days;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (dayKey(date) === dayKey(new Date(now)) && minutes < 12 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
