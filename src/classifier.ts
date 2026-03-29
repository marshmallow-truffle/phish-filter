// src/classifier.ts
import { z } from "zod";
import type { ClassificationResult } from "./models.js";

const ClassificationResultSchema = z.object({
  label: z.enum(["phish", "spam", "benign"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const SYSTEM_PROMPT = `You are an email security classifier. Analyze the email and respond with ONLY a JSON object:
{"label": "phish" | "spam" | "benign", "confidence": 0.0-1.0, "reason": "one sentence"}

Signals to consider:
- Sender domain vs display name mismatch
- Urgency language ("act now", "account suspended")
- Suspicious URLs (misspelled domains, URL shorteners)
- Requests for credentials or payment
- SPF/DKIM/DMARC results from headers (if available)`;

export class Classifier {
  private client: any;
  private concurrencyLimit: number;
  private model: string;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(client: any, maxConcurrent: number = 5, model: string = "claude-sonnet-4-20250514") {
    this.client = client;
    this.concurrencyLimit = maxConcurrent;
    this.model = model;
  }

  async classify(input: {
    sender: string;
    subject: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<ClassificationResult> {
    // Semaphore: wait for a slot
    if (this.active >= this.concurrencyLimit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await this.classifyInner(input);
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private async classifyInner(input: {
    sender: string;
    subject: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<ClassificationResult> {
    let userMessage =
      `From: ${input.sender}\n` +
      `Subject: ${input.subject}\n` +
      `Headers: ${JSON.stringify(input.headers)}\n` +
      `Body:\n${input.body}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });

      const text = response.content[0].text ?? "";
      try {
        const parsed = JSON.parse(text.trim());
        return ClassificationResultSchema.parse(parsed);
      } catch (err) {
        if (attempt === 0) {
          console.warn(`Malformed LLM response (attempt 1): ${text.slice(0, 200)}`);
          userMessage += "\n\nYour previous response was not valid JSON. Respond ONLY with a valid JSON object.";
          continue;
        }
        console.error(`LLM classification failed after retry: ${err}`);
        return { label: "benign", confidence: 0, reason: `Classification failed: ${err}` };
      }
    }
    return { label: "benign", confidence: 0, reason: "Classification failed: unknown" };
  }
}
