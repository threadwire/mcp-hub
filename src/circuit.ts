/**
 * Per-upstream circuit breaker. Failed calls open the breaker; while open the
 * proxy is skipped and a structured "circuit open" error returns instead of an
 * upstream timeout, with retryAfterMs. Half-open probe after cooldown lets a
 * recovered upstream back in. One breaker per server, ports it straight to a
 * map keyed by name.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: "closed" | "open" | "halfOpen" = "closed";

  constructor(
    private opts: { threshold: number; cooldownMs: number; probeOkResets?: boolean } = {
      threshold: 3,
      cooldownMs: 15_000,
    },
  ) {}

  get isOpen(): boolean {
    if (this.state === "open" && Date.now() - this.openedAt >= this.opts.cooldownMs) {
      this.state = "halfOpen";
    }
    return this.state === "open";
  }

  retryAfterMs(): number {
    return Math.max(0, this.opts.cooldownMs - (Date.now() - this.openedAt));
  }

  onSuccess(): void {
    if (this.state === "halfOpen" && (this.opts.probeOkResets ?? true)) {
      this.failures = 0;
      this.state = "closed";
    } else if (this.state !== "open") {
      this.failures = Math.max(0, this.failures - 1);
    }
  }

  onFailure(): void {
    this.failures++;
    if (this.failures >= this.opts.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  snapshot(): { state: string; failures: number } {
    return { state: this.state, failures: this.failures };
  }
}

export class BreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  for(serverName: string): CircuitBreaker {
    let b = this.breakers.get(serverName);
    if (!b) {
      b = new CircuitBreaker();
      this.breakers.set(serverName, b);
    }
    return b;
  }

  snapshots(): Record<string, { state: string; failures: number }> {
    const out: Record<string, { state: string; failures: number }> = {};
    for (const [k, v] of this.breakers) out[k] = v.snapshot();
    return out;
  }
}