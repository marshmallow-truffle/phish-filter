# Email Classifier

Real-time email classification service that watches a Gmail inbox, classifies incoming messages as phishing/spam/benign using an LLM, and quarantines phishing emails automatically.

## Architecture

```
┌─────────────┐    watch()     ┌──────────────┐
│  Gmail API  │ ──────────────>│ GCP Pub/Sub  │
└─────────────┘                │   (topic)    │
                               └──────┬───────┘
                                      │ pull subscription
                                      ▼
                              ┌───────────────┐
                              │  Worker Svc   │
                              │  (Hono)       │
                              └───┬───┬───┬───┘
                                  │   │   │
                    ┌─────────────┘   │   └─────────────┐
                    ▼                 ▼                  ▼
             ┌────────────┐   ┌────────────┐   ┌───────────────┐
             │ Gmail API  │   │  LLM API   │   │  PostgreSQL   │
             │ (fetch +   │   │ (classify) │   │  (persist)    │
             │ quarantine)│   └────────────┘   └───────────────┘
             └────────────┘
```

### Why Pub/Sub over polling?

Event-driven, fault-tolerant, zero data loss during downtime. Gmail pushes change notifications to a Pub/Sub topic; the service pulls from a subscription at its own pace, giving natural backpressure control.

### Reliability: every email gets processed

Three mechanisms work together to guarantee no email is missed, even across crashes and restarts:

**1. Per-account serial queue.** Each Gmail account gets its own notification queue with a single processing loop. Pub/Sub notifications are enqueued immediately (non-blocking) and processed one at a time per account. This eliminates race conditions — the read cursor → fetch messages → process → update cursor sequence is atomic per account, while different accounts process concurrently.

**2. History cursor tracks processed messages, not notifications.** After processing a batch of messages, the cursor advances to the highest `historyId` of successfully processed messages — not the notification's historyId. If the server crashes mid-batch, the cursor reflects only what was actually completed. On restart, `history.list(cursor)` picks up from exactly where processing stopped.

**3. Catch-up on startup uses the same code path.** On startup, each account receives a synthetic notification pushed to its queue. The same loop calls `history.list(last_cursor)`, processes any missed messages, and advances the cursor. There is no separate catch-up code — live processing and crash recovery are identical.

**Dedup guarantees idempotency.** The `classifications` table has a `UNIQUE(message_id)` primary key with `ON CONFLICT DO NOTHING`. If a message is re-fetched (due to overlapping history ranges or Pub/Sub redelivery), it's silently skipped. The cursor only advances past it.

**Pub/Sub ack/nack.** Notifications are only acknowledged after the full batch succeeds. If processing throws, the notification is nacked and Pub/Sub redelivers it after the ack deadline (60s). The dedup check skips any messages that were already processed before the failure.

```
Startup:
  for each account → push synthetic notification to queue

Live:
  Pub/Sub notification → enqueue(emailAddress, ack, nack)

Per-account loop (serial):
  take notification from queue
  read cursor from DB
  history.list(cursor) → message IDs
  for each message:
    dedup check → skip if already in DB
    fetch from Gmail → classify → label → save to DB
    track max historyId
  update cursor to max historyId
  ack notification
```

The service can be down for hours. On restart, every missed email is processed without duplication.

### Database isolation

All database access goes through a `DatabasePort` interface (`src/db.port.ts`). The production implementation is `PgDatabase` (`src/db.pg.ts`), but swapping to SQLite, DynamoDB, or an in-memory store requires only a new class implementing the interface. No other code needs to change.

### Message processing pipeline

```
Pub/Sub notification
  │
  ▼
history.list(startHistoryId) → list of message IDs
  │
  ▼
For each message_id:
  ├── Already in DB? → skip (dedup)
  ├── messages.get(format="full") → parse MIME tree
  │     └── Prefer text/plain, strip HTML, truncate to 2000 chars
  ├── LLM classify → {label, confidence, reason}
  ├── If "phish" → move to PHISH_QUARANTINE label (not Trash)
  ├── Store in Postgres (with body sent to LLM for audit)
  └── Update history cursor
  │
  ▼
ACK the Pub/Sub message (only after full pipeline succeeds)
```

Quarantine uses a custom Gmail label instead of Trash so quarantined messages are visible in the inbox UI and don't auto-delete after 30 days.

### Tradeoffs

- **Classification** uses a single LLM call per message. Production would add URL reputation checks, sender verification (SPF/DKIM/DMARC parsing), ensemble models, and human review for low-confidence results. Intentionally kept simple since the focus is on the delivery infrastructure.
- **Watch expiry**: Gmail `watch()` expires after 7 days. A production system would renew on a cron. Not implemented since it's not relevant for a short-lived demo.
- **History expiry**: Gmail history records expire after ~30 days. The catch-up mechanism relies on history being available, so a production system would need a fallback full-sync path.

## Verification

### Health endpoint

```
GET /health
```

Returns service status, uptime, DB connectivity, and classification counts:

```json
{
  "status": "healthy",
  "uptime_seconds": 43210,
  "messages_processed_total": 47,
  "db_connected": true,
  "db_recent_hour_count": 5,
  "classifications_summary": {
    "phish_count": 3,
    "spam_count": 12,
    "benign_count": 32
  }
}
```

### Recent classifications

```
GET /health/classifications?limit=20
```

Returns the most recent classification results with sender, subject, label, confidence, and quarantine status.

### Send a test email

You can send test phishing and benign emails to the monitored inbox:

```bash
npx tsx scripts/send-test-email.ts \
  --to monitored@gmail.com \
  --template paypal \
  --smtp-user you@gmail.com \
  --smtp-pass your-app-password
```

Templates: `paypal` (phishing), `bank` (phishing), `benign` (GitHub notification).

## Setup

### Prerequisites

- Node.js 22+
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud` CLI)
- PostgreSQL (local or hosted)
- An [Anthropic API key](https://console.anthropic.com/)

### 1. GCP project

1. Go to [Google Cloud Console](https://console.cloud.google.com), create or select a project.
2. Enable **Gmail API** and **Cloud Pub/Sub API** under APIs & Services.

### 2. OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** user type.
3. Fill in app name and email.
4. Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.labels`.
5. Under **Test users**, add the Gmail addresses you want to monitor.

### 3. OAuth credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Add `http://localhost:8080/oauth/callback` as an **Authorized redirect URI**.
4. Note the **Client ID** and **Client Secret**.

### 4. GCP Pub/Sub

```bash
export GCP_PROJECT_ID=your-project-id
./scripts/setup-pubsub.sh
```

This creates the `email-notifications` topic, grants Gmail publish rights, and creates the `email-worker-sub` pull subscription.

### 5. GCP Application Default Credentials

The Pub/Sub pull client needs ADC to authenticate:

```bash
gcloud auth application-default login
```

This opens a browser for you to sign in with your Google account.

### 6. PostgreSQL

**Local:**
```bash
createdb phish_filter
```

**Hosted:** Create a database on [Neon](https://neon.tech) (free tier) or any Postgres provider.

The service applies the schema automatically on startup.

### 7. Environment variables

Create a `.env` file (gitignored):

```bash
# Required
DATABASE_URL=postgresql://localhost/phish_filter
GOOGLE_CLIENT_ID=your-oauth-client-id
GOOGLE_CLIENT_SECRET=your-oauth-client-secret
GCP_PROJECT_ID=your-gcp-project-id
ANTHROPIC_API_KEY=sk-ant-...

# Optional (shown with defaults)
GOOGLE_REFRESH_TOKEN=                  # not needed — add accounts via web UI instead
PUBSUB_TOPIC=email-notifications
PUBSUB_SUBSCRIPTION=email-worker-sub
LLM_MODEL=claude-sonnet-4-20250514
LLM_MAX_CONCURRENT=5
QUARANTINE_LABEL_NAME=PHISH_QUARANTINE
MAX_BODY_LENGTH=2000
OAUTH_REDIRECT_URI=http://localhost:8080/oauth/callback
PORT=8080
```

### 8. Run

```bash
npm install
npm run check   # typecheck + lint + test
npm run dev     # starts with hot reload via tsx
```

Then visit **http://localhost:8080/** to add Gmail accounts via the web UI.

## Deploy

### Fly.io

Install the [Fly CLI](https://fly.io/docs/flyctl/install/), then:

```bash
# First-time setup
fly launch --no-deploy

# Set secrets (all required env vars)
fly secrets set \
  DATABASE_URL="postgresql://user:pass@host/db" \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  GCP_PROJECT_ID="..." \
  ANTHROPIC_API_KEY="..." \
  OAUTH_REDIRECT_URI="https://your-app.fly.dev/oauth/callback"

# Deploy
fly deploy
```

The included `fly.toml` configures:
- Region: `sjc`
- Shared CPU, 512MB RAM
- `auto_stop_machines = false` so the service stays alive for Pub/Sub pull
- `min_machines_running = 1`

After deploy, verify at `https://your-app.fly.dev/`.

### Docker (any host)

```bash
docker build -t email-classifier .
docker run -p 8080:8080 --env-file .env email-classifier
```

## Development

```bash
npm run check       # typecheck + lint + test (run before pushing)
npm run build       # compile TypeScript
npm test            # run tests
npm run lint        # ESLint
npm run dev         # dev server with hot reload
```

### Project structure

```
src/
  config.ts           Environment config (Zod validated)
  credentials.ts      OAuth2 token management
  gmail-client.ts     Gmail API: watch, history, fetch, MIME parsing, quarantine
  pubsub-worker.ts    Pull subscription loop, catch-up, pipeline orchestration
  classifier.ts       LLM classification with concurrency semaphore
  db.port.ts          Database interface (consumers depend on this)
  db.pg.ts            PostgreSQL implementation
  models.ts           Zod schemas and TypeScript types
  health.ts           In-memory stats tracker
  retry.ts            Exponential backoff utility
  index.ts            Hono app, health endpoints, startup sequence
```

### Test coverage

42 tests across 9 files covering: retry logic, credential management, MIME parsing, LLM classification (including malformed response handling and concurrency limiting), database dedup and health queries, Pub/Sub worker pipeline, health endpoints, and end-to-end flow.
