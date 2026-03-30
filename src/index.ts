import { Hono } from "hono";
import type { DatabasePort } from "./db.port.js";
import { ServiceHealth } from "./health.js";

// Exported for testability — endpoints only depend on DatabasePort + health
export function createApp(db: DatabasePort, health: ServiceHealth, extraRoutes?: Hono) {
  const app = new Hono();

  if (extraRoutes) {
    app.route("/", extraRoutes);
  }

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
            failed_count: dbHealth.failed_count,
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
  const { config } = await import("./config.js");
  const { serve } = await import("@hono/node-server");
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const { LlmClassifier } = await import("./llm-classifier.js");
  const { RuleBasedClassifier } = await import("./rule-classifier.js");
  const { ClassifierPipeline } = await import("./classifier-pipeline.js");
  const { PgDatabase } = await import("./db.pg.js");
  const { PubSubWorker } = await import("./pubsub-worker.js");
  const { AccountManager } = await import("./account-manager.js");
  const { createOAuthRoutes } = await import("./oauth-routes.js");

  const db = new PgDatabase();
  const health = new ServiceHealth();

  // 1. Apply schema
  await db.runSchema();
  console.log("Database connected and schema applied");

  // 2. Set up classifier pipeline: rules first, LLM fallback
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const llmClassifier = new LlmClassifier(anthropic, config.LLM_MAX_CONCURRENT, config.LLM_MODEL);
  const ruleClassifier = new RuleBasedClassifier(db);
  const classifier = new ClassifierPipeline([ruleClassifier, llmClassifier]);

  // 3. Set up account manager
  const gmailConfig = {
    gcpProjectId: config.GCP_PROJECT_ID,
    pubsubTopic: config.PUBSUB_TOPIC,
    quarantineLabelName: config.QUARANTINE_LABEL_NAME,
    spamLabelName: config.SPAM_LABEL_NAME,
  };
  const oauthConfig = {
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
  };
  const accountManager = new AccountManager(db, gmailConfig, oauthConfig);

  // 4. Load all accounts from DB
  await accountManager.loadAll();
  console.log(`Loaded ${accountManager.emails().length} accounts from DB`);

  // 5. If env-var refresh token set, register it as an account
  if (config.GOOGLE_REFRESH_TOKEN && !accountManager.has(config.GOOGLE_REFRESH_TOKEN)) {
    try {
      // Discover email by creating a temporary Gmail client
      const { CredentialManager } = await import("./credentials.js");
      const { google } = await import("googleapis");
      const cred = new CredentialManager({
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        refreshToken: config.GOOGLE_REFRESH_TOKEN,
      });
      const gmailService = google.gmail({ version: "v1", auth: cred.getAuth() });
      const profile = await gmailService.users.getProfile({ userId: "me" });
      const email = profile.data.emailAddress!;

      if (!accountManager.has(email)) {
        await db.upsertAccount(email, config.GOOGLE_REFRESH_TOKEN);
        await accountManager.register(email, config.GOOGLE_REFRESH_TOKEN);
        console.log(`Registered env-var account: ${email}`);
      }
    } catch (err) {
      console.error("Failed to register env-var account:", err);
      health.recordError(`Env account registration failed: ${err}`);
    }
  }

  // 6. Create event logger and worker
  const { EventLogger } = await import("./event-logger.js");
  const logger = new EventLogger(db);
  const worker = new PubSubWorker(accountManager, classifier, db, logger, {
    quarantineLabelName: config.QUARANTINE_LABEL_NAME,
    spamLabelName: config.SPAM_LABEL_NAME,
  }, (label) => health.record(label));

  // 7. Trigger catch-up for all registered accounts
  for (const email of accountManager.emails()) {
    worker.triggerCatchUp(email);
  }

  // 8. Start Pub/Sub pull
  worker.pullLoop(config.PUBSUB_SUBSCRIPTION, config.GCP_PROJECT_ID).catch((err) => {
    console.error("Pub/Sub pull loop crashed:", err);
    health.recordError(`Pull loop crashed: ${err}`);
  });

  // 8. Start HTTP server with OAuth routes
  const oauthRoutes = createOAuthRoutes(accountManager, db, health, {
    ...oauthConfig,
    redirectUri: config.OAUTH_REDIRECT_URI,
  });
  const app = createApp(db, health, oauthRoutes);
  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`Server running on port ${info.port} — steady state`);
    console.log(`Add Gmail accounts at http://localhost:${info.port}/`);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, shutting down...");
    worker.stop();
    await db.close();
    process.exit(0);
  });
}

const isDirectRun =
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
