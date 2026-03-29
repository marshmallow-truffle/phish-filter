# Live Email Classification Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-time email classification service that watches a Gmail inbox via Pub/Sub, classifies messages as phish/spam/benign using an LLM, and quarantines phishing emails — with fault tolerance across restarts.

**Architecture:** Gmail push notifications flow through GCP Pub/Sub (pull subscription) to a Hono HTTP server. The worker fetches full message content via Gmail API, classifies via LLM, persists results to Postgres, and quarantines phishing emails to a custom Gmail label. On startup, the service replays missed messages using Gmail's history API, guaranteeing zero data loss across downtime.

**Tech Stack:** TypeScript, Node.js, Hono, googleapis, @anthropic-ai/sdk, pg (node-postgres), @google-cloud/pubsub, Zod, Vitest, PostgreSQL (Neon), Fly.io

---

## System Overview

```
┌─────────────┐    watch()     ┌──────────────┐
│  Gmail API  │ ──────────────▶│ GCP Pub/Sub  │
└─────────────┘                │   (topic)    │
                               └──────┬───────┘
                                      │ pull subscription
                                      │ (worker pulls, NOT push)
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
             │ quarantine)│   │ semaphore: │   └───────────────┘
             └────────────┘   │ max 5      │
                              └────────────┘
```

**Key:** The worker uses a **pull subscription** — it actively pulls messages from Pub/Sub. There is no webhook/push endpoint. This simplifies deployment (no public URL needed for Pub/Sub) and gives us backpressure control.

---

## File Structure

```
email-classifier/
├── README.md
├── Dockerfile
├── package.json
├── tsconfig.json
├── fly.toml
├── schema.sql
├── src/
│   ├── index.ts              ← Hono app, startup sequence, health endpoints
│   ├── config.ts             ← Settings from env vars (Zod validated)
│   ├── credentials.ts        ← OAuth2 token management + auto-refresh
│   ├── gmail-client.ts       ← watch(), history.list(), messages.get(), modify(), MIME parsing
│   ├── pubsub-worker.ts      ← Pull subscription loop, ACK/NACK logic
│   ├── classifier.ts         ← LLM classification call with semaphore rate limit
│   ├── db.port.ts            ← DatabasePort interface (all consumers depend on this)
│   ├── db.pg.ts              ← PostgreSQL implementation of DatabasePort
│   ├── models.ts             ← Zod schemas + TypeScript types
│   ├── retry.ts              ← Retry/backoff utility
│   └── health.ts             ← Health stats tracking
├── tests/
│   ├── retry.test.ts
│   ├── credentials.test.ts
│   ├── gmail-client.test.ts
│   ├── classifier.test.ts
│   ├── db.test.ts            ← Tests PgDatabase against DatabasePort interface
│   ├── pubsub-worker.test.ts
│   ├── health.test.ts
│   ├── index.test.ts
│   └── pipeline.test.ts
└── scripts/
    ├── setup-pubsub.sh       ← GCP topic/subscription creation
    └── send-test-email.ts    ← Send yourself a fake phishing email
```

---

## Database Schema

```sql
CREATE TABLE classifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      TEXT UNIQUE NOT NULL,
    history_id      TEXT,
    sender          TEXT,
    subject         TEXT,
    body_sent_to_llm TEXT,                      -- actual truncated text sent to classifier
    label           TEXT NOT NULL CHECK (label IN ('phish', 'spam', 'benign')),
    confidence      REAL,
    reason          TEXT,
    quarantined     BOOLEAN DEFAULT FALSE,
    raw_headers     JSONB,
    processed_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_classifications_label ON classifications(label);
CREATE INDEX idx_classifications_processed_at ON classifications(processed_at);

CREATE TABLE system_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO system_state (key, value) VALUES ('last_history_id', '0')
    ON CONFLICT (key) DO NOTHING;
```

**Note:** `body_sent_to_llm` stores the actual text sent to the classifier (extracted and truncated from MIME), not Gmail's `snippet`. This is far more useful for debugging classification decisions.

---

## Message Processing Pipeline

```
Pub/Sub notification (historyId=N, as a string)
  │
  ▼
history.list(startHistoryId=last_stored, historyTypes=["messageAdded"])
  │  NOTE: historyId is a string representing a large integer.
  │  Always pass as-is to the API — never cast to number.
  ▼
For each new message_id:
  ├── Check DB: already processed? → skip, ACK
  ├── messages.get(message_id, format="full") → parse MIME tree
  │     └── Extract text/plain or text/html, strip HTML, truncate to 2000 chars
  ├── Acquire LLM semaphore (max 5 concurrent) → classify → {label, confidence, reason}
  ├── If label == "phish" → messages.modify(addLabelIds=["PHISH_QUARANTINE"], removeLabelIds=["INBOX"])
  │     NOTE: Uses custom label, NOT TRASH. Non-destructive — interviewer can see
  │     quarantined messages in Gmail UI. Messages won't auto-delete after 30 days.
  ├── INSERT INTO classifications (...) ON CONFLICT (message_id) DO NOTHING
  └── Update last_stored_history_id in DB (pass as string, no casting)
  │
  ▼
ACK the Pub/Sub message
```

**Critical:** Always call `history.list()` rather than trying to derive the message from the Pub/Sub payload. Multiple notifications can arrive for the same change, and a single notification can correspond to multiple new messages.

**Critical:** Never ACK a Pub/Sub message until the full pipeline (fetch → classify → store) succeeds. If anything fails after retries, NACK the message and Pub/Sub will redeliver it later.

---

## History Catch-Up on Restart

```
┌──────────────────────────────────────────────────────┐
│                   STARTUP SEQUENCE                   │
│                                                      │
│  1. Connect to DB                                    │
│  2. Query: SELECT value FROM system_state            │
│        WHERE key = 'last_history_id'                 │
│  3. Start Pub/Sub pull (buffering messages)           │
│  4. Call: history.list(startHistoryId=last_history_id,│
│           historyTypes=["messageAdded"])              │
│  5. For each message_id in history:                  │
│     - Skip if already in classifications table       │
│     - Otherwise, run full pipeline                   │
│  6. Update last_history_id to current                │
│  7. Call watch() to (re)establish Pub/Sub push       │
│  8. Begin processing buffered + new Pub/Sub messages │
│                                                      │
│  Now in steady state ─────────────────────────────▶  │
└──────────────────────────────────────────────────────┘
```

**Race condition mitigation:** The Pub/Sub pull starts *before* catch-up (step 3) so no messages are missed during replay. Messages arriving during catch-up may overlap with catch-up processing — the `ON CONFLICT (message_id) DO NOTHING` dedup in the DB handles this cleanly. This is the correct approach: idempotent writes make the race harmless.

**Edge case:** Gmail history records expire after ~30 days. Irrelevant for a 24h demo but worth a one-line comment in code.

---

## Retry & Backoff Strategy

```
Retry policy:
  max_retries: 3
  base_delay: 1s
  backoff: exponential (1s, 2s, 4s)
  jitter: ±500ms

Gmail API:
  429 (rate limit) → back off and retry
  5xx             → retry
  401             → refresh OAuth token via credentials.ts, retry once
  403 (quota)     → log, skip message, do NOT ACK (will redeliver)

LLM API:
  429 / 5xx       → retry with backoff
  Malformed JSON  → retry once with "respond ONLY with valid JSON"
  Still fails     → classify as "benign", log the failure
  Rate limiting   → semaphore caps concurrent calls to 5

DB:
  Connection error → retry
  Unique violation → expected (dedup), treat as success
```

---

## Implementation Tasks

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/config.ts`
- Create: `src/models.ts`
- Create: `schema.sql`
- Create: `Dockerfile`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "email-classifier",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@google-cloud/pubsub": "^4.9.0",
    "@hono/node-server": "^1.13.0",
    "googleapis": "^144.0.0",
    "hono": "^4.6.0",
    "html-to-text": "^9.0.5",
    "pg": "^8.13.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create src/config.ts**

```typescript
// src/config.ts
import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string(),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  GOOGLE_REFRESH_TOKEN: z.string(),
  GCP_PROJECT_ID: z.string(),
  PUBSUB_TOPIC: z.string().default("email-notifications"),
  PUBSUB_SUBSCRIPTION: z.string().default("email-worker-sub"),
  ANTHROPIC_API_KEY: z.string(),
  LLM_MODEL: z.string().default("claude-sonnet-4-20250514"),
  LLM_MAX_CONCURRENT: z.coerce.number().default(5),
  QUARANTINE_LABEL_NAME: z.string().default("PHISH_QUARANTINE"),
  MAX_BODY_LENGTH: z.coerce.number().default(2000),
  PORT: z.coerce.number().default(8080),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config = ConfigSchema.parse(process.env);
```

- [ ] **Step 4: Create src/models.ts**

```typescript
// src/models.ts
import { z } from "zod";

export const ClassificationResultSchema = z.object({
  label: z.enum(["phish", "spam", "benign"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export interface EmailMessage {
  messageId: string;
  historyId: string | null;
  sender: string;
  subject: string;
  body: string; // extracted and truncated text sent to LLM
  rawHeaders: Record<string, string>;
}

export interface ClassificationRecord {
  messageId: string;
  historyId: string | null;
  sender: string;
  subject: string;
  bodySentToLlm: string;
  label: string;
  confidence: number;
  reason: string;
  quarantined: boolean;
  processedAt: Date;
}
```

- [ ] **Step 5: Create schema.sql**

```sql
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
```

- [ ] **Step 6: Create Dockerfile**

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/dist dist/
COPY schema.sql ./
CMD ["node", "dist/index.js"]
```

- [ ] **Step 7: Run npm install**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/config.ts src/models.ts schema.sql Dockerfile
git commit -m "feat: project scaffold with config, models, schema, and Dockerfile"
```

---

### Task 2: Retry Utility

**Files:**
- Create: `src/retry.ts`
- Create: `tests/retry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/retry.test.ts
import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/retry.js";

describe("withRetry", () => {
  it("succeeds on third attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("success");

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after max retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelay: 10 })
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("succeeds immediately without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/retry.test.ts`
Expected: FAIL — cannot find module `../src/retry.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/retry.ts

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number; // milliseconds
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, baseDelay } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxRetries) {
        throw lastError;
      }
      const delay =
        baseDelay * 2 ** (attempt - 1) +
        (Math.random() - 0.5) * baseDelay;
      await new Promise((r) => setTimeout(r, Math.max(1, delay)));
    }
  }
  throw lastError!; // unreachable
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/retry.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/retry.ts tests/retry.test.ts
git commit -m "feat: async retry utility with exponential backoff and jitter"
```

---

### Task 3: OAuth2 Credential Management

**Files:**
- Create: `src/credentials.ts`
- Create: `tests/credentials.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/credentials.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CredentialManager } from "../src/credentials.js";

// Mock googleapis
vi.mock("googleapis", () => {
  const mockGmail = {
    users: {
      messages: { get: vi.fn(), modify: vi.fn(), list: vi.fn() },
      labels: { list: vi.fn(), create: vi.fn() },
      history: { list: vi.fn() },
      watch: vi.fn(),
    },
  };
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({
          setCredentials: vi.fn(),
          getAccessToken: vi.fn().mockResolvedValue({ token: "test-token" }),
          on: vi.fn(),
          credentials: { refresh_token: "test-refresh-token" },
        })),
      },
      gmail: vi.fn().mockReturnValue(mockGmail),
    },
  };
});

describe("CredentialManager", () => {
  let manager: CredentialManager;

  beforeEach(() => {
    manager = new CredentialManager({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
    });
  });

  it("creates an OAuth2 client", () => {
    const auth = manager.getAuth();
    expect(auth).toBeDefined();
    expect(auth.setCredentials).toHaveBeenCalledWith({
      refresh_token: "test-refresh-token",
    });
  });

  it("returns the same auth instance on repeated calls", () => {
    const auth1 = manager.getAuth();
    const auth2 = manager.getAuth();
    expect(auth1).toBe(auth2);
  });

  it("creates a Gmail service", () => {
    const gmail = manager.getGmailService();
    expect(gmail).toBeDefined();
    expect(gmail.users).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/credentials.test.ts`
Expected: FAIL — cannot find module `../src/credentials.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/credentials.ts
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface CredentialOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class CredentialManager {
  private auth: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private readonly options: CredentialOptions;

  constructor(options: CredentialOptions) {
    this.options = options;
  }

  getAuth(): OAuth2Client {
    if (!this.auth) {
      this.auth = new google.auth.OAuth2(
        this.options.clientId,
        this.options.clientSecret
      );
      this.auth.setCredentials({
        refresh_token: this.options.refreshToken,
      });
      // googleapis auto-refreshes tokens when they expire
      // using the refresh_token. No manual refresh needed.
    }
    return this.auth;
  }

  getGmailService(): gmail_v1.Gmail {
    if (!this.gmail) {
      this.gmail = google.gmail({ version: "v1", auth: this.getAuth() });
    }
    return this.gmail;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/credentials.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/credentials.ts tests/credentials.test.ts
git commit -m "feat: OAuth2 credential manager with automatic token refresh"
```

---

### Task 4: Gmail Client with MIME Parsing

**Files:**
- Create: `src/gmail-client.ts`
- Create: `tests/gmail-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/gmail-client.test.ts
import { describe, it, expect } from "vitest";
import {
  extractBodyFromPayload,
  extractHeaders,
  parseEmailMessage,
} from "../src/gmail-client.js";

function encode(text: string): string {
  return Buffer.from(text).toString("base64url");
}

describe("extractBodyFromPayload", () => {
  it("extracts plain text from single part", () => {
    const payload = {
      mimeType: "text/plain",
      body: { data: encode("Hello world") },
    };
    expect(extractBodyFromPayload(payload)).toBe("Hello world");
  });

  it("prefers plain text in multipart", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: encode("Plain text") } },
        { mimeType: "text/html", body: { data: encode("<b>HTML</b>") } },
      ],
    };
    expect(extractBodyFromPayload(payload)).toBe("Plain text");
  });

  it("falls back to stripped HTML", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: { data: encode("<p>Hello <b>world</b></p>") },
        },
      ],
    };
    const body = extractBodyFromPayload(payload);
    expect(body).toContain("Hello");
    expect(body).toContain("world");
    expect(body).not.toContain("<p>");
    expect(body).not.toContain("<b>");
  });

  it("truncates long body", () => {
    const longText = "A".repeat(5000);
    const payload = {
      mimeType: "text/plain",
      body: { data: encode(longText) },
    };
    expect(extractBodyFromPayload(payload, 2000).length).toBe(2000);
  });

  it("returns empty string for empty body", () => {
    const payload = { mimeType: "text/plain", body: {} };
    expect(extractBodyFromPayload(payload)).toBe("");
  });
});

describe("extractHeaders", () => {
  it("converts header array to record", () => {
    const headers = [
      { name: "From", value: "test@example.com" },
      { name: "Subject", value: "Test Subject" },
    ];
    const result = extractHeaders(headers);
    expect(result.From).toBe("test@example.com");
    expect(result.Subject).toBe("Test Subject");
  });
});

describe("parseEmailMessage", () => {
  it("parses a full Gmail message", () => {
    const raw = {
      id: "msg123",
      historyId: "456",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "phisher@evil.com" },
          { name: "Subject", value: "Urgent" },
        ],
        body: { data: encode("Click this link") },
      },
    };
    const email = parseEmailMessage(raw);
    expect(email.messageId).toBe("msg123");
    expect(email.historyId).toBe("456");
    expect(email.sender).toBe("phisher@evil.com");
    expect(email.subject).toBe("Urgent");
    expect(email.body).toBe("Click this link");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/gmail-client.test.ts`
Expected: FAIL — cannot find module `../src/gmail-client.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/gmail-client.ts
import { convert } from "html-to-text";
import type { gmail_v1 } from "googleapis";
import type { EmailMessage } from "./models.js";
import { config } from "./config.js";

interface GmailPayload {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayload[];
  headers?: Array<{ name: string; value: string }>;
}

export function extractBodyFromPayload(
  payload: GmailPayload,
  maxLength?: number
): string {
  const limit = maxLength ?? config.MAX_BODY_LENGTH;
  const mimeType = payload.mimeType ?? "";

  // Single part
  if (!mimeType.startsWith("multipart/")) {
    const data = payload.body?.data;
    if (!data) return "";
    let text = Buffer.from(data, "base64url").toString("utf-8");
    if (mimeType.includes("html")) {
      text = convert(text, { wordwrap: false });
    }
    return text.slice(0, limit);
  }

  // Multipart: walk parts, prefer text/plain
  const parts = payload.parts ?? [];
  let plainText: string | null = null;
  let htmlText: string | null = null;

  for (const part of parts) {
    const partMime = part.mimeType ?? "";
    if (partMime.startsWith("multipart/")) {
      const nested = extractBodyFromPayload(part, limit);
      if (nested) return nested;
      continue;
    }
    const data = part.body?.data;
    if (!data) continue;
    const decoded = Buffer.from(data, "base64url").toString("utf-8");
    if (partMime === "text/plain" && plainText === null) {
      plainText = decoded;
    } else if (partMime === "text/html" && htmlText === null) {
      htmlText = decoded;
    }
  }

  if (plainText) return plainText.slice(0, limit);
  if (htmlText) return convert(htmlText, { wordwrap: false }).slice(0, limit);
  return "";
}

export function extractHeaders(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers) {
    result[h.name] = h.value;
  }
  return result;
}

export function parseEmailMessage(
  raw: { id: string; historyId?: string; payload?: GmailPayload },
  maxBodyLength?: number
): EmailMessage {
  const payload = raw.payload ?? {};
  const headers = extractHeaders(payload.headers ?? []);
  const body = extractBodyFromPayload(payload, maxBodyLength);

  return {
    messageId: raw.id,
    historyId: raw.historyId ?? null, // always a string, never cast to number
    sender: headers.From ?? "",
    subject: headers.Subject ?? "",
    body,
    rawHeaders: headers,
  };
}

export class GmailClient {
  private service: gmail_v1.Gmail;
  private quarantineLabelId: string | null = null;

  constructor(service: gmail_v1.Gmail) {
    this.service = service;
  }

  async setupQuarantineLabel(): Promise<string> {
    const res = await this.service.users.labels.list({ userId: "me" });
    const existing = res.data.labels?.find(
      (l) => l.name === config.QUARANTINE_LABEL_NAME
    );
    if (existing?.id) {
      this.quarantineLabelId = existing.id;
      return existing.id;
    }

    const created = await this.service.users.labels.create({
      userId: "me",
      requestBody: {
        name: config.QUARANTINE_LABEL_NAME,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    this.quarantineLabelId = created.data.id!;
    console.log(
      `Created quarantine label: ${config.QUARANTINE_LABEL_NAME} (ID: ${created.data.id})`
    );
    return created.data.id!;
  }

  async watch(): Promise<{ historyId: string; expiration: string }> {
    const res = await this.service.users.watch({
      userId: "me",
      requestBody: {
        topicName: `projects/${config.GCP_PROJECT_ID}/topics/${config.PUBSUB_TOPIC}`,
        labelIds: ["INBOX"],
      },
    });
    const result = {
      historyId: String(res.data.historyId),
      expiration: String(res.data.expiration),
    };
    console.log(
      `Gmail watch established, historyId=${result.historyId}, expiration=${result.expiration}`
    );
    return result;
  }

  async getHistory(startHistoryId: string): Promise<string[]> {
    const messageIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.service.users.history.list({
        userId: "me",
        startHistoryId, // pass as string, never cast to number
        historyTypes: ["messageAdded"],
        pageToken,
      });
      for (const record of res.data.history ?? []) {
        for (const msg of record.messagesAdded ?? []) {
          if (msg.message?.id) {
            messageIds.push(msg.message.id);
          }
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return messageIds;
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const res = await this.service.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    return parseEmailMessage(
      res.data as { id: string; historyId?: string; payload?: GmailPayload }
    );
  }

  async quarantineMessage(messageId: string): Promise<void> {
    if (!this.quarantineLabelId) {
      throw new Error(
        "Quarantine label not set up. Call setupQuarantineLabel() first."
      );
    }
    await this.service.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: [this.quarantineLabelId],
        removeLabelIds: ["INBOX"],
      },
    });
    console.log(`Quarantined message ${messageId}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/gmail-client.test.ts`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add src/gmail-client.ts tests/gmail-client.test.ts
git commit -m "feat: Gmail client with MIME body parsing and custom quarantine label"
```

---

### Task 5: LLM Classifier with Rate Limiting

**Files:**
- Create: `src/classifier.ts`
- Create: `tests/classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/classifier.test.ts
import { describe, it, expect, vi } from "vitest";
import { Classifier } from "../src/classifier.js";

function mockAnthropicClient(responseText: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ text: responseText }],
      }),
    },
  } as any;
}

describe("Classifier", () => {
  it("classifies a phishing email", async () => {
    const client = mockAnthropicClient(
      JSON.stringify({
        label: "phish",
        confidence: 0.95,
        reason: "Sender domain mismatch",
      })
    );
    const classifier = new Classifier(client, 5);

    const result = await classifier.classify({
      sender: "security@paypal-verify.ru",
      subject: "Urgent: Verify Your Account",
      body: "Click here: http://paypal-secure.ru/verify",
      headers: { From: "security@paypal-verify.ru" },
    });

    expect(result.label).toBe("phish");
    expect(result.confidence).toBe(0.95);
  });

  it("retries on malformed JSON then succeeds", async () => {
    const client = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ content: [{ text: "not json" }] })
          .mockResolvedValueOnce({
            content: [
              {
                text: JSON.stringify({
                  label: "benign",
                  confidence: 0.8,
                  reason: "Normal",
                }),
              },
            ],
          }),
      },
    } as any;
    const classifier = new Classifier(client, 5);

    const result = await classifier.classify({
      sender: "test@example.com",
      subject: "Hello",
      body: "Hi",
      headers: {},
    });

    expect(result.label).toBe("benign");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("defaults to benign on total failure", async () => {
    const client = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValue({ content: [{ text: "garbage" }] }),
      },
    } as any;
    const classifier = new Classifier(client, 5);

    const result = await classifier.classify({
      sender: "test@example.com",
      subject: "Hello",
      body: "Hi",
      headers: {},
    });

    expect(result.label).toBe("benign");
    expect(result.confidence).toBe(0);
    expect(result.reason).toMatch(/Classification failed/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/classifier.test.ts`
Expected: FAIL — cannot find module `../src/classifier.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/classifier.ts
import type Anthropic from "@anthropic-ai/sdk";
import { ClassificationResultSchema, type ClassificationResult } from "./models.js";
import { config } from "./config.js";

const SYSTEM_PROMPT = `You are an email security classifier. Analyze the email and respond with ONLY a JSON object:
{"label": "phish" | "spam" | "benign", "confidence": 0.0-1.0, "reason": "one sentence"}

Signals to consider:
- Sender domain vs display name mismatch
- Urgency language ("act now", "account suspended")
- Suspicious URLs (misspelled domains, URL shorteners)
- Requests for credentials or payment
- SPF/DKIM/DMARC results from headers (if available)`;

export class Classifier {
  private client: Anthropic;
  private concurrencyLimit: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(client: Anthropic, maxConcurrent?: number) {
    this.client = client;
    this.concurrencyLimit = maxConcurrent ?? config.LLM_MAX_CONCURRENT;
  }

  async classify(input: {
    sender: string;
    subject: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<ClassificationResult> {
    // Semaphore: wait for a slot
    if (this.active >= this.concurrencyLimit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await this.classifyInner(input);
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private async classifyInner(input: {
    sender: string;
    subject: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<ClassificationResult> {
    let userMessage =
      `From: ${input.sender}\n` +
      `Subject: ${input.subject}\n` +
      `Headers: ${JSON.stringify(input.headers)}\n` +
      `Body:\n${input.body}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.client.messages.create({
        model: config.LLM_MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      try {
        const parsed = JSON.parse(text.trim());
        return ClassificationResultSchema.parse(parsed);
      } catch (err) {
        if (attempt === 0) {
          console.warn(`Malformed LLM response (attempt 1): ${text.slice(0, 200)}`);
          userMessage +=
            "\n\nYour previous response was not valid JSON. Respond ONLY with a valid JSON object.";
          continue;
        }
        console.error(`LLM classification failed after retry: ${err}`);
        return { label: "benign", confidence: 0, reason: `Classification failed: ${err}` };
      }
    }
    // Unreachable
    return { label: "benign", confidence: 0, reason: "Classification failed: unknown" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/classifier.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/classifier.ts tests/classifier.test.ts
git commit -m "feat: LLM classifier with semaphore rate limiting and malformed JSON retry"
```

---

### Task 6: Database Port Interface + PostgreSQL Implementation

**Files:**
- Create: `src/db.port.ts`
- Create: `src/db.pg.ts`
- Create: `tests/db.test.ts`

The database is accessed through a `DatabasePort` interface. All consumers (worker, health endpoints, startup) depend on the interface, never the concrete implementation. This makes it trivial to swap Postgres for SQLite, an in-memory store, or a different schema.

- [ ] **Step 1: Write the interface**

```typescript
// src/db.port.ts

export interface SaveClassificationInput {
  messageId: string;
  historyId: string | null;
  sender: string;
  subject: string;
  bodySentToLlm: string;
  label: string;
  confidence: number;
  reason: string;
  quarantined: boolean;
  rawHeaders: Record<string, string>;
}

export interface HealthStats {
  recent_count: number;
  phish_count: number;
  spam_count: number;
  benign_count: number;
  total_count: number;
}

export interface ClassificationRow {
  message_id: string;
  sender: string;
  subject: string;
  label: string;
  confidence: number;
  reason: string;
  quarantined: boolean;
  processed_at: string;
}

export interface DatabasePort {
  /** Apply schema migrations. */
  runSchema(schemaPath?: string): Promise<void>;

  /** Check if a message has already been classified (dedup). */
  isProcessed(messageId: string): Promise<boolean>;

  /** Persist a classification result. Returns true if inserted, false if duplicate. */
  saveClassification(record: SaveClassificationInput): Promise<boolean>;

  /** Get the last successfully processed Gmail history ID (always a string). */
  getLastHistoryId(): Promise<string>;

  /** Update the recovery cursor. historyId is always a string — never cast to number. */
  updateLastHistoryId(historyId: string): Promise<void>;

  /** Health check: query actual classification data, not just connectivity. */
  checkHealth(): Promise<HealthStats>;

  /** Return recent classifications for the /health/classifications endpoint. */
  getRecentClassifications(limit?: number): Promise<ClassificationRow[]>;

  /** Graceful shutdown. */
  close(): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests**

```typescript
// tests/db.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDatabase } from "../src/db.pg.js";
import type { DatabasePort } from "../src/db.port.js";

function mockPool() {
  return {
    query: vi.fn(),
    end: vi.fn(),
  };
}

describe("PgDatabase", () => {
  let db: DatabasePort;
  let pool: ReturnType<typeof mockPool>;

  beforeEach(() => {
    pool = mockPool();
    db = new PgDatabase(pool as any);
  });

  it("isProcessed returns false for new message", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await db.isProcessed("msg_new")).toBe(false);
  });

  it("isProcessed returns true for existing message", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ message_id: "msg1" }] });
    expect(await db.isProcessed("msg1")).toBe(true);
  });

  it("getLastHistoryId returns string value", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ value: "12345" }] });
    const result = await db.getLastHistoryId();
    expect(result).toBe("12345"); // string, not number
  });

  it("getLastHistoryId returns '0' when no row", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await db.getLastHistoryId()).toBe("0");
  });

  it("checkHealth returns classification counts", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        recent_count: 5, phish_count: 1,
        spam_count: 2, benign_count: 7, total_count: 10,
      }],
    });
    const health = await db.checkHealth();
    expect(health.recent_count).toBe(5);
    expect(health.phish_count).toBe(1);
  });

  it("saveClassification calls INSERT with correct params", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await db.saveClassification({
      messageId: "m1", historyId: "100", sender: "a@b.com",
      subject: "Hi", bodySentToLlm: "body", label: "benign",
      confidence: 0.9, reason: "Normal", quarantined: false,
      rawHeaders: { From: "a@b.com" },
    });
    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO classifications");
    expect(params[0]).toBe("m1");
  });

  it("implements DatabasePort interface", () => {
    // Type-level check: db satisfies DatabasePort
    const port: DatabasePort = db;
    expect(port.isProcessed).toBeTypeOf("function");
    expect(port.saveClassification).toBeTypeOf("function");
    expect(port.getLastHistoryId).toBeTypeOf("function");
    expect(port.updateLastHistoryId).toBeTypeOf("function");
    expect(port.checkHealth).toBeTypeOf("function");
    expect(port.getRecentClassifications).toBeTypeOf("function");
    expect(port.close).toBeTypeOf("function");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — cannot find module `../src/db.pg.js`

- [ ] **Step 4: Write the PostgreSQL implementation**

```typescript
// src/db.pg.ts
import pg from "pg";
import { readFileSync } from "fs";
import type {
  DatabasePort,
  SaveClassificationInput,
  HealthStats,
  ClassificationRow,
} from "./db.port.js";

export class PgDatabase implements DatabasePort {
  private pool: pg.Pool;

  constructor(pool?: pg.Pool) {
    this.pool =
      pool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async runSchema(schemaPath = "schema.sql"): Promise<void> {
    const sql = readFileSync(schemaPath, "utf-8");
    await this.pool.query(sql);
    console.log("Schema applied");
  }

  async isProcessed(messageId: string): Promise<boolean> {
    const res = await this.pool.query(
      "SELECT message_id FROM classifications WHERE message_id = $1",
      [messageId]
    );
    return res.rows.length > 0;
  }

  async saveClassification(record: SaveClassificationInput): Promise<boolean> {
    await this.pool.query(
      `INSERT INTO classifications
         (message_id, history_id, sender, subject, body_sent_to_llm,
          label, confidence, reason, quarantined, raw_headers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (message_id) DO NOTHING`,
      [
        record.messageId,
        record.historyId,
        record.sender,
        record.subject,
        record.bodySentToLlm,
        record.label,
        record.confidence,
        record.reason,
        record.quarantined,
        JSON.stringify(record.rawHeaders),
      ]
    );
    return true;
  }

  async getLastHistoryId(): Promise<string> {
    const res = await this.pool.query(
      "SELECT value FROM system_state WHERE key = 'last_history_id'"
    );
    return res.rows[0]?.value ?? "0";
  }

  async updateLastHistoryId(historyId: string): Promise<void> {
    await this.pool.query(
      "UPDATE system_state SET value = $1 WHERE key = 'last_history_id'",
      [historyId] // always a string, never cast to number
    );
  }

  async checkHealth(): Promise<HealthStats> {
    const res = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE processed_at > now() - interval '1 hour') AS recent_count,
         count(*) FILTER (WHERE label = 'phish') AS phish_count,
         count(*) FILTER (WHERE label = 'spam') AS spam_count,
         count(*) FILTER (WHERE label = 'benign') AS benign_count,
         count(*) AS total_count
       FROM classifications`
    );
    return res.rows[0];
  }

  async getRecentClassifications(limit = 20): Promise<ClassificationRow[]> {
    const res = await this.pool.query(
      `SELECT message_id, sender, subject, label, confidence, reason,
              quarantined, processed_at
       FROM classifications
       ORDER BY processed_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/db.test.ts`
Expected: 7 passed

- [ ] **Step 6: Commit**

```bash
git add src/db.port.ts src/db.pg.ts tests/db.test.ts
git commit -m "feat: DatabasePort interface + PostgreSQL implementation (swappable)"
```

---

### Task 7: Pub/Sub Worker

**Files:**
- Create: `src/pubsub-worker.ts`
- Create: `tests/pubsub-worker.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/pubsub-worker.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PubSubWorker } from "../src/pubsub-worker.js";
import { parseEmailMessage } from "../src/gmail-client.js";

function encode(text: string): string {
  return Buffer.from(text).toString("base64url");
}

function makeRawMessage(msgId: string) {
  return {
    id: msgId,
    historyId: "100",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "test@example.com" },
        { name: "Subject", value: "Test" },
      ],
      body: { data: encode("Test body") },
    },
  };
}

function makeMocks() {
  return {
    gmail: {
      getHistory: vi.fn().mockResolvedValue(["msg1"]),
      getMessage: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(parseEmailMessage(makeRawMessage(id)))
      ),
      quarantineMessage: vi.fn().mockResolvedValue(undefined),
      watch: vi.fn().mockResolvedValue({ historyId: "200", expiration: "9999" }),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue({
        label: "benign",
        confidence: 0.9,
        reason: "Normal email",
      }),
    },
    db: {
      isProcessed: vi.fn().mockResolvedValue(false),
      saveClassification: vi.fn().mockResolvedValue(true),
      getLastHistoryId: vi.fn().mockResolvedValue("50"),
      updateLastHistoryId: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("PubSubWorker", () => {
  let worker: PubSubWorker;
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();
    worker = new PubSubWorker(
      mocks.gmail as any,
      mocks.classifier as any,
      mocks.db as any
    );
  });

  it("processes a new message", async () => {
    const result = await worker.processMessage("msg1");
    expect(result).toBe(true);
    expect(mocks.gmail.getMessage).toHaveBeenCalledWith("msg1");
    expect(mocks.classifier.classify).toHaveBeenCalledOnce();
    expect(mocks.db.saveClassification).toHaveBeenCalledOnce();
  });

  it("skips already-processed message", async () => {
    mocks.db.isProcessed.mockResolvedValue(true);
    const result = await worker.processMessage("msg1");
    expect(result).toBe(false);
    expect(mocks.gmail.getMessage).not.toHaveBeenCalled();
  });

  it("quarantines phish messages", async () => {
    mocks.classifier.classify.mockResolvedValue({
      label: "phish",
      confidence: 0.95,
      reason: "Suspicious URL",
    });
    await worker.processMessage("msg1");
    expect(mocks.gmail.quarantineMessage).toHaveBeenCalledWith("msg1");
  });

  it("does not quarantine benign messages", async () => {
    await worker.processMessage("msg1");
    expect(mocks.gmail.quarantineMessage).not.toHaveBeenCalled();
  });

  it("processes a Pub/Sub notification", async () => {
    const data = JSON.stringify({
      emailAddress: "user@gmail.com",
      historyId: "100",
    });
    await worker.processNotification(Buffer.from(data));
    expect(mocks.db.getLastHistoryId).toHaveBeenCalledOnce();
    expect(mocks.gmail.getHistory).toHaveBeenCalledWith("50");
    expect(mocks.db.updateLastHistoryId).toHaveBeenCalledWith("100");
  });

  it("ignores notification without historyId", async () => {
    const data = JSON.stringify({ emailAddress: "user@gmail.com" });
    await worker.processNotification(Buffer.from(data));
    expect(mocks.gmail.getHistory).not.toHaveBeenCalled();
  });

  it("catches up on missed messages", async () => {
    mocks.gmail.getHistory.mockResolvedValue(["msg1", "msg2"]);
    const processed = await worker.catchUp();
    expect(processed).toBe(2);
    expect(mocks.db.saveClassification).toHaveBeenCalledTimes(2);
    expect(mocks.gmail.watch).toHaveBeenCalledOnce();
    expect(mocks.db.updateLastHistoryId).toHaveBeenCalledWith("200");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pubsub-worker.test.ts`
Expected: FAIL — cannot find module `../src/pubsub-worker.js`

- [ ] **Step 3: Write the implementation**

```typescript
// src/pubsub-worker.ts
import { PubSub } from "@google-cloud/pubsub";
import type { GmailClient } from "./gmail-client.js";
import type { Classifier } from "./classifier.js";
import type { DatabasePort } from "./db.port.js";
import { config } from "./config.js";

export class PubSubWorker {
  private gmail: GmailClient;
  private classifier: Classifier;
  private db: DatabasePort;
  private pubsub: PubSub;
  private running = false;

  constructor(gmail: GmailClient, classifier: Classifier, db: DatabasePort) {
    this.gmail = gmail;
    this.classifier = classifier;
    this.db = db;
    this.pubsub = new PubSub({ projectId: config.GCP_PROJECT_ID });
  }

  async processMessage(messageId: string): Promise<boolean> {
    if (await this.db.isProcessed(messageId)) {
      return false;
    }

    const email = await this.gmail.getMessage(messageId);
    const result = await this.classifier.classify({
      sender: email.sender,
      subject: email.subject,
      body: email.body,
      headers: email.rawHeaders,
    });

    let quarantined = false;
    if (result.label === "phish") {
      await this.gmail.quarantineMessage(messageId);
      quarantined = true;
    }

    await this.db.saveClassification({
      messageId: email.messageId,
      historyId: email.historyId,
      sender: email.sender,
      subject: email.subject,
      bodySentToLlm: email.body,
      label: result.label,
      confidence: result.confidence,
      reason: result.reason,
      quarantined,
      rawHeaders: email.rawHeaders,
    });

    console.log(
      `Classified ${messageId}: ${result.label} (${Math.round(result.confidence * 100)}%) — ${result.reason}`
    );
    return true;
  }

  async processNotification(data: Buffer): Promise<void> {
    const payload = JSON.parse(data.toString());
    const historyId: string | undefined = payload.historyId;
    if (!historyId) {
      console.warn("Pub/Sub message missing historyId:", payload);
      return;
    }

    const lastHistoryId = await this.db.getLastHistoryId();
    const messageIds = await this.gmail.getHistory(lastHistoryId);

    for (const msgId of messageIds) {
      await this.processMessage(msgId);
    }

    await this.db.updateLastHistoryId(String(historyId));
  }

  async catchUp(): Promise<number> {
    const lastHistoryId = await this.db.getLastHistoryId();
    console.log(`Catching up from history ID: ${lastHistoryId}`);

    const messageIds = await this.gmail.getHistory(lastHistoryId);
    let processed = 0;
    for (const msgId of messageIds) {
      if (await this.processMessage(msgId)) {
        processed++;
      }
    }

    if (messageIds.length > 0) {
      const watchResult = await this.gmail.watch();
      await this.db.updateLastHistoryId(watchResult.historyId);
    }

    console.log(`Catch-up complete: ${processed} messages processed`);
    return processed;
  }

  async pullLoop(): Promise<void> {
    this.running = true;
    const subscription = this.pubsub.subscription(config.PUBSUB_SUBSCRIPTION);
    console.log(`Starting Pub/Sub pull loop on ${config.PUBSUB_SUBSCRIPTION}`);

    subscription.on("message", async (message) => {
      try {
        await this.processNotification(message.data);
        message.ack();
      } catch (err) {
        console.error("Failed to process notification:", err);
        message.nack(); // Pub/Sub will redeliver
      }
    });

    subscription.on("error", (err) => {
      console.error("Pub/Sub subscription error:", err);
    });

    // Keep alive until stopped
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          subscription.close();
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
  }

  stop(): void {
    this.running = false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pubsub-worker.test.ts`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add src/pubsub-worker.ts tests/pubsub-worker.test.ts
git commit -m "feat: Pub/Sub pull worker with notification processing and catch-up"
```

---

### Task 8: Health Stats Tracker

**Files:**
- Create: `src/health.ts`
- Create: `tests/health.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/health.test.ts
import { describe, it, expect } from "vitest";
import { ServiceHealth } from "../src/health.js";

describe("ServiceHealth", () => {
  it("starts with zero state", () => {
    const health = new ServiceHealth();
    expect(health.totalProcessed).toBe(0);
    expect(health.counts).toEqual({ phish: 0, spam: 0, benign: 0 });
    expect(health.lastProcessedAt).toBeNull();
  });

  it("records classifications", () => {
    const health = new ServiceHealth();
    health.record("phish");
    health.record("benign");
    health.record("phish");

    expect(health.totalProcessed).toBe(3);
    expect(health.counts.phish).toBe(2);
    expect(health.counts.benign).toBe(1);
    expect(health.lastProcessedAt).not.toBeNull();
  });

  it("records errors", () => {
    const health = new ServiceHealth();
    health.recordError("Connection refused");
    expect(health.lastError).toBe("Connection refused");
    expect(health.lastErrorAt).not.toBeNull();
  });

  it("calculates uptime", () => {
    const health = new ServiceHealth();
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/health.test.ts`
Expected: FAIL — cannot find module `../src/health.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/health.ts

export class ServiceHealth {
  readonly startedAt = new Date();
  lastProcessedAt: Date | null = null;
  totalProcessed = 0;
  counts: Record<string, number> = { phish: 0, spam: 0, benign: 0 };
  lastError: string | null = null;
  lastErrorAt: Date | null = null;

  get uptimeSeconds(): number {
    return (Date.now() - this.startedAt.getTime()) / 1000;
  }

  record(label: string): void {
    this.totalProcessed++;
    this.lastProcessedAt = new Date();
    if (label in this.counts) {
      this.counts[label]++;
    }
  }

  recordError(error: string): void {
    this.lastError = error;
    this.lastErrorAt = new Date();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/health.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/health.ts tests/health.test.ts
git commit -m "feat: in-memory service health tracker"
```

---

### Task 9: Hono App with Startup Sequence

**Files:**
- Create: `src/index.ts`
- Create: `tests/index.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing app
vi.mock("../src/config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost/test",
    GOOGLE_CLIENT_ID: "test-id",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_REFRESH_TOKEN: "test-token",
    GCP_PROJECT_ID: "test-project",
    PUBSUB_TOPIC: "email-notifications",
    PUBSUB_SUBSCRIPTION: "email-worker-sub",
    ANTHROPIC_API_KEY: "test-key",
    LLM_MODEL: "claude-sonnet-4-20250514",
    LLM_MAX_CONCURRENT: 5,
    QUARANTINE_LABEL_NAME: "PHISH_QUARANTINE",
    MAX_BODY_LENGTH: 2000,
    PORT: 8080,
  },
}));

import { createApp } from "../src/index.js";
import { ServiceHealth } from "../src/health.js";

function mockDb() {
  return {
    checkHealth: vi.fn().mockResolvedValue({
      recent_count: 5,
      phish_count: 1,
      spam_count: 2,
      benign_count: 7,
      total_count: 10,
    }),
    getRecentClassifications: vi.fn().mockResolvedValue([
      {
        message_id: "m1",
        sender: "a@b.com",
        subject: "Hi",
        label: "benign",
        confidence: 0.9,
        reason: "Normal",
        quarantined: false,
        processed_at: "2026-03-29T10:00:00Z",
      },
    ]),
  } as any;
}

describe("Health endpoints", () => {
  it("GET /health returns status", async () => {
    const health = new ServiceHealth();
    health.record("phish");
    health.record("benign");
    const db = mockDb();
    const app = createApp(db, health);

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.db_connected).toBe(true);
    expect(data.messages_processed_total).toBe(2);
    expect(data.classifications_summary.phish_count).toBe(1);
  });

  it("GET /health returns degraded when DB fails", async () => {
    const health = new ServiceHealth();
    const db = mockDb();
    db.checkHealth.mockRejectedValue(new Error("connection refused"));
    const app = createApp(db, health);

    const res = await app.request("/health");
    const data = await res.json();
    expect(data.status).toBe("degraded");
    expect(data.db_connected).toBe(false);
  });

  it("GET /health/classifications returns recent records", async () => {
    const db = mockDb();
    const app = createApp(db, new ServiceHealth());

    const res = await app.request("/health/classifications?limit=5");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].message_id).toBe("m1");
  });

  it("GET /health/classifications rejects limit > 100", async () => {
    const db = mockDb();
    const app = createApp(db, new ServiceHealth());

    const res = await app.request("/health/classifications?limit=200");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Write the implementation**

```typescript
// src/index.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import Anthropic from "@anthropic-ai/sdk";

import { config } from "./config.js";
import { CredentialManager } from "./credentials.js";
import { GmailClient } from "./gmail-client.js";
import { Classifier } from "./classifier.js";
import type { DatabasePort } from "./db.port.js";
import { PgDatabase } from "./db.pg.js";
import { ServiceHealth } from "./health.js";
import { PubSubWorker } from "./pubsub-worker.js";

// Exported for testability — endpoints only depend on DatabasePort, not PgDatabase
export function createApp(db: DatabasePort, health: ServiceHealth) {
  const app = new Hono();

  app.get("/health", async (c) => {
    let dbHealth: any = {};
    let dbConnected = false;
    try {
      dbHealth = await db.checkHealth();
      dbConnected = true;
    } catch {
      // DB unreachable
    }

    return c.json({
      status: dbConnected ? "healthy" : "degraded",
      uptime_seconds: Math.round(health.uptimeSeconds),
      last_message_processed_at: health.lastProcessedAt,
      messages_processed_total: health.totalProcessed,
      db_connected: dbConnected,
      db_recent_hour_count: dbHealth.recent_count ?? 0,
      classifications_summary: dbConnected
        ? {
            phish_count: dbHealth.phish_count,
            spam_count: dbHealth.spam_count,
            benign_count: dbHealth.benign_count,
          }
        : health.counts,
      last_error: health.lastError,
      last_error_at: health.lastErrorAt,
    });
  });

  app.get("/health/classifications", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 20;
    if (isNaN(limit) || limit < 1 || limit > 100) {
      return c.json({ error: "limit must be between 1 and 100" }, 400);
    }
    const rows = await db.getRecentClassifications(limit);
    return c.json(rows);
  });

  return app;
}

// Production startup — only runs when not imported as a module for tests
async function main() {
  const db = new PgDatabase();
  const health = new ServiceHealth();

  // 1. Apply schema
  await db.runSchema();
  console.log("Database connected and schema applied");

  // 2. Set up credentials and Gmail client
  const credManager = new CredentialManager({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    refreshToken: config.GOOGLE_REFRESH_TOKEN,
  });
  const gmailService = credManager.getGmailService();
  const gmail = new GmailClient(gmailService);

  // 3. Set up custom quarantine label (non-destructive, not TRASH)
  await gmail.setupQuarantineLabel();

  // 4. Set up LLM classifier with concurrency limit
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const classifier = new Classifier(anthropic);

  // 5. Create worker
  const worker = new PubSubWorker(gmail, classifier, db);

  // 6. Start Pub/Sub pull BEFORE catch-up (buffer messages during replay).
  //    Dedup via ON CONFLICT handles any overlap between catch-up and live messages.
  worker.pullLoop().catch((err) => {
    console.error("Pub/Sub pull loop crashed:", err);
    health.recordError(`Pull loop crashed: ${err}`);
  });

  // 7. Catch up on missed messages since last known history ID
  try {
    const processed = await worker.catchUp();
    console.log(`Startup catch-up: ${processed} messages processed`);
  } catch (err) {
    console.error("Catch-up failed (will rely on Pub/Sub redelivery):", err);
    health.recordError(`Catch-up failed: ${err}`);
  }

  // 8. Establish Gmail watch (renews Pub/Sub push notifications)
  try {
    const watchResult = await gmail.watch();
    console.log(`Gmail watch active until ${watchResult.expiration}`);
  } catch (err) {
    console.error("Failed to establish Gmail watch:", err);
    health.recordError(`Watch failed: ${err}`);
  }

  // 9. Start HTTP server
  const app = createApp(db, health);
  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`Server running on port ${info.port} — steady state`);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, shutting down...");
    worker.stop();
    await db.close();
    process.exit(0);
  });
}

// Only run main() when executed directly (not imported for tests)
const isDirectRun =
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/index.test.ts`
Expected: 4 passed

- [ ] **Step 4: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: Hono app with startup sequence, catch-up, and health endpoints"
```

---

### Task 10: GCP Setup Script and Test Email Sender

**Files:**
- Create: `scripts/setup-pubsub.sh`
- Create: `scripts/send-test-email.ts`

- [ ] **Step 1: Create setup script**

```bash
#!/usr/bin/env bash
# scripts/setup-pubsub.sh
# One-time setup for GCP Pub/Sub topic and subscription.
# Prerequisites: gcloud CLI authenticated, project set.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID env var}"
TOPIC="email-notifications"
SUBSCRIPTION="email-worker-sub"

echo "Creating Pub/Sub topic: $TOPIC"
gcloud pubsub topics create "$TOPIC" --project="$PROJECT_ID" 2>/dev/null || echo "Topic already exists"

echo "Granting Gmail publish rights"
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
    --role="roles/pubsub.publisher"

echo "Creating pull subscription: $SUBSCRIPTION"
gcloud pubsub subscriptions create "$SUBSCRIPTION" \
    --project="$PROJECT_ID" \
    --topic="$TOPIC" \
    --ack-deadline=60 \
    --message-retention-duration=7d \
    2>/dev/null || echo "Subscription already exists"

echo "Done. Topic: $TOPIC, Subscription: $SUBSCRIPTION"
```

- [ ] **Step 2: Create test email script**

```typescript
// scripts/send-test-email.ts
// Usage: npx tsx scripts/send-test-email.ts --to user@gmail.com --smtp-user you@gmail.com --smtp-pass app-password
import { createTransport } from "nodemailer";
import { parseArgs } from "util";

const TEMPLATES = {
  paypal: {
    subject: "Urgent: Your PayPal Account Has Been Limited",
    from: "security@paypa1-support.com",
    body: [
      "Dear Customer,",
      "",
      "We've detected unusual activity on your account. Your account access has been limited until you verify your identity.",
      "",
      "Click here to verify: http://paypa1-secure.com/verify?id=38291",
      "",
      "If you don't verify within 24 hours, your account will be permanently suspended.",
      "",
      "PayPal Security Team",
    ].join("\n"),
  },
  bank: {
    subject: "Action Required: Suspicious Login Detected",
    from: "alerts@chase-banking-secure.net",
    body: [
      "We detected a login from an unrecognized device.",
      "",
      "Location: Moscow, Russia",
      "Device: Unknown",
      "",
      "If this wasn't you, secure your account immediately: http://chase-secure-login.net/verify",
      "",
      "Chase Security",
    ].join("\n"),
  },
  benign: {
    subject: "Your PR was merged",
    from: "notifications@github.com",
    body: [
      "Your pull request #142 'Fix timeout handling' was merged into main.",
      "",
      "View the commit: https://github.com/yourorg/yourrepo/commit/abc123",
      "",
      "— GitHub",
    ].join("\n"),
  },
} as const;

const { values } = parseArgs({
  options: {
    to: { type: "string" },
    template: { type: "string", default: "paypal" },
    "smtp-host": { type: "string", default: "smtp.gmail.com" },
    "smtp-port": { type: "string", default: "587" },
    "smtp-user": { type: "string" },
    "smtp-pass": { type: "string" },
  },
});

const template = TEMPLATES[values.template as keyof typeof TEMPLATES] ?? TEMPLATES.paypal;

const transport = createTransport({
  host: values["smtp-host"],
  port: parseInt(values["smtp-port"]!, 10),
  secure: false,
  auth: { user: values["smtp-user"], pass: values["smtp-pass"] },
});

await transport.sendMail({
  from: template.from,
  to: values.to,
  subject: template.subject,
  text: template.body,
});

console.log(`Sent '${values.template}' test email to ${values.to}`);
```

- [ ] **Step 3: Commit**

```bash
chmod +x scripts/setup-pubsub.sh
git add scripts/setup-pubsub.sh scripts/send-test-email.ts
git commit -m "feat: GCP Pub/Sub setup script and test email sender"
```

---

### Task 11: Fly.io Deployment Config

**Files:**
- Create: `fly.toml`

- [ ] **Step 1: Create fly.toml**

```toml
app = "email-classifier"
primary_region = "sjc"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false   # must stay running for Pub/Sub pull
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
```

- [ ] **Step 2: Commit**

```bash
git add fly.toml
git commit -m "feat: Fly.io deployment config"
```

---

### Task 12: End-to-End Pipeline Test

**Files:**
- Create: `tests/pipeline.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/pipeline.test.ts
import { describe, it, expect, vi } from "vitest";
import { PubSubWorker } from "../src/pubsub-worker.js";
import { parseEmailMessage } from "../src/gmail-client.js";

function encode(text: string): string {
  return Buffer.from(text).toString("base64url");
}

function makeRawMessage(
  msgId: string,
  sender: string,
  subject: string,
  body: string
) {
  return {
    id: msgId,
    historyId: "100",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: sender },
        { name: "Subject", value: subject },
      ],
      body: { data: encode(body) },
    },
  };
}

function makeMocks(classifyResult: { label: string; confidence: number; reason: string }) {
  return {
    gmail: {
      getHistory: vi.fn().mockResolvedValue(["msg1", "msg2"]),
      getMessage: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(
          parseEmailMessage(
            makeRawMessage(id, "phisher@evil.ru", "Urgent!", "Click http://evil.ru/steal")
          )
        )
      ),
      quarantineMessage: vi.fn().mockResolvedValue(undefined),
      watch: vi.fn().mockResolvedValue({ historyId: "200", expiration: "9999" }),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue(classifyResult),
    },
    db: {
      isProcessed: vi.fn().mockResolvedValue(false),
      saveClassification: vi.fn().mockResolvedValue(true),
      getLastHistoryId: vi.fn().mockResolvedValue("50"),
      updateLastHistoryId: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("Pipeline end-to-end", () => {
  it("processes phish: fetch → classify → quarantine → store", async () => {
    const mocks = makeMocks({
      label: "phish",
      confidence: 0.95,
      reason: "Suspicious URL",
    });
    const worker = new PubSubWorker(
      mocks.gmail as any,
      mocks.classifier as any,
      mocks.db as any
    );

    const result = await worker.processMessage("msg1");
    expect(result).toBe(true);

    // Verify full pipeline executed
    expect(mocks.gmail.getMessage).toHaveBeenCalledWith("msg1");
    expect(mocks.classifier.classify).toHaveBeenCalledOnce();
    expect(mocks.gmail.quarantineMessage).toHaveBeenCalledWith("msg1");
    expect(mocks.db.saveClassification).toHaveBeenCalledOnce();

    // Verify body_sent_to_llm contains actual email content
    const saveCall = mocks.db.saveClassification.mock.calls[0][0];
    expect(saveCall.bodySentToLlm).toContain("evil.ru/steal");
    expect(saveCall.quarantined).toBe(true);
  });

  it("skips already-processed messages (dedup)", async () => {
    const mocks = makeMocks({
      label: "phish",
      confidence: 0.95,
      reason: "Suspicious",
    });
    mocks.db.isProcessed.mockResolvedValue(true);
    const worker = new PubSubWorker(
      mocks.gmail as any,
      mocks.classifier as any,
      mocks.db as any
    );

    const result = await worker.processMessage("msg1");
    expect(result).toBe(false);
    expect(mocks.gmail.getMessage).not.toHaveBeenCalled();
    expect(mocks.classifier.classify).not.toHaveBeenCalled();
  });

  it("benign emails are not quarantined", async () => {
    const mocks = makeMocks({
      label: "benign",
      confidence: 0.9,
      reason: "Normal email",
    });
    const worker = new PubSubWorker(
      mocks.gmail as any,
      mocks.classifier as any,
      mocks.db as any
    );

    await worker.processMessage("msg1");
    expect(mocks.gmail.quarantineMessage).not.toHaveBeenCalled();
    const saveCall = mocks.db.saveClassification.mock.calls[0][0];
    expect(saveCall.quarantined).toBe(false);
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests pass across all test files

- [ ] **Step 3: Commit**

```bash
git add tests/pipeline.test.ts
git commit -m "test: end-to-end pipeline tests with mocked Gmail and LLM"
```

---

## Summary of Fixes Applied (from plan review)

| # | Issue | Fix |
|---|-------|-----|
| 1 | OAuth token refresh underspecified | Added `src/credentials.ts` — `CredentialManager` class; googleapis auto-refreshes with refresh_token |
| 2 | Push/pull diagram inconsistency | Diagram annotated "pull subscription" with note explaining pull choice |
| 3 | historyId type confusion | Comments throughout: "always a string, never cast to number" |
| 4 | MIME body parsing missing | `extractBodyFromPayload()` walks MIME tree, prefers text/plain, strips HTML via html-to-text, truncates |
| 5 | Quarantine to TRASH is destructive | Uses custom `PHISH_QUARANTINE` label; `setupQuarantineLabel()` creates it |
| 6 | Race condition in history catch-up | Pub/Sub pull starts *before* catch-up (step 6 in startup); dedup handles overlap |
| 7 | `SELECT 1` health check insufficient | `checkHealth()` queries actual classifications table with recent-hour count |
| 8 | No LLM rate limiting | Manual semaphore in `Classifier` caps concurrent LLM calls |
| 9 | `snippet` column not useful for debugging | Replaced with `body_sent_to_llm` — stores actual text sent to classifier |

## Implementation Order

Follow tasks 1-12 sequentially. All tasks have tests. Tasks 10-11 are config/scripts.

**Start with Task 1 (scaffold + npm install), then Task 3 (credentials) — OAuth is the highest-risk item.**
