import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyIndent,
  dedent,
  getWordCount,
  mimeFromExtension,
  normalizeForPublishing,
  sanitizeBakedContent,
  smartFormat,
  stripBlockId,
  stripFirstBullet,
  stripFrontmatter,
  stripFrontmatterAt,
} from '../src/util';

describe('text helpers', () => {
  it('strips a trailing block id from every line', () => {
    assert.equal(stripBlockId('line one ^abc123'), 'line one');
    assert.equal(stripBlockId('a ^one\nb ^two'), 'a\nb');
    assert.equal(stripBlockId('no id here'), 'no id here');
  });

  it('strips only the first bullet marker', () => {
    assert.equal(stripFirstBullet('- item\n- other'), 'item\n- other');
    assert.equal(stripFirstBullet('1. item'), 'item');
    assert.equal(stripFirstBullet('plain'), 'plain');
  });

  it('indents every line after the first', () => {
    assert.equal(applyIndent('a\nb', '\t'), 'a\n\tb');
    assert.equal(applyIndent('a\nb', ''), 'a\nb');
  });

  it('dedents by the first line indent', () => {
    assert.equal(dedent('\ta\n\tb'), 'a\nb');
    assert.equal(dedent('a\n\tb'), 'a\n\tb');
  });

  it('counts words, ignoring comments', () => {
    assert.equal(getWordCount('one two three'), 3);
    assert.equal(getWordCount('one %%hidden words%% two'), 2);
  });

  it('counts words separated by line breaks and tabs', () => {
    assert.equal(getWordCount('alpha beta\ngamma delta'), 4);
    assert.equal(getWordCount('alpha\r\nbeta\tgamma'), 3);
    // Punctuation-only tokens are not words.
    assert.equal(getWordCount('alpha — beta'), 2);
  });

  it('maps only supported media extensions', () => {
    assert.equal(mimeFromExtension('PNG'), 'image/png');
    assert.equal(mimeFromExtension('mp4'), 'video/mp4');
    assert.equal(mimeFromExtension('pdf'), null);
  });
});

describe('stripFrontmatterAt', () => {
  const note = '---\ntags: [a]\n---\n\nBody.\n\n---\n\nMore.';
  // Offset of the end of the closing `---`, which is what frontmatterPosition gives.
  const frontmatterEnd = 17;

  it('slices by offset when one is supplied', () => {
    assert.equal(stripFrontmatterAt(note, frontmatterEnd), 'Body.\n\n---\n\nMore.');
  });

  it('falls back to the regex without an offset', () => {
    assert.equal(stripFrontmatterAt(note), 'Body.\n\n---\n\nMore.');
  });

  it('ignores an offset when the text does not start with a fence', () => {
    assert.equal(stripFrontmatterAt('Body only.', 17), 'Body only.');
  });

  it('leaves a note with no frontmatter alone', () => {
    assert.equal(stripFrontmatter('# Title\n\nBody.'), '# Title\n\nBody.');
  });
});

describe('sanitizeBakedContent', () => {
  it('removes frontmatter and block ids from transcluded content', () => {
    const child = '---\naliases: [x]\n---\nChild body ^ref1';
    assert.equal(sanitizeBakedContent(child), 'Child body');
  });

  it('prefers the supplied frontmatter offset', () => {
    const child = '---\na: 1\n---\nBody ^id';
    assert.equal(sanitizeBakedContent(child, 12), 'Body');
  });
});

describe('normalizeForPublishing', () => {
  // Exactly what Branch Writing's jsonToHtmlComment emits: the marker string
  // starts with a newline and cards are joined with one more.
  const frontmatter = '---\nbranch-writing: true\n---\n';
  const sections =
    '\n<!--section: 1-->\nFirst card.\n' +
    '\n<!--section: 1.1-->\nChild card.\n' +
    '\n<!--section: 2: Conclusion-->\nLast card.';
  const expected = 'First card.\n\nChild card.\n\nLast card.';

  it('strips markers and frontmatter by offset', () => {
    assert.equal(
      normalizeForPublishing(frontmatter + sections, {
        frontmatterEndOffset: frontmatter.length - 1,
      }),
      expected
    );
  });

  it('strips markers and frontmatter without an offset', () => {
    assert.equal(normalizeForPublishing(frontmatter + sections), expected);
  });

  it('handles the legacy `card:` keyword', () => {
    assert.equal(
      normalizeForPublishing('<!--card: 1-->\nOne.\n\n<!--card: 2-->\nTwo.'),
      'One.\n\nTwo.'
    );
  });

  it('tolerates the malformed terminators Branch Writing repairs', () => {
    assert.equal(
      normalizeForPublishing(
        '<!--section: 1>\nA.\n\n<!--section: 2--\nB.\n\n<!--section: 3->\nC.'
      ),
      'A.\n\nB.\n\nC.'
    );
  });

  it('matches indented markers, as produced by a list transclusion', () => {
    assert.equal(
      normalizeForPublishing('- \tIntro.\n\t<!--section: 1.1-->\n\tNested.'),
      '- \tIntro.\n\tNested.'
    );
  });

  it('strips inline span markers, including the legacy attribute', () => {
    assert.equal(
      normalizeForPublishing(
        '<span data-bw-section="1"></span>Plain.\n\n' +
          '<span data-bw-section="2"></span>\n# Heading'
      ),
      'Plain.\n\n# Heading'
    );
    assert.equal(
      normalizeForPublishing('<span data-section="1"/>Text.'),
      'Text.'
    );
  });

  it('leaves an ordinary note byte-identical', () => {
    const plain = '# Title\n\nProse.\n\n\nDeliberate triple gap.\n';
    assert.equal(normalizeForPublishing(plain), plain);
  });

  it('does not touch a non-numeric html comment', () => {
    const note = 'Before.\n\n<!-- a normal comment -->\n\nAfter.\n';
    assert.equal(normalizeForPublishing(note), note);
  });

  it('does not mistake a horizontal rule for frontmatter', () => {
    const note = 'Intro.\n\n---\n\nOutro.\n';
    assert.equal(normalizeForPublishing(note), note);
  });

  it('collapses the gap left by removed content when told to', () => {
    assert.equal(
      normalizeForPublishing('A.\n\n\n\nB.', { contentRemoved: true }),
      'A.\n\nB.'
    );
  });

  it('keeps deliberate spacing when nothing was removed', () => {
    const note = 'A.\n\n\n\nB.';
    assert.equal(normalizeForPublishing(note), note);
  });

  it('handles an empty string', () => {
    assert.equal(normalizeForPublishing(''), '');
  });
});

describe('smartFormat', () => {
  it('folds a published branch into one flowing paragraph', () => {
    // What normalizeForPublishing hands over for a three-card branch.
    assert.equal(
      smartFormat('First card.\n\nChild card.\n\nLast card.'),
      'First card. Child card. Last card.'
    );
  });

  it('joins soft-wrapped lines', () => {
    assert.equal(
      smartFormat('A sentence broken\nacross two lines.'),
      'A sentence broken across two lines.'
    );
  });

  it('normalizes CRLF and lone carriage returns', () => {
    assert.equal(smartFormat('One.\r\n\r\nTwo.\rThree.'), 'One. Two. Three.');
  });

  it('treats an HTML break as a line break', () => {
    assert.equal(smartFormat('One.<br>Two.<br />Three.'), 'One. Two. Three.');
  });

  it('collapses repeated spaces and drops trailing whitespace', () => {
    assert.equal(smartFormat('Too    many   spaces.   \nNext.'), 'Too many spaces. Next.');
  });

  it('removes zero-width characters and normalizes exotic spaces', () => {
    assert.equal(
      smartFormat('Invis\u200Bible\u00A0and\u2003spaced\u3000out.'),
      'Invisible and spaced out.'
    );
  });

  it('keeps a heading on its own line with prose around it', () => {
    assert.equal(
      smartFormat('Lead in.\n# Title\nBody one.\nBody two.'),
      'Lead in.\n\n# Title\n\nBody one. Body two.'
    );
  });

  it('keeps list items separate and tight', () => {
    assert.equal(
      smartFormat('Intro.\n\n- one\n\n- two\n\t- nested\n\nOutro.'),
      'Intro.\n\n- one\n- two\n\t- nested\n\nOutro.'
    );
  });

  it('keeps a numbered list together', () => {
    assert.equal(
      smartFormat('1. first\n2. second\n3. third'),
      '1. first\n2. second\n3. third'
    );
  });

  it('separates distinct lists, which is what a change of marker means', () => {
    // `.` then `)` then `-` is three lists per CommonMark, not one.
    assert.equal(
      smartFormat('1. first\n2) second\n- [ ] todo'),
      '1. first\n\n2) second\n\n- [ ] todo'
    );
  });

  it('keeps a blockquote and a table as separate blocks', () => {
    assert.equal(
      smartFormat('> quoted\n> more\n\n| a | b |\n| - | - |'),
      '> quoted\n> more\n\n| a | b |\n| - | - |'
    );
  });

  it('keeps a callout intact, brackets and all', () => {
    assert.equal(
      smartFormat('> [!note] Heads up\n> body line\n\nAfter.'),
      '> [!note] Heads up\n> body line\n\nAfter.'
    );
  });

  it('never escapes wikilinks or embeds', () => {
    assert.equal(
      smartFormat('See [[Some Note]] and\n![[image.png]] too.'),
      'See [[Some Note]] and ![[image.png]] too.'
    );
    assert.equal(
      smartFormat('snake_case_name stays put.'),
      'snake_case_name stays put.'
    );
  });

  it('keeps a thematic break on its own line', () => {
    assert.equal(smartFormat('Above.\n\n---\n\nBelow.'), 'Above.\n\n---\n\nBelow.');
  });

  it('reproduces a fenced code block verbatim', () => {
    const note =
      'Before.\n\n```js\nconst a = 1;\n\n  const b   = 2;\n```\n\nAfter one.\nAfter two.';
    assert.equal(
      smartFormat(note),
      'Before.\n\n```js\nconst a = 1;\n\n  const b   = 2;\n```\n\nAfter one. After two.'
    );
  });

  it('keeps a setext heading with its underline', () => {
    assert.equal(
      smartFormat('Title\n=====\n\nBody text.'),
      'Title\n=====\n\nBody text.'
    );
    assert.equal(
      smartFormat('Title\n-----\n\nBody text.'),
      'Title\n-----\n\nBody text.'
    );
  });

  it('reproduces an indented code block verbatim', () => {
    assert.equal(
      smartFormat('Example:\n\n    const a = 1;\n    const b = 2;\n\nDone.'),
      'Example:\n\n    const a = 1;\n    const b = 2;\n\nDone.'
    );
  });

  it('reproduces a raw HTML block verbatim', () => {
    assert.equal(
      smartFormat('Intro.\n\n<div class="x">\n  <p>hi</p>\n</div>\n\nOutro.'),
      'Intro.\n\n<div class="x">\n  <p>hi</p>\n</div>\n\nOutro.'
    );
  });

  it('does not mistake a mid-paragraph year for a list item', () => {
    assert.equal(
      smartFormat('It happened in\n2024. That was the year.'),
      'It happened in 2024. That was the year.'
    );
  });

  it('does not let a foreign fence delimiter close a code block', () => {
    const note = 'A.\n\n~~~\nline one\n```\nline two\n~~~\n\nB.';
    assert.equal(smartFormat(note), note);
  });

  it('leaves an unterminated fence alone rather than reflowing code', () => {
    assert.equal(
      smartFormat('Note.\n\n```\nline one\n\nline two'),
      'Note.\n\n```\nline one\n\nline two'
    );
  });

  it('drops leading and trailing blank lines', () => {
    assert.equal(smartFormat('\n\n  \nBody.\n\n\n'), 'Body.');
  });

  it('is idempotent', () => {
    const note =
      'Lead.\n\nSecond card.\n\n# Heading\n\n- a\n- b\n\n```\ncode\n```\n\nTail.';
    const once = smartFormat(note);
    assert.equal(smartFormat(once), once);
  });

  it('handles an empty string', () => {
    assert.equal(smartFormat(''), '');
  });

  it('turns a raw Branch Writing branch into one publishable paragraph', () => {
    // The whole publish pipeline, as the modal composes it.
    const note =
      '---\nbranch-writing: true\n---\n' +
      '\n<!--section: 1-->\nThe surface story is comforting.\n' +
      '\n<!--section: 1.1-->\nThe reality is colder.\n' +
      '\n<!--section: 1.2-->\nThe mechanism explains why.\n';

    assert.equal(
      smartFormat(normalizeForPublishing(note)),
      'The surface story is comforting. The reality is colder. ' +
        'The mechanism explains why.'
    );
  });
});
