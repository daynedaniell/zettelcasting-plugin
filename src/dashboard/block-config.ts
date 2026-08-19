import { parseYaml } from 'obsidian';

/**
 * Parsing and validation for a `zc-connections` block body.
 *
 * The body is YAML, and a note is edited by hand, so malformed input is the
 * normal case rather than an exceptional one. Nothing here throws: a block that
 * throws takes the whole note preview down with it, so every failure comes back
 * as a message the block renders in place.
 */

export interface ConnectionsBlockConfig {
  /** Platform ids to show, already normalised. Null means every platform. */
  platforms: string[] | null;
  compact: boolean;
}

export type BlockConfigResult =
  | { ok: true; config: ConnectionsBlockConfig; warnings: string[] }
  | { ok: false; message: string };

export const DEFAULT_CONFIG: ConnectionsBlockConfig = {
  platforms: null,
  compact: false,
};

const KNOWN_KEYS = new Set(['platforms', 'compact']);

/**
 * Spellings a user may reasonably write, folded onto the ids the API uses.
 *
 * Mirrors the aliases the server accepts, plus the Nango integration keys the
 * platform list reports (`facebook-page`), so that a block written as
 * `platforms: [facebook]` still matches a row keyed `facebook-page`.
 */
const PLATFORM_ALIASES = new Map<string, string>([
  ['x', 'twitter'],
  ['x.com', 'twitter'],
  ['tweet', 'twitter'],
  ['tweets', 'twitter'],
  ['twitter/x', 'twitter'],
  ['fb', 'facebook'],
  ['meta', 'facebook'],
  ['facebook-page', 'facebook'],
  ['ig', 'instagram'],
  ['insta', 'instagram'],
  ['instagram-business', 'instagram'],
  ['linked-in', 'linkedin'],
  ['bsky', 'bluesky'],
  ['thread', 'threads'],
  ['substack', 'beehiiv'],
  ['newsletter', 'beehiiv'],
]);

/**
 * Fold a platform id written by a user, or reported by the API, onto one
 * comparable form.
 *
 * Both sides of a filter comparison go through this, which is what lets
 * `platforms: [x]` in a note match a row the server keys as `twitter`.
 */
export function normalizePlatformId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return PLATFORM_ALIASES.get(trimmed) ?? trimmed;
}

/** Render a value back to the user in a message, without dumping an object. */
function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null || value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a set of options';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Symbols and functions cannot come out of a YAML parse, but stringifying
  // them blind would throw, which is the one thing this module must not do.
  return 'something unexpected';
}

/**
 * Parse and validate a block body.
 *
 * The YAML parser is a parameter so the tests can run in plain Node — the real
 * one comes from Obsidian, which only exists inside the app.
 */
export function parseBlockConfig(
  source: string,
  parse: (input: string) => unknown = parseYaml
): BlockConfigResult {
  if (!source.trim()) {
    // An empty block is the documented way to ask for everything.
    return { ok: true, config: { ...DEFAULT_CONFIG }, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `Could not read the block options: ${detail}` };
  }

  // A body of only comments parses to null.
  if (parsed === null || parsed === undefined) {
    return { ok: true, config: { ...DEFAULT_CONFIG }, warnings: [] };
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      message: `Expected options like "compact: true", but found ${describe(
        parsed
      )}.`,
    };
  }

  const raw = parsed as Record<string, unknown>;
  const warnings: string[] = [];

  const platforms = readPlatforms(raw.platforms);
  if ('error' in platforms) return { ok: false, message: platforms.error };

  const compact = readCompact(raw.compact);
  if ('error' in compact) return { ok: false, message: compact.error };

  // Unrecognised keys warn rather than fail: a typo in one option should not
  // blank a panel that can still render everything else correctly.
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    warnings.push(
      `Ignored unknown ${unknown.length === 1 ? 'option' : 'options'}: ${unknown
        .map((key) => `"${key}"`)
        .join(', ')}.`
    );
  }

  return {
    ok: true,
    config: { platforms: platforms.value, compact: compact.value },
    warnings,
  };
}

function readPlatforms(
  value: unknown
): { value: string[] | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };

  // `platforms: x` is a natural thing to write for a single platform, and
  // there is no ambiguity in accepting it.
  const list = Array.isArray(value) ? value : [value];

  if (list.length === 0) {
    return {
      error:
        'The "platforms" option is empty. Remove it to show every platform.',
    };
  }

  const ids: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) {
      return {
        error: `The "platforms" option should be a list of platform names, but it contains ${describe(
          item
        )}.`,
      };
    }
    const id = normalizePlatformId(item);
    // Aliases collapse, so `[x, twitter]` must not render the row twice.
    if (!ids.includes(id)) ids.push(id);
  }

  return { value: ids };
}

function readCompact(value: unknown): { value: boolean } | { error: string } {
  if (value === undefined || value === null) return { value: false };
  if (typeof value === 'boolean') return { value };
  return {
    error: `The "compact" option should be true or false, but it is ${describe(
      value
    )}.`,
  };
}
