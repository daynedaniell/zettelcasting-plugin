import { Notice, Plugin } from 'obsidian';

import { IntegrationStatus, fetchIntegrationStatus } from './api';
import { BakeModal } from './BakeModal';
import { SelectionMode, getSelection, hasActiveCard } from './branch-writing';
import { ZettelCastingSettingTab } from './SettingsTab';
import { CacheContents, DashboardCache } from './dashboard/cache';
import { CachedResource } from './dashboard/client';
import { registerConnectionsBlock } from './dashboard/connections-block';

export { BACKEND_URL } from './api';

/** Cache key for the integration-status response. */
const STATUS_CACHE_KEY = 'integration-status';

export interface BakeSettings {
  bakeLinks: boolean;
  bakeEmbeds: boolean;
  bakeInList: boolean;
  convertFileLinks: boolean;
  smartFormatting: boolean;
  platform: string;
  zettelcasting_api_key: string;
  /**
   * Stable identifier for this vault, generated once on first publish and never
   * again.
   *
   * Deliberately not derived from the vault's name or filesystem path: both
   * change when the user renames or moves the vault, which would silently orphan
   * every post already mapped to it. Empty until the first publish generates it.
   */
  sourceVaultId: string;
  /**
   * Write the published post's id back into the source note's frontmatter as
   * `zc_post_id`.
   *
   * On by default — it is what lets a note be matched to its post without a
   * path lookup — but it is the only part of publishing that writes to the
   * user's notes, so it stays switchable.
   */
  stampPostId: boolean;
  /**
   * Last-known-good API responses for the dashboard blocks.
   *
   * It shares `data.json` with the settings above rather than taking a file of
   * its own: both are written through the one `saveData` call, so they cannot
   * clobber each other, and Obsidian gives a plugin exactly one data file.
   */
  dashboardCache: CacheContents;
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
  // Empty until the first publish; `vaultId()` fills it in.
  sourceVaultId: '',
  stampPostId: true,
  dashboardCache: {},
};

export default class EasyBake extends Plugin {
  settings: BakeSettings;

  /** Shared by every dashboard block, so N blocks make one request. */
  statusResource: CachedResource<IntegrationStatus>;

  /** The key the blocks last saw, to notice a change in settings. */
  private lastApiKey = '';

  async loadSettings() {
    // `loadData` is typed `any`; name the shape we expect at the boundary so
    // nothing downstream inherits it. Anything unrecognised in data.json is
    // simply carried through, as before.
    const stored = (await this.loadData()) as Partial<BakeSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
    // A fresh object, so a vault with no cache yet does not end up sharing —
    // and then mutating — the one on DEFAULT_SETTINGS.
    this.settings.dashboardCache = { ...(stored?.dashboardCache ?? {}) };
    this.lastApiKey = this.settings.zettelcasting_api_key;
  }

  /**
   * This vault's id, generating and persisting one the first time it is asked
   * for.
   *
   * Lazy rather than generated at install time so a user who never publishes
   * never has an identifier written for them, and so existing installs pick one
   * up on their next publish rather than needing a migration.
   */
  async vaultId(): Promise<string> {
    if (!this.settings.sourceVaultId) {
      this.settings.sourceVaultId = crypto.randomUUID();
      await this.saveSettings();
    }
    return this.settings.sourceVaultId;
  }

  async saveSettings() {
    await this.saveData(this.settings);

    // The key changed, so anything cached belongs to the previous account and
    // must not be rendered under this one's credentials.
    if (this.settings.zettelcasting_api_key !== this.lastApiKey) {
      this.lastApiKey = this.settings.zettelcasting_api_key;
      await this.statusResource?.reset();
    }
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
    await this.setUpDashboard();

    this.addSettingTab(new ZettelCastingSettingTab(this.app, this));

    // Command IDs and names carry no plugin prefix: Obsidian namespaces the ID
    // by plugin already, and shows the plugin name beside every command.
    this.addCommand({
      id: 'schedule-post-current-file',
      name: 'Schedule post from current file',
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile;
        if (checking || !file) return !!file;
        new BakeModal(this, file).open();
      },
    });

    this.addBranchWritingCommand(
      'schedule-post-active-card',
      'Schedule post from active Branch Writing card',
      'card'
    );

    this.addBranchWritingCommand(
      'schedule-post-active-branch',
      'Schedule post from active Branch Writing branch',
      'branch'
    );
  }

  /**
   * Build the shared cache and client, then register the dashboard blocks.
   *
   * Registration itself makes no request. The blocks read from cache on their
   * first frame and only revalidate once one is actually on screen — and the
   * fetcher returns without touching the network at all while no API key is
   * stored, which is what keeps a fresh install silent until the user connects
   * an account.
   */
  private async setUpDashboard() {
    const cache = new DashboardCache({
      // The cache is a slice of the same `data.json` the settings live in.
      load: () => this.settings.dashboardCache,
      save: async (entries) => {
        this.settings.dashboardCache = entries;
        await this.saveData(this.settings);
      },
    });
    await cache.load();

    this.statusResource = new CachedResource(
      STATUS_CACHE_KEY,
      cache,
      async () => {
        const result = await fetchIntegrationStatus(
          this.settings.zettelcasting_api_key
        );
        return result.status === 'ok'
          ? { ok: true, data: result.data }
          : { ok: false, kind: result.status, message: result.message };
      }
    );

    registerConnectionsBlock(
      this,
      this.statusResource,
      () => !!this.settings.zettelcasting_api_key
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
