/**
 * Writing a published post's id back into the note it came from.
 *
 * This is the only part of publishing that modifies the user's own notes, and
 * the vault is under Obsidian Sync and Obsidian Git — so it goes through
 * `processFrontMatter`, never a string edit. That API parses the frontmatter to
 * an object, hands it over for mutation, and re-serialises only that block; the
 * body of the note is not touched at all.
 *
 * Two consequences worth knowing, both inherent to the API rather than to this
 * module. It re-serialises the frontmatter block, so YAML comments there are
 * dropped and quoting is normalised on the first stamp. And it throws on
 * unparseable YAML rather than overwriting it, which is why the caller treats a
 * failure as "nothing was written" and not as a partial edit.
 */
import { TFile } from 'obsidian';

/** The frontmatter key holding the ZettelCasting post id. */
export const POST_ID_KEY = 'zc_post_id';

/**
 * The slice of `app.fileManager` this needs.
 *
 * Narrowed to one method so the tests can supply a plain object rather than
 * standing up a FileManager, and so it is obvious that nothing else here
 * touches the vault.
 */
export interface FrontMatterWriter {
  processFrontMatter(
    file: TFile,
    fn: (frontmatter: Record<string, unknown>) => void
  ): Promise<void>;
}

export type StampOutcome =
  | { status: 'written' }
  | { status: 'failed'; message: string };

/**
 * Record `postId` on `file` as `zc_post_id`.
 *
 * Overwrites an existing value: a note republished to a new post now maps to
 * that post, and the stale id would resolve to the wrong one. The `sourcePath`
 * mapping the server holds is what keeps the earlier post reachable.
 *
 * Never throws. A publish that succeeded must not be reported as a failure
 * because the note could not be annotated — the post is already live, and
 * there is nothing here worth rolling back or retrying destructively.
 */
export async function stampPostId(
  writer: FrontMatterWriter,
  file: TFile,
  postId: string
): Promise<StampOutcome> {
  try {
    await writer.processFrontMatter(file, (frontmatter) => {
      frontmatter[POST_ID_KEY] = postId;
    });
    return { status: 'written' };
  } catch (err) {
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
