import type { Category, CategoryIcon } from "../shared/types";
import type { Actor, Env } from "./env";
import { eventStatements } from "./events";
import { HttpError, NO_ECHO_ACTORS } from "./notifications";
import { nowIso } from "./util";

interface CategoryRow {
  id: string;
  name: string;
  color: string;
  icon: CategoryIcon;
  position: number;
  state: Category["state"];
  swipe_action: Category["swipeAction"];
  summary: string | null;
  summary_at: string | null;
  aliases: string | null;
  count: number | null;
}

/** Colors for suggested categories, picked from the name so a name keeps its color. */
const SUGGESTED_COLORS = ["#30b0c7", "#bf5af2", "#ff9f0a", "#ff375f", "#32d74b", "#5ac8fa", "#ffcc00", "#a2845e"];

function toDto(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    position: row.position,
    state: row.state,
    swipeAction: row.swipe_action ?? "archive",
    aliases: row.aliases ? row.aliases.split("\u0001").sort() : [],
    count: row.count ?? 0,
    summary: row.summary && row.summary_at ? { text: row.summary, at: row.summary_at } : null,
  };
}

const ALIASES = "(SELECT GROUP_CONCAT(a.alias, char(1)) FROM category_aliases a WHERE a.category_id = c.id) AS aliases";
const COUNT =
  "(SELECT COUNT(*) FROM notifications n WHERE n.category = c.id AND n.status <> 'dismissed' AND n.snoozed_until IS NULL) AS count";
const SELECT = `SELECT c.*, ${ALIASES}, ${COUNT} FROM categories c`;

/** Active first, in the owner's order; then suggestions. */
export async function listCategories(env: Env, options: { counts?: boolean } = {}): Promise<Category[]> {
  // Without counts it skips a COUNT per category, for readers that don't show them.
  const select = options.counts === false ? `SELECT c.*, ${ALIASES}, 0 AS count FROM categories c` : SELECT;
  const { results } = await env.DB.prepare(`${select} ORDER BY c.state = 'suggested', c.position, c.name COLLATE NOCASE`).all<CategoryRow>();
  return results.map(toDto);
}

export async function getCategory(env: Env, id: string): Promise<Category | null> {
  const row = await env.DB.prepare(`${SELECT} WHERE c.id = ?`).bind(id).first<CategoryRow>();
  return row ? toDto(row) : null;
}

/** "Kids' sports" → "kids-sports". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return SUGGESTED_COLORS[Math.abs(hash) % SUGGESTED_COLORS.length] as string;
}

/** A category a write names that doesn't exist yet: it's added as a suggestion when the write commits. */
export interface Suggestion {
  id: string;
  name: string;
  color: string;
  /** Marks rows added by this write, so the caller can tell whether any were. */
  createdAt: string;
}

export interface Resolution {
  /** Category id for each name; null for a removed name or one with no letters. */
  ids: Map<string, string | null>;
  /** New names, by id. */
  suggestions: Map<string, Suggestion>;
}

/** `base`, or `base-2`, `base-3`… if that id is taken. */
function freeId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base.slice(0, 36)}-${n}`;
  return id;
}

/**
 * Finds the category a bot meant by each name: by current name first, then
 * id, then an alias (an old name or a merged category). A name Herald doesn't
 * know becomes a suggestion, written only with the card that uses it (see
 * {@link suggestionStatement}). Reads the list once, whatever the number of names.
 */
export async function resolveCategories(env: Env, raws: (string | null | undefined)[]): Promise<Resolution> {
  const ids = new Map<string, string | null>();
  const suggestions = new Map<string, Suggestion>();
  const wanted = raws.filter((r): r is string => r != null);
  if (wanted.length === 0) return { ids, suggestions };
  const [categories, aliases] = await env.DB.batch([
    env.DB.prepare("SELECT id, name FROM categories"),
    env.DB.prepare("SELECT alias, category_id FROM category_aliases"),
  ]);
  const byName = new Map<string, string>();
  const taken = new Set<string>();
  for (const c of (categories?.results ?? []) as { id: string; name: string }[]) {
    byName.set(c.name.toLowerCase(), c.id);
    taken.add(c.id);
  }
  const byAlias = new Map((aliases?.results ?? []).map((a) => [(a as { alias: string }).alias, (a as { category_id: string | null }).category_id]));
  const createdAt = nowIso();
  for (const raw of wanted) {
    if (ids.has(raw)) continue;
    const name = raw.trim().replace(/\s+/g, " ");
    const key = name.toLowerCase();
    const slug = slugify(name);
    let id: string | null | undefined = byName.get(key) ?? (taken.has(slug) ? slug : undefined);
    if (id === undefined && byAlias.has(key)) id = byAlias.get(key);
    if (id === undefined && byAlias.has(slug)) id = byAlias.get(slug);
    if (id === undefined && slug) {
      id = freeId(slug, taken);
      taken.add(id);
      byName.set(key, id);
      suggestions.set(id, { id, name: name.slice(0, 40), color: colorFor(name), createdAt });
    }
    ids.set(raw, id ?? null);
  }
  return { ids, suggestions };
}

/** Adds a suggested category, but only if the card naming it was written and still names it. */
export function suggestionStatement(env: Env, s: Suggestion, notificationId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO categories (id, name, color, icon, position, state, created_at)
     SELECT ?, ?, ?, 'tag', (SELECT COALESCE(MAX(position), 0) + 1 FROM categories), 'suggested', ?
     WHERE EXISTS (SELECT 1 FROM notifications WHERE id = ? AND category = ?)
     ON CONFLICT DO NOTHING`,
  ).bind(s.id, s.name, s.color, s.createdAt, notificationId, s.id);
}

/** After a write: tells Grok Bot about suggestions it added, if any were. */
export async function announceSuggestions(env: Env, actor: Actor, suggestions: Map<string, Suggestion>): Promise<string | null> {
  const list = [...suggestions.values()];
  if (list.length === 0 || NO_ECHO_ACTORS.has(actor)) return null;
  const added = await env.DB.prepare(
    `SELECT 1 FROM categories WHERE ${list.map(() => "(id = ? AND created_at = ?)").join(" OR ")} LIMIT 1`,
  )
    .bind(...list.flatMap((s) => [s.id, s.createdAt]))
    .first();
  return added ? announce(env, actor) : null;
}

/** Queues `categories.updated` for Grok Bot with the whole list, so it always picks from the current one. */
async function announce(env: Env, actor: Actor): Promise<string | null> {
  if (NO_ECHO_ACTORS.has(actor)) return null;
  const categories = (await listCategories(env, { counts: false })).map(({ count: _count, summary: _summary, ...c }) => c);
  const { statements, eventId } = eventStatements(env, { subject: "categories", event: "categories.updated", actor, payload: { categories } });
  await env.DB.batch(statements);
  return eventId;
}

/** Sets (or, with null, clears) a bot's line about a category's stack. Not an edit to the list, so Grok Bot isn't told. */
export async function setSummary(env: Env, id: string, text: string | null): Promise<Category> {
  const result = await env.DB.prepare("UPDATE categories SET summary = ?, summary_at = ? WHERE id = ?")
    .bind(text, text === null ? null : nowIso(), id)
    .run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Category not found");
  return (await getCategory(env, id)) as Category;
}

export interface CategoryWrite {
  category: Category | null;
  eventId: string | null;
}

export async function createCategory(
  env: Env,
  actor: Actor,
  input: { name: string; color?: string; icon?: CategoryIcon },
): Promise<CategoryWrite> {
  const base = slugify(input.name);
  if (!base) throw new HttpError(400, "Name needs a letter or digit");
  const clash = await env.DB.prepare("SELECT id FROM categories WHERE lower(name) = ?").bind(input.name.toLowerCase()).first();
  if (clash) throw new HttpError(409, "A category with that name already exists");
  // A renamed category keeps its id, so the plain slug may be taken by a category with another name.
  const { results: taken } = await env.DB.prepare("SELECT id FROM categories WHERE id = ? OR id LIKE ?")
    .bind(base, `${base.slice(0, 36)}-%`)
    .all<{ id: string }>();
  const slug = freeId(base, new Set(taken.map((t) => t.id)));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO categories (id, name, color, icon, position, state, created_at)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM categories WHERE state = 'active'), 'active', ?)`,
    ).bind(slug, input.name, input.color?.toLowerCase() ?? colorFor(input.name), input.icon ?? "tag", nowIso()),
    // A name that was removed or merged is free again once it's a category of its own.
    env.DB.prepare("DELETE FROM category_aliases WHERE alias IN (?, ?, ?)").bind(slug, base, input.name.toLowerCase()),
  ]);
  return { category: await getCategory(env, slug), eventId: await announce(env, actor) };
}

/**
 * Renames, recolors, moves or accepts a category. A rename keeps the old
 * name as an alias, so bots still using it land in the same place.
 */
export async function updateCategory(
  env: Env,
  actor: Actor,
  id: string,
  patch: { name?: string; color?: string; icon?: CategoryIcon; position?: number; state?: "active"; swipeAction?: Category["swipeAction"] },
): Promise<CategoryWrite> {
  const current = await getCategory(env, id);
  if (!current) throw new HttpError(404, "Category not found");
  const statements: D1PreparedStatement[] = [];
  if (patch.name !== undefined && patch.name !== current.name) {
    const clash = await env.DB.prepare("SELECT id FROM categories WHERE lower(name) = ? AND id <> ?")
      .bind(patch.name.toLowerCase(), id)
      .first();
    if (clash) throw new HttpError(409, "A category with that name already exists");
    statements.push(
      env.DB.prepare("UPDATE categories SET name = ? WHERE id = ?").bind(patch.name, id),
      env.DB.prepare("DELETE FROM category_aliases WHERE alias = ?").bind(patch.name.toLowerCase()),
    );
    if (current.name.toLowerCase() !== patch.name.toLowerCase()) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO category_aliases (alias, category_id) VALUES (?, ?) ON CONFLICT (alias) DO UPDATE SET category_id = excluded.category_id",
        ).bind(current.name.toLowerCase(), id),
      );
    }
  }
  if (patch.color !== undefined) statements.push(env.DB.prepare("UPDATE categories SET color = ? WHERE id = ?").bind(patch.color.toLowerCase(), id));
  if (patch.icon !== undefined) statements.push(env.DB.prepare("UPDATE categories SET icon = ? WHERE id = ?").bind(patch.icon, id));
  if (patch.swipeAction !== undefined && patch.swipeAction !== current.swipeAction) {
    statements.push(env.DB.prepare("UPDATE categories SET swipe_action = ? WHERE id = ?").bind(patch.swipeAction, id));
  }
  if (patch.state === "active" && current.state !== "active") {
    // An accepted suggestion goes to the end of the list.
    statements.push(
      env.DB.prepare(
        "UPDATE categories SET state = 'active', position = (SELECT COALESCE(MAX(position), 0) + 1 FROM categories WHERE state = 'active') WHERE id = ?",
      ).bind(id),
    );
  }
  if (patch.position !== undefined && current.state === "active") {
    const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE state = 'active'").first<{ n: number }>();
    patch = { ...patch, position: Math.min(patch.position, active?.n ?? 1) };
  }
  if (patch.position !== undefined && current.state === "active" && patch.position !== current.position) {
    // Shift the others so positions stay a gapless 1..n among active categories.
    statements.push(
      env.DB.prepare(
        `UPDATE categories SET position = position + CASE WHEN ? < ? THEN 1 ELSE -1 END
         WHERE state = 'active' AND id <> ? AND position BETWEEN MIN(?, ?) AND MAX(?, ?)`,
      ).bind(patch.position, current.position, id, patch.position, current.position, patch.position, current.position),
      env.DB.prepare("UPDATE categories SET position = ? WHERE id = ?").bind(patch.position, id),
    );
  }
  if (statements.length === 0) return { category: current, eventId: null };
  await env.DB.batch(statements);
  return { category: await getCategory(env, id), eventId: await announce(env, actor) };
}

/**
 * Moves every card from one category into another (or out of any, when
 * `into` is null) and deletes it. Its id and name become aliases, so a bot
 * that still sends them lands in `into`.
 */
export async function mergeCategory(env: Env, actor: Actor, id: string, into: string | null): Promise<CategoryWrite> {
  const current = await getCategory(env, id);
  if (!current) throw new HttpError(404, "Category not found");
  if (into === id) throw new HttpError(400, "Can't merge a category into itself");
  if (into !== null && !(await getCategory(env, into))) throw new HttpError(404, "Target category not found");
  const now = nowIso();
  const alias = (name: string) =>
    env.DB.prepare(
      "INSERT INTO category_aliases (alias, category_id) VALUES (?, ?) ON CONFLICT (alias) DO UPDATE SET category_id = excluded.category_id",
    ).bind(name, into);
  await env.DB.batch([
    env.DB.prepare("UPDATE notifications SET category = ?, version = version + 1, updated_at = ? WHERE category = ?").bind(into, now, id),
    env.DB.prepare("UPDATE category_aliases SET category_id = ? WHERE category_id = ?").bind(into, id),
    // Its cards join another stack, so that stack's summary no longer describes it.
    env.DB.prepare("UPDATE categories SET summary = NULL, summary_at = NULL WHERE id = ?").bind(into),
    alias(id),
    alias(current.name.toLowerCase()),
    env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id),
    // Close the gap it leaves in the order.
    env.DB.prepare("UPDATE categories SET position = position - 1 WHERE state = 'active' AND position > ?").bind(
      current.state === "active" ? current.position : Number.MAX_SAFE_INTEGER,
    ),
  ]);
  return { category: into ? await getCategory(env, into) : null, eventId: await announce(env, actor) };
}
