/**
 * Last-known-good responses, persisted across restarts.
 *
 * Dashboard blocks render from here first and revalidate afterwards, so a note
 * opened offline — or opened before the network settles, which is the common
 * case — shows real data instead of a spinner.
 *
 * Persistence is injected rather than reached for directly: in the plugin it is
 * a slice of `data.json`, and in the tests it is a plain object. That keeps this
 * module free of any Obsidian import and testable in plain Node.
 */

/** One cached response and when it arrived. */
export interface CacheEntry<T = unknown> {
  data: T;
  /** Epoch milliseconds. */
  fetchedAt: number;
}

export type CacheContents = Record<string, CacheEntry>;

/**
 * Where entries live between sessions. `load` is synchronous because a block
 * renders on the first frame and cannot await its own cache.
 */
export interface CachePersistence {
  load(): unknown;
  save(entries: CacheContents): Promise<void>;
}

/**
 * Entries older than this are dropped on load.
 *
 * A week-old response is not worth rendering and its key may no longer exist,
 * so keeping it only grows `data.json` for a panel nobody will believe.
 */
export const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** An entry shaped correctly enough to trust. `data.json` is user-editable. */
function isEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    'data' in entry &&
    typeof entry.fetchedAt === 'number' &&
    Number.isFinite(entry.fetchedAt)
  );
}

export class DashboardCache {
  private entries: CacheContents = {};

  /**
   * `now` is injected so the tests can age an entry without sleeping, and so
   * staleness is decided by one clock rather than by scattered `Date.now()`
   * calls that can straddle a boundary mid-render.
   */
  constructor(
    private readonly persistence: CachePersistence,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Read persisted entries, discarding anything malformed or expired.
   *
   * Writes back only when something was actually dropped — a clean load on
   * every startup should not dirty `data.json`.
   */
  async load(): Promise<void> {
    const raw = this.persistence.load();
    const source =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

    const kept: CacheContents = {};
    let dropped = 0;

    for (const [key, value] of Object.entries(source)) {
      if (!isEntry(value) || this.ageOf(value) > MAX_ENTRY_AGE_MS) {
        dropped++;
        continue;
      }
      kept[key] = value;
    }

    this.entries = kept;
    if (dropped > 0) await this.persistence.save(this.entries);
  }

  /** The cached entry for `key`, or null. Synchronous by design. */
  get<T>(key: string): CacheEntry<T> | null {
    return (this.entries[key] as CacheEntry<T> | undefined) ?? null;
  }

  /** Store a response and persist it. */
  async set<T>(key: string, data: T): Promise<CacheEntry<T>> {
    const entry: CacheEntry<T> = { data, fetchedAt: this.now() };
    this.entries[key] = entry;
    await this.persistence.save(this.entries);
    return entry;
  }

  /** Forget one key. Persists only if there was something to forget. */
  async delete(key: string): Promise<void> {
    if (!(key in this.entries)) return;
    delete this.entries[key];
    await this.persistence.save(this.entries);
  }

  /**
   * Drop every entry. Used when the API key changes — the previous account's
   * platforms are not this one's, and rendering them would be a small but real
   * leak between accounts on a shared vault.
   */
  async clear(): Promise<void> {
    if (Object.keys(this.entries).length === 0) return;
    this.entries = {};
    await this.persistence.save(this.entries);
  }

  /** Milliseconds since the entry was fetched. */
  ageOf(entry: CacheEntry): number {
    // A clock that moved backwards (timezone change, NTP correction) would
    // otherwise report a negative age and make a stale entry look fresh
    // forever.
    return Math.max(0, this.now() - entry.fetchedAt);
  }

  /** Whether the entry is older than `floorMs`. A missing entry is stale. */
  isStale(entry: CacheEntry | null, floorMs: number): boolean {
    return entry === null || this.ageOf(entry) >= floorMs;
  }
}
