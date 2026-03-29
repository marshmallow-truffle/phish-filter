// src/pubsub-worker.ts
import type { GmailClient } from "./gmail-client.js";
import type { Classifier } from "./classifier.js";
import type { DatabasePort } from "./db.port.js";

export class PubSubWorker {
  private gmail: GmailClient;
  private classifier: Classifier;
  private db: DatabasePort;
  private running = false;
  private onClassified?: (label: string) => void;

  constructor(
    gmail: GmailClient,
    classifier: Classifier,
    db: DatabasePort,
    onClassified?: (label: string) => void
  ) {
    this.gmail = gmail;
    this.classifier = classifier;
    this.db = db;
    this.onClassified = onClassified;
  }

  async processMessage(messageId: string): Promise<boolean> {
    if (await this.db.isProcessed(messageId)) {
      return false;
    }

    const email = await this.gmail.getMessage(messageId);
    const result = await this.classifier.classify({
      sender: email.sender,
      subject: email.subject,
      body: email.body,
      headers: email.rawHeaders,
    });

    let quarantined = false;
    if (result.label === "phish") {
      await this.gmail.quarantineMessage(messageId);
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
    });

    this.onClassified?.(result.label);
    console.log(
      `Classified ${messageId}: ${result.label} (${Math.round(result.confidence * 100)}%) — ${result.reason}`
    );
    return true;
  }

  async processNotification(data: Buffer): Promise<void> {
    const payload = JSON.parse(data.toString());
    const historyId: string | undefined = payload.historyId;
    if (!historyId) {
      console.warn("Pub/Sub message missing historyId:", payload);
      return;
    }

    const lastHistoryId = await this.db.getLastHistoryId();
    const messageIds = await this.gmail.getHistory(lastHistoryId);

    for (const msgId of messageIds) {
      await this.processMessage(msgId);
    }

    await this.db.updateLastHistoryId(String(historyId));
  }

  async catchUp(): Promise<number> {
    const lastHistoryId = await this.db.getLastHistoryId();
    console.log(`Catching up from history ID: ${lastHistoryId}`);

    const messageIds = await this.gmail.getHistory(lastHistoryId);
    let processed = 0;
    for (const msgId of messageIds) {
      if (await this.processMessage(msgId)) {
        processed++;
      }
    }

    if (messageIds.length > 0) {
      const watchResult = await this.gmail.watch();
      await this.db.updateLastHistoryId(watchResult.historyId);
    }

    console.log(`Catch-up complete: ${processed} messages processed`);
    return processed;
  }

  async pullLoop(subscriptionName: string): Promise<void> {
    // Lazy import to avoid loading @google-cloud/pubsub in tests
    const { PubSub } = await import("@google-cloud/pubsub");
    const pubsub = new PubSub();
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
