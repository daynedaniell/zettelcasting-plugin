import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CacheContents, DashboardCache } from '../src/dashboard/cache';
import { CachedResource, FetchOutcome, Snapshot } from '../src/dashboard/client';

const MINUTE = 60_000;
const KEY = 'status';

/** A resource over a hand-advanced clock and a scriptable fetcher. */
function resourceAt(
  startMs: number,
  options: { floorMs?: number; cooldownMs?: number; stored?: unknown } = {}
) {
  const clock = { now: startMs };
  let stored: unknown = options.stored ?? {};

  const cache = new DashboardCache(
    {
      load: () => stored,
      save: async (entries: CacheContents) => {
        stored = JSON.parse(JSON.stringify(entries)) as CacheContents;
      },
    },
    () => clock.now
  );

  const fetcher = {
    calls: 0,
    /** Replaced per test to script the next outcome. */
    impl: (): Promise<FetchOutcome<string>> =>
      Promise.resolve({ ok: true, data: 'fresh' }),
  };

  const resource = new CachedResource<string>(
    KEY,
    cache,
    () => {
      fetcher.calls++;
      return fetcher.impl();
    },
    {
      floorMs: options.floorMs ?? 5 * MINUTE,
      cooldownMs: options.cooldownMs ?? 10_000,
      now: () => clock.now,
    }
  );

  return { resource, cache, clock, fetcher };
}

/** A fetcher that resolves only when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('CachedResource', () => {
  describe('snapshot', () => {
    it('is readable before anything has been fetched', () => {
      const { resource } = resourceAt(0);
      const snapshot = resource.snapshot();

      // A block renders this on its first frame, so it must never be absent.
      assert.deepEqual(snapshot, {
        data: null,
        fetchedAt: null,
        loading: false,
        error: null,
        errorKind: null,
      });
    });

    it('returns cached data from an earlier session immediately', async () => {
      const { resource, cache } = resourceAt(MINUTE, {
        stored: { [KEY]: { data: 'from disk', fetchedAt: 0 } },
      });
      await cache.load();

      // No await on a fetch: this is the offline-open path.
      assert.equal(resource.snapshot().data, 'from disk');
      assert.equal(resource.snapshot().fetchedAt, 0);
    });
  });

  describe('coalescing', () => {
    it('serves concurrent callers from one request', async () => {
      const { resource, fetcher } = resourceAt(0);
      const gate = deferred<FetchOutcome<string>>();
      fetcher.impl = () => gate.promise;

      const all = Promise.all([
        resource.revalidate(),
        resource.revalidate(),
        resource.revalidate(),
      ]);

      gate.resolve({ ok: true, data: 'once' });
      const snapshots = await all;

      // Three blocks on a note is three calls to revalidate and one request.
      assert.equal(fetcher.calls, 1);
      for (const snapshot of snapshots) assert.equal(snapshot.data, 'once');
    });

    it('allows a new request once the previous one has settled', async () => {
      const { resource, fetcher, clock } = resourceAt(0);

      await resource.revalidate();
      clock.now += 10 * MINUTE;
      await resource.revalidate();

      assert.equal(fetcher.calls, 2);
    });

    it('reports loading while a request is in flight', async () => {
      const { resource, fetcher } = resourceAt(0);
      const gate = deferred<FetchOutcome<string>>();
      fetcher.impl = () => gate.promise;

      const pending = resource.revalidate();
      assert.equal(resource.snapshot().loading, true);

      gate.resolve({ ok: true, data: 'done' });
      await pending;
      assert.equal(resource.snapshot().loading, false);
    });
  });

  describe('the staleness floor', () => {
    it('does not go to the network below the floor', async () => {
      const { resource, fetcher, clock } = resourceAt(0);

      await resource.revalidate();
      clock.now += 5 * MINUTE - 1;
      await resource.ensureFresh();

      // Re-opening a note, or scrolling the block back into view, is not a
      // reason to hit the API again.
      assert.equal(fetcher.calls, 1);
    });

    it('goes to the network once the floor has passed', async () => {
      const { resource, fetcher, clock } = resourceAt(0);

      await resource.revalidate();
      clock.now += 5 * MINUTE;
      await resource.ensureFresh();

      assert.equal(fetcher.calls, 2);
    });

    it('fetches on first render when there is nothing cached', async () => {
      const { resource, fetcher } = resourceAt(0);
      await resource.ensureFresh();
      assert.equal(fetcher.calls, 1);
    });
  });

  describe('manual refresh', () => {
    it('bypasses the floor', async () => {
      const { resource, fetcher, clock } = resourceAt(0);

      await resource.revalidate();
      clock.now += MINUTE;
      await resource.force();

      // The floor governs automatic revalidation only; a user who clicks
      // refresh gets a refresh.
      assert.equal(fetcher.calls, 2);
    });

    it('honours its own cooldown', async () => {
      const { resource, fetcher, clock } = resourceAt(0, { cooldownMs: 10_000 });

      await resource.force();
      clock.now += 9_999;
      await resource.force();

      assert.equal(fetcher.calls, 1);
      assert.equal(resource.canForce(), false);
    });

    it('permits the next refresh once the cooldown expires', async () => {
      const { resource, fetcher, clock } = resourceAt(0, { cooldownMs: 10_000 });

      await resource.force();
      clock.now += 10_000;

      assert.equal(resource.canForce(), true);
      await resource.force();
      assert.equal(fetcher.calls, 2);
    });
  });

  describe('failure handling', () => {
    it('keeps last-known-good data when a refresh fails', async () => {
      const { resource, fetcher, clock } = resourceAt(0);

      await resource.revalidate();
      fetcher.impl = () =>
        Promise.resolve({ ok: false, kind: 'error', message: 'offline' });
      clock.now += 10 * MINUTE;
      await resource.revalidate();

      // A failed refresh warrants a warning beside the panel, not a blank one.
      const snapshot = resource.snapshot();
      assert.equal(snapshot.data, 'fresh');
      assert.equal(snapshot.error, 'offline');
      assert.equal(snapshot.errorKind, 'error');
    });

    it('clears the error on the next success', async () => {
      const { resource, fetcher, clock } = resourceAt(0);

      fetcher.impl = () =>
        Promise.resolve({ ok: false, kind: 'error', message: 'offline' });
      await resource.revalidate();

      fetcher.impl = () => Promise.resolve({ ok: true, data: 'back' });
      clock.now += 10 * MINUTE;
      await resource.revalidate();

      assert.equal(resource.snapshot().error, null);
      assert.equal(resource.snapshot().data, 'back');
    });

    it('drops cached data when the key is gone', async () => {
      const { resource, fetcher, clock } = resourceAt(0);

      await resource.revalidate();
      fetcher.impl = () =>
        Promise.resolve({ ok: false, kind: 'no-key', message: 'no key' });
      clock.now += 10 * MINUTE;
      await resource.revalidate();

      // The key was removed or revoked, so the cached platforms belong to a
      // session that no longer exists.
      assert.equal(resource.snapshot().data, null);
    });

    it('keeps data on an unauthorized response', async () => {
      const { resource, fetcher, clock } = resourceAt(0);

      await resource.revalidate();
      fetcher.impl = () =>
        Promise.resolve({ ok: false, kind: 'unauthorized', message: 'bad key' });
      clock.now += 10 * MINUTE;
      await resource.revalidate();

      // A mistyped key is recoverable and often transient while typing; the
      // last good panel plus a warning beats a blank one.
      assert.equal(resource.snapshot().data, 'fresh');
      assert.equal(resource.snapshot().errorKind, 'unauthorized');
    });

    it('does not propagate a throwing fetcher', async () => {
      const { resource, fetcher } = resourceAt(0);
      fetcher.impl = () => Promise.reject(new Error('boom'));

      const snapshot = await resource.revalidate();

      // A block that throws takes the note's whole preview down with it.
      assert.equal(snapshot.error, 'boom');
      assert.equal(snapshot.loading, false);
    });

    it('recovers from a throwing fetcher rather than wedging in flight', async () => {
      const { resource, fetcher, clock } = resourceAt(0);
      fetcher.impl = () => Promise.reject(new Error('boom'));
      await resource.revalidate();

      fetcher.impl = () => Promise.resolve({ ok: true, data: 'recovered' });
      clock.now += 10 * MINUTE;
      await resource.revalidate();

      assert.equal(resource.snapshot().data, 'recovered');
      assert.equal(fetcher.calls, 2);
    });
  });

  describe('subscribers', () => {
    it('notifies on loading and again on settle', async () => {
      const { resource } = resourceAt(0);
      const seen: Snapshot<string>[] = [];
      resource.subscribe((s) => seen.push(s));

      await resource.revalidate();

      assert.equal(seen.length, 2);
      assert.equal(seen[0].loading, true);
      assert.equal(seen[1].loading, false);
      assert.equal(seen[1].data, 'fresh');
    });

    it('stops notifying after unsubscribe', async () => {
      const { resource, clock } = resourceAt(0);
      let count = 0;
      const unsubscribe = resource.subscribe(() => count++);

      await resource.revalidate();
      const afterFirst = count;
      unsubscribe();
      clock.now += 10 * MINUTE;
      await resource.revalidate();

      // Block teardown must actually detach, or a closed note keeps rendering.
      assert.equal(count, afterFirst);
    });

    it('keeps notifying the others when one listener throws', async () => {
      const { resource } = resourceAt(0);
      let reached = false;
      resource.subscribe(() => {
        throw new Error('bad renderer');
      });
      resource.subscribe(() => {
        reached = true;
      });

      await resource.revalidate();

      assert.equal(reached, true);
    });
  });

  describe('reset', () => {
    it('forgets data and error state', async () => {
      const { resource } = resourceAt(0);
      await resource.revalidate();

      await resource.reset();

      // Called when the API key changes: one account's data must not render
      // under another's credentials.
      assert.equal(resource.snapshot().data, null);
      assert.equal(resource.snapshot().error, null);
      assert.equal(resource.canForce(), true);
    });
  });
});
