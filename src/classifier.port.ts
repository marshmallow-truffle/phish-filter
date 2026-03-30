import type { ClassificationResult } from "./models.js";

export interface ClassifierInput {
  sender: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
}

export interface ClassifierPort {
  classify(input: ClassifierInput): Promise<ClassificationResult | null>;
}
