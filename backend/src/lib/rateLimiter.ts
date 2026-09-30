/**
 * In-memory fixed-window rate limiter (per Cloud Run instance), which docs/07 §17 allows
 * for HTTP limits in the MVP. Limits protecting AI cost are Firestore-backed instead.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records one hit; false when the key is over its limit in the current window. */
  hit(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.prune(t);
      return true;
    }
    w.count += 1;
    return w.count <= this.limit;
  }

  private prune(t: number) {
    for (const [key, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(key);
  }
}
