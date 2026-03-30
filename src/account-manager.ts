import { GmailClient, type GmailClientConfig } from "./gmail-client.js";
import { CredentialManager } from "./credentials.js";
import type { Database } from "./db.port.js";

export class AccountManager {
  private clients = new Map<string, GmailClient>();
  private db: Database;
  private gmailConfig: GmailClientConfig;
  private oauthConfig: { clientId: string; clientSecret: string };

  constructor(
    db: Database,
    gmailConfig: GmailClientConfig,
    oauthConfig: { clientId: string; clientSecret: string },
  ) {
    this.db = db;
    this.gmailConfig = gmailConfig;
    this.oauthConfig = oauthConfig;
  }

  /** Register an account: create GmailClient, set up quarantine label, call watch, catch up. */
  async register(email: string, refreshToken: string): Promise<void> {
    const credManager = new CredentialManager({
      clientId: this.oauthConfig.clientId,
      clientSecret: this.oauthConfig.clientSecret,
      refreshToken,
    });
    const gmailService = credManager.getGmailService();
    const gmail = new GmailClient(gmailService, this.gmailConfig);

    await gmail.setupLabels();
    const watchResult = await gmail.watch();
    console.log(`Registered account ${email}, watch until ${watchResult.expiration}`);

    // For fresh accounts, set baseline cursor so catch-up doesn't try historyId=0
    const lastHistoryId = await this.db.getAccountHistoryId(email);
    if (lastHistoryId === "0") {
      await this.db.updateAccountHistoryId(email, watchResult.historyId);
      console.log(`Fresh account ${email}, baseline history ${watchResult.historyId}`);
    }

    this.clients.set(email, gmail);
  }

  /** Load all accounts from DB and register each. */
  async loadAll(): Promise<void> {
    const accounts = await this.db.getAccounts();
    for (const account of accounts) {
      try {
        await this.register(account.email, account.refreshToken);
      } catch (err) {
        console.error(`Failed to register account ${account.email}:`, err);
      }
    }
  }

  /** Look up the GmailClient for a given email address. */
  get(email: string): GmailClient | undefined {
    return this.clients.get(email);
  }

  /** List all registered email addresses. */
  emails(): string[] {
    return Array.from(this.clients.keys());
  }

  /** Remove an account from the runtime registry. */
  unregister(email: string): void {
    this.clients.delete(email);
  }

  /** Check if an account is registered. */
  has(email: string): boolean {
    return this.clients.has(email);
  }
}
