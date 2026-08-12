import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import {
  BlockSubpathResult,
  CachedMetadata,
  FootnoteSubpathResult,
  HeadingSubpathResult,
} from 'obsidian';

// `\S` rather than `\P{Z}`: the Unicode separator categories exclude newlines
// and tabs (those are Cc), so `\P{Z}` would match across a line break and fuse
// the last word of one line with the first of the next.
export const wordCountRE = /\S*[\p{L}\p{N}]\S*/gu;
export const commentRE = /(?:<!--[\s\S]*?-->|%%[\s\S]*?(?!%%)[\s\S]+?%%)/g;

/**
 * Media extensions the ZettelCasting backend accepts for upload. Mirrors the
 * server's SUPPORTED_MEDIA_TYPES allowlist. Used to decide which embedded
 * (non-markdown) files get uploaded to the backend vs. left as plain links.
 */
export const MEDIA_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export function mimeFromExtension(ext: string): string | null {
  return MEDIA_MIME_BY_EXT[ext.toLowerCase()] ?? null;
}

export function stripComments(text: string): string {
  return text.replace(commentRE, '');
}

/** The shape we need off an mdast node, without pulling in the full types. */
interface PositionedNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: PositionedNode[];
}

/**
 * Offsets of every code block and code span, in document order.
 *
 * Comment stripping has to skip these. `%%` is a comment marker in LaTeX and a
 * literal in batch files, and `<!-- -->` is ordinary content in an HTML sample —
 * so a regex sweep would treat the text *between* two of them as a comment and
 * delete the code in the middle.
 */
function codeRanges(source: string): Array<[number, number]> {
  let tree: PositionedNode;
  try {
    tree = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
  } catch {
    return [];
  }

  const ranges: Array<[number, number]> = [];

  const visit = (node: PositionedNode) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (from !== undefined && to !== undefined) ranges.push([from, to]);
      // Code has no children worth descending into.
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };

  visit(tree);
  return ranges;
}

/**
 * Strip Obsidian comments — `%%…%%` and `<!--…-->` — from everything except
 * code blocks and code spans, which are published as written.
 *
 * A comment that *wraps* a code fence is left in place rather than removed:
 * the opening and closing markers land in different segments, so they no longer
 * pair up. That is the deliberate trade. Deleting a code block someone meant to
 * publish is unrecoverable; leaving one comment visible is not.
 */
export function stripCommentsOutsideCode(text: string): string {
  if (!text) return text;

  const ranges = codeRanges(text);
  if (ranges.length === 0) return stripComments(text);

  let out = '';
  let cursor = 0;

  for (const [from, to] of ranges) {
    // Defensive: a nested or out-of-order range would otherwise rewind us.
    if (from < cursor) continue;
    out += stripComments(text.slice(cursor, from));
    out += text.slice(from, to);
    cursor = to;
  }

  return out + stripComments(text.slice(cursor));
}

export function getWordCount(text: string): number {
  return (stripComments(text).match(wordCountRE) || []).length;
}

export function dedent(text: string) {
  const firstIndent = text.match(/^([ \t]*)/);
  if (firstIndent) {
    return text.replace(
      //                            Escape tab chars
      new RegExp(`^${firstIndent[0].replace(/\\/g, '\\$&')}`, 'gm'),
      ''
    );
  }
  return text;
}

export function applyIndent(text: string, indent?: string) {
  if (!indent) return text;
  return text.trim().replace(/(\r?\n)/g, `$1${indent}`);
}

export function stripFirstBullet(text: string) {
	if (!text) return text;
  return text.replace(/^[ \t]*(?:[-*+]|[0-9]+[.)]) +/, '');
}

export function stripBlockId(text: string) {
	if (!text) return text;
  return text.replace(/ +\^[^ \n\r]+$/gm, '');
}

export function stripFrontmatter(text: string) {
	if (!text) return text;
  return text.replace(/^---[\s\S]+?\r?\n---(?:\r?\n\s*|$)/, '');
}

/**
 * Remove a note's YAML frontmatter, preferring the cached `frontmatterPosition`
 * over the regex above. The regex cannot tell frontmatter from a note that opens
 * with a `---` horizontal rule and has another one later, and would swallow
 * everything between them.
 *
 * The offset stays valid against *baked* text because Obsidian records
 * frontmatter links separately from `links`/`embeds`, so no splice ever lands
 * before it. The `startsWith` guard covers text that has already been sliced.
 */
export function stripFrontmatterAt(text: string, endOffset?: number) {
  if (!text) return text;

  const usable =
    typeof endOffset === 'number' &&
    endOffset > 0 &&
    endOffset <= text.length &&
    text.startsWith('---');

  // Matches the trailing `\s*` the regex form consumes, so both paths agree.
  return usable ? text.slice(endOffset).replace(/^\s*/, '') : stripFrontmatter(text);
}

export function sanitizeBakedContent(text: string, frontmatterEndOffset?: number) {
  return stripBlockId(stripFrontmatterAt(text, frontmatterEndOffset));
}

/**
 * Structural markers written by hierarchical-writing plugins (Branch Writing and
 * friends). They are invisible in Obsidian but would be published verbatim.
 *
 * Comment form: `<!--section: 1.2.3: Optional Name-->`, plus the legacy `card:`
 * keyword and the malformed terminators (`>`, `--`, `->`) those plugins tolerate.
 * The leading `[ \t]*` matters: `applyIndent` indents every line of a transcluded
 * note, so markers arrive indented when embedded inside a list bullet.
 */
const structureCommentMarkerRE =
  /^[ \t]*<!--\s*(?:section|card)\s*:\s*\d+(?:\.\d+)*(?::[^>\n]*)?\s*(?:-+>?|>)[ \t]*\r?\n?/gm;

/** Inline form: `<span data-bw-section="1.2"></span>` (and legacy `data-section`). */
const structureSpanMarkerRE =
  /<span\s+data-(?:bw-)?section="\d+(?:\.\d+)*"\s*(?:\/>|><\/span>)/g;

/**
 * A `file://` image written by `convertFileLinks`, e.g.
 * `![](file:///Users/someone/vault/report.pdf)`.
 *
 * Matches the generated form rather than any URL: the path is `encodeURI`d, so
 * it holds no whitespace and the link cannot span lines.
 */
const localFileLinkRE = /!\[[^\]\n]*\]\(file:\/\/[^)\s]*\)[ \t]*/g;

/**
 * Final cleanup applied to baked output just before it is published or written
 * to the sidecar note.
 *
 * Removes frontmatter, hierarchical-writing structure markers, and Obsidian
 * comments — both `%%…%%` and `<!--…-->`. Comments are private annotations that
 * render as nothing in the vault, so publishing them verbatim leaks them to a
 * public feed; `getWordCount` has always excluded them, so counting them out of
 * the post but sending them anyway also made the reported length a lie.
 *
 * MUST run only after `bake()` has returned. Baking splices links and embeds at
 * metadata-cache offsets; removing characters any earlier shifts every remaining
 * offset and corrupts the output silently.
 *
 * `frontmatterEndOffset` should come from the root note's cached
 * `frontmatterPosition`. It stays valid against baked text because Obsidian
 * records frontmatter links separately, so no splice ever lands before it. When
 * omitted, the regex fallback is used.
 */
export interface NormalizeOptions {
  /** End of the note's frontmatter, from the cached `frontmatterPosition`. */
  frontmatterEndOffset?: number;
  /**
   * Set when the caller already removed content — uploaded media embeds, say —
   * so the blank line they left behind gets tidied too.
   */
  contentRemoved?: boolean;
  /**
   * Drop the `file://` images `convertFileLinks` produced. Set for the text
   * that goes to the backend and not for the sidecar note: the path resolves on
   * this machine and nowhere else, so publishing it discloses the local
   * username and folder layout while giving the post nothing.
   *
   * Removing these cannot cost a post its media — images and videos are
   * uploaded and attached separately, and never take this form.
   */
  stripLocalFileLinks?: boolean;
}

export function normalizeForPublishing(
  text: string,
  options: NormalizeOptions = {}
): string {
  if (!text) return text;

  const {
    frontmatterEndOffset,
    contentRemoved = false,
    stripLocalFileLinks = false,
  } = options;

  const withoutFrontmatter = stripFrontmatterAt(text, frontmatterEndOffset);
  const withoutMarkers = withoutFrontmatter
    .replace(structureCommentMarkerRE, '')
    .replace(structureSpanMarkerRE, '');

  // Safe to run at this point for the same reason the markers are: `bake()` has
  // already returned, and no `file://` image can sit inside the frontmatter the
  // offset above points past, because frontmatter links are cached separately
  // and never spliced.
  const withoutLocalFiles = stripLocalFileLinks
    ? withoutMarkers.replace(localFileLinkRE, '')
    : withoutMarkers;

  // Comments are stripped after the structure markers, not before: those
  // markers are themselves HTML comments, and their patterns consume the whole
  // line. Stripping generic comments first would take the marker but leave its
  // newline, turning one card boundary into a spurious paragraph break.
  const withoutComments = stripCommentsOutsideCode(withoutLocalFiles);

  // Leave ordinary notes byte-identical.
  if (withoutComments === text && !contentRemoved) return text;

  // Removing a marker line, a comment, a local file link or an embed leaves a
  // gap. Only tidy when something was actually taken out, so deliberate spacing
  // in plain notes survives.
  const removedSomething =
    withoutComments !== withoutFrontmatter || contentRemoved;

  const collapsed = removedSomething
    ? withoutComments.replace(/\n{3,}/g, '\n\n')
    : withoutComments;

  return collapsed.trim();
}

/** Characters that render as nothing but still count against a post's limit. */
const invisibleCharRE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/** Non-breaking and typographic spaces, which break platform word wrapping. */
const exoticSpaceRE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Character-level tidying applied before parsing. Runs first so the parser and
 * the slices taken from it see the same string.
 */
function cleanCharacters(text: string): string {
  return (
    text
      // Windows and classic-Mac line endings, and literal HTML breaks.
      .replace(/\r\n?/g, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(invisibleCharRE, '')
      .replace(exoticSpaceRE, ' ')
  );
}

/** Fold a block of prose onto one line. */
const reflow = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Drop trailing whitespace from every line. */
const trimLineEnds = (text: string) => text.replace(/[ \t]+$/gm, '');

/**
 * Reflow a baked note into prose fit for a social post.
 *
 * Hierarchical writing tools emit one card per block, so a branch arrives as a
 * stack of one-sentence paragraphs separated by blank lines. Those breaks are an
 * artifact of the card structure, not the author's paragraphing — published
 * as-is they read as a column of fragments. Smart formatting folds consecutive
 * paragraphs back into flowing prose.
 *
 * Block boundaries come from a CommonMark + GFM parser rather than from pattern
 * matching, so setext headings, indented code blocks, raw HTML blocks, lazy list
 * continuations and mismatched code fences are all identified correctly.
 *
 * Only paragraphs are rewritten. Every other block — heading, list, blockquote,
 * table, code, HTML, thematic break, footnote definition — is **sliced out of the
 * source text verbatim**, never re-serialized. That is deliberate: a markdown
 * stringifier would escape the syntax Obsidian relies on, turning `[[a link]]`
 * into `\[\[a link]]` and breaking `> [!note]` callouts. Slicing cannot.
 *
 * What goes away: every line break between prose lines — whether a soft wrap or
 * a blank line — plus stray carriage returns, HTML `<br>` tags, zero-width
 * characters, exotic Unicode spaces, repeated spaces and trailing whitespace.
 *
 * Deterministic and idempotent: formatting already-formatted text is a no-op.
 */
export function smartFormat(text: string): string {
  if (!text) return text;

  const source = cleanCharacters(text);

  let blocks;
  try {
    blocks = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }).children;
  } catch {
    // Formatting must never cost someone their post. Fall back to the
    // character-level cleanup, which is all this did before parsing.
    return source.replace(/\n{3,}/g, '\n\n').trim();
  }

  const out: string[] = [];
  let openParagraph = false;

  for (const node of blocks) {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;

    // Positions are always present for parsed input; skip anything synthetic
    // rather than slice with undefined bounds.
    if (from === undefined || to === undefined) continue;

    const raw = source.slice(from, to);

    if (node.type === 'paragraph') {
      const prose = reflow(raw);
      if (!prose) continue;

      // Consecutive paragraphs are the card boundaries we are here to remove.
      if (openParagraph) out[out.length - 1] += ` ${prose}`;
      else out.push(prose);

      openParagraph = true;
      continue;
    }

    if (node.type === 'code') {
      // Whitespace is significant in code, including the trailing kind.
      out.push(raw);
    } else if (node.type === 'list') {
      // A blank line between items only marks the list loose, which is noise in
      // a post; the items themselves are untouched.
      out.push(trimLineEnds(raw).replace(/\n{2,}/g, '\n'));
    } else {
      out.push(trimLineEnds(raw));
    }

    openParagraph = false;
  }

  // Exactly one blank line between blocks.
  return out.join('\n\n');
}

export interface SubpathExtraction {
  /** Raw slice of the note — no transforms yet, so cache offsets still map. */
  text: string;
  /** Where the slice begins in the original content. */
  offset: number;
  /** List blocks need dedenting; heading sections do not. */
  dedent: boolean;
}

/**
 * Narrow a note to the heading section or list block a `#subpath` points at.
 *
 * Returns the *raw* slice plus its offset rather than a finished string: the
 * caller splices links and embeds at metadata-cache offsets, and `dedent` /
 * `stripBlockId` change lengths mid-string. Apply `finalizeSubpath` afterwards.
 *
 * Accepts everything `resolveSubpath` can return. Only the list-block case
 * needs special handling; footnotes and headings both take the plain
 * start/end slice below.
 */
export function extractSubpath(
  content: string,
  subpathResult:
    | HeadingSubpathResult
    | BlockSubpathResult
    | FootnoteSubpathResult,
  cache: CachedMetadata
): SubpathExtraction {
  if (subpathResult.type === 'block' && subpathResult.list && cache.listItems) {
    const targetItem = subpathResult.list;
    const ancestors = new Set<number>([targetItem.position.start.line]);
    const start =
      targetItem.position.start.offset - targetItem.position.start.col;

    let end = targetItem.position.end.offset;
    let found = false;

    for (const item of cache.listItems) {
      if (targetItem === item) {
        found = true;
        continue;
      } else if (!found) {
        // Keep seeking until we find the target
        continue;
      }

      if (!ancestors.has(item.parent)) break;
      ancestors.add(item.position.start.line);
      end = item.position.end.offset;
    }

    return { text: content.substring(start, end), offset: start, dedent: true };
  }

  const start = subpathResult.start.offset;
  const end = subpathResult.end ? subpathResult.end.offset : content.length;

  return { text: content.substring(start, end), offset: start, dedent: false };
}

/** Transforms held back by `extractSubpath` so splicing sees stable offsets. */
export function finalizeSubpath(text: string, extraction: SubpathExtraction) {
  return stripBlockId(extraction.dedent ? dedent(text) : text);
}
