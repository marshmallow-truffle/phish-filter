export interface RetryOptions {
  maxRetries: number;
  baseDelay: number; // milliseconds
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, baseDelay } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxRetries) {
        throw lastError;
      }
      const delay =
        baseDelay * 2 ** (attempt - 1) +
        (Math.random() - 0.5) * baseDelay;
      await new Promise((r) => setTimeout(r, Math.max(1, delay)));
    }
  }
  throw lastError!; // unreachable
}
