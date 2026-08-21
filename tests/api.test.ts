import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  apiBase,
  buildPublishPayload,
  fetchConnectedPlatforms,
  fetchIntegrationStatus,
  multipartBoundary,
  multipartFileBody,
  publishPost,
} from '../src/api';
import { StubRequestUrlParam, requestUrlStub } from './obsidian.stub';

/**
 * Run `body` with `requestUrl` replaced by a canned implementation, restoring
 * the default afterwards even if the assertions throw.
 *
 * `src/api.ts` imports `requestUrl` from `obsidian`, which the test build
 * resolves to `obsidian.stub.ts` — the same module instance this file imports,
 * so swapping the implementation here is what the code under test sees.
 */
async function withRequestUrl(
  impl: (param: StubRequestUrlParam) => unknown,
  body: (calls: StubRequestUrlParam[]) => Promise<void>
) {
  const realImpl = requestUrlStub.impl;
  const calls: StubRequestUrlParam[] = [];

  requestUrlStub.impl = (param) => {
    calls.push(param);
    return impl(param);
  };

  try {
    await body(calls);
  } finally {
    requestUrlStub.impl = realImpl;
  }
}

/**
 * `RequestUrlResponse.json` is a getter that parses on access, so a body that
 * isn't JSON throws at the point of reading rather than at request time.
 */
const jsonResponse = (body: unknown, status = 200) => ({
  status,
  headers: {},
  text: JSON.stringify(body),
  get json() {
    return body;
  },
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

describe('multipartFileBody', () => {
  const BOUNDARY = '----zettelcastingtestboundary';

  /** Latin-1, so every byte round-trips into a comparable character. */
  const asBinaryString = (buffer: ArrayBuffer) =>
    Buffer.from(buffer).toString('latin1');

  it('lays the envelope out exactly as a browser would', () => {
    const bytes = new TextEncoder().encode('hello').buffer;
    const body = multipartFileBody(
      'file',
      'note.png',
      'image/png',
      bytes,
      BOUNDARY
    );

    assert.equal(
      asBinaryString(body),
      `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="note.png"\r\n' +
        'Content-Type: image/png\r\n' +
        '\r\n' +
        'hello\r\n' +
        `--${BOUNDARY}--\r\n`
    );
  });

  it('escapes a quote, CR and LF in the filename', () => {
    const body = multipartFileBody(
      'file',
      'a"b\r\nc.png',
      'image/png',
      new ArrayBuffer(0),
      BOUNDARY
    );

    // Unescaped, the quote would close the header's quoted string early and
    // the newline would end the header altogether.
    assert.match(
      asBinaryString(body),
      /filename="a%22b%0D%0Ac\.png"\r\n/
    );
  });

  it('leaves a percent sign alone, as browsers do', () => {
    const body = multipartFileBody(
      'file',
      '100%.png',
      'image/png',
      new ArrayBuffer(0),
      BOUNDARY
    );

    assert.match(asBinaryString(body), /filename="100%\.png"/);
  });

  it('carries binary payloads through byte for byte', () => {
    const payload = Uint8Array.from([0x00, 0xff, 0x0d, 0x0a, 0x89, 0x50]);
    const body = new Uint8Array(
      multipartFileBody(
        'file',
        'x.png',
        'image/png',
        payload.buffer,
        BOUNDARY
      )
    );

    // The payload sits between the header and the closing boundary; find it by
    // the blank line that ends the part header.
    const start = asBinaryString(body.buffer).indexOf('\r\n\r\n') + 4;
    assert.deepEqual(
      Array.from(body.slice(start, start + payload.length)),
      Array.from(payload)
    );
  });

  it('mints a distinct boundary each time', () => {
    const first = multipartBoundary();
    assert.notEqual(first, multipartBoundary());
    // Long enough that matching file bytes is not a practical concern.
    assert.ok(first.length >= 40, first);
  });
});

describe('fetchConnectedPlatforms', () => {
  it('short-circuits without a key and never calls the network', () =>
    withRequestUrl(
      () => jsonResponse([]),
      async (calls) => {
        assert.equal((await fetchConnectedPlatforms('')).status, 'no-key');
        assert.equal(calls.length, 0);
      }
    ));

  it('sends the key as an X-API-Key header', () =>
    withRequestUrl(
      () => jsonResponse([platform('x', true)]),
      async (calls) => {
        await fetchConnectedPlatforms('secret', 'https://example.com/');

        assert.equal(
          calls[0].url,
          'https://example.com/api/integrations/pkm/platforms'
        );
        assert.deepEqual(calls[0].headers, { 'X-API-Key': 'secret' });
      }
    ));

  it('asks requestUrl for the status rather than an exception', () =>
    withRequestUrl(
      () => jsonResponse([platform('x', true)]),
      async (calls) => {
        await fetchConnectedPlatforms('secret');
        // Without this every non-2xx would throw past the status handling
        // below and land in the generic "could not reach" branch.
        assert.equal(calls[0].throw, false);
      }
    ));

  it('keeps only connected platforms', () =>
    withRequestUrl(
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
    withRequestUrl(
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
    withRequestUrl(
      () => jsonResponse([platform('x', false)]),
      async () => {
        const result = await fetchConnectedPlatforms('key');

        assert.equal(result.status, 'ok');
        assert.equal(result.status === 'ok' && result.connected.length, 0);
        assert.match(result.message, /No platforms connected/);
      }
    ));

  it('drops entries with no usable key', () =>
    withRequestUrl(
      () => jsonResponse([{ isConnected: true }, null, platform('x', true)]),
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(result.status === 'ok' && result.connected.length, 1);
      }
    ));

  it('treats 401 and 403 as a bad key', async () => {
    for (const status of [401, 403]) {
      await withRequestUrl(
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
    withRequestUrl(
      () => jsonResponse({}, 500),
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(result.status, 'error');
        assert.match(result.message, /500/);
      }
    ));

  it('turns a network failure into an error result rather than throwing', () =>
    withRequestUrl(
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
    withRequestUrl(
      () => ({
        status: 200,
        headers: {},
        text: 'not json',
        get json(): unknown {
          throw new Error('not json');
        },
      }),
      async () => {
        assert.equal((await fetchConnectedPlatforms('key')).status, 'error');
      }
    ));

  it('rejects a JSON body that is not an array', () =>
    withRequestUrl(
      () => jsonResponse({ platforms: [] }),
      async () => {
        const result = await fetchConnectedPlatforms('key');
        assert.equal(result.status, 'error');
        assert.match(result.message, /unexpected/);
      }
    ));
});

/** One status row, valid unless a field is overridden with something broken. */
const statusPlatform = (over: Record<string, unknown> = {}) => ({
  key: 'twitter',
  provider: 'twitter',
  name: 'X',
  state: 'connected',
  tokenExpiresAt: null,
  lastPublishedAt: '2026-08-17T14:22:10.000Z',
  failedJobCount: 0,
  ...over,
});

const statusBody = (platforms: unknown[], over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-08-18T09:00:00.000Z',
  platforms,
  ...over,
});

describe('fetchIntegrationStatus', () => {
  it('makes no request at all without an API key', () =>
    withRequestUrl(
      () => {
        throw new Error('should not have been called');
      },
      async (calls) => {
        const result = await fetchIntegrationStatus('');
        assert.equal(result.status, 'no-key');
        // The community-store rule is no network before the user connects an
        // account, so this asserts the absence of the call, not just the result.
        assert.equal(calls.length, 0);
      }
    ));

  it('calls the status endpoint with the key in the header', () =>
    withRequestUrl(
      () => jsonResponse(statusBody([statusPlatform()])),
      async (calls) => {
        await fetchIntegrationStatus('key', 'https://example.com/');
        assert.equal(
          calls[0].url,
          'https://example.com/api/integrations/pkm/status'
        );
        assert.equal(calls[0].headers?.['X-API-Key'], 'key');
      }
    ));

  it('returns the parsed payload', () =>
    withRequestUrl(
      () => jsonResponse(statusBody([statusPlatform({ failedJobCount: 3 })])),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') return;
        assert.equal(result.data.generatedAt, '2026-08-18T09:00:00.000Z');
        assert.equal(result.data.platforms.length, 1);
        assert.equal(result.data.platforms[0].failedJobCount, 3);
        assert.equal(result.data.platforms[0].state, 'connected');
      }
    ));

  it('degrades an unrecognised state to unknown rather than guessing', () =>
    withRequestUrl(
      () => jsonResponse(statusBody([statusPlatform({ state: 'rate_limited' })])),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') return;
        // A newer server must not have its sixth state silently misfiled as
        // one of the five this build knows.
        assert.equal(result.data.platforms[0].state, 'unknown');
      }
    ));

  it('drops an unusable row without failing the whole payload', () =>
    withRequestUrl(
      () =>
        jsonResponse(
          statusBody([
            statusPlatform({ key: '' }),
            null,
            'nonsense',
            statusPlatform({ key: 'ghost', name: 'Ghost' }),
          ])
        ),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') return;
        assert.equal(result.data.platforms.length, 1);
        assert.equal(result.data.platforms[0].key, 'ghost');
      }
    ));

  it('clamps a nonsensical failure count instead of rendering it', () =>
    withRequestUrl(
      () =>
        jsonResponse(
          statusBody([
            statusPlatform({ key: 'a', failedJobCount: -4 }),
            statusPlatform({ key: 'b', failedJobCount: 'lots' }),
            statusPlatform({ key: 'c', failedJobCount: 2.7 }),
          ])
        ),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') return;
        assert.deepEqual(
          result.data.platforms.map((p) => p.failedJobCount),
          [0, 0, 2]
        );
      }
    ));

  it('nulls a timestamp that will not parse', () =>
    withRequestUrl(
      () =>
        jsonResponse(
          statusBody([
            statusPlatform({
              lastPublishedAt: 'whenever',
              tokenExpiresAt: 'soon',
            }),
          ])
        ),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') return;
        assert.equal(result.data.platforms[0].lastPublishedAt, null);
        assert.equal(result.data.platforms[0].tokenExpiresAt, null);
      }
    ));

  it('substitutes a usable generatedAt when the server sends none', () =>
    withRequestUrl(
      () => jsonResponse(statusBody([statusPlatform()], { generatedAt: null })),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') return;
        // "Last synced" counts from this; leaving it null would read "never"
        // for data that just arrived.
        assert.ok(!Number.isNaN(Date.parse(result.data.generatedAt)));
      }
    ));

  it('counts only platforms that are actually connected in its message', () =>
    withRequestUrl(
      () =>
        jsonResponse(
          statusBody([
            statusPlatform({ key: 'a', state: 'connected' }),
            statusPlatform({ key: 'b', state: 'expiring_soon' }),
            statusPlatform({ key: 'c', state: 'disconnected' }),
          ])
        ),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') return;
        assert.match(result.message, /2 platforms connected/);
      }
    ));

  it('reports an invalid key the same way the platform lookup does', () =>
    withRequestUrl(
      () => jsonResponse({}, 401),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'unauthorized');
        assert.match(result.message, /Invalid API key/);
      }
    ));

  it('reports a server error', () =>
    withRequestUrl(
      () => jsonResponse({}, 500),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'error');
        assert.match(result.message, /500/);
      }
    ));

  it('reports a network failure', () =>
    withRequestUrl(
      () => {
        throw new Error('offline');
      },
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'error');
        assert.match(result.message, /Could not reach/);
      }
    ));

  it('rejects a payload with no platforms array', () =>
    withRequestUrl(
      () => jsonResponse({ generatedAt: '2026-08-18T09:00:00.000Z' }),
      async () => {
        const result = await fetchIntegrationStatus('key');
        assert.equal(result.status, 'error');
        assert.match(result.message, /unexpected/);
      }
    ));
});


describe('buildPublishPayload', () => {
  const base = {
    body: 'A thought worth posting',
    platform: 'twitter',
    scheduledFor: new Date('2026-08-21T10:00:00Z'),
    media: [],
  };

  it('carries the source mapping when both values are present', () => {
    const payload = buildPublishPayload({
      ...base,
      sourcePath: '3 - Resources/10-01-06 - Appeal to Consequences.md',
      sourceVaultId: 'vault-uuid',
    });

    assert.equal(
      payload.sourcePath,
      '3 - Resources/10-01-06 - Appeal to Consequences.md'
    );
    assert.equal(payload.sourceVaultId, 'vault-uuid');
  });

  it('omits the keys entirely rather than sending undefined', () => {
    // The server rejects unknown *and* malformed properties, so a key present
    // with no value is not the same as an absent key.
    const payload = buildPublishPayload(base);

    assert.equal('sourcePath' in payload, false);
    assert.equal('sourceVaultId' in payload, false);
  });

  it('omits a half-filled mapping', () => {
    // A vault id with no path, or the reverse, maps nothing. Sending one alone
    // would write a column that can never be resolved.
    const payload = buildPublishPayload({ ...base, sourcePath: 'note.md' });

    assert.equal('sourcePath' in payload, true);
    assert.equal('sourceVaultId' in payload, false);
  });

  it('preserves the fields the endpoint has always received', () => {
    const payload = buildPublishPayload(base);

    assert.equal(payload.body, 'A thought worth posting');
    assert.equal(payload.platform, 'twitter');
    assert.equal(payload.scheduledFor, base.scheduledFor);
    assert.deepEqual(payload.media, []);
    assert.deepEqual(payload.tags, ['scheduled']);
  });
});

describe('publishPost', () => {
  const input = {
    body: 'A thought worth posting',
    platform: 'twitter',
    scheduledFor: new Date('2026-08-21T10:00:00Z'),
    media: [],
    sourcePath: 'notes/idea.md',
    sourceVaultId: 'vault-uuid',
  };

  it('returns the post id from the response', async () => {
    await withRequestUrl(
      () => jsonResponse({ id: 'post-1', body: 'A thought worth posting' }),
      async (calls) => {
        const result = await publishPost(input, 'key', 'https://example.com');

        assert.deepEqual(result, { status: 'ok', postId: 'post-1' });
        assert.equal(calls.length, 1);
        assert.equal(
          calls[0].url,
          'https://example.com/api/integrations/pkm/posts'
        );
      }
    );
  });

  it('succeeds with a null id when the response carries none', async () => {
    // Nothing to stamp is not a publish failure — the post is already live.
    await withRequestUrl(
      () => jsonResponse({ ok: true }),
      async () => {
        const result = await publishPost(input, 'key', 'https://example.com');

        assert.deepEqual(result, { status: 'ok', postId: null });
      }
    );
  });

  it('retries once without the source fields when the server rejects them', async () => {
    // A plugin updated ahead of the server would otherwise fail every publish,
    // because the API rejects properties it does not recognise.
    await withRequestUrl(
      (param) => {
        const sent = JSON.parse(param.body as string) as Record<string, unknown>;
        return 'sourcePath' in sent
          ? jsonResponse(
              {
                message: 'Validation failed',
                errors: [{ property: 'sourcePath' }],
              },
              400
            )
          : jsonResponse({ id: 'post-1' });
      },
      async (calls) => {
        const result = await publishPost(input, 'key', 'https://example.com');

        assert.deepEqual(result, { status: 'ok', postId: 'post-1' });
        assert.equal(calls.length, 2);

        const retried = JSON.parse(calls[1].body as string) as Record<
          string,
          unknown
        >;
        assert.equal('sourcePath' in retried, false);
        assert.equal('sourceVaultId' in retried, false);
        // The post itself must be unchanged by the retry.
        assert.equal(retried.body, 'A thought worth posting');
        assert.deepEqual(retried.tags, ['scheduled']);
      }
    );
  });

  it('does not retry a 400 that is about something else', async () => {
    await withRequestUrl(
      () => jsonResponse({ message: 'Post body is empty' }, 400),
      async (calls) => {
        const result = await publishPost(input, 'key', 'https://example.com');

        assert.equal(result.status, 'error');
        assert.equal(calls.length, 1);
      }
    );
  });

  it('reports a server error rather than throwing', async () => {
    await withRequestUrl(
      () => jsonResponse({}, 500),
      async () => {
        const result = await publishPost(input, 'key', 'https://example.com');

        assert.equal(result.status, 'error');
        assert.match(
          result.status === 'error' ? result.message : '',
          /\(500\)/
        );
      }
    );
  });

  it('reports an unreachable server rather than throwing', async () => {
    await withRequestUrl(
      () => {
        throw new Error('offline');
      },
      async () => {
        const result = await publishPost(input, 'key', 'https://example.com');

        assert.equal(result.status, 'error');
        assert.match(
          result.status === 'error' ? result.message : '',
          /Could not reach/
        );
      }
    );
  });
});
