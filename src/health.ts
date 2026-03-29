export class ServiceHealth {
  readonly startedAt = new Date();
  lastProcessedAt: Date | null = null;
  totalProcessed = 0;
  counts: Record<string, number> = { phish: 0, spam: 0, benign: 0 };
  lastError: string | null = null;
  lastErrorAt: Date | null = null;

  get uptimeSeconds(): number {
    return (Date.now() - this.startedAt.getTime()) / 1000;
  }

  record(label: string): void {
    this.totalProcessed++;
    this.lastProcessedAt = new Date();
    if (label in this.counts) {
      this.counts[label]++;
    }
  }

  recordError(error: string): void {
    this.lastError = error;
    this.lastErrorAt = new Date();
  }
}
