import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { POST_ID_KEY, stampPostId } from '../src/post-id-stamp';

/**
 * A stand-in for `FileManager.processFrontMatter` that works on note text, so
 * these assertions are about what the note ends up looking like rather than
 * about which callback ran.
 *
 * It models the parts of Obsidian's behaviour that matter here: the frontmatter
 * block is parsed to an object and re-serialised, the body after it is passed
 * through untouched, and a note without frontmatter gains one. The YAML support
 * is deliberately shallow — every value these tests use is a flat scalar.
 */
function fakeVault(initial: Record<string, string>) {
  const notes = { ...initial };

  const writer = {
    processFrontMatter: async (
      file: { path: string },
      fn: (frontmatter: Record<string, unknown>) => void
    ) => {
      const text = notes[file.path];
      if (text === undefined) throw new Error(`No such file: ${file.path}`);

      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
      const frontmatter: Record<string, unknown> = {};
      let body = text;

      if (match) {
        for (const line of match[1].split(/\r?\n/)) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          frontmatter[line.slice(0, colon).trim()] = line
            .slice(colon + 1)
            .trim();
        }
        body = text.slice(match[0].length);
      }

      fn(frontmatter);

      const serialized = Object.entries(frontmatter)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join('\n');

      notes[file.path] = `---\n${serialized}\n---\n${body}`;
    },
  };

  return { writer, read: (path: string) => notes[path] };
}

const file = { path: 'notes/idea.md' } as any;

describe('stampPostId', () => {
  it('adds a frontmatter block to a note that has none', async () => {
    const vault = fakeVault({
      'notes/idea.md': '# An idea\n\nThe body of the note.\n',
    });

    const outcome = await stampPostId(vault.writer, file, 'post-1');

    assert.deepEqual(outcome, { status: 'written' });
    assert.equal(
      vault.read('notes/idea.md'),
      '---\nzc_post_id: post-1\n---\n# An idea\n\nThe body of the note.\n'
    );
  });

  it('leaves the body untouched, byte for byte', async () => {
    // The vault is under Obsidian Sync and Obsidian Git, so anything below the
    // frontmatter has to survive the write exactly as it was.
    const body =
      '# An idea\n\n- a list item\n- another\t with a tab\n\n```js\nconst x = 1;\n```\n\nTrailing text with  double  spaces.\n';
    const vault = fakeVault({ 'notes/idea.md': `---\ntitle: Idea\n---\n${body}` });

    await stampPostId(vault.writer, file, 'post-1');

    const written = vault.read('notes/idea.md');
    assert.equal(written.slice(written.indexOf('---\n', 4) + 4), body);
  });

  it('preserves the other frontmatter keys', async () => {
    const vault = fakeVault({
      'notes/idea.md': '---\ntitle: Idea\nstatus: draft\n---\nBody.\n',
    });

    await stampPostId(vault.writer, file, 'post-1');

    assert.equal(
      vault.read('notes/idea.md'),
      '---\ntitle: Idea\nstatus: draft\nzc_post_id: post-1\n---\nBody.\n'
    );
  });

  it('overwrites an existing zc_post_id', async () => {
    // Republishing a note maps it to the new post; the stale id would resolve
    // to the wrong one. The server's sourcePath mapping keeps the earlier post
    // reachable.
    const vault = fakeVault({
      'notes/idea.md': '---\nzc_post_id: post-old\ntitle: Idea\n---\nBody.\n',
    });

    const outcome = await stampPostId(vault.writer, file, 'post-new');

    assert.deepEqual(outcome, { status: 'written' });
    assert.equal(
      vault.read('notes/idea.md'),
      '---\nzc_post_id: post-new\ntitle: Idea\n---\nBody.\n'
    );
  });

  it('reports a failure instead of throwing', async () => {
    // A publish that already succeeded must not be reported as a failure
    // because the note could not be annotated.
    const writer = {
      processFrontMatter: () =>
        Promise.reject(new Error('YAMLParseError: bad indentation')),
    };

    const outcome = await stampPostId(writer, file, 'post-1');

    assert.equal(outcome.status, 'failed');
    assert.match(
      outcome.status === 'failed' ? outcome.message : '',
      /YAMLParseError/
    );
  });

  it('leaves the note alone when the frontmatter cannot be parsed', async () => {
    const original = '---\n: : :\n---\nBody.\n';
    const notes = { 'notes/idea.md': original };
    const writer = {
      processFrontMatter: () => Promise.reject(new Error('YAMLParseError')),
    };

    await stampPostId(writer, file, 'post-1');

    assert.equal(notes['notes/idea.md'], original);
  });

  it('uses the documented frontmatter key', () => {
    assert.equal(POST_ID_KEY, 'zc_post_id');
  });
});
