// src/config.ts
import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string(),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  GOOGLE_REFRESH_TOKEN: z.string(),
  GCP_PROJECT_ID: z.string(),
  PUBSUB_TOPIC: z.string().default("email-notifications"),
  PUBSUB_SUBSCRIPTION: z.string().default("email-worker-sub"),
  ANTHROPIC_API_KEY: z.string(),
  LLM_MODEL: z.string().default("claude-sonnet-4-20250514"),
  LLM_MAX_CONCURRENT: z.coerce.number().default(5),
  QUARANTINE_LABEL_NAME: z.string().default("PHISH_QUARANTINE"),
  MAX_BODY_LENGTH: z.coerce.number().default(2000),
  PORT: z.coerce.number().default(8080),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config = ConfigSchema.parse(process.env);
