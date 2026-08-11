import { Notice, Plugin } from 'obsidian';

import { BakeModal } from './BakeModal';
import { SelectionMode, getSelection, hasActiveCard } from './branch-writing';
import { ZettelCastingSettingTab } from './SettingsTab';

export { BACKEND_URL } from './api';

export interface BakeSettings {
  bakeLinks: boolean;
  bakeEmbeds: boolean;
  bakeInList: boolean;
  convertFileLinks: boolean;
  smartFormatting: boolean;
  platform: string;
  zettelcasting_api_key: string;
}

export const DEFAULT_SETTINGS: BakeSettings = {
  bakeLinks: true,
  bakeEmbeds: true,
  bakeInList: true,
  // Opt-in: affects only the sidecar note saved to the vault, since the
  // published text strips these links either way. Inherited from Easy Bake,
  // where the output stayed on disk and a file:// link actually resolved.
  convertFileLinks: false,
  // Opt-in: it rewrites the body, so existing setups keep their output.
  smartFormatting: false,
  platform: '',
  zettelcasting_api_key: '',
};

export default class EasyBake extends Plugin {
  settings: BakeSettings;

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * `activeEditor` is null whenever no text editor holds focus — including in
   * views that render a note without one, such as Branch Writing. Fall back to
   * the active leaf's file so the command stays available there.
   */
  get activeMarkdownFile() {
    const file =
      this.app.workspace.activeEditor?.file ?? this.app.workspace.getActiveFile();
    return file?.extension === 'md' ? file : null;
  }

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new ZettelCastingSettingTab(this.app, this));

    this.addCommand({
      id: 'send-to-zettelcasting-file',
      name: 'Send to ZettelCasting - current file',
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile;
        if (checking || !file) return !!file;
        new BakeModal(this, file).open();
      },
    });

    this.addBranchWritingCommand(
      'send-to-zettelcasting-card',
      'Send to ZettelCasting - active card',
      'card'
    );

    this.addBranchWritingCommand(
      'send-to-zettelcasting-branch',
      'Send to ZettelCasting - active branch',
      'branch'
    );
  }

  /**
   * Publish a single Branch Writing card, or that card plus its descendants.
   *
   * Both commands stay hidden unless a Branch Writing view is focused with a
   * card selected, so they are unreachable without that plugin installed and
   * enabled. The whole-file command above is unaffected either way.
   */
  private addBranchWritingCommand(
    id: string,
    name: string,
    mode: SelectionMode
  ) {
    this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        // Cheap probe while the palette is filtering; build the full selection
        // only when the command actually runs.
        if (checking) return hasActiveCard(this.app);

        const selection = getSelection(this.app, mode);
        if (!selection) {
          new Notice('No Branch Writing card is selected.');
          return;
        }

        new BakeModal(this, selection.file, selection).open();
      },
    });
  }
}
