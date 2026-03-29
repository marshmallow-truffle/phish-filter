import { describe, it, expect, vi } from "vitest";
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
