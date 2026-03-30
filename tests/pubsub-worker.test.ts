import { describe, it, expect, vi, beforeEach } from "vitest";
import { PubSubWorker } from "../src/pubsub-worker.js";
import { parseEmailMessage } from "../src/gmail-client.js";

function encode(text: string): string {
  return Buffer.from(text).toString("base64url");
}

function makeRawMessage(msgId: string) {
  return {
    id: msgId,
    historyId: "100",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "test@example.com" },
        { name: "Subject", value: "Test" },
      ],
      body: { data: encode("Test body") },
    },
  };
}

function makeMocks() {
  const gmail = {
    getHistory: vi.fn().mockResolvedValue(["msg1"]),
    getMessage: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(parseEmailMessage(makeRawMessage(id)))
    ),
    labelMessage: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue({ historyId: "200", expiration: "9999" }),
  };
  return {
    gmail,
    accountManager: {
      get: vi.fn().mockReturnValue(gmail),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue({
        label: "benign",
        confidence: 0.9,
        reason: "Normal email",
      }),
    },
    db: {
      isProcessed: vi.fn().mockResolvedValue(false),
      saveClassification: vi.fn().mockResolvedValue(true),
      getAccountHistoryId: vi.fn().mockResolvedValue("50"),
      updateAccountHistoryId: vi.fn().mockResolvedValue(undefined),
      incrementAccountStats: vi.fn().mockResolvedValue(undefined),
      logEvent: vi.fn().mockResolvedValue(undefined),
    },
    logger: {
      log: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("PubSubWorker", () => {
  let worker: PubSubWorker;
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();
    worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.logger as any,
      { quarantineLabelName: "PHISH_QUARANTINE", spamLabelName: "SPAM_DETECTED" }
    );
  });

  it("processes a new message", async () => {
    const result = await worker.processMessage("msg1", mocks.gmail as any, "user@gmail.com");
    expect(result).toBe(true);
    expect(mocks.gmail.getMessage).toHaveBeenCalledWith("msg1");
    expect(mocks.classifier.classify).toHaveBeenCalledOnce();
    expect(mocks.db.saveClassification).toHaveBeenCalledOnce();
    const saveCall = mocks.db.saveClassification.mock.calls[0][0];
    expect(saveCall.accountEmail).toBe("user@gmail.com");
    expect(mocks.db.incrementAccountStats).toHaveBeenCalledWith("user@gmail.com", "benign");
  });

  it("skips already-processed message", async () => {
    mocks.db.isProcessed.mockResolvedValue(true);
    const result = await worker.processMessage("msg1", mocks.gmail as any);
    expect(result).toBe(false);
    expect(mocks.gmail.getMessage).not.toHaveBeenCalled();
  });

  it("quarantines phish messages", async () => {
    mocks.classifier.classify.mockResolvedValue({
      label: "phish",
      confidence: 0.95,
      reason: "Suspicious URL",
    });
    await worker.processMessage("msg1", mocks.gmail as any);
    expect(mocks.gmail.labelMessage).toHaveBeenCalledWith("msg1", "PHISH_QUARANTINE");
  });

  it("does not label benign messages", async () => {
    await worker.processMessage("msg1", mocks.gmail as any);
    expect(mocks.gmail.labelMessage).not.toHaveBeenCalled();
  });

  it("routes notification by emailAddress", async () => {
    const data = JSON.stringify({
      emailAddress: "user@gmail.com",
      historyId: "100",
    });
    await worker.processNotification(Buffer.from(data));
    expect(mocks.accountManager.get).toHaveBeenCalledWith("user@gmail.com");
    expect(mocks.db.getAccountHistoryId).toHaveBeenCalledWith("user@gmail.com");
    expect(mocks.gmail.getHistory).toHaveBeenCalledWith("50");
    expect(mocks.db.updateAccountHistoryId).toHaveBeenCalledWith("user@gmail.com", "100");
  });

  it("ignores notification without historyId", async () => {
    const data = JSON.stringify({ emailAddress: "user@gmail.com" });
    await worker.processNotification(Buffer.from(data));
    expect(mocks.gmail.getHistory).not.toHaveBeenCalled();
  });

  it("ignores notification for unknown account", async () => {
    mocks.accountManager.get.mockReturnValue(undefined);
    const data = JSON.stringify({ emailAddress: "unknown@gmail.com", historyId: "100" });
    await worker.processNotification(Buffer.from(data));
    expect(mocks.gmail.getHistory).not.toHaveBeenCalled();
  });
});
