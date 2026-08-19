import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CacheContents,
  DashboardCache,
  MAX_ENTRY_AGE_MS,
} from '../src/dashboard/cache';

const MINUTE = 60_000;

/**
 * An in-memory stand-in for the `data.json` slice, recording every write so a
 * test can assert that a clean load does not dirty the file.
 */
function persistence(initial: unknown = {}) {
  const state = {
    stored: initial,
    writes: [] as CacheContents[],
  };

  return {
    state,
    adapter: {
      load: () => state.stored,
      save: async (entries: CacheContents) => {
        // Snapshot, so a later mutation of the live object cannot rewrite
        // history and hide a bug.
        state.stored = JSON.parse(JSON.stringify(entries)) as CacheContents;
        state.writes.push(state.stored as CacheContents);
      },
    },
  };
}

/** A cache over a clock the test advances by hand. */
function cacheAt(startMs: number, initial: unknown = {}) {
  const clock = { now: startMs };
  const p = persistence(initial);
  const cache = new DashboardCache(p.adapter, () => clock.now);
  return { cache, clock, ...p };
}

describe('DashboardCache', () => {
  describe('load', () => {
    it('restores entries written in an earlier session', async () => {
      const { cache } = cacheAt(1_000_000, {
        status: { data: { platforms: [] }, fetchedAt: 999_000 },
      });

      await cache.load();

      assert.deepEqual(cache.get('status')?.data, { platforms: [] });
      assert.equal(cache.get('status')?.fetchedAt, 999_000);
    });

    it('does not write when everything loaded cleanly', async () => {
      const { cache, state } = cacheAt(1_000_000, {
        status: { data: 1, fetchedAt: 999_000 },
      });

      await cache.load();

      // data.json is the settings file; a startup that rewrites it for no
      // reason races the settings tab and churns the user's vault sync.
      assert.equal(state.writes.length, 0);
    });

    it('drops entries past the maximum age and persists the pruning', async () => {
      const now = 10 * MAX_ENTRY_AGE_MS;
      const { cache, state } = cacheAt(now, {
        fresh: { data: 'keep', fetchedAt: now - MINUTE },
        ancient: { data: 'drop', fetchedAt: now - MAX_ENTRY_AGE_MS - 1 },
      });

      await cache.load();

      assert.equal(cache.get('fresh')?.data, 'keep');
      assert.equal(cache.get('ancient'), null);
      assert.equal(state.writes.length, 1);
      assert.deepEqual(Object.keys(state.stored as object), ['fresh']);
    });

    it('survives a hand-edited data.json', async () => {
      // Everything here is something a user could plausibly leave behind.
      const { cache } = cacheAt(1_000_000, {
        noTimestamp: { data: 'x' },
        stringTimestamp: { data: 'x', fetchedAt: 'yesterday' },
        nanTimestamp: { data: 'x', fetchedAt: NaN },
        notAnObject: 'nonsense',
        nullEntry: null,
        good: { data: 'x', fetchedAt: 999_000 },
      });

      await cache.load();

      for (const key of [
        'noTimestamp',
        'stringTimestamp',
        'nanTimestamp',
        'notAnObject',
        'nullEntry',
      ]) {
        assert.equal(cache.get(key), null, `${key} should have been dropped`);
      }
      assert.equal(cache.get('good')?.data, 'x');
    });

    it('treats a non-object store as empty rather than throwing', async () => {
      for (const stored of [null, undefined, 'nonsense', 42]) {
        const { cache } = cacheAt(1_000_000, stored);
        await cache.load();
        assert.equal(cache.get('anything'), null);
      }
    });

    it('keeps an entry stamped in the future', async () => {
      // A clock correction can leave a stamp ahead of now; that is not a
      // reason to throw away good data.
      const { cache } = cacheAt(1_000_000, {
        status: { data: 'x', fetchedAt: 2_000_000 },
      });

      await cache.load();

      assert.equal(cache.get('status')?.data, 'x');
    });
  });

  describe('set and get', () => {
    it('stamps an entry with the current clock and persists it', async () => {
      const { cache, state } = cacheAt(500_000);

      await cache.set('status', { platforms: ['x'] });

      assert.equal(cache.get('status')?.fetchedAt, 500_000);
      assert.equal(state.writes.length, 1);
      assert.deepEqual(
        (state.stored as CacheContents).status.data,
        { platforms: ['x'] }
      );
    });

    it('overwrites in place', async () => {
      const { cache, clock } = cacheAt(500_000);

      await cache.set('status', 'first');
      clock.now += MINUTE;
      await cache.set('status', 'second');

      assert.equal(cache.get('status')?.data, 'second');
      assert.equal(cache.get('status')?.fetchedAt, 500_000 + MINUTE);
    });

    it('returns null for a key it has never seen', () => {
      const { cache } = cacheAt(500_000);
      assert.equal(cache.get('missing'), null);
    });
  });

  describe('staleness', () => {
    it('is fresh below the floor and stale at it', async () => {
      const { cache, clock } = cacheAt(0);
      await cache.set('status', 'x');
      const entry = cache.get('status');

      clock.now = 5 * MINUTE - 1;
      assert.equal(cache.isStale(entry, 5 * MINUTE), false);

      // At exactly the floor it is stale: the floor is a minimum interval
      // between requests, so waiting it out must permit the next one.
      clock.now = 5 * MINUTE;
      assert.equal(cache.isStale(entry, 5 * MINUTE), true);
    });

    it('treats a missing entry as stale', () => {
      const { cache } = cacheAt(0);
      assert.equal(cache.isStale(null, 5 * MINUTE), true);
    });

    it('clamps a backwards clock to zero age', async () => {
      const { cache, clock } = cacheAt(1_000_000);
      await cache.set('status', 'x');

      // NTP correction or a timezone change moves the clock back; a negative
      // age would otherwise pin the entry as permanently fresh.
      clock.now = 1_000_000 - MINUTE;

      const entry = cache.get('status');
      assert.equal(cache.ageOf(entry!), 0);
      assert.equal(cache.isStale(entry, 5 * MINUTE), false);
    });
  });

  describe('delete and clear', () => {
    it('forgets one key', async () => {
      const { cache } = cacheAt(0);
      await cache.set('a', 1);
      await cache.set('b', 2);

      await cache.delete('a');

      assert.equal(cache.get('a'), null);
      assert.equal(cache.get('b')?.data, 2);
    });

    it('does not write when deleting a key that was never there', async () => {
      const { cache, state } = cacheAt(0);
      await cache.delete('missing');
      assert.equal(state.writes.length, 0);
    });

    it('clears everything', async () => {
      const { cache, state } = cacheAt(0);
      await cache.set('a', 1);
      await cache.set('b', 2);

      await cache.clear();

      assert.equal(cache.get('a'), null);
      assert.equal(cache.get('b'), null);
      assert.deepEqual(state.stored, {});
    });

    it('does not write when clearing an already-empty cache', async () => {
      const { cache, state } = cacheAt(0);
      await cache.clear();
      assert.equal(state.writes.length, 0);
    });
  });
});
