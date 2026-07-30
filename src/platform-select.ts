import { DropdownComponent, Setting } from 'obsidian';

import { fetchConnectedPlatforms } from './api';
import EasyBake from './main';

/**
 * The "Publish to platform" dropdown plus its status line.
 *
 * Shared by the publish modal and the settings tab so both populate the list
 * the same way, guard against out-of-order responses the same way, and word
 * their errors the same way.
 */
export interface PlatformSelect {
  /** Fetch now. */
  refresh(): Promise<void>;
  /** Fetch shortly, coalescing rapid calls — used while the key is typed. */
  scheduleRefresh(): void;
  /** Cancel any pending refresh. Call from onClose/hide. */
  dispose(): void;
}

const REFRESH_DEBOUNCE_MS = 400;

export function createPlatformSelect(
  container: HTMLElement,
  plugin: EasyBake,
  name = 'Publish to platform',
  desc?: string
): PlatformSelect {
  const { settings } = plugin;

  let dropdown!: DropdownComponent;

  const statusEl = container.createDiv({
    cls: 'setting-item-description zettelcasting-platform-status',
  });

  const setting = new Setting(container).setName(name);
  if (desc) setting.setDesc(desc);

  setting.addDropdown((component) => {
    // Populated by refresh() with the user's actually-connected platforms —
    // there are no hardcoded options.
    dropdown = component;
    component.onChange(async (value) => {
      settings.platform = value;
      await plugin.saveSettings();
    });
  });

  const setStatus = (
    message: string,
    state: 'muted' | 'error' | 'success' = 'muted'
  ) => {
    statusEl.setText(message);
    statusEl.toggleClass('is-error', state === 'error');
    statusEl.toggleClass('is-success', state === 'success');
  };

  const showPlaceholder = (label: string) => {
    const sel = dropdown.selectEl;
    while (sel.options.length > 0) sel.remove(0);
    sel.add(new Option(label, ''));
    dropdown.setDisabled(true);
  };

  // Bumped on every refresh so a slow earlier response can't overwrite the
  // result of a later one.
  let generation = 0;
  let timer: number | null = null;

  const refresh = async () => {
    const current = ++generation;

    setStatus(
      settings.zettelcasting_api_key
        ? 'Fetching platforms…'
        : 'Enter an API key to see your connected platforms.'
    );

    const result = await fetchConnectedPlatforms(settings.zettelcasting_api_key);

    if (current !== generation) return;

    if (result.status !== 'ok') {
      setStatus(
        result.message,
        result.status === 'no-key' ? 'muted' : 'error'
      );
      // Drop the now-unusable options so a stale list can't be submitted.
      showPlaceholder('No platforms available');
      return;
    }

    const { connected } = result;

    if (connected.length === 0) {
      showPlaceholder('No platforms connected — visit your dashboard');
      setStatus(result.message, 'error');
      return;
    }

    const sel = dropdown.selectEl;
    while (sel.options.length > 0) sel.remove(0);
    dropdown.setDisabled(false);
    for (const platform of connected) {
      sel.add(new Option(platform.name, platform.key));
    }

    // Keep the saved choice when it is still connected.
    const hasMatch = connected.some((p) => p.key === settings.platform);
    const target = hasMatch ? settings.platform : connected[0].key;
    sel.value = target;
    if (settings.platform !== target) {
      settings.platform = target;
      await plugin.saveSettings();
    }

    setStatus(result.message, 'success');
  };

  const clearTimer = () => {
    if (timer === null) return;
    activeWindow.clearTimeout(timer);
    timer = null;
  };

  return {
    refresh,
    scheduleRefresh() {
      clearTimer();
      timer = activeWindow.setTimeout(() => {
        timer = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    },
    dispose: clearTimer,
  };
}
