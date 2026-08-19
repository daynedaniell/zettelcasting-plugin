import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BlockConfigResult,
  normalizePlatformId,
  parseBlockConfig,
} from '../src/dashboard/block-config';

/**
 * Drive the validator with an already-parsed value.
 *
 * Obsidian bundles js-yaml and the plugin uses it directly; what this module
 * owns is everything *after* the parse, so the parser is injected rather than
 * reimplemented. The YAML-failure path is covered by `throwingParse` below.
 */
function withParsed(value: unknown): BlockConfigResult {
  // Any non-empty source will do — the injected parser ignores it.
  return parseBlockConfig('placeholder', () => value);
}

const throwingParse = (message: string) => () => {
  throw new Error(message);
};

/** Assert success and hand back the config. */
function configOf(result: BlockConfigResult) {
  assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

/** Assert failure and hand back the message. */
function messageOf(result: BlockConfigResult): string {
  assert.equal(result.ok, false, `expected failure, got: ${JSON.stringify(result)}`);
  if (result.ok) throw new Error('unreachable');
  return result.message;
}

describe('parseBlockConfig', () => {
  describe('empty bodies', () => {
    it('treats an empty block as every platform, non-compact', () => {
      const { config, warnings } = configOf(parseBlockConfig(''));
      assert.deepEqual(config, { platforms: null, compact: false });
      assert.deepEqual(warnings, []);
    });

    it('treats a whitespace-only block the same, without parsing', () => {
      // The parser must not even run: `parseYaml('  ')` is a pointless call on
      // every render of an empty block.
      const result = parseBlockConfig('   \n\t\n', throwingParse('called'));
      assert.equal(configOf(result).config.platforms, null);
    });

    it('treats a comment-only block as empty', () => {
      // A body of only comments parses to null, not to an object.
      assert.equal(configOf(withParsed(null)).config.platforms, null);
      assert.equal(configOf(withParsed(undefined)).config.platforms, null);
    });
  });

  describe('platforms', () => {
    it('reads a list', () => {
      const { config } = configOf(withParsed({ platforms: ['x', 'linkedin'] }));
      assert.deepEqual(config.platforms, ['twitter', 'linkedin']);
    });

    it('accepts a bare string for a single platform', () => {
      // `platforms: ghost` is a natural thing to write and unambiguous.
      const { config } = configOf(withParsed({ platforms: 'ghost' }));
      assert.deepEqual(config.platforms, ['ghost']);
    });

    it('normalises case and surrounding space', () => {
      const { config } = configOf(
        withParsed({ platforms: ['  LinkedIn ', 'GHOST'] })
      );
      assert.deepEqual(config.platforms, ['linkedin', 'ghost']);
    });

    it('collapses aliases that name the same platform', () => {
      // Otherwise `[x, twitter]` renders the same row twice.
      const { config } = configOf(
        withParsed({ platforms: ['x', 'twitter', 'x.com'] })
      );
      assert.deepEqual(config.platforms, ['twitter']);
    });

    it('folds the integration key onto the platform name', () => {
      // The API keys Facebook as `facebook-page`; a note should not have to.
      const { config } = configOf(
        withParsed({ platforms: ['facebook', 'instagram-business'] })
      );
      assert.deepEqual(config.platforms, ['facebook', 'instagram']);
    });

    it('means every platform when omitted or null', () => {
      assert.equal(configOf(withParsed({ compact: true })).config.platforms, null);
      assert.equal(configOf(withParsed({ platforms: null })).config.platforms, null);
    });

    it('rejects an empty list, naming the fix', () => {
      // Rendering nothing at all is never what someone meant.
      const message = messageOf(withParsed({ platforms: [] }));
      assert.match(message, /empty/i);
      assert.match(message, /Remove it/);
    });

    it('rejects a non-string entry, quoting what it found', () => {
      const message = messageOf(withParsed({ platforms: ['x', 42] }));
      assert.match(message, /platforms/);
      assert.match(message, /42/);
    });

    it('rejects a blank entry', () => {
      assert.equal(withParsed({ platforms: ['x', '   '] }).ok, false);
    });

    it('rejects a nested structure', () => {
      const message = messageOf(withParsed({ platforms: [{ name: 'x' }] }));
      assert.match(message, /platforms/);
    });
  });

  describe('compact', () => {
    it('reads true and false', () => {
      assert.equal(configOf(withParsed({ compact: true })).config.compact, true);
      assert.equal(configOf(withParsed({ compact: false })).config.compact, false);
    });

    it('defaults to false when omitted or null', () => {
      assert.equal(configOf(withParsed({})).config.compact, false);
      assert.equal(configOf(withParsed({ compact: null })).config.compact, false);
    });

    it('rejects a non-boolean rather than guessing', () => {
      // YAML already turns `yes` and `true` into booleans; anything still a
      // string here was meant as something else.
      const message = messageOf(withParsed({ compact: 'sure' }));
      assert.match(message, /compact/);
      assert.match(message, /true or false/);
    });

    it('rejects a number', () => {
      assert.equal(withParsed({ compact: 1 }).ok, false);
    });
  });

  describe('unknown options', () => {
    it('warns but still renders', () => {
      // A typo in one option should not blank a panel that is otherwise fine.
      const { config, warnings } = configOf(
        withParsed({ compact: true, platfroms: ['x'] })
      );
      assert.equal(config.compact, true);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /platfroms/);
    });

    it('names every unknown option in one warning', () => {
      const { warnings } = configOf(withParsed({ foo: 1, bar: 2 }));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /"foo"/);
      assert.match(warnings[0], /"bar"/);
    });

    it('says nothing when every option is recognised', () => {
      const { warnings } = configOf(
        withParsed({ platforms: ['x'], compact: true })
      );
      assert.deepEqual(warnings, []);
    });
  });

  describe('malformed input', () => {
    it('reports a YAML error instead of throwing', () => {
      const result = parseBlockConfig(
        'platforms: [x',
        throwingParse('unexpected end of the stream')
      );
      const message = messageOf(result);
      assert.match(message, /Could not read the block options/);
      // The parser's own complaint is the useful half; keep it.
      assert.match(message, /unexpected end of the stream/);
    });

    it('rejects a body that is a bare scalar', () => {
      const message = messageOf(withParsed('compact'));
      assert.match(message, /Expected options/);
      assert.match(message, /"compact"/);
    });

    it('rejects a body that is a bare list', () => {
      const message = messageOf(withParsed(['x', 'linkedin']));
      assert.match(message, /Expected options/);
      assert.match(message, /a list/);
    });

    it('never throws, whatever it is handed', () => {
      const inputs: unknown[] = [
        0,
        false,
        '',
        [],
        [[]],
        { platforms: { x: true } },
        { compact: [] },
        { platforms: [null] },
      ];
      for (const input of inputs) {
        assert.doesNotThrow(
          () => withParsed(input),
          `threw on ${JSON.stringify(input)}`
        );
      }
    });
  });
});

describe('normalizePlatformId', () => {
  it('lowercases and trims', () => {
    assert.equal(normalizePlatformId('  Ghost '), 'ghost');
  });

  it('resolves aliases in both directions of the filter', () => {
    // The user's `x` and the server's `twitter` must land on the same id, or
    // the filter silently matches nothing.
    assert.equal(normalizePlatformId('x'), normalizePlatformId('twitter'));
    assert.equal(
      normalizePlatformId('facebook-page'),
      normalizePlatformId('facebook')
    );
  });

  it('passes an unknown id through unchanged', () => {
    // A platform this build has never heard of should still be filterable.
    assert.equal(normalizePlatformId('Mastodon'), 'mastodon');
  });
});
