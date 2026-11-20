// Fixed-window rate limiter, one counter per client key per minute.
// Simple on purpose. Expired buckets are only replaced on the next hit, so the map can grow with many keys.
export class RateLimiter {
  constructor({ limit = 30, windowMs = 60000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map();
  }

  // Returns true if the request is allowed.
  hit(key) {
    const window = Math.floor(this.now() / this.windowMs);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.window !== window) {
      bucket = { window, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }
}
