// src/models.ts
import { z } from "zod";

export const ClassificationResultSchema = z.object({
  label: z.enum(["phish", "spam", "benign", "failed"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export const DEFAULT_CLASSIFICATION: ClassificationResult = {
  label: "failed",
  confidence: 0,
  reason: "Classification failed after retries",
};

export interface EmailMessage {
  messageId: string;
  historyId: string | null;
  sender: string;
  subject: string;
  body: string; // extracted and truncated text sent to LLM
  rawHeaders: Record<string, string>;
}

export interface ClassificationRule {
  id: string;
  field: "sender_domain" | "subject" | "body";
  pattern: string;
  label: "phish" | "spam" | "benign" | "failed";
  confidence: number;
  reason: string;
  enabled: boolean;
}

export interface ClassificationRecord {
  messageId: string;
  historyId: string | null;
  sender: string;
  subject: string;
  bodySentToLlm: string;
  label: string;
  confidence: number;
  reason: string;
  quarantined: boolean;
  processedAt: Date;
}
