// src/gmail-client.ts
import { convert } from "html-to-text";
import type { gmail_v1 } from "googleapis";
import type { EmailMessage } from "./models.js";

interface GmailPayload {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayload[];
  headers?: Array<{ name: string; value: string }>;
}

export function extractBodyFromPayload(
  payload: GmailPayload,
  maxLength: number = 2000
): string {
  const mimeType = payload.mimeType ?? "";

  // Single part
  if (!mimeType.startsWith("multipart/")) {
    const data = payload.body?.data;
    if (!data) return "";
    let text = Buffer.from(data, "base64url").toString("utf-8");
    if (mimeType.includes("html")) {
      text = convert(text, { wordwrap: false });
    }
    return text.slice(0, maxLength);
  }

  // Multipart: walk parts, prefer text/plain
  const parts = payload.parts ?? [];
  let plainText: string | null = null;
  let htmlText: string | null = null;

  for (const part of parts) {
    const partMime = part.mimeType ?? "";
    if (partMime.startsWith("multipart/")) {
      const nested = extractBodyFromPayload(part, maxLength);
      if (nested) return nested;
      continue;
    }
    const data = part.body?.data;
    if (!data) continue;
    const decoded = Buffer.from(data, "base64url").toString("utf-8");
    if (partMime === "text/plain" && plainText === null) {
      plainText = decoded;
    } else if (partMime === "text/html" && htmlText === null) {
      htmlText = decoded;
    }
  }

  if (plainText) return plainText.slice(0, maxLength);
  if (htmlText) return convert(htmlText, { wordwrap: false }).slice(0, maxLength);
  return "";
}

export function extractHeaders(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers) {
    result[h.name] = h.value;
  }
  return result;
}

export function parseEmailMessage(
  raw: { id: string; historyId?: string; payload?: GmailPayload },
  maxBodyLength?: number
): EmailMessage {
  const payload = raw.payload ?? {};
  const headers = extractHeaders(payload.headers ?? []);
  const body = extractBodyFromPayload(payload, maxBodyLength);

  return {
    messageId: raw.id,
    historyId: raw.historyId ?? null, // always a string, never cast to number
    sender: headers.From ?? "",
    subject: headers.Subject ?? "",
    body,
    rawHeaders: headers,
  };
}

export interface GmailClientConfig {
  gcpProjectId: string;
  pubsubTopic: string;
  quarantineLabelName: string;
}

export class GmailClient {
  private service: gmail_v1.Gmail;
  private config: GmailClientConfig;
  private quarantineLabelId: string | null = null;

  constructor(service: gmail_v1.Gmail, config: GmailClientConfig) {
    this.service = service;
    this.config = config;
  }

  async setupQuarantineLabel(): Promise<string> {
    const res = await this.service.users.labels.list({ userId: "me" });
    const existing = res.data.labels?.find(
      (l) => l.name === this.config.quarantineLabelName
    );
    if (existing?.id) {
      this.quarantineLabelId = existing.id;
      return existing.id;
    }

    const created = await this.service.users.labels.create({
      userId: "me",
      requestBody: {
        name: this.config.quarantineLabelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    this.quarantineLabelId = created.data.id!;
    console.log(
      `Created quarantine label: ${this.config.quarantineLabelName} (ID: ${created.data.id})`
    );
    return created.data.id!;
  }

  async watch(): Promise<{ historyId: string; expiration: string }> {
    const res = await this.service.users.watch({
      userId: "me",
      requestBody: {
        topicName: `projects/${this.config.gcpProjectId}/topics/${this.config.pubsubTopic}`,
        labelIds: ["INBOX"],
      },
    });
    const result = {
      historyId: String(res.data.historyId),
      expiration: String(res.data.expiration),
    };
    console.log(
      `Gmail watch established, historyId=${result.historyId}, expiration=${result.expiration}`
    );
    return result;
  }

  async getHistory(startHistoryId: string): Promise<string[]> {
    const messageIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.service.users.history.list({
        userId: "me",
        startHistoryId, // pass as string, never cast to number
        historyTypes: ["messageAdded"],
        pageToken,
      });
      for (const record of res.data.history ?? []) {
        for (const msg of record.messagesAdded ?? []) {
          if (msg.message?.id) {
            messageIds.push(msg.message.id);
          }
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return messageIds;
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const res = await this.service.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    return parseEmailMessage(
      res.data as { id: string; historyId?: string; payload?: any }
    );
  }

  async quarantineMessage(messageId: string): Promise<void> {
    if (!this.quarantineLabelId) {
      throw new Error(
        "Quarantine label not set up. Call setupQuarantineLabel() first."
      );
    }
    await this.service.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: [this.quarantineLabelId],
        removeLabelIds: ["INBOX"],
      },
    });
    console.log(`Quarantined message ${messageId}`);
  }
}
