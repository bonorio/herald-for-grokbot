-- Herald's schema. New migrations go in 0002_*.sql and up.

-- What bots post. Lists, stacks and Chat all read from here.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('bot', 'webhook')),
  source_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  avatar_url TEXT,
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  full_text TEXT,
  url TEXT,
  kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('alert', 'result', 'question', 'update')),
  flag TEXT NOT NULL DEFAULT 'none' CHECK (flag IN ('none', 'awaiting', 'urgent')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'dismissed', 'responded')),
  response_prompt TEXT,
  response_text TEXT,
  stack_key TEXT,
  idempotency_key TEXT UNIQUE,
  status_before_dismiss TEXT,
  -- Bumped on every write; updates only apply to the version they read.
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  responded_at TEXT,
  -- The Chat request this answers.
  request_id TEXT,
  body_format TEXT NOT NULL DEFAULT 'text' CHECK (body_format IN ('text', 'markdown')),
  summary TEXT,
  blocks TEXT,
  quick_replies TEXT,
  streaming INTEGER NOT NULL DEFAULT 0,
  -- The email, bill or event it's about (JSON).
  subject TEXT,
  actions TEXT,
  due_at TEXT,
  response_action TEXT,
  outcome TEXT,
  topic TEXT,
  task TEXT,
  lane TEXT NOT NULL DEFAULT 'fyi' CHECK (lane IN ('needs_you', 'fyi', 'handled')),
  category TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  -- What a dismiss also did in the mailbox.
  disposition TEXT CHECK (disposition IN ('archive', 'trash', 'read', 'unsubscribe')),
  snoozed_until TEXT,
  status_before_snooze TEXT
);
CREATE INDEX notifications_created ON notifications (created_at DESC, id DESC);
CREATE INDEX notifications_updated ON notifications (updated_at);
CREATE INDEX notifications_status ON notifications (status, created_at DESC);
CREATE INDEX notifications_request ON notifications (request_id);
CREATE INDEX notifications_source ON notifications (source_id, created_at DESC);
CREATE INDEX notifications_category ON notifications (category, created_at DESC);
CREATE INDEX notifications_snoozed ON notifications (snoozed_until) WHERE snoozed_until IS NOT NULL;

-- The audit log: every change to a notification, and what Grok Bot is told.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_notification ON events (notification_id, created_at);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  actor TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  expires_at TEXT NOT NULL
);

-- Webhooks to Grok Bot, retried until delivered.
CREATE TABLE webhook_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX webhook_outbox_due ON webhook_outbox (status, next_attempt_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT
);

-- What the owner sends a bot from Chat.
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  to_source_id TEXT NOT NULL,
  to_sender TEXT NOT NULL,
  text TEXT NOT NULL,
  in_reply_to TEXT,
  actor TEXT NOT NULL,
  -- The audit event that carries it to Grok Bot; joins to webhook_outbox for delivery status.
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'answered')),
  created_at TEXT NOT NULL,
  answered_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT
);
CREATE INDEX requests_target ON requests (to_source_id, created_at DESC);

-- Each bot's name, face and live status.
CREATE TABLE senders (
  source_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sender TEXT NOT NULL,
  avatar_url TEXT,
  -- When the name was set: the naming notification's createdAt, or the time of an explicit rename.
  named_at TEXT NOT NULL,
  role TEXT,
  color TEXT,
  status_text TEXT,
  status_state TEXT CHECK (status_state IN ('working', 'idle')),
  status_at TEXT
);

-- The line at the top of Home.
CREATE TABLE briefing (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL,
  actor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Settings, as JSON values.
CREATE TABLE prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Herald owns the list; bots pick from it and suggest new ones.
CREATE TABLE categories (
  -- Stable across renames; bots may send it or the name.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suggested')),
  created_at TEXT NOT NULL,
  -- A bot's one line about the stack on Home.
  summary TEXT,
  summary_at TEXT,
  -- What a hard swipe also does in the mailbox.
  swipe_action TEXT NOT NULL DEFAULT 'archive' CHECK (swipe_action IN ('archive', 'trash', 'read', 'unsubscribe', 'none'))
);

CREATE TABLE category_aliases (
  alias TEXT PRIMARY KEY,
  category_id TEXT
);

INSERT INTO categories (id, name, color, icon, position, swipe_action, created_at) VALUES
  ('people', 'People', '#0a84ff', 'person', 1, 'archive', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('work', 'Work', '#5e5ce6', 'briefcase', 2, 'archive', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('money', 'Money', '#34c759', 'card', 3, 'archive', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('calendar', 'Calendar', '#ff9f0a', 'calendar', 4, 'archive', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('family', 'Family', '#ff6482', 'heart', 5, 'archive', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('home', 'Home', '#ac8e68', 'house', 6, 'archive', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('travel', 'Travel', '#64d2ff', 'plane', 7, 'archive', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shopping', 'Shopping', '#ffd60a', 'bag', 8, 'archive', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('newsletters', 'Newsletters', '#8e8e93', 'news', 9, 'trash', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- The inboxes and calendars Grok Bot watches, as it reports them, plus the owner's scan settings.
CREATE TABLE sources (
  -- Chosen by the bot and stable, e.g. "gmail:me@example.com".
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'calendar', 'other')),
  provider TEXT,
  account TEXT,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'scanning', 'error')),
  last_error TEXT,
  last_scan_at TEXT,
  next_scan_at TEXT,
  -- How many new things the last scan found.
  last_found INTEGER,
  -- The owner's: how often to scan, and whether to at all.
  cadence_minutes INTEGER NOT NULL DEFAULT 15,
  paused INTEGER NOT NULL DEFAULT 0,
  -- When the owner last tapped Scan now; cleared by the bot's next report.
  scan_requested_at TEXT,
  -- When the owner last changed the schedule; a source isn't quiet until a
  -- whole new interval has passed since.
  settings_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
