import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDatabase } from "../src/db.pg.js";
import type { Database, LogStore } from "../src/db.port.js";

function mockPool() {
  return {
    query: vi.fn(),
    end: vi.fn(),
  };
}

describe("PgDatabase", () => {
  let db: Database & LogStore;
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
      messageId: "m1", sender: "a@b.com",
      subject: "Hi", label: "benign",
      confidence: 0.9, reason: "Normal", quarantined: false,
    });
    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO classifications");
    expect(params[0]).toBe("m1");
  });

  it("getRules returns enabled rules", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "r1", field: "sender_domain", pattern: "evil.com", label: "phish", confidence: 1.0, reason: "Known bad domain", enabled: true },
      ],
    });
    const rules = await db.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].field).toBe("sender_domain");
    expect(rules[0].pattern).toBe("evil.com");
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("WHERE enabled = TRUE");
  });

  it("getAccounts returns mapped rows with stats", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        email: "a@b.com", refresh_token: "tok", last_history_id: "50",
        total_processed: 10, phish_count: 2, spam_count: 3, benign_count: 5,
        last_processed_at: "2026-03-29T10:00:00Z",
      }],
    });
    const accounts = await db.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe("a@b.com");
    expect(accounts[0].totalProcessed).toBe(10);
    expect(accounts[0].phishCount).toBe(2);
  });

  it("upsertAccount calls INSERT ON CONFLICT", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await db.upsertAccount("a@b.com", "tok");
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO accounts");
    expect(sql).toContain("ON CONFLICT");
  });

  it("getAccountHistoryId returns string", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ last_history_id: "999" }] });
    expect(await db.getAccountHistoryId("a@b.com")).toBe("999");
  });

  it("removeAccount calls DELETE", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await db.removeAccount("a@b.com");
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("DELETE FROM accounts");
    expect(params[0]).toBe("a@b.com");
  });

  it("incrementAccountStats updates counts", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await db.incrementAccountStats("a@b.com", "phish");
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("total_processed = total_processed + 1");
    expect(sql).toContain("phish_count = phish_count + 1");
    expect(params[0]).toBe("a@b.com");
  });

  it("logEvent inserts with auto-incrementing seq", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await db.logEvent({ messageId: "msg1", stage: "classified", level: "info", message: "benign" });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO events");
    expect(sql).toContain("COALESCE");
    expect(params[0]).toBe("msg1");
  });

  it("getEvents returns rows ordered by seq", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { message_id: "msg1", seq: 1, stage: "fetched", level: "info", message: "ok", metadata: null, created_at: "2026-03-29T10:00:00Z", account_email: null },
      ],
    });
    const events = await db.getEvents("msg1");
    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe("fetched");
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("ORDER BY seq");
    expect(params[0]).toBe("msg1");
  });

  it("implements Database interface", () => {
    const d: Database = db;
    expect(d.runSchema).toBeTypeOf("function");
    expect(d.close).toBeTypeOf("function");
    expect(d.getAccounts).toBeTypeOf("function");
    expect(d.upsertAccount).toBeTypeOf("function");
    expect(d.removeAccount).toBeTypeOf("function");
    expect(d.getAccountHistoryId).toBeTypeOf("function");
    expect(d.updateAccountHistoryId).toBeTypeOf("function");
    expect(d.incrementAccountStats).toBeTypeOf("function");
    expect(d.getRules).toBeTypeOf("function");
    expect(d.saveRule).toBeTypeOf("function");
    expect(d.removeRule).toBeTypeOf("function");
  });

  it("implements LogStore interface", () => {
    const l: LogStore = db;
    expect(l.isProcessed).toBeTypeOf("function");
    expect(l.saveClassification).toBeTypeOf("function");
    expect(l.checkHealth).toBeTypeOf("function");
    expect(l.getRecentClassifications).toBeTypeOf("function");
    expect(l.logEvent).toBeTypeOf("function");
    expect(l.getEvents).toBeTypeOf("function");
    expect(l.getRecentEvents).toBeTypeOf("function");
  });
});
