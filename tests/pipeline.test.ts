import { describe, it, expect, vi } from "vitest";
import { PubSubWorker } from "../src/pubsub-worker.js";
import { parseEmailMessage } from "../src/gmail-client.js";

function encode(text: string): string {
  return Buffer.from(text).toString("base64url");
}

function makeRawMessage(
  msgId: string,
  sender: string,
  subject: string,
  body: string
) {
  return {
    id: msgId,
    historyId: "100",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: sender },
        { name: "Subject", value: subject },
      ],
      body: { data: encode(body) },
    },
  };
}

function makeMocks(classifyResult: { label: string; confidence: number; reason: string }) {
  const gmail = {
    getHistory: vi.fn().mockResolvedValue(["msg1", "msg2"]),
    getMessage: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(
        parseEmailMessage(
          makeRawMessage(id, "phisher@evil.ru", "Urgent!", "Click http://evil.ru/steal")
        )
      )
    ),
    labelMessage: vi.fn().mockResolvedValue(undefined),
  };
  return {
    gmail,
    accountManager: { get: vi.fn().mockReturnValue(gmail) },
    classifier: { classify: vi.fn().mockResolvedValue(classifyResult) },
    db: {
      isProcessed: vi.fn().mockResolvedValue(false),
      saveClassification: vi.fn().mockResolvedValue(true),
      incrementAccountStats: vi.fn().mockResolvedValue(undefined),
      logEvent: vi.fn().mockResolvedValue(undefined),
    },
    logger: { log: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("Pipeline end-to-end", () => {
  it("processes phish: fetch → classify → quarantine → store", async () => {
    const mocks = makeMocks({
      label: "phish",
      confidence: 0.95,
      reason: "Suspicious URL",
    });
    const worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.logger as any,
      { quarantineLabelName: "PHISH_QUARANTINE", spamLabelName: "SPAM_DETECTED" }
    );

    const historyId = await worker.processMessage("msg1", mocks.gmail as any);
    expect(historyId).toBe("100"); // returned historyId from the message

    expect(mocks.gmail.getMessage).toHaveBeenCalledWith("msg1");
    expect(mocks.classifier.classify).toHaveBeenCalledOnce();
    expect(mocks.gmail.labelMessage).toHaveBeenCalledWith("msg1", "PHISH_QUARANTINE");
    expect(mocks.db.saveClassification).toHaveBeenCalledOnce();

    const saveCall = mocks.db.saveClassification.mock.calls[0][0];
    expect(saveCall.bodySentToLlm).toContain("evil.ru/steal");
    expect(saveCall.quarantined).toBe(true);
  });

  it("skips already-processed messages (dedup)", async () => {
    const mocks = makeMocks({
      label: "phish",
      confidence: 0.95,
      reason: "Suspicious",
    });
    mocks.db.isProcessed.mockResolvedValue(true);
    const worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.logger as any,
      { quarantineLabelName: "PHISH_QUARANTINE", spamLabelName: "SPAM_DETECTED" }
    );

    const result = await worker.processMessage("msg1", mocks.gmail as any);
    expect(result).toBeNull();
    expect(mocks.gmail.getMessage).not.toHaveBeenCalled();
    expect(mocks.classifier.classify).not.toHaveBeenCalled();
  });

  it("benign emails are not quarantined", async () => {
    const mocks = makeMocks({
      label: "benign",
      confidence: 0.9,
      reason: "Normal email",
    });
    const worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.logger as any,
      { quarantineLabelName: "PHISH_QUARANTINE", spamLabelName: "SPAM_DETECTED" }
    );

    await worker.processMessage("msg1", mocks.gmail as any);
    expect(mocks.gmail.labelMessage).not.toHaveBeenCalled();
    const saveCall = mocks.db.saveClassification.mock.calls[0][0];
    expect(saveCall.quarantined).toBe(false);
  });
});
