import { MarkdownPostProcessorContext, Plugin, setIcon } from 'obsidian';

import { IntegrationPlatformStatus, IntegrationState, IntegrationStatus } from '../api';
import {
  DashboardBlockHost,
  renderBlockError,
  renderBlockWarning,
} from './block-host';
import { ConnectionsBlockConfig, normalizePlatformId, parseBlockConfig } from './block-config';
import { CachedResource, Snapshot } from './client';
import { formatIsoRelative, formatRelative } from './relative-time';

/**
 * The `zc-connections` block: connection health per platform, rendered inside
 * an ordinary note.
 */

export const BLOCK_NAME = 'zc-connections';

/** How each state reads, and which theme colour carries it. */
const STATE_COPY: Record<IntegrationState, { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'success' },
  expiring_soon: { label: 'Expiring soon', tone: 'warning' },
  expired: { label: 'Expired', tone: 'error' },
  error: { label: 'Error', tone: 'error' },
  disconnected: { label: 'Not connected', tone: 'muted' },
  unknown: { label: 'Unknown', tone: 'muted' },
};

type Tone = 'success' | 'warning' | 'error' | 'muted';

/**
 * Register the processor. Called once from `onload`.
 *
 * The resource is created by the caller and shared, so every block on every
 * note reads one cache and coalesces onto one request.
 */
export function registerConnectionsBlock(
  plugin: Plugin,
  resource: CachedResource<IntegrationStatus>,
  hasApiKey: () => boolean
) {
  plugin.registerMarkdownCodeBlockProcessor(
    BLOCK_NAME,
    (source, el, ctx) => renderBlock(source, el, ctx, resource, hasApiKey)
  );
}

function renderBlock(
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  resource: CachedResource<IntegrationStatus>,
  hasApiKey: () => boolean
) {
  const parsed = parseBlockConfig(source);

  if (!parsed.ok) {
    // A bad body is a note-editing problem; say so in place and stop. No
    // host is created, so nothing is scheduled and nothing needs tearing down.
    renderBlockError(el, parsed.message, BLOCK_NAME);
    return;
  }

  const { config, warnings } = parsed;
  const container = el.createDiv({ cls: 'zc-connections' });
  if (config.compact) container.addClass('is-compact');

  const host = new DashboardBlockHost<IntegrationStatus>(container, {
    name: BLOCK_NAME,
    resource,
    render: (snapshot) =>
      paint(container, snapshot, config, warnings, resource, hasApiKey),
  });

  // Handing the child to Obsidian is what guarantees teardown when the block
  // leaves the preview, however it leaves.
  ctx.addChild(host);
}

/** Repaint the whole block. Cheap enough that diffing would only add bugs. */
function paint(
  container: HTMLElement,
  snapshot: Snapshot<IntegrationStatus>,
  config: ConnectionsBlockConfig,
  warnings: string[],
  resource: CachedResource<IntegrationStatus>,
  hasApiKey: () => boolean
) {
  container.empty();
  const now = Date.now();

  for (const warning of warnings) renderBlockWarning(container, warning);

  // Nothing has been connected yet, so there is nothing to report and — by
  // design — no request has been made to find out.
  if (!hasApiKey()) {
    renderEmptyState(
      container,
      'Connect your ZettelCasting account in Settings → Community plugins → ZettelCasting to see your platforms here.'
    );
    return;
  }

  renderHeader(container, snapshot, now, resource);

  if (snapshot.error) {
    // Beside the data, never instead of it: a failed refresh does not make the
    // last good answer wrong.
    renderBlockWarning(container, snapshot.error);
  }

  const platforms = selectPlatforms(snapshot.data, config);

  if (platforms === null) {
    renderEmptyState(
      container,
      snapshot.loading
        ? 'Loading your platforms…'
        : 'No connection data yet. Refresh to try again.'
    );
    return;
  }

  if (platforms.length === 0) {
    renderEmptyState(
      container,
      config.platforms
        ? `No platforms matched ${config.platforms
            .map((p) => `"${p}"`)
            .join(', ')}. Check the names in this block.`
        : 'No platforms connected. Connect one in your ZettelCasting dashboard.'
    );
    return;
  }

  const list = container.createDiv({ cls: 'zc-connections-list' });
  for (const platform of platforms) {
    renderPlatform(list, platform, config.compact, now);
  }
}

/**
 * Apply the block's `platforms` filter.
 *
 * Returns null when there is nothing cached at all, which the caller renders
 * differently from an empty result — "not loaded yet" and "nothing matched"
 * are different problems with different fixes.
 */
function selectPlatforms(
  data: IntegrationStatus | null,
  config: ConnectionsBlockConfig
): IntegrationPlatformStatus[] | null {
  if (!data) return null;
  if (!config.platforms) return data.platforms;

  const wanted = new Set(config.platforms);
  return data.platforms.filter(
    (p) =>
      wanted.has(normalizePlatformId(p.key)) ||
      wanted.has(normalizePlatformId(p.provider))
  );
}

function renderHeader(
  container: HTMLElement,
  snapshot: Snapshot<IntegrationStatus>,
  now: number,
  resource: CachedResource<IntegrationStatus>
) {
  const header = container.createDiv({ cls: 'zc-connections-header' });

  header.createDiv({
    cls: 'zc-connections-synced',
    text: snapshot.fetchedAt
      ? `Last synced ${formatRelative(snapshot.fetchedAt, now)}`
      : 'Not synced yet',
  });

  const button = header.createEl('button', {
    cls: 'zc-connections-refresh clickable-icon',
    attr: { 'aria-label': 'Refresh connection status' },
  });
  setIcon(button, 'refresh-cw');

  // Disabled while a request is in flight or inside the cooldown, so a click
  // that would do nothing looks like it would do nothing.
  const disabled = snapshot.loading || !resource.canForce();
  button.disabled = disabled;
  button.toggleClass('is-loading', snapshot.loading);

  button.addEventListener('click', () => {
    void resource.force();
  });
}

function renderPlatform(
  list: HTMLElement,
  platform: IntegrationPlatformStatus,
  compact: boolean,
  now: number
) {
  const { label, tone } = STATE_COPY[platform.state] ?? STATE_COPY.unknown;

  const row = list.createDiv({ cls: 'zc-connection' });

  const dot = row.createSpan({ cls: 'zc-connection-dot' });
  dot.setAttribute('data-tone', tone);

  row.createSpan({ cls: 'zc-connection-name', text: platform.name });
  row
    .createSpan({ cls: 'zc-connection-state', text: label })
    .setAttribute('data-tone', tone);

  if (compact) {
    // One line per platform: state, plus the failure count only when it is
    // the thing worth acting on.
    if (platform.failedJobCount > 0) {
      row
        .createSpan({
          cls: 'zc-connection-failed',
          text: `${platform.failedJobCount} failed`,
        })
        .setAttribute('data-tone', 'error');
    }
    return;
  }

  const detail = row.createDiv({ cls: 'zc-connection-detail' });

  detail.createSpan({
    text: `Last published ${formatIsoRelative(
      platform.lastPublishedAt,
      now,
      'never'
    )}`,
  });

  if (platform.state === 'expiring_soon' && platform.tokenExpiresAt) {
    const expires = Date.parse(platform.tokenExpiresAt);
    if (!Number.isNaN(expires)) {
      detail
        .createSpan({
          // Future-dated, so `formatRelative` would read "ago"; word it as the
          // deadline it is.
          text: `Expires ${describeDeadline(expires, now)}`,
        })
        .setAttribute('data-tone', 'warning');
    }
  }

  detail
    .createSpan({
      text:
        platform.failedJobCount === 0
          ? 'No failed jobs'
          : `${platform.failedJobCount} failed job${
              platform.failedJobCount === 1 ? '' : 's'
            }`,
    })
    .setAttribute('data-tone', platform.failedJobCount > 0 ? 'error' : 'muted');
}

/** `in 3 days`, `today`, or a date once it is far enough out. */
function describeDeadline(whenMs: number, now: number): string {
  const days = Math.ceil((whenMs - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 14) return `in ${days} days`;
  return `on ${new Date(whenMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })}`;
}

function renderEmptyState(container: HTMLElement, message: string) {
  return container.createDiv({ cls: 'zc-connections-empty', text: message });
}
