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
    expect(result).toBe("12345");
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
