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
