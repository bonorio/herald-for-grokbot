import { isQuiet, type ScanSource } from "../shared/types";
import type { Actor, Env } from "./env";
import { eventStatements } from "./events";
import { HttpError } from "./notifications";
import { nowIso } from "./util";

interface SourceRow {
  id: string;
  kind: ScanSource["kind"];
  provider: string | null;
  account: string | null;
  label: string;
  status: ScanSource["status"];
  last_error: string | null;
  last_scan_at: string | null;
  next_scan_at: string | null;
  last_found: number | null;
  cadence_minutes: number;
  paused: number;
  scan_requested_at: string | null;
  settings_at: string | null;
  created_at: string;
}

/** A Scan now nobody answered stops holding the button after this. */
const REQUEST_MS = 10 * 60_000;

function toDto(row: SourceRow): ScanSource {
  const dto: ScanSource = {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    account: row.account,
    label: row.label,
    status: row.status,
    lastError: row.last_error,
    lastScanAt: row.last_scan_at,
    nextScanAt: row.next_scan_at,
    lastFound: row.last_found,
    cadenceMinutes: row.cadence_minutes,
    paused: !!row.paused,
    scanRequestedAt:
      row.scan_requested_at && Date.now() - new Date(row.scan_requested_at).getTime() < REQUEST_MS ? row.scan_requested_at : null,
    // The owner's last schedule change, or else whenever it was first heard of.
    watchingSince: row.settings_at ?? row.last_scan_at ?? row.created_at,
    stale: false,
  };
  dto.stale = isQuiet(dto);
  return dto;
}

/** Email first, then calendars, each by label. */
export async function listSources(env: Env): Promise<ScanSource[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM sources ORDER BY CASE kind WHEN 'email' THEN 0 WHEN 'calendar' THEN 1 ELSE 2 END, label COLLATE NOCASE",
  ).all<SourceRow>();
  return results.map(toDto);
}

export async function getSource(env: Env, id: string): Promise<ScanSource | null> {
  const row = await env.DB.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first<SourceRow>();
  return row ? toDto(row) : null;
}

export interface SourceReport {
  kind: ScanSource["kind"];
  label: string;
  provider?: string | null;
  account?: string | null;
  status?: ScanSource["status"];
  error?: string | null;
  lastScanAt?: string | null;
  nextScanAt?: string | null;
  found?: number | null;
}

/**
 * What the bot says about a source: that it exists, and how its last scan
 * went. Leaves the owner's cadence and pause alone. A scan report (a newer
 * `lastScanAt`) answers any pending Scan now.
 */
export async function reportSource(env: Env, id: string, report: SourceReport): Promise<ScanSource> {
  const now = nowIso();
  const status = report.status ?? (report.error ? "error" : "ok");
  await env.DB.prepare(
    `INSERT INTO sources (id, kind, provider, account, label, status, last_error, last_scan_at, next_scan_at, last_found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       kind = excluded.kind,
       provider = COALESCE(excluded.provider, sources.provider),
       account = COALESCE(excluded.account, sources.account),
       label = excluded.label,
       status = excluded.status,
       last_error = excluded.last_error,
       last_scan_at = COALESCE(excluded.last_scan_at, sources.last_scan_at),
       next_scan_at = COALESCE(excluded.next_scan_at, sources.next_scan_at),
       -- A scan report's count is that scan's, even when it found nothing.
       last_found = CASE WHEN excluded.last_scan_at IS NOT NULL THEN excluded.last_found ELSE sources.last_found END,
       -- Any report after Scan now answers it, a failure included.
       scan_requested_at = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      report.kind,
      report.provider ?? null,
      report.account ?? null,
      report.label,
      status,
      status === "error" ? (report.error ?? "Scan failed") : null,
      report.lastScanAt ?? null,
      report.nextScanAt ?? null,
      report.found ?? null,
      now,
      now,
    )
    .run();
  return (await getSource(env, id)) as ScanSource;
}

export interface SourceWrite {
  source: ScanSource;
  eventId: string | null;
}

/** The owner's cadence and pause for one source. Grok Bot hears `source.settings` and scans to match. */
export async function setSourceSettings(
  env: Env,
  actor: Actor,
  id: string,
  patch: { cadenceMinutes?: number; paused?: boolean },
): Promise<SourceWrite> {
  const current = await getSource(env, id);
  if (!current) throw new HttpError(404, "No such inbox or calendar");
  const cadence = patch.cadenceMinutes ?? current.cadenceMinutes;
  const paused = patch.paused ?? current.paused;
  if (cadence === current.cadenceMinutes && paused === current.paused) return { source: current, eventId: null };
  const source = { ...current, cadenceMinutes: cadence, paused };
  const { statements, eventId } = eventStatements(env, {
    subject: `source:${id}`,
    event: "source.settings",
    actor,
    payload: { source: { id, kind: source.kind, provider: source.provider, account: source.account, cadenceMinutes: cadence, paused } },
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE sources SET cadence_minutes = ?, paused = ?, settings_at = ?, updated_at = ? WHERE id = ?").bind(
      cadence,
      paused ? 1 : 0,
      nowIso(),
      nowIso(),
      id,
    ),
    ...statements,
  ]);
  return { source: (await getSource(env, id)) as ScanSource, eventId };
}

/** Scan now: asks Grok Bot to scan these sources (all that aren't paused, when none are named). */
export async function requestScan(env: Env, actor: Actor, ids?: string[]): Promise<{ sources: ScanSource[]; eventId: string | null }> {
  const all = await listSources(env);
  const targets = ids ? all.filter((s) => ids.includes(s.id)) : all.filter((s) => !s.paused);
  if (ids && targets.length !== new Set(ids).size) throw new HttpError(404, "No such inbox or calendar");
  // Nothing reported yet (the first run) still asks: an empty list means "scan everything you watch".
  if (targets.length === 0 && (ids || all.length > 0)) return { sources: [], eventId: null };
  const now = nowIso();
  const { statements, eventId } = eventStatements(env, {
    subject: "sources",
    event: "scan.requested",
    actor,
    payload: { sources: targets.map((s) => ({ id: s.id, kind: s.kind, provider: s.provider, account: s.account })) },
  });
  await env.DB.batch([
    env.DB.prepare(`UPDATE sources SET scan_requested_at = ? WHERE id IN (${targets.map(() => "?").join(", ")})`).bind(now, ...targets.map((s) => s.id)),
    ...statements,
  ]);
  return { sources: targets.map((s) => ({ ...s, scanRequestedAt: now })), eventId };
}

export async function deleteSource(env: Env, id: string): Promise<void> {
  const result = await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(id).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "No such inbox or calendar");
}
