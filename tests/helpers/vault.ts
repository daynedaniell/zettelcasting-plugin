/* eslint-disable @typescript-eslint/no-explicit-any */
import { BakeSettings } from '../../src/main';

/**
 * A fake vault whose metadata cache is parsed from the note text, so the
 * link/embed offsets the baking code splices at are real rather than invented.
 */

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---/;
const WIKILINK_RE = /(!?)\[\[([^\]]+)\]\]/g;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const BLOCK_ID_RE = / \^([\w-]+)\s*$/;

const pos = (line: number, offset: number, length: number) => ({
  start: { line, col: 0, offset },
  end: { line, col: length, offset: offset + length },
});

export function buildCache(text: string): any {
  const cache: any = {
    links: [],
    embeds: [],
    headings: [],
    listItems: [],
    blocks: {},
  };

  const frontmatter = FRONTMATTER_RE.exec(text);
  let bodyStart = 0;
  if (frontmatter && frontmatter.index === 0) {
    cache.frontmatter = {};
    cache.frontmatterPosition = pos(0, 0, frontmatter[0].length);
    bodyStart = frontmatter[0].length;
  }

  const lines = text.split('\n');
  const lineStart: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineStart.push(cursor);
    cursor += line.length + 1;
  }

  lines.forEach((line, i) => {
    if (lineStart[i] < bodyStart) return;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      cache.headings.push({
        heading: heading[2].trim(),
        level: heading[1].length,
        position: pos(i, lineStart[i], line.length),
      });
    }
  });

  // Track nesting so `parent` is the enclosing item's line, as Obsidian reports.
  const stack: { indent: number; line: number }[] = [];
  lines.forEach((line, i) => {
    if (lineStart[i] < bodyStart) return;

    const item = LIST_ITEM_RE.exec(line);
    if (!item) {
      if (line.trim() === '') stack.length = 0;
      return;
    }

    const indent = item[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    cache.listItems.push({
      position: pos(i, lineStart[i], line.length),
      // Obsidian uses a negative value for top-level items.
      parent: stack.length ? stack[stack.length - 1].line : -(i + 1),
    });
    stack.push({ indent, line: i });
  });

  lines.forEach((line, i) => {
    if (lineStart[i] < bodyStart) return;

    const block = BLOCK_ID_RE.exec(line);
    if (!block) return;

    const listItem = cache.listItems.find(
      (it: any) => it.position.start.line === i
    );
    cache.blocks[block[1]] = {
      id: block[1],
      position: listItem ? listItem.position : pos(i, lineStart[i], line.length),
    };
  });

  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(text))) {
    // Obsidian records frontmatter links separately from links/embeds.
    if (match.index < bodyStart) continue;

    const [target, display] = match[2].split('|');
    const entry = {
      link: target,
      original: match[0],
      displayText: display ?? target,
      position: {
        start: { line: 0, col: 0, offset: match.index },
        end: { line: 0, col: 0, offset: match.index + match[0].length },
      },
    };
    (match[1] === '!' ? cache.embeds : cache.links).push(entry);
  }

  return cache;
}

export interface FakeVault {
  app: any;
  file(path: string): any;
  write(path: string, text: string): void;
}

export function createVault(files: Record<string, string>): FakeVault {
  const contents = { ...files };

  // Obsidian hands out one TFile instance per path, and the cycle guard is an
  // identity Set — so these must be memoized or recursion would never stop.
  const fileCache = new Map<string, any>();

  const makeFile = (path: string) => {
    const existing = fileCache.get(path);
    if (existing) return existing;

    const name = path.split('/').pop() ?? path;
    const parentPath = path.includes('/')
      ? path.slice(0, path.lastIndexOf('/'))
      : '/';
    const file = {
      path,
      name,
      basename: name.replace(/\.[^.]+$/, ''),
      extension: name.includes('.') ? (name.split('.').pop() as string) : '',
      parent: { path: parentPath },
    };
    fileCache.set(path, file);
    return file;
  };

  const app: any = {
    vault: {
      cachedRead: async (f: any) => contents[f.path] ?? '',
      readBinary: async () => new ArrayBuffer(0),
      adapter: { getFullPath: (p: string) => `/vault/${p}` },
      getAbstractFileByPath: (p: string) =>
        contents[p] !== undefined ? makeFile(p) : null,
    },
    metadataCache: {
      getFileCache: (f: any) =>
        contents[f.path] !== undefined ? buildCache(contents[f.path]) : null,
      getFirstLinkpathDest: (link: string) => {
        const candidates = link.includes('.') ? [link] : [`${link}.md`, link];
        const hit = candidates.find((c) => contents[c] !== undefined);
        return hit ? makeFile(hit) : null;
      },
    },
  };

  return {
    app,
    file: makeFile,
    write: (path, text) => {
      contents[path] = text;
    },
  };
}

export function createSettings(
  overrides: Partial<BakeSettings> = {}
): BakeSettings {
  return {
    bakeLinks: true,
    bakeEmbeds: true,
    bakeInList: true,
    convertFileLinks: true,
    smartFormatting: false,
    platform: '',
    zettelcasting_api_key: '',
    ...overrides,
  };
}
