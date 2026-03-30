import { Hono } from "hono";
import { google } from "googleapis";
import type { AccountManager } from "./account-manager.js";
import type { DatabasePort } from "./db.port.js";
import type { ServiceHealth } from "./health.js";

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
  health: ServiceHealth,
  oauthConfig: OAuthConfig,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const [accounts, classifications, rules, dbHealth] = await Promise.all([
      db.getAccounts(),
      db.getRecentClassifications(20),
      db.getRules(),
      db.checkHealth().catch(() => null),
    ]);

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

    const classificationRows = classifications
      .map((cl) => `<tr>
        <td>${cl.sender}</td>
        <td>${cl.subject}</td>
        <td class="label-${cl.label}">${cl.label}</td>
        <td>${cl.confidence}</td>
        <td>${cl.reason}</td>
        <td>${cl.quarantined ? "Yes" : ""}</td>
        <td>${new Date(cl.processed_at).toLocaleString()}</td>
      </tr>`)
      .join("\n");

    const ruleRows = rules
      .map((r) => `<tr>
        <td>${r.field}</td>
        <td><code>${r.pattern}</code></td>
        <td class="label-${r.label}">${r.label}</td>
        <td>${r.confidence}</td>
        <td>${r.reason}</td>
        <td><form method="POST" action="/rules/${r.id}/remove" style="margin:0" onsubmit="return confirm('Remove this rule?')"><button type="submit" class="btn-remove">Remove</button></form></td>
      </tr>`)
      .join("\n");

    return c.html(`<!DOCTYPE html>
<html>
<head><title>Phish Filter</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 40px auto; padding: 0 20px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 20px; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 14px; }
  th { background: #f5f5f5; }
  h2 { margin-top: 30px; border-bottom: 1px solid #ddd; padding-bottom: 5px; }
  .btn { display: inline-block; padding: 8px 16px; background: #4285f4; color: white; text-decoration: none; border-radius: 4px; font-size: 14px; }
  .btn:hover { background: #3367d6; }
  .btn-remove { padding: 3px 10px; background: #d93025; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .btn-remove:hover { background: #b71c1c; }
  .label-phish { color: #d93025; font-weight: bold; }
  .label-spam { color: #e37400; font-weight: bold; }
  .label-benign { color: #188038; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 13px; }
  .status-healthy { background: #e6f4ea; color: #188038; }
  .status-degraded { background: #fce8e6; color: #d93025; }
  .add-rule { margin: 10px 0 20px; }
  .add-rule input, .add-rule select { padding: 6px 10px; font-size: 14px; border: 1px solid #ddd; border-radius: 4px; }
  .add-rule button { padding: 6px 16px; }
  code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
</style>
</head>
<body>
  <h1>Phish Filter</h1>

  <h2>Health</h2>
  <p>
    Status: <span class="status status-${dbHealth ? "healthy" : "degraded"}">${dbHealth ? "healthy" : "degraded"}</span>
    &nbsp; Uptime: ${Math.round(health.uptimeSeconds)}s
    &nbsp; Total processed: ${dbHealth?.total_count ?? 0}
    ${health.lastError ? `&nbsp; Last error: ${health.lastError}` : ""}
  </p>

  <h2>Monitored Accounts</h2>
  ${accounts.length > 0
    ? `<table>
        <tr><th>Email</th><th>History ID</th><th>Processed</th><th>Phish</th><th>Spam</th><th>Benign</th><th>Last Processed</th><th></th></tr>
        ${accountRows}
      </table>`
    : "<p>No accounts registered yet.</p>"}
  <a href="/oauth/authorize" class="btn">Add Gmail Account</a>

  <h2>Classification Rules</h2>
  ${rules.length > 0
    ? `<table>
        <tr><th>Field</th><th>Pattern</th><th>Label</th><th>Confidence</th><th>Reason</th><th></th></tr>
        ${ruleRows}
      </table>`
    : "<p>No rules configured. Emails will be classified by LLM only.</p>"}
  <form method="POST" action="/rules/add" class="add-rule">
    <select name="field">
      <option value="sender_domain">Sender Domain</option>
      <option value="subject">Subject (regex)</option>
      <option value="body">Body (regex)</option>
    </select>
    <input name="pattern" placeholder="Pattern" required size="25">
    <select name="label">
      <option value="phish">phish</option>
      <option value="spam">spam</option>
      <option value="benign">benign</option>
    </select>
    <input name="confidence" type="number" value="1.0" min="0" max="1" step="0.1" style="width:60px">
    <input name="reason" placeholder="Reason" required size="20">
    <button type="submit" class="btn">Add Rule</button>
  </form>

  <h2>Recent Classifications</h2>
  ${classifications.length > 0
    ? `<table>
        <tr><th>Sender</th><th>Subject</th><th>Label</th><th>Confidence</th><th>Reason</th><th>Quarantined</th><th>Time</th></tr>
        ${classificationRows}
      </table>`
    : "<p>No emails classified yet.</p>"}
</body>
</html>`);
  });

  app.post("/accounts/:email/remove", async (c) => {
    const email = decodeURIComponent(c.req.param("email"));
    await db.removeAccount(email);
    accountManager.unregister(email);
    return c.redirect("/");
  });

  app.post("/rules/add", async (c) => {
    const body = await c.req.parseBody();
    await db.saveRule({
      field: body.field as string,
      pattern: body.pattern as string,
      label: body.label as string,
      confidence: parseFloat(body.confidence as string) || 1.0,
      reason: body.reason as string,
    });
    return c.redirect("/");
  });

  app.post("/rules/:id/remove", async (c) => {
    await db.removeRule(c.req.param("id"));
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

    auth.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress!;

    await db.upsertAccount(email, tokens.refresh_token);

    try {
      await accountManager.register(email, tokens.refresh_token);
    } catch (err) {
      console.error(`Account ${email} saved but registration failed:`, err);
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
