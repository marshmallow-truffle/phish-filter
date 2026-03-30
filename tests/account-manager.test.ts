// tests/account-manager.test.ts
import { describe, it, expect, vi } from "vitest";
import { AccountManager } from "../src/account-manager.js";

// Mock googleapis
vi.mock("googleapis", () => {
  const mockGmail = {
    users: {
      messages: { get: vi.fn(), modify: vi.fn() },
      labels: { list: vi.fn().mockResolvedValue({ data: { labels: [{ name: "PHISH_QUARANTINE", id: "Label_123" }] } }), create: vi.fn() },
      history: { list: vi.fn().mockResolvedValue({ data: { history: [] } }) },
      watch: vi.fn().mockResolvedValue({ data: { historyId: "100", expiration: "9999999" } }),
    },
  };
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({
          setCredentials: vi.fn(),
          credentials: {},
        })),
      },
      gmail: vi.fn().mockReturnValue(mockGmail),
    },
  };
});

function mockDb() {
  return {
    getAccounts: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue(null),
    upsertAccount: vi.fn().mockResolvedValue(undefined),
    getAccountHistoryId: vi.fn().mockResolvedValue("0"),
    updateAccountHistoryId: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const gmailConfig = {
  gcpProjectId: "test-project",
  pubsubTopic: "test-topic",
  quarantineLabelName: "PHISH_QUARANTINE",
};

const oauthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
};

describe("AccountManager", () => {
  it("register adds a client to the map", async () => {
    const db = mockDb();
    const manager = new AccountManager(db, gmailConfig, oauthConfig);

    await manager.register("user@gmail.com", "refresh-token");

    expect(manager.has("user@gmail.com")).toBe(true);
    expect(manager.get("user@gmail.com")).toBeDefined();
    expect(manager.emails()).toEqual(["user@gmail.com"]);
  });

  it("loadAll registers all DB accounts", async () => {
    const db = mockDb();
    db.getAccounts.mockResolvedValue([
      { email: "a@gmail.com", refreshToken: "tok-a", lastHistoryId: "0", watchExpiration: null },
      { email: "b@gmail.com", refreshToken: "tok-b", lastHistoryId: "50", watchExpiration: null },
    ]);
    const manager = new AccountManager(db, gmailConfig, oauthConfig);

    await manager.loadAll();

    expect(manager.emails()).toHaveLength(2);
    expect(manager.has("a@gmail.com")).toBe(true);
    expect(manager.has("b@gmail.com")).toBe(true);
  });

  it("loadAll continues if one account fails", async () => {
    const db = mockDb();
    db.getAccounts.mockResolvedValue([
      { email: "good@gmail.com", refreshToken: "tok", lastHistoryId: "0", watchExpiration: null },
      { email: "bad@gmail.com", refreshToken: "bad-tok", lastHistoryId: "0", watchExpiration: null },
    ]);

    const { google } = await import("googleapis");

    // Build two separate mock gmail instances
    const goodMock = {
      users: {
        messages: { get: vi.fn(), modify: vi.fn() },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [{ name: "PHISH_QUARANTINE", id: "Label_123" }] } }), create: vi.fn() },
        history: { list: vi.fn().mockResolvedValue({ data: { history: [] } }) },
        watch: vi.fn().mockResolvedValue({ data: { historyId: "100", expiration: "9999999" } }),
      },
    };
    const badMock = {
      users: {
        messages: { get: vi.fn(), modify: vi.fn() },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [{ name: "PHISH_QUARANTINE", id: "Label_123" }] } }), create: vi.fn() },
        history: { list: vi.fn().mockResolvedValue({ data: { history: [] } }) },
        watch: vi.fn().mockRejectedValue(new Error("auth failed")),
      },
    };

    let callCount = 0;
    vi.mocked(google.gmail).mockImplementation(() => {
      callCount++;
      return callCount === 1 ? (goodMock as any) : (badMock as any);
    });

    const manager = new AccountManager(db, gmailConfig, oauthConfig);
    await manager.loadAll();

    // At least the good account should be registered
    expect(manager.has("good@gmail.com")).toBe(true);
  });

  it("get returns undefined for unknown email", () => {
    const db = mockDb();
    const manager = new AccountManager(db, gmailConfig, oauthConfig);
    expect(manager.get("unknown@gmail.com")).toBeUndefined();
  });

  it("register updates history ID when messages exist", async () => {
    const db = mockDb();
    const { google } = await import("googleapis");

    const historyMock = {
      users: {
        messages: { get: vi.fn(), modify: vi.fn() },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [{ name: "PHISH_QUARANTINE", id: "Label_123" }] } }), create: vi.fn() },
        history: {
          list: vi.fn().mockResolvedValue({
            data: {
              history: [{ messagesAdded: [{ message: { id: "msg1" } }] }],
            },
          }),
        },
        watch: vi.fn().mockResolvedValue({ data: { historyId: "100", expiration: "9999999" } }),
      },
    };
    vi.mocked(google.gmail).mockReturnValueOnce(historyMock as any);

    const manager = new AccountManager(db, gmailConfig, oauthConfig);
    await manager.register("user@gmail.com", "tok");

    expect(db.updateAccountHistoryId).toHaveBeenCalled();
  });
});
