import type { ClassificationRule } from "./models.js";

export interface Account {
  email: string;
  refreshToken: string;
  lastHistoryId: string;
  totalProcessed: number;
  phishCount: number;
  spamCount: number;
  benignCount: number;
  failedCount: number;
  lastProcessedAt: Date | null;
}

export interface SaveClassificationInput {
  messageId: string;
  sender: string;
  subject: string;
  label: string;
  confidence: number;
  reason: string;
  quarantined: boolean;
}

export interface HealthStats {
  recent_count: number;
  phish_count: number;
  spam_count: number;
  benign_count: number;
  failed_count: number;
  total_count: number;
}

export interface ClassificationRow {
  message_id: string;
  sender: string;
  subject: string;
  label: string;
  confidence: number;
  reason: string;
  quarantined: boolean;
  processed_at: string;
}

export interface EventRow {
  message_id: string;
  seq: number;
  account_email: string | null;
  stage: string;
  level: string;
  message: string;
  metadata: any;
  created_at: string;
}

/** Small, consistent dataset: accounts, rules, history cursors. */
export interface Database {
  runSchema(schemaPath?: string): Promise<void>;
  close(): Promise<void>;
  getAccounts(): Promise<Account[]>;
  upsertAccount(email: string, refreshToken: string): Promise<void>;
  removeAccount(email: string): Promise<void>;
  getAccountHistoryId(email: string): Promise<string>;
  updateAccountHistoryId(email: string, historyId: string): Promise<void>;
  incrementAccountStats(email: string, label: string): Promise<void>;
  getRules(): Promise<ClassificationRule[]>;
  saveRule(rule: { field: string; pattern: string; label: string; confidence: number; reason: string }): Promise<void>;
  removeRule(id: string): Promise<void>;
}

/** Append-heavy, periodically truncated: classifications, events. */
export interface LogStore {
  isProcessed(messageId: string): Promise<boolean>;
  saveClassification(record: SaveClassificationInput): Promise<boolean>;
  checkHealth(): Promise<HealthStats>;
  getRecentClassifications(limit?: number): Promise<ClassificationRow[]>;
  logEvent(event: { messageId: string; accountEmail?: string; stage: string; level: string; message: string; metadata?: Record<string, any> }): Promise<void>;
  getEvents(messageId: string): Promise<EventRow[]>;
  getRecentEvents(limit?: number): Promise<EventRow[]>;
}
