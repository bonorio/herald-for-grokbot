import { useEffect, useState } from "react";

/** What Connect Grok Bot makes: a message for its chat, and the two secrets for its secure secrets box. */
export interface Connection {
  message: string;
  apiKey: string;
  signingSecret: string;
}

/** Copies a value, says so for a moment, and says so if the browser won't allow it (or has no clipboard, as on plain http). */
export function Copy({ value, label = "Copy", className = "chip-btn" }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <button
      className={className}
      onClick={() => {
        if (!navigator.clipboard) return setState("failed");
        navigator.clipboard.writeText(value).then(() => setState("copied"), () => setState("failed"));
      }}
      type="button"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select it and copy" : label}
    </button>
  );
}

/**
 * Connecting Grok Bot, in the order it happens: paste the message into its
 * chat, then, when it asks through its secrets box, paste each secret there.
 * The secrets never go in the chat.
 */
export function ConnectionKit({ connection }: { connection: Connection }) {
  return (
    <div className="connection-kit">
      <ol className="onboard-steps">
        <li>Copy this message and paste it into your chat with Grok Bot. It has no secrets in it.</li>
      </ol>
      <pre className="onboard-message">{connection.message}</pre>
      <Copy className="btn btn-primary btn-block" label="Copy message" value={connection.message} />
      <ol className="onboard-steps" start={2}>
        <li>
          Grok Bot asks for two secrets in its secure secrets box. Copy each one here and paste it into the box with the same name, never into the
          chat.
        </li>
      </ol>
      {[
        { name: "HERALD_API_KEY", value: connection.apiKey },
        { name: "HERALD_SIGNING_SECRET", value: connection.signingSecret },
      ].map((s) => (
        <div className="item glass secret-row" key={s.name}>
          <div className="item-main">
            <div className="item-title">{s.name}</div>
            <code className="secret-value">{s.value}</code>
          </div>
          <Copy label="Copy" value={s.value} />
        </div>
      ))}
      <p className="onboard-note">
        Grok Bot also sets up a webhook routine and fills in its address and header itself where it can. If it asks you instead, both are on
        that routine's panel in Grok Bot and it tells you where: the webhook URL goes in the chat, the Authorization header (the whole "Name:
        value" line) in the secrets box. Herald doesn't have them.
      </p>
    </div>
  );
}
