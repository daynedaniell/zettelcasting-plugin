import { CacheEntry, DashboardCache } from './cache';

/**
 * Cache-first access to one endpoint, shared by every block that reads it.
 *
 * A block never calls the API directly. It reads a snapshot — which is
 * synchronous and always available — renders it, and asks for a revalidation.
 * Several blocks on the same note therefore produce one request, not one each,
 * and they all re-render from the same result.
 */

/** What a fetcher reports back. Mirrors the API client's result unions. */
export type FetchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: FetchErrorKind; message: string };

export type FetchErrorKind = 'no-key' | 'unauthorized' | 'error';

export type Fetcher<T> = () => Promise<FetchOutcome<T>>;

/** Everything a block needs to render, in one synchronously-readable object. */
export interface Snapshot<T> {
  /** Last-known-good data. Null only when nothing has ever succeeded. */
  data: T | null;
  /** When `data` was fetched, epoch ms, or null. */
  fetchedAt: number | null;
  /** A revalidation is in flight. Never a reason to hide `data`. */
  loading: boolean;
  /** The most recent revalidation failure, cleared by the next success. */
  error: string | null;
  errorKind: FetchErrorKind | null;
}

export interface CachedResourceOptions {
  /**
   * Minimum interval between automatic revalidations. Rendering a block, or
   * scrolling one back into view, will not go to the network more often.
   */
  floorMs?: number;
  /**
   * Minimum interval between *user-initiated* refreshes. The floor above does
   * not apply to those — a refresh button that ignores the user for five
   * minutes reads as broken — but a button is still not a request generator.
   */
  cooldownMs?: number;
  now?: () => number;
}

export const DEFAULT_FLOOR_MS = 5 * 60_000;
export const DEFAULT_COOLDOWN_MS = 10_000;

export class CachedResource<T> {
  private readonly floorMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  /** The in-flight revalidation, if any. This is what coalesces callers. */
  private inFlight: Promise<Snapshot<T>> | null = null;
  /**
   * `-Infinity`, not 0: with 0 the cooldown would measure from the epoch, so
   * the very first refresh is only permitted because `Date.now()` happens to be
   * large. Under any injected clock starting at 0 it would be refused.
   */
  private lastForcedAt = -Infinity;
  private error: string | null = null;
  private errorKind: FetchErrorKind | null = null;
  private listeners = new Set<(snapshot: Snapshot<T>) => void>();

  constructor(
    private readonly key: string,
    private readonly cache: DashboardCache,
    private readonly fetcher: Fetcher<T>,
    options: CachedResourceOptions = {}
  ) {
    this.floorMs = options.floorMs ?? DEFAULT_FLOOR_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** The current state. Safe to call on every render; never touches the network. */
  snapshot(): Snapshot<T> {
    const entry = this.cache.get<T>(this.key);
    return {
      data: entry?.data ?? null,
      fetchedAt: entry?.fetchedAt ?? null,
      loading: this.inFlight !== null,
      error: this.error,
      errorKind: this.errorKind,
    };
  }

  /** Whether an automatic revalidation is currently permitted. */
  isStale(): boolean {
    return this.cache.isStale(this.cache.get(this.key), this.floorMs);
  }

  /**
   * Revalidate if the cached entry has aged past the floor. This is what a
   * block calls on first render and on becoming visible again — the common
   * path, and a no-op most of the time.
   */
  async ensureFresh(): Promise<Snapshot<T>> {
    if (!this.isStale()) return this.snapshot();
    return this.revalidate();
  }

  /**
   * Whether a user-initiated refresh would do anything, so a button can show
   * itself disabled rather than silently ignoring a click.
   */
  canForce(): boolean {
    return this.now() - this.lastForcedAt >= this.cooldownMs;
  }

  /**
   * A user-initiated refresh. Bypasses the staleness floor but honours the
   * cooldown; a click inside the cooldown returns the current snapshot without
   * a request.
   */
  async force(): Promise<Snapshot<T>> {
    if (!this.canForce()) return this.snapshot();
    this.lastForcedAt = this.now();
    return this.revalidate();
  }

  /**
   * Fetch and store. Concurrent callers share one request: the second caller
   * joins the promise the first started rather than opening its own, which is
   * what keeps N blocks on a note from making N requests.
   */
  revalidate(): Promise<Snapshot<T>> {
    if (this.inFlight) return this.inFlight;

    const run = async (): Promise<Snapshot<T>> => {
      try {
        const outcome = await this.fetcher();

        if (outcome.ok) {
          await this.cache.set(this.key, outcome.data);
          this.error = null;
          this.errorKind = null;
        } else {
          // Deliberately not clearing the cached data: a failed refresh is a
          // reason to show a warning beside the last-known-good panel, not to
          // blank it. The exception is `no-key`, handled below.
          this.error = outcome.message;
          this.errorKind = outcome.kind;

          // The account was disconnected or the key revoked, so the cached
          // data belongs to a session that no longer exists.
          if (outcome.kind === 'no-key') await this.cache.delete(this.key);
        }
      } catch (e) {
        // A fetcher is documented not to throw, but a block must not be able
        // to take a note's preview down if one ever does.
        this.error =
          e instanceof Error ? e.message : 'Something went wrong refreshing.';
        this.errorKind = 'error';
      } finally {
        this.inFlight = null;
      }

      const snapshot = this.snapshot();
      this.notify(snapshot);
      return snapshot;
    };

    this.inFlight = run();
    // Announce the loading state, but only after `inFlight` is set so a
    // listener re-reading the snapshot synchronously sees `loading: true`.
    this.notify(this.snapshot());
    return this.inFlight;
  }

  /** Re-render hook. Returns its own unsubscribe, for block teardown. */
  subscribe(listener: (snapshot: Snapshot<T>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Forget everything, in memory and on disk.
   *
   * Called when the API key changes: the previous account's platforms are not
   * this one's, and a block that kept rendering them would be showing one
   * account's data under another's credentials.
   */
  async reset(): Promise<void> {
    this.error = null;
    this.errorKind = null;
    this.lastForcedAt = -Infinity;
    await this.cache.delete(this.key);
    this.notify(this.snapshot());
  }

  /** The raw cached entry, for callers that need the timestamp alone. */
  entry(): CacheEntry<T> | null {
    return this.cache.get<T>(this.key);
  }

  private notify(snapshot: Snapshot<T>) {
    for (const listener of [...this.listeners]) {
      // One block throwing in its renderer must not stop the others updating.
      try {
        listener(snapshot);
      } catch {
        // Nothing useful to do here; the block owns its own error rendering.
      }
    }
  }
}
