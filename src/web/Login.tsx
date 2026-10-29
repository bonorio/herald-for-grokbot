import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useRef, useState } from "react";
import { request } from "./api";

/** A readable default name for a passkey made on this device, e.g. "iPhone · Oct 28". */
function deviceName(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Macintosh/.test(ua)
        ? "Mac"
        : /Android/.test(ua)
          ? "Android"
          : /Windows/.test(ua)
            ? "Windows"
            : "Browser";
  return `${device} · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export async function registerPasskey(setupCode?: string, ownerName?: string) {
  const options = await request<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/auth/register/options", {
    method: "POST",
    json: { setupCode, ownerName },
  });
  const response = await startRegistration({ optionsJSON: options });
  await request("/auth/register/verify", {
    method: "POST",
    json: { response, setupCode, ownerName, name: deviceName() },
  });
}

export function Login({ hasPasskey, onSignedIn }: { hasPasskey: boolean; onSignedIn: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      onSignedIn();
    } catch (e) {
      const message = (e as Error).message;
      setError(/NotAllowedError|cancel/i.test(`${(e as Error).name} ${message}`) ? "Cancelled." : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-mark" aria-hidden>
        H
      </div>
      <h1>Herald</h1>
      {hasPasskey ? (
        <>
          <p className="hint">Sign in with your passkey.</p>
          <button
            className="btn btn-primary btn-block"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const options = await request<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
                  "/auth/login/options",
                  { method: "POST" },
                );
                const response = await startAuthentication({ optionsJSON: options });
                await request("/auth/login/verify", { method: "POST", json: { response } });
              })
            }
            type="button"
          >
            {busy ? "Waiting…" : "Sign in with passkey"}
          </button>
        </>
      ) : (
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => registerPasskey(code, name.trim() || undefined));
          }}
        >
          <p className="hint">First run: enter the setup code, then save a passkey on this device.</p>
          <input
            aria-label="Setup code"
            // Typed off a computer screen: no capitals, corrections or suggestions getting in the way.
            autoCapitalize="none"
            autoComplete="one-time-code"
            autoCorrect="off"
            className="setup-code"
            enterKeyHint="next"
            onKeyDown={(e) => {
              // Return moves on to the name, rather than starting the passkey before it's filled in.
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                nameInput.current?.focus();
              }
            }}
            inputMode="text"
            onChange={(e) => setCode(e.target.value)}
            placeholder="xxxx-xxxx-xxxx-xxxx"
            spellCheck={false}
            value={code}
          />
          <input aria-label="Your first name (optional)" autoComplete="given-name" enterKeyHint="go" ref={nameInput} onChange={(e) => setName(e.target.value)} placeholder="Your first name (optional)" value={name} />
          <button className="btn btn-primary btn-block" disabled={busy || !code.trim()} type="submit">
            {busy ? "Waiting…" : "Create passkey"}
          </button>
        </form>
      )}
      {error ? <div className="error">{error}</div> : null}
    </main>
  );
}
