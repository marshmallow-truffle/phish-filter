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

function mockAccountManager() {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    emails: vi.fn().mockReturnValue([]),
    has: vi.fn().mockReturnValue(false),
  } as any;
}

function mockDb() {
  return {
    getAccounts: vi.fn().mockResolvedValue([
      { email: "existing@gmail.com", refreshToken: "tok", lastHistoryId: "100", watchExpiration: null },
    ]),
    upsertAccount: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const oauthConfig = {
  clientId: "test-id",
  clientSecret: "test-secret",
  redirectUri: "http://localhost:8080/oauth/callback",
};

describe("OAuth routes", () => {
  it("GET / shows accounts and add button", async () => {
    const app = createOAuthRoutes(mockAccountManager(), mockDb(), oauthConfig);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("existing@gmail.com");
    expect(html).toContain("Add Gmail Account");
    expect(html).toContain("/oauth/authorize");
  });

  it("GET /oauth/authorize redirects to Google", async () => {
    const app = createOAuthRoutes(mockAccountManager(), mockDb(), oauthConfig);
    const res = await app.request("/oauth/authorize");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
  });

  it("GET /oauth/callback exchanges code and registers account", async () => {
    const am = mockAccountManager();
    const db = mockDb();
    const app = createOAuthRoutes(am, db, oauthConfig);

    const res = await app.request("/oauth/callback?code=test-auth-code");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(db.upsertAccount).toHaveBeenCalledWith("newuser@gmail.com", "new-refresh-token");
    expect(am.register).toHaveBeenCalledWith("newuser@gmail.com", "new-refresh-token");
  });

  it("GET /oauth/callback returns 400 without code", async () => {
    const app = createOAuthRoutes(mockAccountManager(), mockDb(), oauthConfig);
    const res = await app.request("/oauth/callback");
    expect(res.status).toBe(400);
  });
});
