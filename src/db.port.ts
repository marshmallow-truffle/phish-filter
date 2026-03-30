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
  historyId: string | null;
  sender: string;
  subject: string;
  bodySentToLlm: string;
  label: string;
  confidence: number;
  reason: string;
  quarantined: boolean;
  rawHeaders: Record<string, string>;
  accountEmail?: string;
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

export interface DatabasePort {
  runSchema(schemaPath?: string): Promise<void>;
  isProcessed(messageId: string): Promise<boolean>;
  saveClassification(record: SaveClassificationInput): Promise<boolean>;
  getLastHistoryId(): Promise<string>;
  updateLastHistoryId(historyId: string): Promise<void>;
  checkHealth(): Promise<HealthStats>;
  getRecentClassifications(limit?: number): Promise<ClassificationRow[]>;
  getRules(): Promise<ClassificationRule[]>;
  saveRule(rule: { field: string; pattern: string; label: string; confidence: number; reason: string }): Promise<void>;
  removeRule(id: string): Promise<void>;
  getAccounts(): Promise<Account[]>;
  getAccount(email: string): Promise<Account | null>;
  upsertAccount(email: string, refreshToken: string): Promise<void>;
  getAccountHistoryId(email: string): Promise<string>;
  updateAccountHistoryId(email: string, historyId: string): Promise<void>;
  removeAccount(email: string): Promise<void>;
  incrementAccountStats(email: string, label: string): Promise<void>;
  logEvent(event: { messageId: string; accountEmail?: string; stage: string; level: string; message: string; metadata?: Record<string, any> }): Promise<void>;
  getEvents(messageId: string): Promise<Array<{ message_id: string; seq: number; account_email: string | null; stage: string; level: string; message: string; metadata: any; created_at: string }>>;
  getRecentEvents(limit?: number): Promise<Array<{ message_id: string; seq: number; account_email: string | null; stage: string; level: string; message: string; metadata: any; created_at: string }>>;
  close(): Promise<void>;
}
