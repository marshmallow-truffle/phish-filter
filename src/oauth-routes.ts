import { Hono } from "hono";
import { google } from "googleapis";
import type { AccountManager } from "./account-manager.js";
import type { DatabasePort } from "./db.port.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/userinfo.email",
];

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createOAuthRoutes(
  accountManager: AccountManager,
  db: DatabasePort,
  oauthConfig: OAuthConfig,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const accounts = await db.getAccounts();
    const accountRows = accounts
      .map((a) => `<tr>
        <td>${a.email}</td>
        <td>${a.lastHistoryId}</td>
        <td>${a.totalProcessed}</td>
        <td>${a.phishCount}</td>
        <td>${a.spamCount}</td>
        <td>${a.benignCount}</td>
        <td>${a.lastProcessedAt ? new Date(a.lastProcessedAt).toLocaleString() : "—"}</td>
        <td><form method="POST" action="/accounts/${encodeURIComponent(a.email)}/remove" style="margin:0" onsubmit="return confirm('Remove ${a.email}?')"><button type="submit" class="btn-remove">Remove</button></form></td>
      </tr>`)
      .join("\n");

    return c.html(`<!DOCTYPE html>
<html>
<head><title>Phish Filter</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 1000px; margin: 40px auto; padding: 0 20px; }
  table { border-collapse: collapse; width: 100%; margin: 20px 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f5f5f5; }
  .btn { display: inline-block; padding: 10px 20px; background: #4285f4; color: white; text-decoration: none; border-radius: 4px; }
  .btn:hover { background: #3367d6; }
  .btn-remove { padding: 4px 12px; background: #d93025; color: white; border: none; border-radius: 4px; cursor: pointer; }
  .btn-remove:hover { background: #b71c1c; }
</style>
</head>
<body>
  <h1>Phish Filter</h1>
  <h2>Monitored Accounts</h2>
  ${accounts.length > 0
    ? `<table>
        <tr><th>Email</th><th>History ID</th><th>Processed</th><th>Phish</th><th>Spam</th><th>Benign</th><th>Last Processed</th><th></th></tr>
        ${accountRows}
      </table>`
    : "<p>No accounts registered yet.</p>"}
  <a href="/oauth/authorize" class="btn">Add Gmail Account</a>
  <h2>Quick Links</h2>
  <ul>
    <li><a href="/health">Health Status</a></li>
    <li><a href="/health/classifications">Recent Classifications</a></li>
  </ul>
</body>
</html>`);
  });

  app.post("/accounts/:email/remove", async (c) => {
    const email = decodeURIComponent(c.req.param("email"));
    await db.removeAccount(email);
    accountManager.unregister(email);
    return c.redirect("/");
  });

  app.get("/oauth/authorize", (c) => {
    const auth = new google.auth.OAuth2(
      oauthConfig.clientId,
      oauthConfig.clientSecret,
      oauthConfig.redirectUri,
    );
    const url = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
    });
    return c.redirect(url);
  });

  app.get("/oauth/callback", async (c) => {
    const code = c.req.query("code");
    if (!code) {
      return c.text("Missing authorization code", 400);
    }

    const auth = new google.auth.OAuth2(
      oauthConfig.clientId,
      oauthConfig.clientSecret,
      oauthConfig.redirectUri,
    );

    const { tokens } = await auth.getToken(code);
    if (!tokens.refresh_token) {
      return c.html(`<!DOCTYPE html>
<html><body>
  <h1>Error: No refresh token returned</h1>
  <p>Google only returns a refresh token on the first authorization, or when you explicitly revoke and re-authorize.</p>
  <p>Go to <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>, remove this app, then <a href="/oauth/authorize">try again</a>.</p>
</body></html>`, 400);
    }

    // Discover email address from the authorized account
    auth.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress!;

    // Persist token first (so it survives even if register fails)
    await db.upsertAccount(email, tokens.refresh_token);

    // Hot-register: set up label, watch, catch up
    try {
      await accountManager.register(email, tokens.refresh_token);
    } catch (err) {
      console.error(`Account ${email} saved but registration failed:`, err);
      // Account is persisted — will retry on next server restart
      return c.html(`<!DOCTYPE html>
<html><body>
  <h1>Account saved, but setup incomplete</h1>
  <p>Account <strong>${email}</strong> was saved. However, Gmail watch setup failed:</p>
  <pre>${err instanceof Error ? err.message : String(err)}</pre>
  <p>This usually means the Pub/Sub topic hasn't been created yet. Run:</p>
  <pre>./scripts/setup-pubsub.sh</pre>
  <p>Then restart the server — the account will be registered automatically.</p>
  <p><a href="/">Back to dashboard</a></p>
</body></html>`, 200);
    }

    return c.redirect("/");
  });

  return app;
}
