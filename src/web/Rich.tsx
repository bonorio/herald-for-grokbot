import { createContext, Fragment, useContext, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block, Bot, Notification } from "../shared/types";

/** Every bot by agent id, for its accent color, role and status. */
export const BotsContext = createContext<Map<string, Bot>>(new Map());

const AVATAR_COLORS = ["#5e5ce6", "#0a84ff", "#30b0c7", "#34c759", "#ff9f0a", "#ff375f", "#bf5af2", "#8e8e93"];

/** The bot's own color, or a steady one picked from its name. */
export function accentFor(name: string, color?: string | null): string {
  if (color) return color;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] as string;
}

export function useAccent(n: { sourceId: string; sender: string }): string {
  const bot = useContext(BotsContext).get(n.sourceId);
  return accentFor(n.sender, bot?.color);
}

/** Plain text with bare URLs turned into links. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a href={part} key={i} rel="noreferrer" target="_blank">
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** Markdown from bots: no raw HTML, links open outside, images stay out. */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        components={{
          a: ({ href, children }) => (
            <a href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {text}
      </Markdown>
    </div>
  );
}

export function TypingDots({ label = "Writing" }: { label?: string }) {
  return (
    <span aria-label={`${label}…`} className="typing" role="status">
      <i />
      <i />
      <i />
    </span>
  );
}

/** The full text of a notification, as Markdown or plain text, with a caret while it streams. */
export function RichText({ n }: { n: Notification }) {
  const text = n.fullText ?? n.body;
  if (n.streaming && !text.trim()) return <TypingDots />;
  return (
    <div className={`rich ${n.streaming ? "is-streaming" : ""}`}>
      {n.bodyFormat === "markdown" ? (
        <MarkdownText text={text} />
      ) : (
        <div className="plain">
          <Linkified text={text} />
        </div>
      )}
    </div>
  );
}

function Progress({ block }: { block: Extract<Block, { type: "progress" }> }) {
  const pct = Math.round(block.value * 100);
  return (
    <div className="blk blk-progress">
      <div className="blk-progress-row">
        <span>{block.label ?? "Progress"}</span>
        <span className="muted">{pct === 100 ? "Done" : `${pct}%`}</span>
      </div>
      <div className="bar" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {block.detail ? <div className="blk-detail">{block.detail}</div> : null}
    </div>
  );
}

function Checklist({
  block,
  onToggle,
}: {
  block: Extract<Block, { type: "checklist" }>;
  onToggle?: (item: string, done: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const done = block.items.filter((i) => i.done).length;
  return (
    <div className="blk blk-checklist">
      <div className="blk-title">
        {block.title ?? "Checklist"}
        <span className="muted">
          {done}/{block.items.length}
        </span>
      </div>
      {block.items.map((item) => (
        <label className={`check ${item.done ? "is-done" : ""}`} key={item.id}>
          <input
            checked={item.done}
            disabled={!onToggle || busy === item.id}
            onChange={(e) => {
              if (!onToggle) return;
              setBusy(item.id);
              onToggle(item.id, e.target.checked).finally(() => setBusy(null));
            }}
            type="checkbox"
          />
          <span>{item.text}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * A step to finish elsewhere: which app, what for, whether it's done, and
 * one button that goes there. Herald only links; the app does the rest.
 */
export function Handoff({ block }: { block: Extract<Block, { type: "handoff" }> }) {
  const done = block.state === "done";
  return (
    <div className={`blk blk-handoff ${done ? "is-done" : ""}`}>
      <div className="handoff-app">
        <span aria-hidden className="handoff-mark">
          {block.app.trim().charAt(0).toUpperCase()}
        </span>
        <span>{block.app}</span>
        <span className="handoff-state">{done ? "✓ Done" : "Waiting for you"}</span>
      </div>
      <strong className="handoff-title">{block.title}</strong>
      {block.site ? <span className="muted">{block.site}</span> : null}
      {block.detail ? <span className="handoff-detail">{block.detail}</span> : null}
      {done ? null : (
        <a
          className="btn btn-primary handoff-go"
          href={block.url}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          rel="noreferrer"
          target="_blank"
        >
          Open {block.app}
        </a>
      )}
    </div>
  );
}

/** Typed cards under a notification's text. */
export function Blocks({
  blocks,
  onToggle,
}: {
  blocks: Block[];
  onToggle?: (block: number, item: string, done: boolean) => Promise<void>;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="blocks">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "progress":
            return <Progress block={block} key={index} />;
          case "facts":
            return (
              <div className="blk blk-facts" key={index}>
                {block.title ? <div className="blk-title">{block.title}</div> : null}
                <dl>
                  {block.items.map((item, i) => (
                    <div key={i}>
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          case "table":
            return (
              <div className="blk blk-table" key={index}>
                {block.title ? <div className="blk-title">{block.title}</div> : null}
                <div className="md-table">
                  <table>
                    <thead>
                      <tr>
                        {block.columns.map((c, i) => (
                          <th key={i}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {block.rows.map((row, r) => (
                        <tr className={block.highlight === r ? "is-pick" : ""} key={r}>
                          {block.columns.map((_, c) => (
                            <td key={c}>{row[c] ?? ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          case "checklist":
            return (
              <Checklist
                block={block}
                key={index}
                onToggle={onToggle ? (item, done) => onToggle(index, item, done) : undefined}
              />
            );
          case "link":
            return (
              <a className="blk blk-link" href={block.url} key={index} rel="noreferrer" target="_blank">
                {block.imageUrl ? <img alt="" loading="lazy" src={block.imageUrl} /> : null}
                <span className="blk-link-text">
                  <span className="blk-link-site">{block.site ?? new URL(block.url).hostname.replace(/^www\./, "")}</span>
                  <strong>{block.title}</strong>
                  {block.description ? <span className="muted">{block.description}</span> : null}
                </span>
              </a>
            );
          case "handoff":
            return <Handoff block={block} key={index} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

/** The blocks worth showing on a card in the list: live progress, and a step waiting on the owner elsewhere. */
export function CardProgress({ blocks }: { blocks: Block[] }) {
  const progress = blocks.find((b): b is Extract<Block, { type: "progress" }> => b.type === "progress");
  const handoff = blocks.find((b): b is Extract<Block, { type: "handoff" }> => b.type === "handoff" && b.state === "waiting");
  return (
    <>
      {progress ? <Progress block={progress} /> : null}
      {handoff ? <Handoff block={handoff} /> : null}
    </>
  );
}
