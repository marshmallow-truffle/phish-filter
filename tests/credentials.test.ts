// tests/credentials.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CredentialManager } from "../src/credentials.js";

// Mock googleapis
vi.mock("googleapis", () => {
  const mockGmail = {
    users: {
      messages: { get: vi.fn(), modify: vi.fn(), list: vi.fn() },
      labels: { list: vi.fn(), create: vi.fn() },
      history: { list: vi.fn() },
      watch: vi.fn(),
    },
  };
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({
          setCredentials: vi.fn(),
          getAccessToken: vi.fn().mockResolvedValue({ token: "test-token" }),
          on: vi.fn(),
          credentials: { refresh_token: "test-refresh-token" },
        })),
      },
      gmail: vi.fn().mockReturnValue(mockGmail),
    },
  };
});

describe("CredentialManager", () => {
  let manager: CredentialManager;

  beforeEach(() => {
    manager = new CredentialManager({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
    });
  });

  it("creates an OAuth2 client", () => {
    const auth = manager.getAuth();
    expect(auth).toBeDefined();
    expect(auth.setCredentials).toHaveBeenCalledWith({
      refresh_token: "test-refresh-token",
    });
  });

  it("returns the same auth instance on repeated calls", () => {
    const auth1 = manager.getAuth();
    const auth2 = manager.getAuth();
    expect(auth1).toBe(auth2);
  });

  it("creates a Gmail service", () => {
    const gmail = manager.getGmailService();
    expect(gmail).toBeDefined();
    expect(gmail.users).toBeDefined();
  });
});
