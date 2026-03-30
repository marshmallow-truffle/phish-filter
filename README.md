# Phish Filter

Real-time email classification service. Watches Gmail inboxes via GCP Pub/Sub, classifies emails using configurable rules and an LLM, and labels phishing/spam in Gmail automatically. Handles multiple accounts, survives crashes without losing emails, and provides a web dashboard for monitoring.

```
Gmail → GCP Pub/Sub → Worker (Hono) → Classify (rules + LLM) → Label in Gmail + Store in Postgres
```

### Reliability: every email gets processed

Each Gmail account has a **serial processing queue**. Pub/Sub notifications are enqueued and processed one at a time — read cursor, fetch messages via `history.list`, classify, update cursor. No concurrent access to the cursor means no race conditions.

The cursor advances to the **highest historyId of successfully processed messages**, not the notification's. On crash, unprocessed messages are replayed from the last saved cursor. On startup, the same loop runs catch-up — no separate code path.

**Dedup** (`message_id` primary key, `ON CONFLICT DO NOTHING`) ensures re-fetched messages are silently skipped. **Pub/Sub ack** happens only after the full batch succeeds; failures trigger nack and redelivery.

### Database isolation

Database access is split into two interfaces (`src/db.port.ts`): **Database** (accounts, rules, history cursors — small, consistent) and **LogStore** (classifications, events — append-heavy, truncatable). `PgDatabase` implements both. Swapping storage backends requires only a new implementation of the relevant interface.

## Observability

### Web dashboard

Visit `http://localhost:8080/` — the dashboard shows:

- **Health status** — uptime, DB connectivity, total processed
- **Monitored accounts** — per-account stats (processed, phish, spam, benign, failed) with add/remove
- **Classification rules** — view, add, and remove rules for the rule-based classifier
- **Recent classifications** — sender, subject, label, confidence, with link to event trace
- **Event lookup** — search by message ID to see the full processing trace
- **Recent events** — last 50 events across all accounts

### JSON API endpoints

```
GET /health                          → service status + classification counts
GET /health/classifications?limit=20 → recent classification records
GET /events?message_id=...           → event trace for a specific email
```

### Send a test email

Forward or send any email to a monitored Gmail account, or use the test script:

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

PUBSUB_TOPIC=email-notifications
PUBSUB_SUBSCRIPTION=email-worker-sub
LLM_MODEL=claude-haiku-4-5-20251001
LLM_MAX_CONCURRENT=5
QUARANTINE_LABEL_NAME=PHISH_QUARANTINE
SPAM_LABEL_NAME=SPAM_DETECTED
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

## Development

```bash
npm run check       # typecheck + lint + test (run before pushing)
npm run build       # compile TypeScript
npm test            # run tests
npm run lint        # ESLint
npm run dev         # dev server with hot reload
```
