import { describe, it, expect, vi, beforeEach } from "vitest";
import { PubSubWorker, NotificationQueue } from "../src/pubsub-worker.js";
import { parseEmailMessage } from "../src/gmail-client.js";

function encode(text: string): string {
  return Buffer.from(text).toString("base64url");
}

function makeRawMessage(msgId: string, historyId = "100") {
  return {
    id: msgId,
    historyId,
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
      getAccountHistoryId: vi.fn().mockResolvedValue("50"),
      updateAccountHistoryId: vi.fn().mockResolvedValue(undefined),
      incrementAccountStats: vi.fn().mockResolvedValue(undefined),
    },
    log: {
      isProcessed: vi.fn().mockResolvedValue(false),
      saveClassification: vi.fn().mockResolvedValue(true),
      logEvent: vi.fn().mockResolvedValue(undefined),
    },
    logger: {
      log: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const labelConfig = { quarantineLabelName: "PHISH_QUARANTINE", spamLabelName: "SPAM_DETECTED", maxMessagesPerBatch: 5 };

describe("NotificationQueue", () => {
  it("push then take returns immediately", async () => {
    const q = new NotificationQueue();
    const item = { ack: vi.fn(), nack: vi.fn() };
    q.push(item);
    const result = await q.take();
    expect(result).toBe(item);
  });

  it("take before push waits for push", async () => {
    const q = new NotificationQueue();
    const item = { ack: vi.fn(), nack: vi.fn() };
    const promise = q.take();
    q.push(item);
    const result = await promise;
    expect(result).toBe(item);
  });
});

describe("PubSubWorker.processMessage", () => {
  let worker: PubSubWorker;
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    mocks = makeMocks();
    worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.log as any,
      mocks.logger as any,
      labelConfig
    );
  });

  it("returns historyId on success", async () => {
    const result = await worker.processMessage("msg1", mocks.gmail as any, "user@gmail.com");
    expect(result).toBe("100"); // historyId from makeRawMessage
    expect(mocks.gmail.getMessage).toHaveBeenCalledWith("msg1");
    expect(mocks.classifier.classify).toHaveBeenCalledOnce();
    expect(mocks.log.saveClassification).toHaveBeenCalledOnce();
    expect(mocks.db.incrementAccountStats).toHaveBeenCalledWith("user@gmail.com", "benign");
  });

  it("returns null for dedup-skipped messages", async () => {
    mocks.log.isProcessed.mockResolvedValue(true);
    const result = await worker.processMessage("msg1", mocks.gmail as any);
    expect(result).toBeNull();
    expect(mocks.gmail.getMessage).not.toHaveBeenCalled();
  });

  it("labels phish messages", async () => {
    mocks.classifier.classify.mockResolvedValue({
      label: "phish",
      confidence: 0.95,
      reason: "Suspicious URL",
    });
    await worker.processMessage("msg1", mocks.gmail as any);
    expect(mocks.gmail.labelMessage).toHaveBeenCalledWith("msg1", "PHISH_QUARANTINE");
  });

  it("labels spam messages", async () => {
    mocks.classifier.classify.mockResolvedValue({
      label: "spam",
      confidence: 0.8,
      reason: "Spam pattern",
    });
    await worker.processMessage("msg1", mocks.gmail as any);
    expect(mocks.gmail.labelMessage).toHaveBeenCalledWith("msg1", "SPAM_DETECTED");
  });

  it("does not label benign messages", async () => {
    await worker.processMessage("msg1", mocks.gmail as any);
    expect(mocks.gmail.labelMessage).not.toHaveBeenCalled();
  });
});

describe("PubSubWorker account loop", () => {
  it("updates cursor to max historyId from processed messages", async () => {
    const mocks = makeMocks();
    mocks.gmail.getHistory.mockResolvedValue(["msg1", "msg2", "msg3"]);
    let callCount = 0;
    mocks.gmail.getMessage.mockImplementation((id: string) => {
      const historyIds = ["100", "300", "200"];
      return Promise.resolve(parseEmailMessage(makeRawMessage(id, historyIds[callCount++])));
    });

    const worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.log as any,
      mocks.logger as any,
      labelConfig
    );

    const ack = vi.fn();
    const nack = vi.fn();
    worker.enqueue("user@gmail.com", ack, nack);

    await new Promise((r) => setTimeout(r, 100));

    expect(mocks.db.updateAccountHistoryId).toHaveBeenCalledWith("user@gmail.com", "300");
    expect(ack).toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();

    worker.stop();
  });

  it("does not update cursor when 0 messages", async () => {
    const mocks = makeMocks();
    mocks.gmail.getHistory.mockResolvedValue([]);

    const worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.log as any,
      mocks.logger as any,
      labelConfig
    );

    const ack = vi.fn();
    worker.enqueue("user@gmail.com", ack, vi.fn());

    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.db.updateAccountHistoryId).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalled();

    worker.stop();
  });

  it("nacks on failure", async () => {
    const mocks = makeMocks();
    mocks.gmail.getHistory.mockRejectedValue(new Error("API error"));

    const worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.log as any,
      mocks.logger as any,
      labelConfig
    );

    const ack = vi.fn();
    const nack = vi.fn();
    worker.enqueue("user@gmail.com", ack, nack);

    await new Promise((r) => setTimeout(r, 50));

    expect(nack).toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();

    worker.stop();
  });

  it("catch-up triggers processing via triggerCatchUp", async () => {
    const mocks = makeMocks();
    mocks.gmail.getHistory.mockResolvedValue(["msg1"]);

    const worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.log as any,
      mocks.logger as any,
      labelConfig
    );

    worker.triggerCatchUp("user@gmail.com");

    await new Promise((r) => setTimeout(r, 100));

    expect(mocks.db.getAccountHistoryId).toHaveBeenCalledWith("user@gmail.com");
    expect(mocks.gmail.getHistory).toHaveBeenCalledWith("50", 5);
    expect(mocks.log.saveClassification).toHaveBeenCalledOnce();

    worker.stop();
  });

  it("processes notifications serially (second waits for first)", async () => {
    const mocks = makeMocks();
    const order: number[] = [];
    let resolveFirst: () => void;
    const firstBlocks = new Promise<void>((r) => { resolveFirst = r; });

    mocks.gmail.getHistory
      .mockImplementationOnce(async () => {
        order.push(1);
        await firstBlocks;
        return ["msg1"];
      })
      .mockImplementationOnce(async () => {
        order.push(2);
        return [];
      });

    const worker = new PubSubWorker(
      mocks.accountManager as any,
      mocks.classifier as any,
      mocks.db as any,
      mocks.log as any,
      mocks.logger as any,
      labelConfig
    );

    const ack1 = vi.fn();
    const ack2 = vi.fn();
    worker.enqueue("user@gmail.com", ack1, vi.fn());
    worker.enqueue("user@gmail.com", ack2, vi.fn());

    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([1]);
    expect(ack1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();

    resolveFirst!();
    await new Promise((r) => setTimeout(r, 100));

    expect(order).toEqual([1, 2]);
    expect(ack1).toHaveBeenCalled();
    expect(ack2).toHaveBeenCalled();

    worker.stop();
  });

  it("cursor reflects highest historyId with randomized order", async () => {
    for (const seed of [42, 99, 7, 256, 1000]) {
      const mocks = makeMocks();
      const historyIds = Array.from({ length: 5 }, (_, i) => String(seed + i * 37 + ((i * 13) % 50)));
      const expectedMax = historyIds.reduce((a, b) => Number(a) > Number(b) ? a : b);

      const msgIds = historyIds.map((_, i) => `msg${i}`);
      mocks.gmail.getHistory.mockResolvedValue(msgIds);
      let idx = 0;
      mocks.gmail.getMessage.mockImplementation((id: string) =>
        Promise.resolve(parseEmailMessage(makeRawMessage(id, historyIds[idx++])))
      );

      const worker = new PubSubWorker(
        mocks.accountManager as any,
        mocks.classifier as any,
        mocks.db as any,
        mocks.log as any,
        mocks.logger as any,
        labelConfig
      );

      const ack = vi.fn();
      worker.enqueue("user@gmail.com", ack, vi.fn());
      await new Promise((r) => setTimeout(r, 150));

      expect(mocks.db.updateAccountHistoryId).toHaveBeenCalledWith("user@gmail.com", expectedMax);
      worker.stop();
    }
  });
});
