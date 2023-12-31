import { Plugin } from 'obsidian';

import { BakeModal } from './BakeModal';

export interface BakeSettings {
  bakeLinks: boolean;
  bakeEmbeds: boolean;
  bakeInList: boolean;
  convertFileLinks: boolean;
  zettelcasting_api_key: string;
}

const DEFAULT_SETTINGS: BakeSettings = {
  bakeLinks: true,
  bakeEmbeds: true,
  bakeInList: true,
  convertFileLinks: true,
  zettelcasting_api_key: '1234567891011',
};

export default class EasyBake extends Plugin {
  settings: BakeSettings;

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  get activeMarkdownFile() {
    return this.app.workspace.activeEditor?.file;
  }

  async onload() {
    await this.loadSettings();

    this.addCommand({
  id: 'send-to-zettelcasting-file',
      name: 'Send to ZettelCasting - current file',
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile;
        if (checking || !file) return !!file;
        new BakeModal(this, file).open();
      },
    });
  }

}
