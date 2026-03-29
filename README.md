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

### Fault tolerance: history catch-up

The core reliability mechanism. On every startup (including crash recovery), the service:

1. Reads `last_history_id` from Postgres (the recovery cursor)
2. Starts the Pub/Sub pull subscription (buffers messages during replay)
3. Calls `history.list(startHistoryId=last_history_id)` to fetch every message added since the last known state
4. Processes each message through the full pipeline (dedup check, fetch, classify, store)
5. Re-establishes `watch()` to renew Pub/Sub notifications

The `classifications` table has a `UNIQUE(message_id)` constraint with `ON CONFLICT DO NOTHING`, so overlapping messages from catch-up and live Pub/Sub are handled idempotently.

This means the service can be down for hours and on restart will process every missed email without duplication.

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
- A GCP project with Gmail API and Pub/Sub API enabled
- A PostgreSQL database (e.g., [Neon](https://neon.tech) free tier)
- An [Anthropic API key](https://console.anthropic.com/)

### 1. GCP project and Gmail OAuth2

1. Go to [Google Cloud Console](https://console.cloud.google.com), create or select a project.
2. Enable **Gmail API** and **Cloud Pub/Sub API** under APIs & Services.
3. Under **Credentials**, create an **OAuth 2.0 Client ID** (type: Web application).
   - Add `http://localhost:3000/oauth/callback` as an authorized redirect URI.
4. Note the **Client ID** and **Client Secret**.
5. Obtain a refresh token using the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/):
   - Click the gear icon, check "Use your own OAuth credentials", and enter your Client ID/Secret.
   - In Step 1, authorize the scopes: `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.labels`.
   - In Step 2, exchange the authorization code for a **refresh token**.

### 2. GCP Pub/Sub

```bash
export GCP_PROJECT_ID=your-project-id
./scripts/setup-pubsub.sh
```

This creates the `email-notifications` topic, grants `gmail-api-push@system.gserviceaccount.com` publish rights, and creates the `email-worker-sub` pull subscription with a 60s ack deadline and 7-day message retention.

### 3. PostgreSQL

Create a database on [Neon](https://neon.tech) (free tier) or any Postgres provider. The service applies the schema automatically on startup from `schema.sql`.

### 4. Environment variables

Create a `.env` file (gitignored) or export directly:

```bash
# Required
DATABASE_URL=postgresql://user:pass@host/db
GOOGLE_CLIENT_ID=your-oauth-client-id
GOOGLE_CLIENT_SECRET=your-oauth-client-secret
GOOGLE_REFRESH_TOKEN=your-refresh-token
GCP_PROJECT_ID=your-gcp-project-id
ANTHROPIC_API_KEY=sk-ant-...

# Optional (shown with defaults)
PUBSUB_TOPIC=email-notifications
PUBSUB_SUBSCRIPTION=email-worker-sub
LLM_MODEL=claude-sonnet-4-20250514
LLM_MAX_CONCURRENT=5
QUARANTINE_LABEL_NAME=PHISH_QUARANTINE
MAX_BODY_LENGTH=2000
PORT=8080
```

### 5. Run locally

```bash
npm install
npm run check   # typecheck + lint + test
npm run dev     # starts with hot reload via tsx
```

The service will connect to Postgres, apply the schema, set up the Gmail watch, catch up on any missed messages, and begin pulling from Pub/Sub.

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
  GOOGLE_REFRESH_TOKEN="..." \
  GCP_PROJECT_ID="..." \
  ANTHROPIC_API_KEY="..."

# Deploy
fly deploy
```

The included `fly.toml` configures:
- Region: `sjc`
- Shared CPU, 512MB RAM
- `auto_stop_machines = false` so the service stays alive for Pub/Sub pull
- `min_machines_running = 1`

After deploy, verify at:
```
https://email-classifier.fly.dev/health
https://email-classifier.fly.dev/health/classifications
```

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
