import type { ClassifierPort, ClassifierInput } from "./classifier.port.js";
import type { ClassificationResult, ClassificationRule } from "./models.js";
import type { DatabasePort } from "./db.port.js";

interface CompiledRule extends ClassificationRule {
  compiledPattern?: RegExp;
}

export class RuleBasedClassifier implements ClassifierPort {
  private db: DatabasePort;
  private rulesCache: CompiledRule[] = [];
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
          label: rule.label,
          confidence: rule.confidence,
          reason: `Rule match: ${rule.reason}`,
        };
      }
    }
    return null;
  }

  private matches(rule: CompiledRule, input: ClassifierInput): boolean {
    switch (rule.field) {
      case "sender_domain": {
        const domain = input.sender.split("@").pop()?.toLowerCase() ?? "";
        return domain === rule.pattern.toLowerCase();
      }
      case "subject":
        return rule.compiledPattern?.test(input.subject) ?? false;
      case "body":
        return rule.compiledPattern?.test(input.body) ?? false;
      default:
        return false;
    }
  }

  private async refreshRulesIfStale(): Promise<void> {
    if (Date.now() - this.lastRefresh > this.refreshIntervalMs) {
      const rules = await this.db.getRules();
      this.rulesCache = rules.map((rule) => {
        if (rule.field === "sender_domain") return rule;
        try {
          return { ...rule, compiledPattern: new RegExp(rule.pattern, "i") };
        } catch {
          console.warn(`Skipping rule with invalid pattern: ${rule.pattern}`);
          return rule; // no compiledPattern — matches() returns false
        }
      });
      this.lastRefresh = Date.now();
    }
  }
}
