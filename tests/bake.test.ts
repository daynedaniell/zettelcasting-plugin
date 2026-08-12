import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bake } from '../src/BakeModal';
import { BakeSettings } from '../src/main';
import { normalizeForPublishing } from '../src/util';
import { createSettings, createVault } from './helpers/vault';

const CHILD = 'Child body.';

/** Bake `Root.md` out of an ad-hoc vault. */
async function bakeRoot(
  files: Record<string, string>,
  options: {
    subpath?: string | null;
    settings?: Partial<BakeSettings>;
    media?: Set<any>;
    range?: [number, number];
  } = {}
) {
  const vault = createVault(files);
  return bake(
    vault.app,
    vault.file('Root.md'),
    options.subpath ?? null,
    new Set(),
    createSettings(options.settings),
    options.media ?? new Set(),
    options.range
  );
}

describe('bake — whole file', () => {
  it('returns the note untouched when it has no links', async () => {
    const text = '# Title\n\nJust prose.\n';
    assert.equal(await bakeRoot({ 'Root.md': text }), text);
  });

  it('inlines a link on its own line and flattens one mid-sentence', async () => {
    const result = await bakeRoot({
      'Child.md': CHILD,
      'Root.md': 'Intro cites [[Child]] inline.\n\n![[Child]]\n',
    });
    assert.equal(result, 'Intro cites Child inline.\n\nChild body.\n');
  });

  it('uses the display text when a link is aliased', async () => {
    const result = await bakeRoot({
      'Child.md': CHILD,
      'Root.md': 'See [[Child|the child note]] for more.',
    });
    assert.equal(result, 'See the child note for more.');
  });

  it('leaves an unresolved link alone', async () => {
    const text = 'Points at [[Nowhere]].';
    assert.equal(await bakeRoot({ 'Root.md': text }), text);
  });

  it('transcludes recursively', async () => {
    const result = await bakeRoot({
      'Grand.md': 'Deep.',
      'Child.md': 'Child says:\n\n![[Grand]]',
      'Root.md': '![[Child]]',
    });
    assert.equal(result, 'Child says:\n\nDeep.');
  });

  it('strips the transcluded note frontmatter and block ids', async () => {
    const result = await bakeRoot({
      'Child.md': '---\ntags: [x]\n---\nChild body. ^ref',
      'Root.md': '![[Child]]',
    });
    assert.equal(result, CHILD);
  });

  it('breaks a transclusion cycle instead of recursing forever', async () => {
    const vault = createVault({
      'A.md': 'A\n\n![[B]]',
      'B.md': 'B\n\n![[A]]',
    });
    const result = await bake(
      vault.app,
      vault.file('A.md'),
      null,
      new Set(),
      createSettings()
    );
    assert.equal(result, 'A\n\nB\n\nA');
  });

  it('indents a transclusion to match the bullet it sits under', async () => {
    const result = await bakeRoot({
      'Child.md': 'First line.\nSecond line.',
      'Root.md': '- Item\n\t- ![[Child]]\n',
    });
    assert.equal(result, '- Item\n\t- First line.\n\tSecond line.\n');
  });

  it('does not inline into a list when bakeInList is off', async () => {
    const result = await bakeRoot({
      'Child.md': CHILD,
      'Root.md': '- Item\n\t- ![[Child]]\n',
      // Without the list handling the embed is mid-line, so it degrades.
    }, { settings: { bakeInList: false } });
    assert.equal(result, '- Item\n\t- Child\n');
  });

  it('honours the bakeLinks and bakeEmbeds toggles', async () => {
    const files = {
      'Child.md': CHILD,
      'Root.md': '[[Child]]\n\n![[Child]]',
    };

    assert.equal(
      await bakeRoot(files, { settings: { bakeLinks: false } }),
      '[[Child]]\n\nChild body.'
    );
    assert.equal(
      await bakeRoot(files, { settings: { bakeEmbeds: false } }),
      'Child body.\n\n![[Child]]'
    );
  });
});

describe('bake — attachments', () => {
  it('collects an embedded image and removes it from the body', async () => {
    const media = new Set<any>();
    const result = await bakeRoot(
      { 'pic.png': '', 'Root.md': 'Look:\n\n![[pic.png]]\n\nEnd.' },
      { media }
    );

    assert.equal(media.size, 1);
    assert.equal([...media][0].path, 'pic.png');
    assert.equal(result, 'Look:\n\n\n\nEnd.');
  });

  it('still collects media when embed inlining is disabled', async () => {
    const media = new Set<any>();
    await bakeRoot(
      { 'pic.png': '', 'Root.md': '![[pic.png]]' },
      { media, settings: { bakeEmbeds: false } }
    );
    assert.equal(media.size, 1);
  });

  it('still collects media when file link conversion is off', async () => {
    // `convertFileLinks` governs *unsupported* attachments only. Images and
    // videos are matched earlier and uploaded either way, so turning it off
    // must never cost a post its media.
    const media = new Set<any>();
    await bakeRoot(
      {
        'pic.png': '',
        'clip.mp4': '',
        'Root.md': '![[pic.png]]\n\n![[clip.mp4]]',
      },
      { media, settings: { convertFileLinks: false } }
    );

    assert.deepEqual(
      [...media].map((f) => f.path).sort(),
      ['clip.mp4', 'pic.png']
    );
  });

  it('converts an unsupported attachment to a file:// link', async () => {
    assert.equal(
      await bakeRoot({ 'doc.pdf': '', 'Root.md': '![[doc.pdf]]' }),
      '![](file:///vault/doc.pdf)'
    );
  });

  it('leaves the attachment link alone when conversion is off', async () => {
    assert.equal(
      await bakeRoot(
        { 'doc.pdf': '', 'Root.md': '![[doc.pdf]]' },
        { settings: { convertFileLinks: false } }
      ),
      '![[doc.pdf]]'
    );
  });
});

describe('bake — the two outputs', () => {
  // What the modal does for real: one bake, rendered twice. The post must carry
  // its images and none of the author's local paths; the sidecar keeps both.
  const files = {
    'pic.png': '',
    'doc.pdf': '',
    'Root.md': 'Look:\n\n![[pic.png]]\n\nAnd:\n\n![[doc.pdf]]\n\nEnd.',
  };

  it('uploads the image and keeps local paths out of the post', async () => {
    const media = new Set<any>();
    const baked = await bakeRoot(files, { media });

    // The image is uploaded and attached separately, never inlined as a path.
    assert.deepEqual([...media].map((f) => f.path), ['pic.png']);

    const published = normalizeForPublishing(baked, {
      contentRemoved: media.size > 0,
      stripLocalFileLinks: true,
    });

    assert.equal(published, 'Look:\n\nAnd:\n\nEnd.');
    assert.ok(!published.includes('file://'));
    assert.ok(!published.includes('doc.pdf'));
  });

  it('keeps the attachment link in the sidecar copy', async () => {
    const media = new Set<any>();
    const baked = await bakeRoot(files, { media });

    const local = normalizeForPublishing(baked, {
      contentRemoved: media.size > 0,
    });

    assert.ok(local.includes('![](file:///vault/doc.pdf)'));
  });
});

describe('bake — subpath', () => {
  it('narrows to a heading section', async () => {
    const result = await bakeRoot(
      {
        'Child.md': CHILD,
        'Root.md':
          '## Section\n\n![[Child]]\n\n## Next\n\nTail.',
      },
      { subpath: '#Section' }
    );
    assert.equal(result, '## Section\n\nChild body.\n\n');
  });

  it('runs a trailing section to the end of the note', async () => {
    const result = await bakeRoot(
      { 'Root.md': '## One\n\nA.\n\n## Two\n\nB.' },
      { subpath: '#Two' }
    );
    assert.equal(result, '## Two\n\nB.');
  });

  it('ignores a link that sits before the section', async () => {
    // Regression: targets used to keep whole-file offsets after the slice, so a
    // link ahead of the heading was spliced over the section's own text.
    const result = await bakeRoot(
      {
        'Child.md': CHILD,
        'Root.md':
          'Intro cites [[Child]] here.\n\n## Section\n\n![[Child]]\n\n## Next\n\nTail.',
      },
      { subpath: '#Section' }
    );
    assert.equal(result, '## Section\n\nChild body.\n\n');
  });

  it('narrows to a block, keeps its children, and drops the block id', async () => {
    const result = await bakeRoot(
      {
        'Child.md': CHILD,
        'Root.md':
          'Intro [[Child]] first.\n\n- Parent ^blk\n\t- ![[Child]]\n- Sibling\n',
      },
      { subpath: '#^blk' }
    );
    assert.equal(result, '- Parent\n\t- Child body.');
  });

  it('falls back to the whole note when the subpath does not resolve', async () => {
    const text = '## One\n\nA.';
    assert.equal(
      await bakeRoot({ 'Root.md': text }, { subpath: '#Missing' }),
      text
    );
  });
});

describe('bake — range', () => {
  const NOTE =
    '---\nbranch-writing: true\n---\n' +
    '\n<!--section: 1-->\nFirst card links [[Child]].\n' +
    '\n<!--section: 2-->\nSecond card cites [[Child]] too.\n\n![[Child]]\n' +
    '\n<!--section: 3-->\nThird card.';

  const rangeOf = (start: string, end: string): [number, number] => {
    const from = NOTE.indexOf(start);
    const to = NOTE.indexOf(end) + end.length;
    assert.ok(from !== -1 && to > from, 'fixture anchors must exist');
    return [from, to];
  };

  const files = { 'Child.md': CHILD, 'Root.md': NOTE };

  it('publishes a single card', async () => {
    const result = await bakeRoot(files, {
      range: rangeOf('First card', 'links [[Child]].'),
    });
    assert.equal(result, 'First card links Child.');
  });

  it('bakes links and embeds inside the range', async () => {
    const result = await bakeRoot(files, {
      range: rangeOf('Second card', '![[Child]]'),
    });
    assert.equal(result, 'Second card cites Child too.\n\nChild body.');
  });

  it('spans a branch, markers and all', async () => {
    const result = await bakeRoot(files, {
      range: rangeOf('Second card', 'Third card.'),
    });
    assert.equal(
      result,
      'Second card cites Child too.\n\nChild body.\n' +
        '\n<!--section: 3-->\nThird card.'
    );
  });

  it('never splices a link from outside the range', async () => {
    const result = await bakeRoot(files, {
      range: rangeOf('Third card.', 'Third card.'),
    });
    assert.equal(result, 'Third card.');
  });

  it('excludes a link that straddles the range boundary', async () => {
    const [start] = rangeOf('Second card', 'too.');
    // Cut mid-link: the partial `[[Child` must not be treated as a target.
    const cut: [number, number] = [start, NOTE.indexOf('[[Child]] too.') + 4];
    const result = await bakeRoot(files, { range: cut });
    assert.equal(result, 'Second card cites [[Ch');
  });
});
