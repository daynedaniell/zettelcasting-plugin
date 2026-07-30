import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apiBase, fetchConnectedPlatforms } from '../src/api';

type FetchCall = { url: string; init?: RequestInit };

/**
 * Run `body` with `fetch` replaced by a canned implementation, restoring the
 * real one afterwards even if the assertions throw.
 */
async function withFetch(
  impl: (url: string, init?: RequestInit) => unknown,
  body: (calls: FetchCall[]) => Promise<void>
) {
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  }) as unknown as typeof fetch;

  try {
    await body(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const platform = (key: string, isConnected: boolean) => ({
  key,
  provider: key,
  name: key.toUpperCase(),
  logoUrl: '',
  enabled: true,
  isConnected,
});

describe('apiBase', () => {
  it('trims a trailing slash', () => {
    assert.equal(apiBase('https://example.com/'), 'https://example.com');
    assert.equal(apiBase('https://example.com'), 'https://example.com');
    assert.equal(apiBase(''), '');
  });
});

describe('fetchConnectedPlatforms', () => {
  it('short-circuits without a key and never calls the network', () =>
    withFetch(
      () => jsonResponse([]),
      async (calls) => {
        assert.equal((await fetchConnectedPlatforms('')).status, 'no-key');
        assert.equal(calls.length, 0);
      }
    ));

  it('sends the key as an X-API-Key header', () =>
    withFetch(
      () => jsonResponse([platform('x', true)]),
      async (calls) => {
        await fetchConnectedPlatforms('secret', 'https://example.com/');

        assert.equal(
          calls[0].url,
          'https://example.com/api/integrations/pkm/platforms'
        );
        assert.deepEqual(calls[0].init?.headers, { 'X-API-Key': 'secret' });
      }
    ));

  it('keeps only connected platforms', () =>
    withFetch(
      () =>
        jsonResponse([
          platform('x', true),
          platform('bluesky', false),
          platform('mastodon', true),
        ]),
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') return;

        assert.deepEqual(
          result.connected.map((p) => p.key),
          ['x', 'mastodon']
        );
        assert.equal(result.message, '2 platforms connected.');
      }
    ));

  it('singularises the message for one platform', () =>
    withFetch(
      () => jsonResponse([platform('x', true)]),
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(
          result.status === 'ok' && result.message,
          '1 platform connected.'
        );
      }
    ));

  it('reports an empty account as ok with nothing connected', () =>
    withFetch(
      () => jsonResponse([platform('x', false)]),
      async () => {
        const result = await fetchConnectedPlatforms('key');

        assert.equal(result.status, 'ok');
        assert.equal(result.status === 'ok' && result.connected.length, 0);
        assert.match(result.message, /No platforms connected/);
      }
    ));

  it('drops entries with no usable key', () =>
    withFetch(
      () => jsonResponse([{ isConnected: true }, null, platform('x', true)]),
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(result.status === 'ok' && result.connected.length, 1);
      }
    ));

  it('treats 401 and 403 as a bad key', async () => {
    for (const status of [401, 403]) {
      await withFetch(
        () => jsonResponse({}, status),
        async () => {
          assert.equal(
            (await fetchConnectedPlatforms('key')).status,
            'unauthorized'
          );
        }
      );
    }
  });

  it('reports any other failure status as a server error', () =>
    withFetch(
      () => jsonResponse({}, 500),
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(result.status, 'error');
        assert.match(result.message, /500/);
      }
    ));

  it('turns a network failure into an error result rather than throwing', () =>
    withFetch(
      () => {
        throw new Error('offline');
      },
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(result.status, 'error');
        assert.match(result.message, /Could not reach/);
      }
    ));

  it('rejects a body that is not JSON', () =>
    withFetch(
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      }),
      async () => {
        assert.equal((await fetchConnectedPlatforms('key')).status, 'error');
      }
    ));

  it('rejects a JSON body that is not an array', () =>
    withFetch(
      () => jsonResponse({ platforms: [] }),
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(result.status, 'error');
        assert.match(result.message, /unexpected/);
      }
    ));
});
