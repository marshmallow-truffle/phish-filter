// tests/gmail-client.test.ts
import { describe, it, expect } from "vitest";
import {
  extractBodyFromPayload,
  extractHeaders,
  parseEmailMessage,
} from "../src/gmail-client.js";

function encode(text: string): string {
  return Buffer.from(text).toString("base64url");
}

describe("extractBodyFromPayload", () => {
  it("extracts plain text from single part", () => {
    const payload = {
      mimeType: "text/plain",
      body: { data: encode("Hello world") },
    };
    expect(extractBodyFromPayload(payload)).toBe("Hello world");
  });

  it("prefers plain text in multipart", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: encode("Plain text") } },
        { mimeType: "text/html", body: { data: encode("<b>HTML</b>") } },
      ],
    };
    expect(extractBodyFromPayload(payload)).toBe("Plain text");
  });

  it("falls back to stripped HTML", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: { data: encode("<p>Hello <b>world</b></p>") },
        },
      ],
    };
    const body = extractBodyFromPayload(payload);
    expect(body).toContain("Hello");
    expect(body).toContain("world");
    expect(body).not.toContain("<p>");
    expect(body).not.toContain("<b>");
  });

  it("truncates long body", () => {
    const longText = "A".repeat(5000);
    const payload = {
      mimeType: "text/plain",
      body: { data: encode(longText) },
    };
    expect(extractBodyFromPayload(payload, 2000).length).toBe(2000);
  });

  it("returns empty string for empty body", () => {
    const payload = { mimeType: "text/plain", body: {} };
    expect(extractBodyFromPayload(payload)).toBe("");
  });
});

describe("extractHeaders", () => {
  it("converts header array to record", () => {
    const headers = [
      { name: "From", value: "test@example.com" },
      { name: "Subject", value: "Test Subject" },
    ];
    const result = extractHeaders(headers);
    expect(result.From).toBe("test@example.com");
    expect(result.Subject).toBe("Test Subject");
  });
});

describe("parseEmailMessage", () => {
  it("parses a full Gmail message", () => {
    const raw = {
      id: "msg123",
      historyId: "456",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "phisher@evil.com" },
          { name: "Subject", value: "Urgent" },
        ],
        body: { data: encode("Click this link") },
      },
    };
    const email = parseEmailMessage(raw);
    expect(email.messageId).toBe("msg123");
    expect(email.historyId).toBe("456");
    expect(email.sender).toBe("phisher@evil.com");
    expect(email.subject).toBe("Urgent");
    expect(email.body).toBe("Click this link");
  });
});
