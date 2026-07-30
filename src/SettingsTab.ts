import { App, PluginSettingTab, Setting } from 'obsidian';

import { BACKEND_URL } from './api';
import EasyBake from './main';
import { PlatformSelect, createPlatformSelect } from './platform-select';

/**
 * Plugin settings tab — Settings → Community plugins → ZettelCasting.
 *
 * Holds the account credentials and the baking defaults, so the API key can be
 * entered once instead of inside every publish modal. Everything here writes
 * the same `plugin.settings` the modal reads, so a change in either place is
 * immediately reflected in the other.
 */
export class ZettelCastingSettingTab extends PluginSettingTab {
  private platformSelect: PlatformSelect | null = null;

  constructor(app: App, private plugin: EasyBake) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const { settings } = this.plugin;

    containerEl.empty();

    new Setting(containerEl).setName('Account').setHeading();

    new Setting(containerEl)
      .setName('ZettelCasting API key')
      .setDesc(
        createFragment((frag) => {
          frag.appendText('Find your key in your ZettelCasting dashboard at ');
          frag.createEl('a', {
            text: BACKEND_URL.replace(/^https?:\/\//, ''),
            href: BACKEND_URL,
          });
          frag.appendText('.');
        })
      )
      .addText((text) => {
        // Masked like any other credential field; the key is a bearer token.
        text.inputEl.type = 'password';
        text.inputEl.autocapitalize = 'off';
        text.inputEl.spellcheck = false;

        text
          .setPlaceholder('Enter your ZettelCasting API key')
          .setValue(settings.zettelcasting_api_key)
          .onChange(async (value) => {
            settings.zettelcasting_api_key = value.trim();
            await this.plugin.saveSettings();
            // Debounced — otherwise pasting a key fires one request per keystroke.
            this.platformSelect?.scheduleRefresh();
          });
      });

    this.platformSelect?.dispose();
    this.platformSelect = createPlatformSelect(
      containerEl,
      this.plugin,
      'Default platform',
      'Preselected in the publish dialog. You can still change it there for an individual post.'
    );
    void this.platformSelect.refresh();

    new Setting(containerEl)
      .setName('Baking defaults')
      .setDesc(
        'Starting values for the publish dialog. Changing them there updates these too.'
      )
      .setHeading();

    this.addToggle(
      'Convert embedded markdown',
      'Include the content of ![[embedded markdown files]] when the link is on its own line.',
      'bakeEmbeds'
    );

    this.addToggle(
      'Convert links',
      'Include the content of [[any link]] when it is on its own line.',
      'bakeLinks'
    );

    this.addToggle(
      'Convert links and embeds in lists',
      'Include the content of [[any link]] or ![[embedded markdown file]] when it takes up an entire list bullet.',
      'bakeInList'
    );

    this.addToggle(
      'Convert file links',
      'Convert links to ![[non-markdown files.png]] to ![](file:///full/path/to/non-markdown%20files.png)',
      'convertFileLinks'
    );

    this.addToggle(
      'Smart formatting',
      'Reflow the post into flowing paragraphs: folds the line breaks between cards and wrapped lines into running prose. Headings, lists, quotes and code blocks keep their own lines.',
      'smartFormatting'
    );
  }

  hide() {
    this.platformSelect?.dispose();
    this.platformSelect = null;
    this.containerEl.empty();
  }

  /** One of the four boolean baking settings, shared with the publish modal. */
  private addToggle(
    name: string,
    desc: string,
    key:
      | 'bakeEmbeds'
      | 'bakeLinks'
      | 'bakeInList'
      | 'convertFileLinks'
      | 'smartFormatting'
  ) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
