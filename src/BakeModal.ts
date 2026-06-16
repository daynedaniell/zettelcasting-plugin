import {
  App,
  DropdownComponent,
  FileSystemAdapter,
  Modal,
  Notice,
  Platform,
  Setting,
  TFile,
  parseLinktext,
  resolveSubpath,
} from 'obsidian';

import EasyBake, { BACKEND_URL, BakeSettings } from './main';
import {
  applyIndent,
  extractSubpath,
  getWordCount,
  mimeFromExtension,
  sanitizeBakedContent,
  stripFirstBullet,
} from './util';

import Component from './Component.svelte';
import { picked_date } from './date.store';

const lineStartRE = /(?:^|\n) *$/;
const listLineStartRE = /(?:^|\n)([ \t]*)(?:[-*+]|[0-9]+[.)]) +$/;
const lineEndRE = /^ *(?:\r?\n|$)/;

interface PlatformWithConnectionDto {
  key: string;
  provider: string;
  name: string;
  logoUrl: string;
  enabled: boolean;
  isConnected: boolean;
}

async function bake(
  app: App,
  file: TFile,
  subpath: string | null,
  ancestors: Set<TFile>,
  settings: BakeSettings,
  // Collects embedded image/video files encountered while baking so the caller
  // can upload them and attach the resulting URLs to the post.
  media: Set<TFile> = new Set()
) {
  const { vault, metadataCache } = app;

  let text = await vault.cachedRead(file);
  const cache = metadataCache.getFileCache(file);

  if (!cache) return text;

  const resolvedSubpath = subpath ? resolveSubpath(cache, subpath) : null;
  if (resolvedSubpath) {
    text = extractSubpath(text, resolvedSubpath, cache);
  }

  const links = settings.bakeLinks ? cache.links || [] : [];
  const embeds = settings.bakeEmbeds ? cache.embeds || [] : [];
  const targets = [...links, ...embeds];

  if (targets.length === 0) return text;

  targets.sort((a, b) => a.position.start.offset - b.position.start.offset);

  const newAncestors = new Set(ancestors);
  newAncestors.add(file);

  let posOffset = 0;
  for (const target of targets) {
    const { path, subpath } = parseLinktext(target.link);
    const linkedFile = metadataCache.getFirstLinkpathDest(path, file.path);

    if (!linkedFile) continue;

    const start = target.position.start.offset + posOffset;
    const end = target.position.end.offset + posOffset;
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

    if (newAncestors.has(linkedFile) || isInline) {
      replaceTarget(target.displayText || path);
      continue;
    }

    const baked = sanitizeBakedContent(
      await bake(app, linkedFile, subpath, newAncestors, settings, media)
    );
    replaceTarget(
      listMatch ? applyIndent(stripFirstBullet(baked), listMatch[1]) : baked
    );
  }

  return text;
}

/** Resolve the API base origin, trimming any trailing slash. */
function apiBase(backendUrl: string): string {
  return (backendUrl || '').replace(/\/$/, '');
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

  const { url } = (await resp.json()) as { url: string };
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
  btn.setAttrs({ disabled: 'true', 'aria-disabled': 'true' });
}

function enableBtn(btn: HTMLButtonElement) {
  btn.removeClass('mod-muted');
  btn.addClass('mod-cta');
  btn.setAttrs({ disabled: 'false', 'aria-disabled': 'false' });
}

export class BakeModal extends Modal {
  component: Component;

  constructor(plugin: EasyBake, file: TFile) {
    super(plugin.app);

    const { contentEl } = this;
    const { settings } = plugin;

    this.titleEl.setText('Schedule post with ZettelCasting');
    this.modalEl.addClass('mod-narrow', 'easy-bake-modal');
    this.contentEl
      .createEl('p', { text: 'Input file: ' })
      .createEl('strong', { text: file.path });

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
        'Convert links to ![[non-markdown files.png]] to ![](file:///full/path/to/non-markdown%20files.png)'
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.convertFileLinks).onChange((value) => {
          settings.convertFileLinks = value;
          plugin.saveSettings();
        })
      );

    new Setting(contentEl).setName('Output file name').then((setting) => {
      new Setting(contentEl).then((setting) => {
        setting.addButton((btn) =>
          btn.setButtonText('Calculate word count').onClick(async () => {
            const baked = await bake(this.app, file, null, new Set(), settings);
            setting.descEl.setText(getWordCount(baked).toString());
          })
        );
      });

      // Declare variables before defining refreshPlatforms so the closure
      // captures the bindings (assigned below before first call).
      let platformDropdown!: DropdownComponent;
      let platformStatusEl!: HTMLDivElement;

      // Fetches the authenticated user's connected platforms and updates the dropdown.
      const refreshPlatforms = async () => {
        const apiKey = settings.zettelcasting_api_key;

        if (!apiKey) {
          platformStatusEl.setText(
            'Enter an API key above to see your connected platforms.'
          );
          platformStatusEl.style.color = 'var(--text-muted)';
          const sel = platformDropdown.selectEl;
          while (sel.options.length > 0) sel.remove(0);
          sel.add(new Option('No platforms available', ''));
          platformDropdown.setDisabled(true);
          return;
        }

        platformStatusEl.setText('Fetching platforms…');
        platformStatusEl.style.color = 'var(--text-muted)';

        try {
          const resp = await fetch(`${apiBase(BACKEND_URL)}/api/integrations/pkm/platforms`, {
            headers: { 'X-API-Key': apiKey },
          });

          if (!resp.ok) {
            const isAuth = resp.status === 401 || resp.status === 403;
            platformStatusEl.setText(
              isAuth
                ? 'Invalid API key — please check your key and try again.'
                : `Server error (${resp.status}) — please try again later.`
            );
            platformStatusEl.style.color = 'var(--text-error)';
            return;
          }

          const platforms = (await resp.json()) as PlatformWithConnectionDto[];
          const connected = platforms.filter((p) => p.isConnected);

          const sel = platformDropdown.selectEl;
          while (sel.options.length > 0) sel.remove(0);

          if (connected.length === 0) {
            sel.add(new Option('No platforms connected — visit your dashboard', ''));
            platformDropdown.setDisabled(true);
            platformStatusEl.setText(
              'No platforms connected. Connect platforms in your ZettelCasting dashboard.'
            );
            platformStatusEl.style.color = 'var(--text-error)';
            return;
          }

          platformDropdown.setDisabled(false);
          for (const p of connected) {
            sel.add(new Option(p.name, p.key));
          }

          // Restore previously saved selection if still available
          const hasMatch = connected.some((p) => p.key === settings.platform);
          const targetValue = hasMatch ? settings.platform : connected[0].key;
          sel.value = targetValue;
          if (settings.platform !== targetValue) {
            settings.platform = targetValue;
            await plugin.saveSettings();
          }

          const count = connected.length;
          platformStatusEl.setText(
            `${count} platform${count === 1 ? '' : 's'} connected.`
          );
          platformStatusEl.style.color = 'var(--text-success)';
        } catch {
          platformStatusEl.setText(
            'Could not reach the ZettelCasting server. Please try again later.'
          );
          platformStatusEl.style.color = 'var(--text-error)';
        }
      };

      // --- API key input ---
      new Setting(contentEl)
        .setName('Zettelcasting API Key')
        .addText((text) =>
          text
            .setPlaceholder('Enter your ZettelCasting API key')
            .setValue(settings.zettelcasting_api_key)
            .onChange(async (value) => {
              settings.zettelcasting_api_key = value;
              await plugin.saveSettings();
              await refreshPlatforms();
            })
        );

      // Status line (appears between API key and dropdown in the DOM)
      platformStatusEl = contentEl.createDiv({
        cls: 'setting-item-description zettelcasting-platform-status',
        attr: { style: 'padding: 0 var(--size-4-3) var(--size-4-2);' },
      });

      new Setting(contentEl)
        .setName('Publish to Platform')
        .addDropdown((dropdown) => {
          // Populated by refreshPlatforms() with the user's actually-connected
          // platforms — no hardcoded options.
          platformDropdown = dropdown;
          dropdown.onChange(async (value) => {
            settings.platform = value;
            await plugin.saveSettings();
          });
        });

      // Populate the dropdown on open from the saved key/backend URL.
      void refreshPlatforms();

      this.modalEl.createDiv('modal-button-container', (el) => {
        let outputName = file.basename + '.zcast.md';
        let outputFolder = file.parent?.path || '';

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

            let publishDate: Date = new Date();
            picked_date.subscribe((val) => {
              if (val !== null) publishDate = val;
            });

            const mediaFiles = new Set<TFile>();
            const baked = await bake(
              this.app,
              file,
              null,
              new Set(),
              settings,
              mediaFiles
            );

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
                baked,
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

            const nextPath = outputFolder + outputName + '.md';
            let existing = vault.getAbstractFileByPath(nextPath);

            if (existing instanceof TFile) {
              await vault.modify(existing, baked);
            } else {
              existing = await vault.create(nextPath, baked);
            }

            if (existing instanceof TFile) {
              this.app.workspace.getLeaf('tab').openFile(existing);
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
    this.component = new Component({
      target: this.contentEl,
    });
  }

  onClose() {
    this.component.$destroy();
    const { contentEl } = this;
    contentEl.empty();
  }
}
