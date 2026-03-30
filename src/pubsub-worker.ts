import type { GmailClient } from "./gmail-client.js";
import type { ClassifierPort } from "./classifier.port.js";
import type { DatabasePort } from "./db.port.js";
import type { AccountManager } from "./account-manager.js";
import { DEFAULT_CLASSIFICATION } from "./models.js";

export class PubSubWorker {
  private accountManager: AccountManager;
  private classifier: ClassifierPort;
  private db: DatabasePort;
  private running = false;
  private onClassified?: (label: string) => void;

  constructor(
    accountManager: AccountManager,
    classifier: ClassifierPort,
    db: DatabasePort,
    onClassified?: (label: string) => void
  ) {
    this.accountManager = accountManager;
    this.classifier = classifier;
    this.db = db;
    this.onClassified = onClassified;
  }

  async processMessage(messageId: string, gmail: GmailClient, accountEmail?: string): Promise<boolean> {
    if (await this.db.isProcessed(messageId)) {
      return false;
    }

    const email = await gmail.getMessage(messageId);
    const result = await this.classifier.classify({
      sender: email.sender,
      subject: email.subject,
      body: email.body,
      headers: email.rawHeaders,
    }) ?? DEFAULT_CLASSIFICATION;

    let quarantined = false;
    if (result.label === "phish") {
      await gmail.quarantineMessage(messageId);
      quarantined = true;
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

    this.onClassified?.(result.label);
    console.log(
      `Classified ${messageId}: ${result.label} (${Math.round(result.confidence * 100)}%) — ${result.reason}`
    );
    return true;
  }

  async processNotification(data: Buffer): Promise<void> {
    const payload = JSON.parse(data.toString());
    const { emailAddress, historyId } = payload;
    if (!historyId || !emailAddress) {
      console.warn("Pub/Sub message missing historyId or emailAddress:", payload);
      return;
    }

    const gmail = this.accountManager.get(emailAddress);
    if (!gmail) {
      console.warn(`No registered account for ${emailAddress}, ignoring`);
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
