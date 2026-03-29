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
