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
