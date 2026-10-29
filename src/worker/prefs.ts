import type { Env } from "./env";

/** A saved setting, or null when there's none. Values are stored as JSON. */
export async function getPref<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

/** Saves a setting; null removes it. */
export async function setPref(env: Env, key: string, value: unknown): Promise<void> {
  await (value === null
    ? env.DB.prepare("DELETE FROM prefs WHERE key = ?").bind(key)
    : env.DB.prepare("INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(
        key,
        JSON.stringify(value),
      )
  ).run();
}
