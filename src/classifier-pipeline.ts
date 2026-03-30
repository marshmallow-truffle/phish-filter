import type { ClassifierPort, ClassifierInput } from "./classifier.port.js";
import { DEFAULT_CLASSIFICATION, type ClassificationResult } from "./models.js";

export class ClassifierPipeline implements ClassifierPort {
  private classifiers: ClassifierPort[];

  constructor(classifiers: ClassifierPort[]) {
    this.classifiers = classifiers;
  }

  async classify(input: ClassifierInput): Promise<ClassificationResult> {
    for (const classifier of this.classifiers) {
      const result = await classifier.classify(input);
      if (result !== null) {
        return result;
      }
    }
    return DEFAULT_CLASSIFICATION;
  }
}
