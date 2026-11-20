// Circuit breaker: stops sending traffic to a backend that keeps failing,
// then lets a trial request through after a cooldown.
// States: closed (normal) -> open (after N failures) -> half-open (after cooldown) -> closed on success.
export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 30000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.openedAt = null;
  }

  get state() {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  allow() {
    return this.state !== 'open';
  }

  onSuccess() {
    this.failures = 0;
    this.openedAt = null;
  }

  onFailure() {
    this.failures += 1;
    // A failed trial request re-opens the circuit immediately.
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.openedAt = this.now();
    }
  }
}
