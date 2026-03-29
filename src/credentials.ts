// src/credentials.ts
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface CredentialOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class CredentialManager {
  private auth: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private readonly options: CredentialOptions;

  constructor(options: CredentialOptions) {
    this.options = options;
  }

  getAuth(): OAuth2Client {
    if (!this.auth) {
      this.auth = new google.auth.OAuth2(
        this.options.clientId,
        this.options.clientSecret
      );
      this.auth.setCredentials({
        refresh_token: this.options.refreshToken,
      });
      // googleapis auto-refreshes tokens when they expire
      // using the refresh_token. No manual refresh needed.
    }
    return this.auth;
  }

  getGmailService(): gmail_v1.Gmail {
    if (!this.gmail) {
      this.gmail = google.gmail({ version: "v1", auth: this.getAuth() });
    }
    return this.gmail;
  }
}
