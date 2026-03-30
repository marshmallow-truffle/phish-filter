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
}

export class PubSubWorker {
  private accountManager: AccountManager;
  private classifier: ClassifierPort;
  private db: DatabasePort;
  private logger: EventLogger;
  private quarantineLabelName: string;
  private spamLabelName: string;
  private running = false;
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
    this.quarantineLabelName = labelConfig.quarantineLabelName;
    this.spamLabelName = labelConfig.spamLabelName;
    this.onClassified = onClassified;
  }

  async processMessage(messageId: string, gmail: GmailClient, accountEmail?: string): Promise<boolean> {
    if (await this.db.isProcessed(messageId)) {
      await this.logger.log({ messageId, accountEmail, stage: "message_skipped", level: "info", message: "Already processed (dedup)" });
      return false;
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
      ) ?? DEFAULT_CLASSIFICATION;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.logger.log({ messageId, accountEmail, stage: "classification_error", level: "error", message: `Classification failed after 3 retries: ${errMsg}`, metadata: { error: errMsg } });
      result = DEFAULT_CLASSIFICATION;
    }

    const level = result.confidence === 0 && result.reason.startsWith("Classification failed") ? "warn" : "info";
    await this.logger.log({ messageId, accountEmail, stage: "classified", level, message: `${result.label} (${Math.round(result.confidence * 100)}%) — ${result.reason}`, metadata: { label: result.label, confidence: result.confidence, reason: result.reason } });

    const labelMap: Record<string, string> = {
      phish: this.quarantineLabelName,
      spam: this.spamLabelName,
    };
    const labelName = labelMap[result.label];
    let quarantined = false;
    if (labelName) {
      await gmail.labelMessage(messageId, labelName);
      quarantined = true;
      await this.logger.log({ messageId, accountEmail, stage: "labeled", level: "info", message: `Labeled as ${labelName} and removed from inbox` });
    }

    await this.db.saveClassification({
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

    if (accountEmail) {
      await this.db.incrementAccountStats(accountEmail, result.label);
    }
    this.onClassified?.(result.label);
    return true;
  }

  async processNotification(data: Buffer): Promise<void> {
    const payload = JSON.parse(data.toString());
    const { emailAddress, historyId } = payload;
    if (!historyId || !emailAddress) {
      await this.logger.log({ messageId: `notification-${Date.now()}`, stage: "notification_invalid", level: "warn", message: "Missing historyId or emailAddress", metadata: payload });
      return;
    }

    await this.logger.log({ messageId: `history-${historyId}`, accountEmail: emailAddress, stage: "notification_received", level: "info", message: `historyId=${historyId}` });

    const gmail = this.accountManager.get(emailAddress);
    if (!gmail) {
      await this.logger.log({ messageId: `history-${historyId}`, accountEmail: emailAddress, stage: "account_not_found", level: "warn", message: `No registered account for ${emailAddress}` });
      return;
    }

    const lastHistoryId = await this.db.getAccountHistoryId(emailAddress);
    const messageIds = await gmail.getHistory(lastHistoryId);

    for (const msgId of messageIds) {
      await this.processMessage(msgId, gmail, emailAddress);
    }

    await this.db.updateAccountHistoryId(emailAddress, String(historyId));
  }

  async pullLoop(subscriptionName: string, projectId?: string): Promise<void> {
    const { PubSub } = await import("@google-cloud/pubsub");
    const pubsub = new PubSub({ projectId });
    const subscription = pubsub.subscription(subscriptionName);
    this.running = true;
    console.log(`Starting Pub/Sub pull loop on ${subscriptionName}`);

    subscription.on("message", async (message: any) => {
      try {
        await this.processNotification(message.data);
        message.ack();
      } catch (err) {
        console.error("Failed to process notification:", err);
        message.nack();
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
