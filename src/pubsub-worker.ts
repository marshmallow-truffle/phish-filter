import type { GmailClient } from "./gmail-client.js";
import type { ClassifierPort } from "./classifier.port.js";
import type { DatabasePort } from "./db.port.js";
import type { AccountManager } from "./account-manager.js";
import type { EventLogger } from "./event-logger.js";
import { DEFAULT_CLASSIFICATION } from "./models.js";
import { withRetry } from "./retry.js";

export interface PubSubWorkerConfig {
  quarantineLabelName: string;
  spamLabelName: string;
  maxMessagesPerBatch: number;
}

interface QueueItem {
  ack: () => void;
  nack: () => void;
}

export class NotificationQueue {
  private items: QueueItem[] = [];
  private waiter: ((item: QueueItem) => void) | null = null;

  push(item: QueueItem): void {
    if (this.waiter) {
      this.waiter(item);
      this.waiter = null;
    } else {
      this.items.push(item);
    }
  }

  take(): Promise<QueueItem> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

export class PubSubWorker {
  private accountManager: AccountManager;
  private classifier: ClassifierPort;
  private db: DatabasePort;
  private logger: EventLogger;
  private labelMap: Record<string, string>;
  private maxMessagesPerBatch: number;
  private running = true;
  private queues = new Map<string, NotificationQueue>();
  private onClassified?: (label: string) => void;

  constructor(
    accountManager: AccountManager,
    classifier: ClassifierPort,
    db: DatabasePort,
    logger: EventLogger,
    labelConfig: PubSubWorkerConfig,
    onClassified?: (label: string) => void
  ) {
    this.accountManager = accountManager;
    this.classifier = classifier;
    this.db = db;
    this.logger = logger;
    this.labelMap = {
      phish: labelConfig.quarantineLabelName,
      spam: labelConfig.spamLabelName,
    };
    this.maxMessagesPerBatch = labelConfig.maxMessagesPerBatch;
    this.onClassified = onClassified;
  }

  async processMessage(messageId: string, gmail: GmailClient, accountEmail: string): Promise<string | null> {
    if (await this.db.isProcessed(messageId)) {
      await this.logger.log({ messageId, accountEmail, stage: "message_skipped", level: "info", message: "Already processed (dedup)" });
      return null;
    }

    const email = await gmail.getMessage(messageId);
    await this.logger.log({ messageId, accountEmail, stage: "message_fetched", level: "info", message: `From: ${email.sender}, Subject: ${email.subject}` });

    let result;
    try {
      result = await withRetry(
        () => this.classifier.classify({
          sender: email.sender,
          subject: email.subject,
          body: email.body,
          headers: email.rawHeaders,
        }),
        { maxRetries: 3, baseDelay: 1000 }
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.logger.log({ messageId, accountEmail, stage: "classification_error", level: "error", message: `Classification failed after 3 retries: ${errMsg}`, metadata: { error: errMsg } });
      result = DEFAULT_CLASSIFICATION;
    }

    if (!result) result = DEFAULT_CLASSIFICATION;

    const level = result.confidence === 0 && result.reason.startsWith("Classification failed") ? "warn" : "info";
    await this.logger.log({ messageId, accountEmail, stage: "classified", level, message: `${result.label} (${Math.round(result.confidence * 100)}%) — ${result.reason}`, metadata: { label: result.label, confidence: result.confidence, reason: result.reason } });

    const labelName = this.labelMap[result.label];
    let quarantined = false;
    if (labelName) {
      await gmail.labelMessage(messageId, labelName);
      quarantined = true;
      await this.logger.log({ messageId, accountEmail, stage: "labeled", level: "info", message: `Labeled as ${labelName} and removed from inbox` });
    }

    const inserted = await this.db.saveClassification({
      messageId: email.messageId,
      historyId: email.historyId,
      sender: email.sender,
      subject: email.subject,
      bodySentToLlm: email.body,
      label: result.label,
      confidence: result.confidence,
      reason: result.reason,
      quarantined,
      rawHeaders: email.rawHeaders,
      accountEmail,
    });

    await this.logger.log({ messageId, accountEmail, stage: "saved", level: "info", message: "Classification persisted" });

    if (inserted) {
      await this.db.incrementAccountStats(accountEmail, result.label);
    }
    this.onClassified?.(result.label);
    return email.historyId;
  }

  enqueue(emailAddress: string, ack: () => void, nack: () => void): void {
    let queue = this.queues.get(emailAddress);
    if (!queue) {
      queue = new NotificationQueue();
      this.queues.set(emailAddress, queue);
      this.startAccountLoop(emailAddress, queue);
    }
    queue.push({ ack, nack });
  }

  triggerCatchUp(emailAddress: string): void {
    this.enqueue(emailAddress, () => {}, () => {});
  }

  private async startAccountLoop(emailAddress: string, queue: NotificationQueue): Promise<void> {
    while (this.running) {
      const notification = await queue.take();
      try {
        const gmail = this.accountManager.get(emailAddress);
        if (!gmail) {
          notification.ack();
          continue;
        }

        const cursor = await this.db.getAccountHistoryId(emailAddress);
        const messageIds = await gmail.getHistory(cursor, this.maxMessagesPerBatch);

        let maxHistoryId: string | null = null;
        for (const msgId of messageIds) {
          const historyId = await this.processMessage(msgId, gmail, emailAddress);
          if (historyId) {
            const num = Number(historyId);
            if (!maxHistoryId || num > Number(maxHistoryId)) {
              maxHistoryId = historyId;
            }
          }
        }

        if (maxHistoryId) {
          await this.db.updateAccountHistoryId(emailAddress, maxHistoryId);
        }
        notification.ack();
      } catch (err) {
        console.error(`Error processing notifications for ${emailAddress}:`, err);
        notification.nack();
      }
    }
  }

  async pullLoop(subscriptionName: string, projectId?: string): Promise<void> {
    const { PubSub } = await import("@google-cloud/pubsub");
    const pubsub = new PubSub({ projectId });
    const subscription = pubsub.subscription(subscriptionName);
    console.log(`Starting Pub/Sub pull loop on ${subscriptionName}`);

    subscription.on("message", (message: any) => {
      try {
        const payload = JSON.parse(message.data.toString());
        if (!payload.historyId || !payload.emailAddress) {
          message.ack();
          return;
        }
        this.enqueue(payload.emailAddress, () => message.ack(), () => message.nack());
      } catch {
        message.ack();
      }
    });

    subscription.on("error", (err: any) => {
      console.error("Pub/Sub subscription error:", err);
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          subscription.close();
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
  }

  stop(): void {
    this.running = false;
  }
}
