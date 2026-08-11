import {
  App,
  FileSystemAdapter,
  Modal,
  Notice,
  Platform,
  Setting,
  TFile,
  parseLinktext,
  resolveSubpath,
} from 'obsidian';

import { BACKEND_URL, apiBase } from './api';
import EasyBake, { BakeSettings } from './main';
import { PlatformSelect, createPlatformSelect } from './platform-select';
import {
  applyIndent,
  extractSubpath,
  finalizeSubpath,
  getWordCount,
  mimeFromExtension,
  normalizeForPublishing,
  sanitizeBakedContent,
  smartFormat,
  stripFirstBullet,
} from './util';

import { BranchWritingSelection, findRangeInFile } from './branch-writing';

import Component from './Component.svelte';
import { picked_date } from './date.store';
import { get } from 'svelte/store';

const lineStartRE = /(?:^|\n) *$/;
const listLineStartRE = /(?:^|\n)([ \t]*)(?:[-*+]|[0-9]+[.)]) +$/;
const lineEndRE = /^ *(?:\r?\n|$)/;

/**
 * Offset just past the root note's YAML frontmatter, or undefined when it has
 * none. Passed to normalizeForPublishing so the frontmatter is removed by
 * position rather than by a regex that can misfire on a leading `---` rule.
 */
const frontmatterEndOffset = (app: App, file: TFile): number | undefined =>
  app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.offset;

export async function bake(
  app: App,
  file: TFile,
  subpath: string | null,
  ancestors: Set<TFile>,
  settings: BakeSettings,
  // Collects embedded image/video files encountered while baking so the caller
  // can upload them and attach the resulting URLs to the post.
  media: Set<TFile> = new Set(),
  // Publish only this span of the file (a Branch Writing card or branch).
  // Only ever set by the top-level call; recursion never passes it.
  range?: [number, number]
) {
  const { vault, metadataCache } = app;

  let text = await vault.cachedRead(file);
  const cache = metadataCache.getFileCache(file);

  if (!cache) return text;

  // Narrow the note to a `#subpath` section or an explicit span. Both shift the
  // text out from under the metadata-cache offsets the splice loop uses, so the
  // window is recorded and every offset is re-based by `sliceStart` below.
  // Only one can be active: `range` is passed only by the top-level card and
  // branch commands, which never use a subpath.
  let sliceStart = 0;
  let sliceEnd = text.length;
  let finalize: ((value: string) => string) | null = null;

  const resolvedSubpath = subpath ? resolveSubpath(cache, subpath) : null;
  if (resolvedSubpath) {
    const extraction = extractSubpath(text, resolvedSubpath, cache);
    text = extraction.text;
    sliceStart = extraction.offset;
    sliceEnd = extraction.offset + extraction.text.length;
    // `dedent`/`stripBlockId` change lengths, so they run after splicing.
    finalize = (value) => finalizeSubpath(value, extraction);
  } else if (range) {
    text = text.slice(range[0], range[1]);
    sliceStart = range[0];
    sliceEnd = range[1];
  }

  const done = (value: string) => (finalize ? finalize(value) : value);

  const links = (settings.bakeLinks ? cache.links || [] : []).map((ref) => ({
    ref,
    isEmbed: false,
  }));
  // Embeds are always scanned so that embedded media can be collected for
  // upload regardless of `bakeEmbeds` — that toggle only controls whether
  // embedded *markdown* gets inlined (enforced below).
  const embeds = (cache.embeds || []).map((ref) => ({ ref, isEmbed: true }));
  // Drop anything outside the window; a no-op when the whole note is in play.
  const targets = [...links, ...embeds].filter(
    ({ ref }) =>
      ref.position.start.offset >= sliceStart &&
      ref.position.end.offset <= sliceEnd
  );

  if (targets.length === 0) return done(text);

  targets.sort(
    (a, b) => a.ref.position.start.offset - b.ref.position.start.offset
  );

  const newAncestors = new Set(ancestors);
  newAncestors.add(file);

  let posOffset = 0;
  for (const { ref: target, isEmbed } of targets) {
    const { path, subpath } = parseLinktext(target.link);
    const linkedFile = metadataCache.getFirstLinkpathDest(path, file.path);

    if (!linkedFile) continue;

    // `sliceStart` is 0 unless we narrowed to a span, so the whole-file path is
    // arithmetically unchanged.
    const start = target.position.start.offset - sliceStart + posOffset;
    const end = target.position.end.offset - sliceStart + posOffset;
    const prevLen = end - start;

    const before = text.substring(0, start);
    const after = text.substring(end);

    const listMatch = settings.bakeInList
      ? before.match(listLineStartRE)
      : null;
    const isInline =
      !(listMatch || lineStartRE.test(before)) || !lineEndRE.test(after);
    const isMarkdownFile = linkedFile.extension === 'md';

    const replaceTarget = (replacement: string) => {
      text = before + replacement + after;
      posOffset += replacement.length - prevLen;
    };

    if (!isMarkdownFile) {
      // Supported image/video embeds are collected for upload and removed from
      // the post body — a local file:// URI is useless to the remote backend.
      if (mimeFromExtension(linkedFile.extension)) {
        media.add(linkedFile);
        replaceTarget('');
        continue;
      }

      if (!settings.convertFileLinks) continue;

      const adapter = app.vault.adapter as FileSystemAdapter;

      if (!adapter.getFullPath) continue;
      const fullPath = adapter.getFullPath(linkedFile.path);
      const protocol = Platform.isWin ? 'file:///' : 'file://';
      replaceTarget(`![](${protocol}${encodeURI(fullPath)})`);
      continue;
    }

    // Embedded markdown is only inlined when the user opted in; leave the
    // ![[wikilink]] untouched otherwise.
    if (isEmbed && !settings.bakeEmbeds) continue;

    if (newAncestors.has(linkedFile) || isInline) {
      replaceTarget(target.displayText || path);
      continue;
    }

    // Strip the child's frontmatter by cached position where possible — the
    // regex fallback cannot tell it from a leading `---` horizontal rule.
    const baked = sanitizeBakedContent(
      await bake(app, linkedFile, subpath, newAncestors, settings, media),
      metadataCache.getFileCache(linkedFile)?.frontmatterPosition?.end.offset
    );
    replaceTarget(
      listMatch ? applyIndent(stripFirstBullet(baked), listMatch[1]) : baked
    );
  }

  return done(text);
}

/**
 * Upload a single embedded media file to the backend staging endpoint and
 * return the fetchable URL the post can reference. Throws on failure so the
 * caller can abort posting rather than silently dropping media.
 */
async function uploadMedia(
  app: App,
  file: TFile,
  backendUrl: string,
  apiKey: string
): Promise<string> {
  const bytes = await app.vault.readBinary(file);
  const mime = mimeFromExtension(file.extension) ?? 'application/octet-stream';

  const form = new FormData();
  // Don't set Content-Type manually — the runtime adds the multipart boundary.
  form.append('file', new Blob([bytes], { type: mime }), file.name);

  const resp = await fetch(`${apiBase(backendUrl)}/api/integrations/pkm/media`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
    body: form,
  });

  if (!resp.ok) {
    throw new Error(`Upload failed (${resp.status}) for ${file.name}`);
  }

  const { url } = (await resp.json()) as { url?: unknown };

  // Guard the shape: a missing url would otherwise be posted as `null` in the
  // media array and the post would silently lose its image.
  if (typeof url !== 'string' || !url) {
    throw new Error(`Upload returned no URL for ${file.name}`);
  }

  return url;
}

async function send_note(
  text: string,
  publishDate: Date,
  platform: string,
  zettelcasting_api_key: string,
  backendUrl: string,
  media: string[]
) {
  const response = await fetch(`${apiBase(backendUrl)}/api/integrations/pkm/posts`, {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': `${zettelcasting_api_key}`,
    },
    body: JSON.stringify({
      body: text,
      platform: platform,
      scheduledFor: publishDate,
      media: media,
      tags: ['scheduled'],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to schedule post (${response.status})`);
  }
}

function disableBtn(btn: HTMLButtonElement) {
  btn.removeClass('mod-cta');
  btn.addClass('mod-muted');
  // `disabled` is a boolean attribute — setAttribute('disabled', 'false') would
  // still disable it, so drive the property and remove the attribute instead.
  btn.disabled = true;
  btn.setAttr('aria-disabled', 'true');
}

function enableBtn(btn: HTMLButtonElement) {
  btn.removeClass('mod-muted');
  btn.addClass('mod-cta');
  btn.disabled = false;
  btn.removeAttribute('aria-disabled');
}

export class BakeModal extends Modal {
  component!: Component;
  private platformSelect: PlatformSelect | null = null;

  /**
   * `selection` narrows the post to one Branch Writing card or branch. Omitted
   * for the whole-file command, which behaves exactly as before.
   */
  constructor(
    plugin: EasyBake,
    file: TFile,
    selection?: BranchWritingSelection
  ) {
    super(plugin.app);

    const { contentEl } = this;
    const { settings } = plugin;

    this.titleEl.setText('Schedule post with ZettelCasting');
    this.modalEl.addClass('mod-narrow', 'easy-bake-modal');
    this.contentEl
      .createEl('p', { text: 'Input file: ' })
      .createEl('strong', { text: file.path });

    if (selection) {
      this.contentEl
        .createEl('p', { text: 'Publishing: ' })
        .createEl('strong', { text: selection.label });

      if (selection.archivedInSpan > 0) {
        // Archived cards sitting between the first and last published card are
        // inside the span and will go out with it. Say so rather than surprise.
        const count = selection.archivedInSpan;
        this.contentEl.createDiv({
          cls: 'setting-item-description zettelcasting-archived-warning',
          text: `Includes ${count} archived card${
            count === 1 ? '' : 's'
          } that fall inside this branch.`,
        });
      }
    }

    new Setting(contentEl)
      .setName('Convert embedded markdown')
      .setDesc(
        'Include the content of ![[embedded markdown files]] when the link is on its own line.'
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.bakeEmbeds).onChange((value) => {
          settings.bakeEmbeds = value;
          plugin.saveSettings();
        })
      );

    new Setting(contentEl)
      .setName('Convert links')
      .setDesc('Include the content of [[any link]] when it is on its own line.')
      .addToggle((toggle) =>
        toggle.setValue(settings.bakeLinks).onChange((value) => {
          settings.bakeLinks = value;
          plugin.saveSettings();
        })
      );

    new Setting(contentEl)
      .setName('Convert links and embeds in lists')
      .setDesc(
        'Include the content of [[any link]] or ![[embedded markdown file]] when it takes up an entire list bullet.'
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.bakeInList).onChange((value) => {
          settings.bakeInList = value;
          plugin.saveSettings();
        })
      );

    new Setting(contentEl)
      .setName('Convert file links')
      .setDesc(
        'Rewrite links to non-markdown files, a PDF say, as ![](file:///full/path/to/report.pdf) in the local copy saved to your vault. These links never go out with the post — the path resolves on this machine only. Images and videos are uploaded and attached to the post instead, so they are unaffected.'
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.convertFileLinks).onChange((value) => {
          settings.convertFileLinks = value;
          plugin.saveSettings();
        })
      );

    new Setting(contentEl)
      .setName('Smart formatting')
      .setDesc(
        'Reflow the post into flowing paragraphs: folds the line breaks between cards and wrapped lines into running prose. Headings, lists, quotes and code blocks keep their own lines.'
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.smartFormatting).onChange((value) => {
          settings.smartFormatting = value;
          plugin.saveSettings();
        })
      );

    /**
     * Locate the selected card's span in the note as saved on disk. Resolved at
     * publish time rather than when the modal opens so it reflects the freshest
     * save. `undefined` means "whole file"; `null` means the store is ahead of
     * the file and we must not guess.
     */
    const resolveRange = async (): Promise<
      [number, number] | null | undefined
    > => {
      if (!selection) return undefined;
      const text = await this.app.vault.cachedRead(file);
      return findRangeInFile(text, selection.contents);
    };

    /**
     * Render the baked text for one of its two destinations: strip frontmatter,
     * structure markers and comments, then reflow if the user asked for it.
     *
     * The two differ in one respect. `convertFileLinks` rewrites an attachment
     * as `![](file:///…)`, which resolves on this machine only — useful in the
     * sidecar note, which stays in the vault, and a disclosure of the local
     * username and folder layout in a post, which does not. So the published
     * text drops those links and the sidecar keeps them.
     *
     * Embedded images and videos are unaffected either way: they are uploaded
     * and attached to the post separately, and never take the `file://` form.
     *
     * The word count uses the published text, so it keeps describing what
     * actually goes out.
     */
    const buildText = (
      baked: string,
      range: [number, number] | undefined,
      { forPublishing, contentRemoved = false }: {
        forPublishing: boolean;
        contentRemoved?: boolean;
      }
    ) => {
      const normalized = normalizeForPublishing(baked, {
        // A card span starts below the frontmatter, so skip that offset.
        frontmatterEndOffset: range
          ? undefined
          : frontmatterEndOffset(this.app, file),
        contentRemoved,
        stripLocalFileLinks: forPublishing,
      });

      return settings.smartFormatting ? smartFormat(normalized) : normalized;
    };

    new Setting(contentEl).setName('Output file name').then((setting) => {
      new Setting(contentEl).then((setting) => {
        setting.addButton((btn) =>
          btn.setButtonText('Calculate word count').onClick(async () => {
            const range = await resolveRange();
            if (range === null) {
              setting.descEl.setText('Card not found in the saved file yet.');
              return;
            }
            const baked = await bake(
              this.app,
              file,
              null,
              new Set(),
              settings,
              new Set(),
              range ?? undefined
            );
            setting.descEl.setText(
              getWordCount(
                buildText(baked, range ?? undefined, { forPublishing: true })
              ).toString()
            );
          })
        );
      });

      // The API key lives in the plugin's settings tab, not here — a post
      // dialog is the wrong place to manage a credential. Point there when it
      // is missing, so the empty platform list is self-explanatory.
      if (!settings.zettelcasting_api_key) {
        contentEl.createDiv({
          cls: 'setting-item-description zettelcasting-platform-status is-error',
          text: 'No API key set. Add one in Settings → Community plugins → ZettelCasting.',
        });
      }

      this.platformSelect = createPlatformSelect(contentEl, plugin);
      void this.platformSelect.refresh();

      this.modalEl.createDiv('modal-button-container', (el) => {
        // Section numbers are digits and dots, so they are already filename-safe.
        let outputName = selection
          ? `${file.basename} - ${selection.fileNameSuffix}.zcast.md`
          : file.basename + '.zcast.md';
        // The vault root's path is '/', which would build a '//name.md' path.
        const parentPath = file.parent?.path ?? '';
        let outputFolder = parentPath === '/' ? '' : parentPath;

        if (outputFolder) outputFolder += '/';

        const btn = el.createEl('button', {
          cls: 'mod-cta',
          text: 'Schedule Post',
        });

        activeWindow.setTimeout(() => {
          btn.focus();
        });

        btn.addEventListener('click', async () => {
          disableBtn(btn);
          if (outputName) {
            const { vault } = this.app;

            if (!settings.zettelcasting_api_key) {
              new Notice(
                'Add your ZettelCasting API key in the plugin settings before scheduling.',
                8000
              );
              enableBtn(btn);
              return;
            }

            if (!settings.platform) {
              new Notice('Select a platform to publish to.');
              enableBtn(btn);
              return;
            }

            // Read the store once; `subscribe` here would leak an unsubscriber
            // on every click. Falls back to "now" when no date was picked.
            const publishDate = get(picked_date) ?? new Date();

            const range = await resolveRange();
            if (range === null) {
              new Notice(
                'Could not find that card in the saved note. Give Branch Writing a moment to save, then try again.',
                8000
              );
              enableBtn(btn);
              return;
            }

            const mediaFiles = new Set<TFile>();
            const baked = await bake(
              this.app,
              file,
              null,
              new Set(),
              settings,
              mediaFiles,
              range ?? undefined
            );

            // Strip frontmatter and hierarchical-writing structure markers only
            // now that baking is done — doing it earlier would shift the
            // metadata-cache offsets bake() splices links and embeds at.
            //
            // Uploaded embeds were removed from the body, leaving a gap.
            const contentRemoved = mediaFiles.size > 0;
            const publishText = buildText(baked, range ?? undefined, {
              forPublishing: true,
              contentRemoved,
            });
            // The vault copy keeps the `file://` attachment links the post
            // drops: they resolve here, which is the whole point of a sidecar.
            const localText = buildText(baked, range ?? undefined, {
              forPublishing: false,
              contentRemoved,
            });

            // Upload embedded images/videos first; abort the post if any fail
            // so we never schedule a post that's missing its media.
            const mediaUrls: string[] = [];
            try {
              for (const mediaFile of mediaFiles) {
                mediaUrls.push(
                  await uploadMedia(
                    this.app,
                    mediaFile,
                    BACKEND_URL,
                    settings.zettelcasting_api_key
                  )
                );
              }
            } catch (err) {
              new Notice(
                err instanceof Error ? err.message : 'Media upload failed',
                8000
              );
              enableBtn(btn);
              return;
            }

            try {
              await send_note(
                publishText,
                publishDate,
                settings.platform,
                settings.zettelcasting_api_key,
                BACKEND_URL,
                mediaUrls
              );
            } catch (err) {
              new Notice(
                err instanceof Error ? err.message : 'Failed to schedule post',
                8000
              );
              enableBtn(btn);
              return;
            }

            const count = mediaUrls.length;
            new Notice(
              count > 0
                ? `Scheduled post with ${count} media file${count === 1 ? '' : 's'}.`
                : 'Scheduled post.'
            );

            // `outputName` already carries the .md extension unless the user
            // edited it away — Vault.create rejects extensionless paths.
            const fileName = outputName.endsWith('.md')
              ? outputName
              : outputName + '.md';
            const nextPath = outputFolder + fileName;

            // The post is already scheduled at this point, so a local write
            // failure must not be reported as a scheduling failure.
            try {
              let existing = vault.getAbstractFileByPath(nextPath);

              // Write the normalized text, not the raw bake: the sidecar is a
              // record of what went out, and this keeps a source note's
              // frontmatter from being inherited by the generated file. It
              // differs from the posted text only in keeping the `file://`
              // attachment links, which resolve in the vault but not off it.
              if (existing instanceof TFile) {
                await vault.modify(existing, localText);
              } else {
                existing = await vault.create(nextPath, localText);
              }

              if (existing instanceof TFile) {
                await this.app.workspace.getLeaf('tab').openFile(existing);
              }
            } catch (err) {
              new Notice(
                `Post scheduled, but writing ${nextPath} failed: ${
                  err instanceof Error ? err.message : 'unknown error'
                }`,
                8000
              );
            }
          }

          this.close();
        });

        setting.addText((text) =>
          text.setValue(outputName).onChange((value) => {
            outputName = value;
            if (!value) {
              disableBtn(btn);
            } else if (btn.disabled) {
              enableBtn(btn);
            }
          })
        );
      });
    });
  }

  onOpen() {
    // `picked_date` is a module-level store shared by every modal instance —
    // reset it so a date picked in a previous session isn't reused silently.
    picked_date.set(null);
    this.component = new Component({
      target: this.contentEl,
    });
  }

  onClose() {
    this.platformSelect?.dispose();
    this.platformSelect = null;
    picked_date.set(null);
    this.component.$destroy();
    const { contentEl } = this;
    contentEl.empty();
  }
}
