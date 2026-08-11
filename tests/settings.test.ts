import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS } from '../src/main';

describe('default settings', () => {
  it('leaves file link conversion off', () => {
    // A conservative default rather than a safety mechanism: the published text
    // strips these links whatever this is set to (see normalizeForPublishing's
    // `stripLocalFileLinks`), so turning it on only adds absolute paths to the
    // sidecar note in the vault. Off by default because most people never open
    // the sidecar.
    assert.equal(DEFAULT_SETTINGS.convertFileLinks, false);
  });

  it('leaves smart formatting off, since it rewrites the body', () => {
    assert.equal(DEFAULT_SETTINGS.smartFormatting, false);
  });

  it('ships no credentials and no preselected platform', () => {
    assert.equal(DEFAULT_SETTINGS.zettelcasting_api_key, '');
    assert.equal(DEFAULT_SETTINGS.platform, '');
  });
});
