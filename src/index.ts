import { Hono } from "hono";
import type { DatabasePort } from "./db.port.js";
import { ServiceHealth } from "./health.js";

// Exported for testability — endpoints only depend on DatabasePort + health
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

// Production startup — only runs when executed directly
async function main() {
  // Lazy import config to avoid throwing in test environments
  const { config } = await import("./config.js");
  const { serve } = await import("@hono/node-server");
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const { CredentialManager } = await import("./credentials.js");
  const { GmailClient } = await import("./gmail-client.js");
  const { LlmClassifier } = await import("./llm-classifier.js");
  const { RuleBasedClassifier } = await import("./rule-classifier.js");
  const { ClassifierPipeline } = await import("./classifier-pipeline.js");
  const { PgDatabase } = await import("./db.pg.js");
  const { PubSubWorker } = await import("./pubsub-worker.js");

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
  const gmail = new GmailClient(gmailService, {
    gcpProjectId: config.GCP_PROJECT_ID,
    pubsubTopic: config.PUBSUB_TOPIC,
    quarantineLabelName: config.QUARANTINE_LABEL_NAME,
  });

  // 3. Set up custom quarantine label (non-destructive, not TRASH)
  await gmail.setupQuarantineLabel();

  // 4. Set up classifier pipeline: rules first, LLM fallback
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const llmClassifier = new LlmClassifier(anthropic, config.LLM_MAX_CONCURRENT, config.LLM_MODEL);
  const ruleClassifier = new RuleBasedClassifier(db);
  const classifier = new ClassifierPipeline([ruleClassifier, llmClassifier]);

  // 5. Create worker (with health callback to track in-memory stats)
  const worker = new PubSubWorker(gmail, classifier, db, (label) => health.record(label));

  // 6. Start Pub/Sub pull BEFORE catch-up (buffer messages during replay).
  //    Dedup via ON CONFLICT handles any overlap between catch-up and live messages.
  worker.pullLoop(config.PUBSUB_SUBSCRIPTION).catch((err) => {
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
