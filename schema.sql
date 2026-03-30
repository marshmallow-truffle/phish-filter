CREATE TABLE IF NOT EXISTS classifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      TEXT UNIQUE NOT NULL,
    history_id      TEXT,
    sender          TEXT,
    subject         TEXT,
    body_sent_to_llm TEXT,
    label           TEXT NOT NULL CHECK (label IN ('phish', 'spam', 'benign')),
    confidence      REAL,
    reason          TEXT,
    quarantined     BOOLEAN DEFAULT FALSE,
    raw_headers     JSONB,
    processed_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classifications_label ON classifications(label);
CREATE INDEX IF NOT EXISTS idx_classifications_processed_at ON classifications(processed_at);

CREATE TABLE IF NOT EXISTS system_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO system_state (key, value) VALUES ('last_history_id', '0')
    ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS accounts (
    email           TEXT PRIMARY KEY,
    refresh_token   TEXT NOT NULL,
    last_history_id TEXT NOT NULL DEFAULT '0',
    watch_expiration TIMESTAMPTZ,
    added_at        TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'classifications' AND column_name = 'account_email'
  ) THEN
    ALTER TABLE classifications ADD COLUMN account_email TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_classifications_account ON classifications(account_email);

CREATE TABLE IF NOT EXISTS classification_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    field       TEXT NOT NULL CHECK (field IN ('sender_domain', 'subject', 'body')),
    pattern     TEXT NOT NULL,
    label       TEXT NOT NULL CHECK (label IN ('phish', 'spam', 'benign')),
    confidence  REAL NOT NULL DEFAULT 1.0,
    reason      TEXT NOT NULL,
    enabled     BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT now()
);
