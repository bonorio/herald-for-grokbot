import { useEffect, useState } from "react";
import { CADENCES, isQuiet, type ScanSource } from "../shared/types";
import { Icon } from "./Action";
import { request } from "./api";
import { TYPE_COLORS } from "./categories";
import { daysBetween } from "./group";

/** The inboxes and calendars Grok Bot watches, refetched whenever `key` changes. The third value is a load error. */
export function useSources(key: string) {
  const [sources, setSources] = useState<ScanSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    request<{ items: ScanSource[] }>("/api/sources").then(
      (r) => {
        if (!live) return;
        setSources(r.items);
        setError(null);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return [sources, setSources, error] as const;
}

/** The time, ticking each minute, so quiet sources show up without anything new arriving. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** "now", "12m ago", "3h ago", then "yesterday 3:15 PM" or "Mon 3:15 PM", so an old scan never reads like today's. */
export function sinceLabel(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 12 * 60) return `${Math.floor(minutes / 60)}h ago`;
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = -daysBetween(date, new Date(now));
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Gmail · me@example.com" */
export function sourceName(s: ScanSource): string {
  return s.account && !s.label.includes(s.account) ? `${s.label} · ${s.account}` : s.label;
}

/** Where a source is: scanning, asked to scan, failed, or when it last looked and what it found. */
export function sourceState(s: ScanSource, now = Date.now()): string {
  if (s.paused) return "Paused";
  if (s.status === "error") return s.lastError ?? "Last scan failed";
  if (s.status === "scanning") return "Scanning…";
  if (s.scanRequestedAt) return "Scan requested…";
  if (!s.lastScanAt) return "Not scanned yet";
  const found = s.lastFound ? ` · ${s.lastFound} new` : "";
  return `Scanned ${sinceLabel(s.lastScanAt, now)}${found}`;
}

function cadenceLabel(minutes: number): string {
  return minutes < 60 ? `Every ${minutes} min` : minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
}

function KindIcon({ kind }: { kind: ScanSource["kind"] }) {
  const type = kind === "calendar" ? "event" : "email";
  return (
    <span aria-hidden className="type-badge source-badge" style={{ width: 30, height: 30, "--type": TYPE_COLORS[type] } as React.CSSProperties}>
      <Icon className="type-badge-icon" type={type} />
    </span>
  );
}

/** Settings: each inbox and calendar, when it last scanned, how often it should, and Scan now. */
export function SourceSettings({
  sources,
  loadError,
  onChanged,
  onRetry,
}: {
  sources: ScanSource[] | null;
  loadError: string | null;
  onChanged: (sources: ScanSource[]) => void;
  onRetry: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const now = useMinute();
  const list = (sources ?? []).map((s) => ({ ...s, stale: isQuiet(s, now) }));

  /** Runs a change and merges the sources it returns, without fetching the list again. */
  async function run(task: () => Promise<ScanSource | { items: ScanSource[] }>) {
    setError(null);
    try {
      const result = await task();
      const changed = "items" in result ? result.items : [result];
      onChanged((sources ?? []).map((s) => changed.find((c) => c.id === s.id) ?? s));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="group">
      <h2 className="group-title">Inboxes and calendars</h2>
      <p className="group-note">What Grok Bot scans for you, when it last looked, and how often it should.</p>
      {error ? <div className="error">{error}</div> : null}
      {loadError && !sources ? (
        <div className="error">
          Couldn't load them: {loadError}{" "}
          <button className="link-btn" onClick={onRetry} type="button">
            Try again
          </button>
        </div>
      ) : list.length === 0 ? (
        <p className="group-note">{sources ? "Grok Bot hasn't reported any yet. They show up here after its first scan." : "Loading…"}</p>
      ) : null}
      {list.map((s) => (
        <div className={`item glass source-item ${s.stale ? "is-stale" : ""}`} key={s.id}>
          <KindIcon kind={s.kind} />
          <div className="item-main">
            <div className="item-title">{sourceName(s)}</div>
            <div className={`item-sub ${s.status === "error" ? "source-error" : ""}`}>{sourceState(s, now)}</div>
          </div>
          <div className="item-actions">
            <select
              aria-label={`How often to scan ${s.label}`}
              className="chip-btn"
              onChange={(e) =>
                void run(() =>
                  request<ScanSource>(`/api/sources/${encodeURIComponent(s.id)}`, {
                    method: "PATCH",
                    json: e.target.value === "paused" ? { paused: true } : { paused: false, cadenceMinutes: Number(e.target.value) },
                  }),
                )
              }
              value={s.paused ? "paused" : String(s.cadenceMinutes)}
            >
              {CADENCES.map((m) => (
                <option key={m} value={m}>
                  {cadenceLabel(m)}
                </option>
              ))}
              <option value="paused">Paused</option>
            </select>
            <button
              className="chip-btn"
              disabled={s.paused || !!s.scanRequestedAt}
              onClick={() => void run(() => request<{ items: ScanSource[] }>("/api/sources/scan", { method: "POST", json: { ids: [s.id] } }))}
              type="button"
            >
              Scan now
            </button>
          </div>
        </div>
      ))}
      {list.filter((s) => !s.paused).length > 1 ? (
        <button
          className="btn btn-secondary"
          onClick={() => void run(() => request<{ items: ScanSource[] }>("/api/sources/scan", { method: "POST" }))}
          type="button"
        >
          Scan everything now
        </button>
      ) : null}
    </section>
  );
}

/** On Home: a line for each inbox or calendar that's gone quiet or failing, with Scan now. */
export function QuietSources({ sources, onScan }: { sources: ScanSource[]; onScan: (s: ScanSource) => void }) {
  // Re-checked each minute: a source that's gone silent sends nothing to say so.
  const now = useMinute();
  const quiet = sources.filter((s) => isQuiet(s, now));
  if (quiet.length === 0) return null;
  return (
    <section aria-label="Sync problems" className="quiet-sources">
      {quiet.map((s) => (
        <div className="quiet-source glass" key={s.id}>
          <span aria-hidden className="quiet-dot" />
          <span className="quiet-text">
            <strong>{sourceName(s)}</strong>{" "}
            {s.status === "error" ? (s.lastError ?? "couldn't sync") : s.lastScanAt ? `last synced ${sinceLabel(s.lastScanAt, now)}` : "hasn't synced yet"}
          </span>
          <button className="chip-btn" disabled={!!s.scanRequestedAt} onClick={() => onScan(s)} type="button">
            {s.scanRequestedAt ? "Asked…" : "Scan now"}
          </button>
        </div>
      ))}
    </section>
  );
}
