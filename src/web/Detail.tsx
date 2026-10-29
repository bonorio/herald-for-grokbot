import { useContext, useEffect, useRef, useState } from "react";
import { type Disposition, isExpired, type Notification, promptOptions } from "../shared/types";
import { ActionBar, DueChip, isTransaction, SubjectView, TypeBadge } from "./Action";
import { actionLabel, answerButtons, answeredLabel, Pills, sourceAction, sourceLabel } from "./Card";
import { CategoriesContext, headingOf, useFiling } from "./categories";
import { snoozedLabel } from "./Snooze";
import { fullTime } from "./group";
import { Blocks, RichText } from "./Rich";

interface DetailProps {
  n: Notification;
  onClose: () => void;
  onRespond: (text: string, action?: string) => Promise<void>;
  /** A disposition also asks Grok Bot to do that to the email at its source. */
  onDismiss: (disposition?: Disposition | null) => void;
  onSnooze: () => void;
  onRestore: () => void;
  /** Opens the bot's thread to send a follow-up; only for bots. */
  onFollowUp?: () => void;
  onToggle: (block: number, item: string, done: boolean) => Promise<void>;
}

export function Detail({ n, onClose, onRespond, onDismiss, onSnooze, onRestore, onFollowUp, onToggle }: DetailProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const categories = useContext(CategoriesContext);
  const filing = useFiling(n);
  const atSource = sourceAction(n, filing.category);
  const options = answerButtons(n).length ? answerButtons(n) : promptOptions(n.responsePrompt);
  const expired = n.status !== "responded" && isExpired(n.responsePrompt);
  const answered = n.status === "responded" && n.responseText;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    sheet.current?.focus();
    document.body.classList.add("no-scroll");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [onClose]);

  async function send(value: string) {
    if (!value.trim()) return;
    setSending(value);
    setError(null);
    try {
      await onRespond(value.trim());
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        aria-label={`${n.sender} notification`}
        aria-modal="true"
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        ref={sheet}
        role="dialog"
        tabIndex={-1}
      >
        <div className="sheet-grabber" />
        <header className="sheet-head">
          <TypeBadge n={n} size={44} />
          <div className="sheet-who">
            <div className="sheet-sender">
              {headingOf(n, categories)} <Pills n={n} />
            </div>
            <div className="sheet-time">
              {fullTime(n.createdAt)} · via {n.sender}
            </div>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="sheet-scroll">
          {n.title ? <h2 className="sheet-title">{n.title}</h2> : null}
          {n.dueAt && n.status !== "responded" ? <DueChip n={n} /> : null}
          {n.subject ? <SubjectView subject={n.subject} /> : null}
          <div className="sheet-text">
            <RichText n={n} />
          </div>
          <Blocks blocks={n.blocks} onToggle={onToggle} />
          {n.url ? (
            <a className="btn btn-secondary btn-block" href={n.url} rel="noreferrer" target="_blank">
              Open link ↗
            </a>
          ) : null}
        </div>

        <footer className="sheet-foot">
          {isTransaction(n) ? (
            <ActionBar full n={n} onRespond={onRespond} />
          ) : answered ? (
            <div className="reply-bubble">
              <span className="reply-label">You replied{n.respondedAt ? ` · ${fullTime(n.respondedAt)}` : ""}</span>
              {answeredLabel(n.responseText ?? "")}
            </div>
          ) : expired ? (
            <div className="hint">This question expired{n.responsePrompt?.expiresAt ? ` ${fullTime(n.responsePrompt.expiresAt)}` : ""}.</div>
          ) : options.length > 0 ? (
            <div className="choice-row">
              {options.map((option, index) => (
                <button
                  className={`btn ${index === options.length - 1 ? "btn-primary" : "btn-secondary"}`}
                  disabled={!!sending}
                  key={option}
                  onClick={() => send(option)}
                  type="button"
                >
                  {sending === option ? "…" : actionLabel(option)}
                </button>
              ))}
            </div>
          ) : (
            <form
              className="reply-form"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <textarea
                aria-label="Reply"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(text);
                }}
                placeholder={n.responsePrompt?.placeholder ?? `Reply to ${n.sender}`}
                rows={2}
                value={text}
              />
              <button className="btn btn-primary" disabled={!text.trim() || !!sending} type="submit">
                {sending ? "…" : "Send"}
              </button>
            </form>
          )}
          {error ? <div className="error">{error}</div> : null}
          <div className="sheet-actions">
            {onFollowUp ? (
              <button className="link-btn" onClick={onFollowUp} type="button">
                Follow up with {n.sender}
              </button>
            ) : null}
            {n.status === "dismissed" ? (
              <button className="link-btn" onClick={onRestore} type="button">
                Restore to inbox
              </button>
            ) : (
              <>
                {n.status === "responded" ? null : (
                  <button className="link-btn" onClick={onSnooze} type="button">
                    {n.snoozedUntil ? snoozedLabel(n.snoozedUntil) : "Snooze"}
                  </button>
                )}
                {atSource ? (
                  <button className="link-btn" onClick={() => onDismiss(atSource)} type="button">
                    {sourceLabel(n, atSource)}
                  </button>
                ) : null}
                <button className="link-btn danger" onClick={() => onDismiss(null)} type="button">
                  Dismiss
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
