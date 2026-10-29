import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { isStandalone } from "./push";

interface SetupState {
  connected: boolean;
  devices: number;
  sources: number;
  suggestions: number;
  hidden: boolean;
  /** Opened from a Home Screen on some device. */
  installed: boolean;
}

/**
 * The first-run checklist at the top of Home: what's left before Herald is
 * fully set up. It goes away once everything's done, or when hidden.
 */
export function SetupChecklist({ tick }: { tick: number }) {
  const [state, setState] = useState<SetupState | null>(null);
  /** Hidden or all done: nothing left to check for. */
  const finished = useRef(false);
  useEffect(() => {
    if (finished.current) return;
    request<SetupState>("/api/setup").then((next) => {
      // Opened from the Home Screen here: that's done, on every device.
      if (!next.installed && isStandalone()) {
        next = { ...next, installed: true };
        void request("/api/setup/installed", { method: "POST" }).catch(() => undefined);
      }
      setState(next);
    }, () => undefined);
  }, [tick]);
  if (!state || state.hidden) {
    if (state) finished.current = true;
    return null;
  }

  const steps = [
    {
      done: state.connected,
      label: "Connect Grok Bot",
      detail: "Settings → Grok Bot → Connect, then paste the message into Grok Bot's chat.",
    },
    {
      done: state.sources > 0,
      label: "Your inboxes and calendars",
      detail: state.connected ? "They show up after Grok Bot's first scan." : "They show up once Grok Bot is connected and has scanned.",
    },
    {
      done: state.installed,
      label: "Add Herald to your Home Screen",
      detail: "In Safari: ☰ (left of the address) → Share → Add to Home Screen, then open Herald from there.",
    },
    {
      done: state.devices > 0,
      label: "Turn on notifications",
      detail: "Settings → Notifications, on each phone you use.",
    },
    {
      done: state.suggestions === 0,
      label: "Review your categories",
      detail: `${state.suggestions} suggested by Grok Bot. Keep, merge or remove them in Settings → Categories.`,
    },
  ];
  if (steps.every((s) => s.done)) {
    finished.current = true;
    return null;
  }

  return (
    <section aria-label="Finish setting up" className="setup glass">
      <div className="setup-head">
        <strong>Finish setting up</strong>
        <button
          className="link-btn"
          onClick={() => {
            setState({ ...state, hidden: true });
            void request("/api/setup/hide", { method: "POST" }).catch(() => undefined);
          }}
          type="button"
        >
          Hide
        </button>
      </div>
      <a className="btn btn-primary btn-block setup-continue" href="#welcome">
        Continue setup
      </a>
      <ol className="setup-steps">
        {steps.map((s) => (
          <li className={s.done ? "is-done" : ""} key={s.label}>
            <span aria-hidden className="setup-check">
              {s.done ? "✓" : ""}
            </span>
            <a className="setup-step" href="#settings">
              <span>{s.label}</span>
              {s.done ? null : <span className="muted">{s.detail}</span>}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
