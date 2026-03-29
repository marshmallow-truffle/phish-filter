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
}

export interface HealthStats {
  recent_count: number;
  phish_count: number;
  spam_count: number;
  benign_count: number;
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
  close(): Promise<void>;
}
