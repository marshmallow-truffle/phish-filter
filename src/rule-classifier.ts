import type { ClassifierPort, ClassifierInput } from "./classifier.port.js";
import type { ClassificationResult, ClassificationRule } from "./models.js";
import type { DatabasePort } from "./db.port.js";

export class RuleBasedClassifier implements ClassifierPort {
  private db: DatabasePort;
  private rulesCache: ClassificationRule[] = [];
  private lastRefresh = 0;
  private refreshIntervalMs: number;

  constructor(db: DatabasePort, refreshIntervalMs = 60_000) {
    this.db = db;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  async classify(input: ClassifierInput): Promise<ClassificationResult | null> {
    await this.refreshRulesIfStale();

    for (const rule of this.rulesCache) {
      if (this.matches(rule, input)) {
        return {
          label: rule.label as ClassificationResult["label"],
          confidence: rule.confidence,
          reason: `Rule match: ${rule.reason}`,
        };
      }
    }
    return null;
  }

  private matches(rule: ClassificationRule, input: ClassifierInput): boolean {
    try {
      switch (rule.field) {
        case "sender_domain": {
          const domain = input.sender.split("@").pop()?.toLowerCase() ?? "";
          return domain === rule.pattern.toLowerCase();
        }
        case "subject":
          return new RegExp(rule.pattern, "i").test(input.subject);
        case "body":
          return new RegExp(rule.pattern, "i").test(input.body);
        default:
          return false;
      }
    } catch {
      // Invalid regex — skip this rule
      console.warn(`Skipping rule with invalid pattern: ${rule.pattern}`);
      return false;
    }
  }

  private async refreshRulesIfStale(): Promise<void> {
    if (Date.now() - this.lastRefresh > this.refreshIntervalMs) {
      this.rulesCache = await this.db.getRules();
      this.lastRefresh = Date.now();
    }
  }
}
