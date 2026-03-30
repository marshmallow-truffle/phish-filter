import { describe, it, expect, vi } from "vitest";
import { RuleBasedClassifier } from "../src/rule-classifier.js";
import type { ClassificationRule } from "../src/models.js";

function makeRule(overrides: Partial<ClassificationRule> = {}): ClassificationRule {
  return {
    id: "r1",
    field: "sender_domain",
    pattern: "evil.com",
    label: "phish",
    confidence: 1.0,
    reason: "Known bad domain",
    enabled: true,
    ...overrides,
  };
}

function mockDb(rules: ClassificationRule[] = []) {
  return {
    getRules: vi.fn().mockResolvedValue(rules),
  } as any;
}

describe("RuleBasedClassifier", () => {
  const input = {
    sender: "attacker@evil.com",
    subject: "Urgent: Verify your account",
    body: "Click http://evil.com/steal to verify",
    headers: { From: "attacker@evil.com" },
  };

  it("matches sender domain (exact, case-insensitive)", async () => {
    const db = mockDb([makeRule({ pattern: "Evil.COM" })]);
    const classifier = new RuleBasedClassifier(db, 0);

    const result = await classifier.classify(input);
    expect(result).not.toBeNull();
    expect(result!.label).toBe("phish");
    expect(result!.confidence).toBe(1.0);
    expect(result!.reason).toContain("Rule match");
  });

  it("matches subject via regex (case-insensitive)", async () => {
    const db = mockDb([makeRule({ field: "subject", pattern: "urgent.*verify" })]);
    const classifier = new RuleBasedClassifier(db, 0);

    const result = await classifier.classify(input);
    expect(result).not.toBeNull();
    expect(result!.label).toBe("phish");
  });

  it("matches body via regex (case-insensitive)", async () => {
    const db = mockDb([makeRule({ field: "body", pattern: "click.*steal" })]);
    const classifier = new RuleBasedClassifier(db, 0);

    const result = await classifier.classify(input);
    expect(result).not.toBeNull();
    expect(result!.label).toBe("phish");
  });

  it("returns null when no rules match", async () => {
    const db = mockDb([makeRule({ pattern: "safe.com" })]);
    const classifier = new RuleBasedClassifier(db, 0);

    const result = await classifier.classify(input);
    expect(result).toBeNull();
  });

  it("handles invalid regex gracefully", async () => {
    const db = mockDb([makeRule({ field: "subject", pattern: "[invalid(" })]);
    const classifier = new RuleBasedClassifier(db, 0);

    const result = await classifier.classify(input);
    expect(result).toBeNull(); // invalid regex is skipped, no match
  });

  it("caches rules and refreshes after TTL", async () => {
    const rules = [makeRule()];
    const db = mockDb(rules);
    const classifier = new RuleBasedClassifier(db, 100); // 100ms TTL

    // First call fetches rules
    await classifier.classify(input);
    expect(db.getRules).toHaveBeenCalledTimes(1);

    // Second call uses cache
    await classifier.classify(input);
    expect(db.getRules).toHaveBeenCalledTimes(1);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 150));

    // Third call refreshes
    await classifier.classify(input);
    expect(db.getRules).toHaveBeenCalledTimes(2);
  });

  it("returns first matching rule", async () => {
    const db = mockDb([
      makeRule({ pattern: "evil.com", label: "phish", reason: "Domain blocklist" }),
      makeRule({ id: "r2", field: "subject", pattern: "urgent", label: "spam", reason: "Spam pattern" }),
    ]);
    const classifier = new RuleBasedClassifier(db, 0);

    const result = await classifier.classify(input);
    expect(result!.label).toBe("phish"); // first rule wins
    expect(result!.reason).toContain("Domain blocklist");
  });
});
