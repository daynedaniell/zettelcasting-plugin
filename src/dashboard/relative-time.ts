/**
 * Human-readable ages for the "last synced" and "last published" lines.
 *
 * Both arguments are explicit rather than reading the clock inside, so a panel
 * that formats several timestamps dates them all from one instant instead of
 * from several a few milliseconds apart.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `2 minutes ago`, `3 hours ago`, `12 Aug 2026`. */
export function formatRelative(thenMs: number, nowMs: number): string {
  const elapsed = nowMs - thenMs;

  // A clock correction, or a server slightly ahead of this machine, should not
  // produce "in 3 seconds" on a panel about things that already happened.
  if (elapsed < 45 * SECOND) return 'just now';

  if (elapsed < 90 * SECOND) return 'a minute ago';
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)} minutes ago`;
  if (elapsed < 90 * MINUTE) return 'an hour ago';
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)} hours ago`;
  if (elapsed < 2 * DAY) return 'yesterday';
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;

  // Past a week, the date is more useful than the interval.
  return new Date(thenMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Format an ISO timestamp, or a fallback when it is absent or unparseable.
 *
 * The fallback is a caller's choice because "never" is the right word for a
 * platform that has never published and the wrong one for a sync that simply
 * has not happened yet.
 */
export function formatIsoRelative(
  iso: string | null,
  nowMs: number,
  fallback: string
): string {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? fallback : formatRelative(parsed, nowMs);
}
