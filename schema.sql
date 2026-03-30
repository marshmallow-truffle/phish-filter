CREATE TABLE IF NOT EXISTS classifications (
    message_id      TEXT PRIMARY KEY,
    sender          TEXT,
    subject         TEXT,
    label           TEXT NOT NULL CHECK (label IN ('phish', 'spam', 'benign', 'failed')),
    confidence      REAL,
    reason          TEXT,
    quarantined     BOOLEAN DEFAULT FALSE,
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
    total_processed INT DEFAULT 0,
    phish_count     INT DEFAULT 0,
    spam_count      INT DEFAULT 0,
    benign_count    INT DEFAULT 0,
    failed_count    INT DEFAULT 0,
    last_processed_at TIMESTAMPTZ,
    added_at        TIMESTAMPTZ DEFAULT now()
);


CREATE TABLE IF NOT EXISTS events (
    message_id    TEXT NOT NULL,
    seq           INT NOT NULL,
    account_email TEXT,
    stage         TEXT NOT NULL,
    level         TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    message       TEXT NOT NULL,
    metadata      JSONB,
    created_at    TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (message_id, seq)
);

CREATE TABLE IF NOT EXISTS classification_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    field       TEXT NOT NULL CHECK (field IN ('sender_domain', 'subject', 'body')),
    pattern     TEXT NOT NULL,
    label       TEXT NOT NULL CHECK (label IN ('phish', 'spam', 'benign', 'failed')),
    confidence  REAL NOT NULL DEFAULT 1.0,
    reason      TEXT NOT NULL,
    enabled     BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT now()
);
