/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findRangeInFile,
  getSelection,
  hasActiveCard,
} from '../src/branch-writing';

/**
 * Stand in for Branch Writing's stores. `sections` maps a section number to its
 * card body; `names` supplies the optional label from `<!--section: 1.2: X-->`.
 */
function createHost(options: {
  sections: Record<string, string>;
  names?: Record<string, string>;
  activeSection?: string;
  file?: any;
}) {
  const { sections, names = {}, activeSection } = options;
  const file = options.file ?? { path: 'Note.md', basename: 'Note' };

  const idSection: Record<string, string> = {};
  const sectionId: Record<string, string> = {};
  const content: Record<string, { content: string }> = {};

  Object.entries(sections).forEach(([section, body], i) => {
    const nodeId = `n${i}`;
    idSection[nodeId] = section;
    sectionId[section] = nodeId;
    content[nodeId] = { content: body };
  });

  const active = activeSection ?? Object.keys(sections)[0];

  const view = {
    file,
    documentStore: {
      getValue: () => ({
        document: { content },
        sections: {
          id_section: idSection,
          section_id: sectionId,
          section_names: names,
        },
      }),
    },
    viewStore: {
      getValue: () => ({ document: { activeNode: sectionId[active] } }),
    },
  };

  return {
    plugins: { plugins: { 'branch-writing': { api: { getActiveView: () => view } } } },
  } as any;
}

describe('findRangeInFile', () => {
  it('returns null for an empty selection', () => {
    assert.equal(findRangeInFile('abc', []), null);
  });

  it('returns null when the text is not on disk yet', () => {
    assert.equal(findRangeInFile('abc', ['zzz']), null);
  });

  it('spans a single card', () => {
    assert.deepEqual(findRangeInFile('xx HELLO yy', ['HELLO']), [3, 8]);
  });

  it('searches for the last anchor after the first', () => {
    assert.deepEqual(findRangeInFile('x A y A z B', ['A', 'B']), [2, 11]);
  });

  it('returns null when the last anchor is missing', () => {
    assert.equal(findRangeInFile('only A here', ['A', 'B']), null);
  });
});

describe('getSelection', () => {
  it('returns null when Branch Writing is absent', () => {
    assert.equal(getSelection({} as any, 'card'), null);
    assert.equal(hasActiveCard({} as any), false);
  });

  it('returns null when the api is not the expected shape', () => {
    const app = { plugins: { plugins: { 'branch-writing': { api: {} } } } } as any;
    assert.equal(getSelection(app, 'card'), null);
  });

  it('picks up the active card', () => {
    const app = createHost({
      sections: { '1': 'First.', '2': 'Second.' },
      activeSection: '2',
    });

    const selection = getSelection(app, 'card');
    assert.notEqual(selection, null);
    assert.equal(selection?.section, '2');
    assert.deepEqual(selection?.contents, ['Second.']);
    assert.equal(selection?.fileNameSuffix, '2');
    assert.equal(selection?.label, 'card 2');
    assert.equal(hasActiveCard(app), true);
  });

  it('includes the section name in the label', () => {
    const app = createHost({
      sections: { '1': 'Body.' },
      names: { '1': 'Introduction' },
    });
    assert.equal(getSelection(app, 'card')?.label, 'card 1 — Introduction');
  });

  it('collects a branch in document order', () => {
    const app = createHost({
      sections: {
        '1': 'One.',
        '2': 'Two.',
        '2.1': 'Two-one.',
        '2.2': 'Two-two.',
        '3': 'Three.',
      },
      activeSection: '2',
    });

    const selection = getSelection(app, 'branch');
    assert.deepEqual(selection?.contents, ['Two.', 'Two-one.', 'Two-two.']);
    assert.equal(selection?.label, 'branch 2 (3 cards)');
  });

  it('orders sections numerically, not lexically', () => {
    const sections: Record<string, string> = { '1': 'Root.' };
    for (let i = 1; i <= 11; i++) sections[`1.${i}`] = `Card ${i}.`;

    const app = createHost({ sections, activeSection: '1' });
    const contents = getSelection(app, 'branch')?.contents;

    assert.equal(contents?.at(-1), 'Card 11.');
    assert.equal(contents?.at(-2), 'Card 10.');
  });

  it('does not treat a sibling with a shared prefix as a descendant', () => {
    const app = createHost({
      sections: { '1': 'One.', '11': 'Eleven.', '1.1': 'One-one.' },
      activeSection: '1',
    });
    assert.deepEqual(getSelection(app, 'branch')?.contents, ['One.', 'One-one.']);
  });

  it('skips empty cards', () => {
    const app = createHost({
      sections: { '1': 'Body.', '1.1': '   ', '1.2': 'Tail.' },
      activeSection: '1',
    });
    assert.deepEqual(getSelection(app, 'branch')?.contents, ['Body.', 'Tail.']);
  });

  it('returns null when the whole selection is empty', () => {
    const app = createHost({ sections: { '1': '  ' } });
    assert.equal(getSelection(app, 'card'), null);
  });

  it('excludes archived cards and reports those inside the span', () => {
    const app = createHost({
      sections: {
        '1': 'Root.',
        '1.1': 'Kept.',
        '1.2': 'Hidden.',
        '1.3': 'Also kept.',
        '1.4': 'Trailing archived.',
      },
      names: {
        '1.2': 'notes: archived',
        '1.4': 'archived',
      },
      activeSection: '1',
    });

    const selection = getSelection(app, 'branch');
    assert.deepEqual(selection?.contents, ['Root.', 'Kept.', 'Also kept.']);
    // 1.2 sits between the first and last kept card; 1.4 was trimmed off the end.
    assert.equal(selection?.archivedInSpan, 1);
  });

  it('reports no archived cards for an ordinary branch', () => {
    const app = createHost({
      sections: { '1': 'Root.', '1.1': 'Child.' },
      activeSection: '1',
    });
    assert.equal(getSelection(app, 'branch')?.archivedInSpan, 0);
  });
});
