// tests/pubsub-worker.test.ts
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
  return {
    gmail: {
      getHistory: vi.fn().mockResolvedValue(["msg1"]),
      getMessage: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(parseEmailMessage(makeRawMessage(id)))
      ),
      quarantineMessage: vi.fn().mockResolvedValue(undefined),
      watch: vi.fn().mockResolvedValue({ historyId: "200", expiration: "9999" }),
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
      getLastHistoryId: vi.fn().mockResolvedValue("50"),
      updateLastHistoryId: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("PubSubWorker", () => {
  let worker: PubSubWorker;
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();
    worker = new PubSubWorker(
      mocks.gmail as any,
      mocks.classifier as any,
      mocks.db as any
    );
  });

  it("processes a new message", async () => {
    const result = await worker.processMessage("msg1");
    expect(result).toBe(true);
    expect(mocks.gmail.getMessage).toHaveBeenCalledWith("msg1");
    expect(mocks.classifier.classify).toHaveBeenCalledOnce();
    expect(mocks.db.saveClassification).toHaveBeenCalledOnce();
  });

  it("skips already-processed message", async () => {
    mocks.db.isProcessed.mockResolvedValue(true);
    const result = await worker.processMessage("msg1");
    expect(result).toBe(false);
    expect(mocks.gmail.getMessage).not.toHaveBeenCalled();
  });

  it("quarantines phish messages", async () => {
    mocks.classifier.classify.mockResolvedValue({
      label: "phish",
      confidence: 0.95,
      reason: "Suspicious URL",
    });
    await worker.processMessage("msg1");
    expect(mocks.gmail.quarantineMessage).toHaveBeenCalledWith("msg1");
  });

  it("does not quarantine benign messages", async () => {
    await worker.processMessage("msg1");
    expect(mocks.gmail.quarantineMessage).not.toHaveBeenCalled();
  });

  it("processes a Pub/Sub notification", async () => {
    const data = JSON.stringify({
      emailAddress: "user@gmail.com",
      historyId: "100",
    });
    await worker.processNotification(Buffer.from(data));
    expect(mocks.db.getLastHistoryId).toHaveBeenCalledOnce();
    expect(mocks.gmail.getHistory).toHaveBeenCalledWith("50");
    expect(mocks.db.updateLastHistoryId).toHaveBeenCalledWith("100");
  });

  it("ignores notification without historyId", async () => {
    const data = JSON.stringify({ emailAddress: "user@gmail.com" });
    await worker.processNotification(Buffer.from(data));
    expect(mocks.gmail.getHistory).not.toHaveBeenCalled();
  });

  it("catches up on missed messages", async () => {
    mocks.gmail.getHistory.mockResolvedValue(["msg1", "msg2"]);
    const processed = await worker.catchUp();
    expect(processed).toBe(2);
    expect(mocks.db.saveClassification).toHaveBeenCalledTimes(2);
    expect(mocks.gmail.watch).toHaveBeenCalledOnce();
    expect(mocks.db.updateLastHistoryId).toHaveBeenCalledWith("200");
  });
});
