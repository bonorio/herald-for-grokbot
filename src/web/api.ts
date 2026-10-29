import type { Bot, Briefing, Category, Disposition, Notification, NotificationPage } from "../shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body, credentials: "same-origin" });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export type Changed = Notification & { changed: boolean };

/** Every notification matching `query`, following cursors. */
export async function fetchAll(query: string, max = 2000): Promise<Notification[]> {
  const items: Notification[] = [];
  let cursor: string | null = null;
  do {
    const page: NotificationPage = await request(
      `/api/notifications?limit=200&${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < max);
  return items;
}

export const actions = {
  read: (id: string) => request<Changed>(`/api/notifications/${id}/read`, { method: "POST" }),
  dismiss: (id: string) => request<Changed>(`/api/notifications/${id}/dismiss`, { method: "POST" }),
  restore: (id: string) => request<Changed>(`/api/notifications/${id}/restore`, { method: "POST" }),
  readMany: (ids: string[]) => request<{ results: { id: string; changed?: boolean; error?: string }[] }>("/api/notifications/read", { method: "POST", json: { ids } }),
  dismissMany: (ids: string[], disposition: Disposition | null = null) =>
    request<{ results: { id: string; changed?: boolean; error?: string }[] }>("/api/notifications/dismiss", {
      method: "POST",
      json: disposition ? { ids, disposition } : { ids },
    }),
  snooze: (id: string, until: string | null) => request<Changed>(`/api/notifications/${id}/snooze`, { method: "POST", json: { until } }),
  restoreMany: (ids: string[]) => request<{ results: { id: string; changed?: boolean; error?: string }[] }>("/api/notifications/restore", { method: "POST", json: { ids } }),
  checklist: (id: string, block: number, item: string, done: boolean) =>
    request<Changed>(`/api/notifications/${id}/checklist`, { method: "POST", json: { block, item, done } }),
  respond: (id: string, text: string, action?: string) =>
    request<Changed>(`/api/notifications/${id}/respond`, { method: "POST", json: action ? { text, action } : { text } }),
};

/** The last inbox seen, so the app opens instantly while it refreshes. */
// Bump when the Notification shape changes, so an old cache isn't rendered by new code.
const CACHE_KEY = "herald:snapshot:v3";

export interface Snapshot {
  items: Notification[];
  dismissed: Notification[];
  bots: Bot[];
  categories: Category[];
  briefing: Briefing | null;
}

export function readSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(snapshot: Snapshot): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full or blocked: the app just opens a little slower next time.
  }
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}
