import { describe, it, expect, vi } from "vitest";

vi.mock("googleapis", () => {
  const mockAuth = {
    setCredentials: vi.fn(),
    generateAuthUrl: vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/auth?fake"),
    getToken: vi.fn().mockResolvedValue({
      tokens: { refresh_token: "new-refresh-token", access_token: "access" },
    }),
  };
  const mockGmail = {
    users: {
      getProfile: vi.fn().mockResolvedValue({
        data: { emailAddress: "newuser@gmail.com" },
      }),
    },
  };
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => mockAuth),
      },
      gmail: vi.fn().mockReturnValue(mockGmail),
    },
  };
});

import { createOAuthRoutes } from "../src/oauth-routes.js";
import { ServiceHealth } from "../src/health.js";

function mockAccountManager() {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn(),
    get: vi.fn(),
    emails: vi.fn().mockReturnValue([]),
    has: vi.fn().mockReturnValue(false),
  } as any;
}

function mockDb() {
  return {
    getAccounts: vi.fn().mockResolvedValue([
      {
        email: "existing@gmail.com", refreshToken: "tok", lastHistoryId: "100",
        totalProcessed: 5, phishCount: 1, spamCount: 2, benignCount: 2, lastProcessedAt: null,
      },
    ]),
    getRecentClassifications: vi.fn().mockResolvedValue([
      { message_id: "msg1", sender: "a@b.com", subject: "Hi", label: "benign", confidence: 0.9, reason: "Normal", quarantined: false, processed_at: "2026-03-29T10:00:00Z" },
    ]),
    getRules: vi.fn().mockResolvedValue([
      { id: "r1", field: "sender_domain", pattern: "evil.com", label: "phish", confidence: 1.0, reason: "Blocklist" },
    ]),
    checkHealth: vi.fn().mockResolvedValue({ total_count: 10 }),
    upsertAccount: vi.fn().mockResolvedValue(undefined),
    removeAccount: vi.fn().mockResolvedValue(undefined),
    saveRule: vi.fn().mockResolvedValue(undefined),
    removeRule: vi.fn().mockResolvedValue(undefined),
    getRecentEvents: vi.fn().mockResolvedValue([
      { message_id: "msg1", seq: 1, account_email: null, stage: "classified", level: "info", message: "benign", metadata: null, created_at: "2026-03-29T10:00:00Z" },
    ]),
    getEvents: vi.fn().mockResolvedValue([
      { message_id: "msg1", seq: 1, account_email: null, stage: "message_fetched", level: "info", message: "Fetched", metadata: null, created_at: "2026-03-29T10:00:00Z" },
    ]),
  } as any;
}

const oauthConfig = {
  clientId: "test-id",
  clientSecret: "test-secret",
  redirectUri: "http://localhost:8080/oauth/callback",
};

function makeApp(am = mockAccountManager(), db = mockDb()) {
  return createOAuthRoutes(am, db, new ServiceHealth(), oauthConfig);
}

describe("OAuth routes", () => {
  it("GET / shows all sections", async () => {
    const app = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Accounts
    expect(html).toContain("existing@gmail.com");
    expect(html).toContain("Add Gmail Account");
    // Health
    expect(html).toContain("healthy");
    // Classifications
    expect(html).toContain("a@b.com");
    expect(html).toContain("benign");
    // Rules
    expect(html).toContain("evil.com");
    expect(html).toContain("Blocklist");
  });

  it("GET /oauth/authorize redirects to Google", async () => {
    const res = await makeApp().request("/oauth/authorize");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
  });

  it("GET /oauth/callback exchanges code and registers account", async () => {
    const am = mockAccountManager();
    const db = mockDb();
    const app = createOAuthRoutes(am, db, new ServiceHealth(), oauthConfig);

    const res = await app.request("/oauth/callback?code=test-auth-code");
    expect(res.status).toBe(302);
    expect(db.upsertAccount).toHaveBeenCalledWith("newuser@gmail.com", "new-refresh-token");
    expect(am.register).toHaveBeenCalledWith("newuser@gmail.com", "new-refresh-token");
  });

  it("GET /oauth/callback returns 400 without code", async () => {
    const res = await makeApp().request("/oauth/callback");
    expect(res.status).toBe(400);
  });

  it("POST /accounts/:email/remove deletes and redirects", async () => {
    const am = mockAccountManager();
    const db = mockDb();
    const app = createOAuthRoutes(am, db, new ServiceHealth(), oauthConfig);

    const res = await app.request("/accounts/existing%40gmail.com/remove", { method: "POST" });
    expect(res.status).toBe(302);
    expect(db.removeAccount).toHaveBeenCalledWith("existing@gmail.com");
    expect(am.unregister).toHaveBeenCalledWith("existing@gmail.com");
  });

  it("POST /rules/add saves rule and redirects", async () => {
    const db = mockDb();
    const app = createOAuthRoutes(mockAccountManager(), db, new ServiceHealth(), oauthConfig);

    const form = new FormData();
    form.set("field", "sender_domain");
    form.set("pattern", "evil.com");
    form.set("label", "phish");
    form.set("confidence", "1.0");
    form.set("reason", "Known bad");

    const res = await app.request("/rules/add", { method: "POST", body: form });
    expect(res.status).toBe(302);
    expect(db.saveRule).toHaveBeenCalledWith({
      field: "sender_domain",
      pattern: "evil.com",
      label: "phish",
      confidence: 1.0,
      reason: "Known bad",
    });
  });

  it("POST /rules/:id/remove deletes rule and redirects", async () => {
    const db = mockDb();
    const app = createOAuthRoutes(mockAccountManager(), db, new ServiceHealth(), oauthConfig);

    const res = await app.request("/rules/r1/remove", { method: "POST" });
    expect(res.status).toBe(302);
    expect(db.removeRule).toHaveBeenCalledWith("r1");
  });

  it("GET /events?message_id=... shows event trace", async () => {
    const db = mockDb();
    const app = createOAuthRoutes(mockAccountManager(), db, new ServiceHealth(), oauthConfig);

    const res = await app.request("/events?message_id=msg1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Events for msg1");
    expect(html).toContain("message_fetched");
    expect(db.getEvents).toHaveBeenCalledWith("msg1");
  });

  it("GET / shows recent events section", async () => {
    const app = makeApp();
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain("Recent Events");
    expect(html).toContain("classified");
  });
});
