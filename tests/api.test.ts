import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  apiBase,
  fetchConnectedPlatforms,
  multipartBoundary,
  multipartFileBody,
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
