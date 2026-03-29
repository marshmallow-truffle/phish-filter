// scripts/send-test-email.ts
import { createTransport } from "nodemailer";
import { parseArgs } from "util";

const TEMPLATES = {
  paypal: {
    subject: "Urgent: Your PayPal Account Has Been Limited",
    from: "security@paypa1-support.com",
    body: "Dear Customer,\n\nWe've detected unusual activity on your account. Your account access has been limited until you verify your identity.\n\nClick here to verify: http://paypa1-secure.com/verify?id=38291\n\nIf you don't verify within 24 hours, your account will be permanently suspended.\n\nPayPal Security Team",
  },
  bank: {
    subject: "Action Required: Suspicious Login Detected",
    from: "alerts@chase-banking-secure.net",
    body: "We detected a login from an unrecognized device.\n\nLocation: Moscow, Russia\nDevice: Unknown\n\nIf this wasn't you, secure your account immediately: http://chase-secure-login.net/verify\n\nChase Security",
  },
  benign: {
    subject: "Your PR was merged",
    from: "notifications@github.com",
    body: "Your pull request #142 'Fix timeout handling' was merged into main.\n\nView the commit: https://github.com/yourorg/yourrepo/commit/abc123\n\n— GitHub",
  },
} as const;

const { values } = parseArgs({
  options: {
    to: { type: "string" },
    template: { type: "string", default: "paypal" },
    "smtp-host": { type: "string", default: "smtp.gmail.com" },
    "smtp-port": { type: "string", default: "587" },
    "smtp-user": { type: "string" },
    "smtp-pass": { type: "string" },
  },
});

const template = TEMPLATES[values.template as keyof typeof TEMPLATES] ?? TEMPLATES.paypal;

const transport = createTransport({
  host: values["smtp-host"],
  port: parseInt(values["smtp-port"]!, 10),
  secure: false,
  auth: { user: values["smtp-user"], pass: values["smtp-pass"] },
});

await transport.sendMail({
  from: template.from,
  to: values.to,
  subject: template.subject,
  text: template.body,
});

console.log(`Sent '${values.template}' test email to ${values.to}`);
