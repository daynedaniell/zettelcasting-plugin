import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatIsoRelative, formatRelative } from '../src/dashboard/relative-time';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

/** Format something that happened `elapsed` ms before NOW. */
const ago = (elapsed: number) => formatRelative(NOW - elapsed, NOW);

describe('formatRelative', () => {
  it('reads as just now inside the first three-quarters of a minute', () => {
    assert.equal(ago(0), 'just now');
    assert.equal(ago(44 * SECOND), 'just now');
  });

  it('does not say "in 3 seconds" for a timestamp slightly ahead', () => {
    // The server stamps `generatedAt`, so a machine a few seconds behind it
    // would otherwise render a future age on a panel about the past.
    assert.equal(formatRelative(NOW + 10 * SECOND, NOW), 'just now');
  });

  it('counts minutes, then hours', () => {
    assert.equal(ago(75 * SECOND), 'a minute ago');
    assert.equal(ago(5 * MINUTE), '5 minutes ago');
    assert.equal(ago(59 * MINUTE), '59 minutes ago');
    assert.equal(ago(80 * MINUTE), 'an hour ago');
    assert.equal(ago(5 * HOUR), '5 hours ago');
  });

  it('counts days once past yesterday', () => {
    assert.equal(ago(30 * HOUR), 'yesterday');
    assert.equal(ago(3 * DAY), '3 days ago');
    assert.equal(ago(6 * DAY), '6 days ago');
  });

  it('switches to a date past a week', () => {
    // "23 days ago" is harder to place than the date itself.
    const formatted = ago(30 * DAY);
    assert.doesNotMatch(formatted, /ago/);
    assert.match(formatted, /2026/);
  });
});

describe('formatIsoRelative', () => {
  it('formats a valid timestamp', () => {
    const iso = new Date(NOW - 5 * MINUTE).toISOString();
    assert.equal(formatIsoRelative(iso, NOW, 'never'), '5 minutes ago');
  });

  it('falls back for a null timestamp', () => {
    // A platform that has never published has no date to render.
    assert.equal(formatIsoRelative(null, NOW, 'never'), 'never');
  });

  it('falls back rather than rendering "Invalid Date"', () => {
    assert.equal(formatIsoRelative('whenever', NOW, 'never'), 'never');
    assert.equal(formatIsoRelative('', NOW, 'never'), 'never');
  });
});
