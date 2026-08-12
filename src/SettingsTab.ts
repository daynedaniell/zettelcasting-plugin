import { App, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';

import { BACKEND_URL } from './api';
import EasyBake, { BakeSettings } from './main';
import { PlatformSelect, attachPlatformSelect } from './platform-select';

/** The baking settings the modal and this tab both expose. */
type BakingToggleKey = Extract<
  {
    [K in keyof BakeSettings]: BakeSettings[K] extends boolean ? K : never;
  }[keyof BakeSettings],
  string
>;

/**
 * Copy for the baking toggles, shared by every row below. These read from and
 * write to `plugin.settings` by key — Obsidian persists them for us.
 */
const BAKING_TOGGLES: {
  key: BakingToggleKey;
  name: string;
  desc: string;
}[] = [
  {
    key: 'bakeEmbeds',
    name: 'Convert embedded Markdown',
    desc: 'Include the content of ![[embedded Markdown files]] when the link is on its own line.',
  },
  {
    key: 'bakeLinks',
    name: 'Convert links',
    desc: 'Include the content of [[any link]] when it is on its own line.',
  },
  {
    key: 'bakeInList',
    name: 'Convert links and embeds in lists',
    desc: 'Include the content of [[any link]] or ![[embedded Markdown file]] when it takes up an entire list bullet.',
  },
  {
    key: 'convertFileLinks',
    name: 'Convert file links',
    desc: 'Rewrite links to non-Markdown files, a PDF say, as ![](file:///full/path/to/report.pdf) in the local copy saved to your vault. These links never go out with the post — the path resolves on this machine only. Images and videos are uploaded and attached to the post instead, so they are unaffected.',
  },
  {
    key: 'smartFormatting',
    name: 'Smart formatting',
    desc: 'Reflow the post into flowing paragraphs: folds the line breaks between cards and wrapped lines into running prose. Headings, lists, quotes and code blocks keep their own lines.',
  },
];

/**
 * Plugin settings tab — Settings → Community plugins → ZettelCasting.
 *
 * Holds the account credentials and the baking defaults, so the API key can be
 * entered once instead of inside every publish modal. Everything here writes
 * the same `plugin.settings` the modal reads, so a change in either place is
 * immediately reflected in the other.
 *
 * Declared rather than rendered: returning definitions from
 * `getSettingDefinitions` is what puts these settings in Obsidian's global
 * settings search, and lets Obsidian own the read/write/persist cycle for the
 * plain toggles. The two rows that no built-in control covers — a masked
 * credential field and a dropdown whose options are fetched — use the `render`
 * escape hatch, and stay searchable through the name and description declared
 * alongside them.
 */
export class ZettelCastingSettingTab extends PluginSettingTab {
  private platformSelect: PlatformSelect | null = null;

  constructor(app: App, private plugin: EasyBake) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: 'group',
        heading: 'Account',
        items: [
          {
            name: 'ZettelCasting API key',
            desc: createFragment((frag) => {
              frag.appendText('Find your key in your ZettelCasting dashboard at ');
              frag.createEl('a', {
                text: BACKEND_URL.replace(/^https?:\/\//, ''),
                href: BACKEND_URL,
              });
              frag.appendText('.');
            }),
            aliases: ['token', 'credential', 'login', 'account'],
            render: (setting) => this.renderApiKey(setting),
          },
          {
            name: 'Default platform',
            desc: 'Preselected in the publish dialog. You can still change it there for an individual post.',
            aliases: ['connected platforms', 'publish to'],
            render: (setting) => this.renderPlatformSelect(setting),
          },
        ],
      },
      {
        type: 'group',
        heading: 'Baking defaults',
        items: BAKING_TOGGLES.map(({ key, name, desc }) => ({
          name,
          desc,
          control: { type: 'toggle', key },
        })),
      },
    ];
  }

  hide() {
    // The `render` cleanup below covers the ordinary teardown; this catches the
    // paths where Obsidian tears the tab down without unmounting the row.
    this.disposePlatformSelect();
    super.hide();
  }

  /**
   * Masked credential field. `render` rows persist nothing on their own, so
   * this saves the key itself — same write the modal's rows do.
   */
  private renderApiKey(setting: Setting) {
    const { settings } = this.plugin;

    setting.addText((text) => {
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
  }

  /**
   * The connected-platform dropdown. Its options come from the server, so no
   * declarative control fits: `dropdown` takes a fixed set of options.
   */
  private renderPlatformSelect(setting: Setting) {
    this.disposePlatformSelect();

    const statusEl = setting.descEl.createDiv({
      cls: 'zettelcasting-platform-status',
    });

    const platformSelect = attachPlatformSelect(setting, statusEl, this.plugin);
    this.platformSelect = platformSelect;
    void platformSelect.refresh();

    return () => {
      // Only clear the field if this row is still the live one — a re-render
      // will have replaced it before the old row is torn down.
      if (this.platformSelect === platformSelect) this.platformSelect = null;
      platformSelect.dispose();
    };
  }

  private disposePlatformSelect() {
    this.platformSelect?.dispose();
    this.platformSelect = null;
  }
}
