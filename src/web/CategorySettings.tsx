import { useState } from "react";
import { CATEGORY_ICONS, type Category, type Disposition, SWIPE_ACTIONS, type SwipeAction } from "../shared/types";
import { DISPOSITION_LABELS } from "./Card";
import { request } from "./api";
import { CategoryGlyph } from "./categories";

const COLORS = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff6482", "#ff375f", "#ff9f0a", "#ffd60a", "#34c759", "#30b0c7", "#64d2ff", "#ac8e68", "#8e8e93"];

/** What a long swipe left does to an email in a category, as Settings says it. */
const SWIPE_LABELS: Record<SwipeAction, string> = {
  ...(Object.fromEntries(Object.entries(DISPOSITION_LABELS).map(([k, v]) => [k, v.label])) as Record<Disposition, string>),
  none: "Just dismiss",
};

function Badge({ c, size = 30 }: { c: Pick<Category, "color" | "icon">; size?: number }) {
  return (
    <span aria-hidden className="type-badge" style={{ width: size, height: size, "--type": c.color } as React.CSSProperties}>
      <CategoryGlyph className="type-badge-icon" icon={c.icon} />
    </span>
  );
}

function cards(n: number): string {
  return n === 1 ? "1 card" : `${n} cards`;
}

/** Name, color and icon for one category, and moving or removing it. */
function Editor({
  c,
  last,
  run,
  onClose,
}: {
  c: Category;
  last: boolean;
  run: (task: () => Promise<unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(c.name);
  const patch = (json: Partial<Pick<Category, "name" | "color" | "icon" | "position" | "swipeAction">>) =>
    run(() => request(`/api/categories/${encodeURIComponent(c.id)}`, { method: "PATCH", json }));
  return (
    <div className="category-editor">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== c.name) void patch({ name: name.trim() });
        }}
      >
        <input aria-label="Name" maxLength={40} onChange={(e) => setName(e.target.value)} value={name} />
        <button className="btn btn-secondary" disabled={!name.trim() || name.trim() === c.name} type="submit">
          Rename
        </button>
      </form>
      <div aria-label="Color" className="swatches" role="radiogroup">
        {COLORS.map((color) => (
          <button
            aria-checked={c.color === color}
            aria-label={color}
            className="swatch"
            key={color}
            onClick={() => void patch({ color })}
            role="radio"
            style={{ "--type": color } as React.CSSProperties}
            type="button"
          />
        ))}
      </div>
      <div aria-label="Icon" className="icon-grid" role="radiogroup">
        {CATEGORY_ICONS.map((icon) => (
          <button aria-checked={c.icon === icon} aria-label={icon} className="icon-pick" key={icon} onClick={() => void patch({ icon })} role="radio" type="button">
            <CategoryGlyph icon={icon} />
          </button>
        ))}
      </div>
      <label className="swipe-pick">
        <span>Long swipe on an email</span>
        <select onChange={(e) => void patch({ swipeAction: e.target.value as SwipeAction })} value={c.swipeAction}>
          {SWIPE_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {SWIPE_LABELS[action]}
            </option>
          ))}
        </select>
      </label>
      <div className="item-actions">
        <button className="chip-btn" disabled={c.position <= 1} onClick={() => void patch({ position: c.position - 1 })} type="button">
          Move up
        </button>
        <button className="chip-btn" disabled={last} onClick={() => void patch({ position: c.position + 1 })} type="button">
          Move down
        </button>
        <button
          className="chip-btn danger"
          onClick={() =>
            confirm(`Remove ${c.name}? Its ${cards(c.count)} become uncategorized.`) &&
            void run(() => request(`/api/categories/${encodeURIComponent(c.id)}`, { method: "DELETE" })).then((ok) => ok && onClose())
          }
          type="button"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/** A name a bot used that Herald didn't know: keep it, fold it into another, or drop it. */
function Suggestion({ c, active, run }: { c: Category; active: Category[]; run: (task: () => Promise<unknown>) => Promise<boolean> }) {
  const path = `/api/categories/${encodeURIComponent(c.id)}`;
  return (
    <div className="item glass">
      <Badge c={c} />
      <div className="item-main">
        <div className="item-title">{c.name}</div>
        <div className="item-sub">{cards(c.count)}</div>
      </div>
      <div className="item-actions">
        <button className="chip-btn" onClick={() => void run(() => request(path, { method: "PATCH", json: { state: "active" } }))} type="button">
          Keep
        </button>
        <select
          aria-label={`Merge ${c.name} into`}
          className="chip-btn"
          onChange={(e) => e.target.value && void run(() => request(`${path}/merge`, { method: "POST", json: { into: e.target.value } }))}
          value=""
        >
          <option value="">Merge into…</option>
          {active.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button className="chip-btn danger" onClick={() => void run(() => request(path, { method: "DELETE" }))} type="button">
          Remove
        </button>
      </div>
    </div>
  );
}

/**
 * The category list Herald owns. Bots file every card under one of these;
 * a name they make up shows here as a suggestion.
 */
export function CategorySettings({ categories, onChanged }: { categories: Category[] | null; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = (categories ?? []).filter((c) => c.state === "active");
  const suggested = (categories ?? []).filter((c) => c.state === "suggested");

  async function run(task: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await task();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  return (
    <section className="group">
      <h2 className="group-title">Categories</h2>
      <p className="group-note">Your bots file every card under one of these. Cards in the same category stack together on Home.</p>
      {error ? <div className="error">{error}</div> : null}

      {suggested.length ? (
        <>
          <h3 className="group-subtitle">Suggested by your bots</h3>
          {suggested.map((c) => (
            <Suggestion active={active} c={c} key={c.id} run={run} />
          ))}
        </>
      ) : null}

      {active.map((c, i) => (
        <div className="item glass category-item" key={c.id}>
          <button aria-expanded={open === c.id} className="category-row" onClick={() => setOpen(open === c.id ? null : c.id)} type="button">
            <Badge c={c} />
            <span className="item-main">
              <span className="item-title">{c.name}</span>
              <span className="item-sub"> {c.count ? cards(c.count) : ""}</span>
            </span>
            <span aria-hidden className="muted">
              {open === c.id ? "▾" : "▸"}
            </span>
          </button>
          {open === c.id ? <Editor c={c} last={i === active.length - 1} onClose={() => setOpen(null)} run={run} /> : null}
        </div>
      ))}

      <form
        className="row category-add"
        onSubmit={(e) => {
          e.preventDefault();
          const value = name.trim();
          if (value) void run(() => request("/api/categories", { method: "POST", json: { name: value } })).then((ok) => ok && setName(""));
        }}
      >
        <input aria-label="New category" maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="New category" value={name} />
        <button className="btn btn-secondary" disabled={!name.trim()} type="submit">
          Add
        </button>
      </form>
    </section>
  );
}
