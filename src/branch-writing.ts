import { App, TFile } from 'obsidian';

/**
 * Read-only integration with the Branch Writing plugin, which models a note as a
 * tree of cards and serializes it back to Markdown with invisible structure
 * markers.
 *
 * Everything here is guarded and every failure degrades to `null`. Without that
 * plugin installed or enabled this module is inert, and nothing in it mutates
 * Branch Writing's state — note that its API also exposes registration methods
 * (`registerStartAnimationRunningChecker`, `dispatchSettings`, …) which replace
 * singletons inside that plugin. We deliberately touch only the getters.
 */

const BRANCH_WRITING_PLUGIN_ID = 'branch-writing';

export type SelectionMode = 'card' | 'branch';

/** The internals we read. Not a public contract of that plugin — hence the guards. */
interface BranchWritingSections {
  id_section?: Record<string, string>;
  section_id?: Record<string, string>;
  section_names?: Record<string, string>;
}

interface BranchWritingView {
  file?: TFile | null;
  documentStore?: {
    getValue(): {
      document?: { content?: Record<string, { content?: string } | undefined> };
      sections?: BranchWritingSections;
    };
  };
  viewStore?: {
    getValue(): { document?: { activeNode?: string } };
  };
}

interface BranchWritingApi {
  getActiveView?: () => BranchWritingView | null;
}

interface AppWithPlugins {
  plugins?: {
    plugins?: Record<string, { api?: BranchWritingApi } | undefined>;
  };
}

export interface BranchWritingSelection {
  file: TFile;
  /** Section number of the active card, e.g. "1.2". */
  section: string;
  /** Card bodies in document order — used to locate the span in the file. */
  contents: string[];
  /** Modal heading, e.g. `card 1.2 — Introduction`. */
  label: string;
  /** Filename fragment for the sidecar note, e.g. "1.2". */
  fileNameSuffix: string;
  /** Archived cards that fall inside the published span (branch mode only). */
  archivedInSpan: number;
}

/**
 * `app.plugins.plugins` holds only *enabled* plugin instances, so this single
 * lookup covers both "not installed" and "installed but disabled".
 *
 * Resolved on every call rather than cached: Branch Writing assigns its `api`
 * partway through its own `onload`, so a reference captured at our load time
 * could be undefined depending on plugin load order.
 */
const getApi = (app: App): BranchWritingApi | null => {
  const api = (app as unknown as AppWithPlugins).plugins?.plugins?.[
    BRANCH_WRITING_PLUGIN_ID
  ]?.api;
  return typeof api?.getActiveView === 'function' ? api : null;
};

/** Numeric, part-by-part ordering so "1.10" sorts after "1.9". */
const compareSections = (a: string, b: string): number => {
  const aParts = a.split('.');
  const bParts = b.split('.');
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    if (aParts[i] === undefined) return -1;
    if (bParts[i] === undefined) return 1;
    const diff = Number(aParts[i]) - Number(bParts[i]);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * Mirrors Branch Writing's own `isArchivedSectionName`. Archived cards are
 * hidden in its view but still present in the file, so they must not be
 * published just because they sit inside a branch.
 */
const isArchivedName = (name: string | undefined): boolean => {
  if (!name) return false;
  const trimmed = name.trim();
  return (
    trimmed === 'archived' ||
    trimmed.endsWith(': archived') ||
    trimmed.startsWith('archived: ')
  );
};

/**
 * Locate the span covered by `contents` in the note as saved on disk.
 *
 * A Branch Writing branch is always a contiguous run of the file — it serializes
 * depth-first — so anchoring on the first and last card is enough. Returns null
 * when the text can't be found, which means the store is ahead of the file.
 */
export function findRangeInFile(
  fileText: string,
  contents: string[]
): [number, number] | null {
  if (contents.length === 0) return null;

  const first = contents[0];
  const start = fileText.indexOf(first);
  if (start === -1) return null;

  if (contents.length === 1) return [start, start + first.length];

  const last = contents[contents.length - 1];
  const lastStart = fileText.indexOf(last, start);
  if (lastStart === -1) return null;

  return [start, lastStart + last.length];
}

/**
 * The card the user is looking at, or that card plus its descendants.
 *
 * Returns null whenever Branch Writing is absent, no card is active, or the
 * selection has nothing publishable in it.
 */
export function getSelection(
  app: App,
  mode: SelectionMode
): BranchWritingSelection | null {
  const view = getApi(app)?.getActiveView?.() ?? null;
  const file = view?.file;
  if (!view || !file) return null;

  const documentState = view.documentStore?.getValue();
  const content = documentState?.document?.content;
  const sections = documentState?.sections;
  const idSection = sections?.id_section;
  const sectionId = sections?.section_id;
  const activeNode = view.viewStore?.getValue()?.document?.activeNode;

  if (!content || !idSection || !sectionId || !activeNode) return null;

  const section = idSection[activeNode];
  if (!section) return null;

  const nameOf = (s: string) => sections?.section_names?.[s];

  // A branch is every section whose number is the root or extends it.
  const span =
    mode === 'card'
      ? [section]
      : Object.keys(sectionId)
          .filter((s) => s === section || s.startsWith(`${section}.`))
          .sort(compareSections);

  const bodyOf = (s: string) => content[sectionId[s]]?.content ?? '';
  const publishable = span.filter(
    (s) => bodyOf(s).trim().length > 0 && !isArchivedName(nameOf(s))
  );

  if (publishable.length === 0) return null;

  // Excluding archived cards trims the ends of the span, but any that sit
  // between the first and last kept card still fall inside it. Count them so
  // the modal can say so rather than publishing them silently.
  const firstKept = span.indexOf(publishable[0]);
  const lastKept = span.indexOf(publishable[publishable.length - 1]);
  const archivedInSpan = span
    .slice(firstKept, lastKept + 1)
    .filter((s) => isArchivedName(nameOf(s))).length;

  const name = nameOf(section);
  const cardCount = publishable.length;
  const label =
    mode === 'card'
      ? `card ${section}${name ? ` — ${name}` : ''}`
      : `branch ${section}${name ? ` — ${name}` : ''} (${cardCount} card${
          cardCount === 1 ? '' : 's'
        })`;

  return {
    file,
    section,
    contents: publishable.map(bodyOf),
    label,
    fileNameSuffix: section,
    archivedInSpan,
  };
}

/** Cheap probe for command `checkCallback`, so the palette stays responsive. */
export function hasActiveCard(app: App): boolean {
  return getSelection(app, 'card') !== null;
}
