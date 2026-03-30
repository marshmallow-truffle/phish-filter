import { describe, it, expect, vi } from "vitest";
import { ClassifierPipeline } from "../src/classifier-pipeline.js";
import type { ClassifierPort } from "../src/classifier.port.js";

const input = {
  sender: "test@example.com",
  subject: "Hello",
  body: "Hi there",
  headers: { From: "test@example.com" },
};

function mockClassifier(result: any): ClassifierPort {
  return { classify: vi.fn().mockResolvedValue(result) };
}

describe("ClassifierPipeline", () => {
  it("returns first classifier's result when non-null", async () => {
    const first = mockClassifier({ label: "phish", confidence: 1.0, reason: "Rule match" });
    const second = mockClassifier({ label: "benign", confidence: 0.9, reason: "LLM says ok" });
    const pipeline = new ClassifierPipeline([first, second]);

    const result = await pipeline.classify(input);
    expect(result.label).toBe("phish");
    expect(first.classify).toHaveBeenCalledOnce();
    expect(second.classify).not.toHaveBeenCalled();
  });

  it("falls through to second when first returns null", async () => {
    const first = mockClassifier(null);
    const second = mockClassifier({ label: "spam", confidence: 0.8, reason: "LLM detected spam" });
    const pipeline = new ClassifierPipeline([first, second]);

    const result = await pipeline.classify(input);
    expect(result.label).toBe("spam");
    expect(first.classify).toHaveBeenCalledOnce();
    expect(second.classify).toHaveBeenCalledOnce();
  });

  it("returns benign fallback when all classifiers return null", async () => {
    const first = mockClassifier(null);
    const second = mockClassifier(null);
    const pipeline = new ClassifierPipeline([first, second]);

    const result = await pipeline.classify(input);
    expect(result.label).toBe("benign");
    expect(result.confidence).toBe(0);
    expect(result.reason).toContain("No classifier produced a result");
  });

  it("runs classifiers in order, not parallel", async () => {
    const order: number[] = [];
    const first: ClassifierPort = {
      classify: vi.fn().mockImplementation(async () => {
        order.push(1);
        return null;
      }),
    };
    const second: ClassifierPort = {
      classify: vi.fn().mockImplementation(async () => {
        order.push(2);
        return { label: "benign", confidence: 0.5, reason: "ok" };
      }),
    };
    const pipeline = new ClassifierPipeline([first, second]);

    await pipeline.classify(input);
    expect(order).toEqual([1, 2]);
  });
});
