export interface ClosableServer {
  close(): Promise<void>;
}

export interface SessionRegistryOptions {
  ttlMs: number;
  maxSessions: number;
  reapIntervalMs?: number;
  now?: () => number;
}

interface SessionEntry<T> {
  transport: T;
  server: ClosableServer;
  createdAt: number;
  lastSeenAt: number;
  binding?: string;
}

export interface SessionRegistryStats {
  active: number;
  max: number;
  ttl_ms: number;
  expired_total: number;
  closed_total: number;
  rejected_total: number;
}

export interface SessionReservation<T> {
  commit(id: string, transport: T, server: ClosableServer, binding?: string): void;
  release(): void;
}

/**
 * Bounds stateful MCP transports even when clients disappear without sending
 * the optional HTTP DELETE teardown request.
 */
export class SessionRegistry<T> {
  private readonly entries = new Map<string, SessionEntry<T>>();
  private readonly now: () => number;
  private readonly timer?: NodeJS.Timeout;
  private expiredTotal = 0;
  private closedTotal = 0;
  private rejectedTotal = 0;
  private pendingReservations = 0;

  constructor(private readonly options: SessionRegistryOptions) {
    if (options.ttlMs <= 0 || options.maxSessions <= 0) {
      throw new Error('Session TTL and maximum must be positive');
    }
    this.now = options.now ?? Date.now;
    const interval = options.reapIntervalMs ?? Math.min(options.ttlMs, 60_000);
    if (interval > 0) {
      this.timer = setInterval(() => { void this.reapExpired(); }, interval);
      this.timer.unref();
    }
  }

  add(id: string, transport: T, server: ClosableServer, binding?: string): void {
    const now = this.now();
    this.entries.set(id, { transport, server, createdAt: now, lastSeenAt: now, binding });
  }

  get(id: string, binding?: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.binding !== binding) return undefined;
    entry.lastSeenAt = this.now();
    return entry.transport;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  async canAccept(): Promise<boolean> {
    await this.reapExpired();
    if (this.entries.size + this.pendingReservations < this.options.maxSessions) return true;
    this.rejectedTotal += 1;
    return false;
  }

  async reserve(): Promise<SessionReservation<T> | undefined> {
    await this.reapExpired();
    if (this.entries.size + this.pendingReservations >= this.options.maxSessions) {
      this.rejectedTotal += 1;
      return undefined;
    }
    this.pendingReservations += 1;
    let settled = false;
    return {
      commit: (id, transport, server, binding) => {
        if (settled) throw new Error('Session reservation already settled');
        settled = true;
        this.pendingReservations -= 1;
        this.add(id, transport, server, binding);
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.pendingReservations -= 1;
      },
    };
  }

  async close(id: string, reason: 'client' | 'expired' | 'shutdown' = 'client'): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    // Delete first because server.close() invokes the transport's onclose hook.
    this.entries.delete(id);
    if (reason === 'expired') this.expiredTotal += 1;
    this.closedTotal += 1;
    try {
      await entry.server.close();
    } catch {
      // The transport may already be gone; the registry still must release it.
    }
    return true;
  }

  async reapExpired(): Promise<number> {
    const cutoff = this.now() - this.options.ttlMs;
    const expired = [...this.entries.entries()]
      .filter(([, entry]) => entry.lastSeenAt <= cutoff)
      .map(([id]) => id);
    await Promise.all(expired.map(id => this.close(id, 'expired')));
    return expired.length;
  }

  stats(): SessionRegistryStats {
    return {
      active: this.entries.size,
      max: this.options.maxSessions,
      ttl_ms: this.options.ttlMs,
      expired_total: this.expiredTotal,
      closed_total: this.closedTotal,
      rejected_total: this.rejectedTotal,
    };
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.entries.keys()].map(id => this.close(id, 'shutdown')));
  }
}

export function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}
