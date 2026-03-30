import pg from "pg";
import { readFileSync } from "fs";
import type {
  Account,
  DatabasePort,
  SaveClassificationInput,
  HealthStats,
  ClassificationRow,
} from "./db.port.js";
import type { ClassificationRule } from "./models.js";

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
          label, confidence, reason, quarantined, raw_headers, account_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
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
        record.accountEmail ?? null,
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
      [historyId]
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

  async getRules(): Promise<ClassificationRule[]> {
    const res = await this.pool.query(
      "SELECT id, field, pattern, label, confidence, reason, enabled FROM classification_rules WHERE enabled = TRUE"
    );
    return res.rows;
  }

  async getAccounts(): Promise<Account[]> {
    const res = await this.pool.query(
      "SELECT email, refresh_token, last_history_id, watch_expiration FROM accounts"
    );
    return res.rows.map((r: any) => ({
      email: r.email,
      refreshToken: r.refresh_token,
      lastHistoryId: r.last_history_id,
      watchExpiration: r.watch_expiration,
    }));
  }

  async getAccount(email: string): Promise<Account | null> {
    const res = await this.pool.query(
      "SELECT email, refresh_token, last_history_id, watch_expiration FROM accounts WHERE email = $1",
      [email]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      email: r.email,
      refreshToken: r.refresh_token,
      lastHistoryId: r.last_history_id,
      watchExpiration: r.watch_expiration,
    };
  }

  async upsertAccount(email: string, refreshToken: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO accounts (email, refresh_token)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET refresh_token = EXCLUDED.refresh_token`,
      [email, refreshToken]
    );
  }

  async getAccountHistoryId(email: string): Promise<string> {
    const res = await this.pool.query(
      "SELECT last_history_id FROM accounts WHERE email = $1",
      [email]
    );
    return res.rows[0]?.last_history_id ?? "0";
  }

  async updateAccountHistoryId(email: string, historyId: string): Promise<void> {
    await this.pool.query(
      "UPDATE accounts SET last_history_id = $1 WHERE email = $2",
      [historyId, email]
    );
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
