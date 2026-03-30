import type { LogStore } from "./db.port.js";

export class EventLogger {
  private db: LogStore;

  constructor(db: LogStore) {
    this.db = db;
  }

  async log(event: {
    messageId: string;
    accountEmail?: string;
    stage: string;
    level: "info" | "warn" | "error";
    message: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    const prefix = event.level === "error" ? "ERROR" : event.level === "warn" ? "WARN" : "INFO";
    console.log(`[${prefix}] [${event.stage}] ${event.messageId}: ${event.message}`);
    try {
      await this.db.logEvent(event);
    } catch (err) {
      console.error("Failed to persist event:", err);
    }
  }
}
