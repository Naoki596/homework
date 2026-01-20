export type CacheEntry<V> = { value: V; expiresAt: number };

export class TTLCache<V> {
  private store = new Map<string, CacheEntry<V>>();

  constructor(private readonly defaultTtlMs: number) {}

  get(key: string): V | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number) {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.store.set(key, { value, expiresAt });
  }
}

