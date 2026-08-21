/**
 * ZettelCasting backend access.
 *
 * One implementation shared by the modal and the settings tab, rather than two
 * drifting copies. Requests go through Obsidian's `requestUrl` rather than
 * `fetch`, so they are not subject to the renderer's CORS rules; the tests
 * drive them through the stub `obsidian` module.
 */
import { RequestUrlResponse, requestUrl } from 'obsidian';

/**
 * ZettelCasting API origin. This is a fixed deployment endpoint and is
 * intentionally not user-configurable.
 */
export const BACKEND_URL = 'https://zettelcasting.com';

export interface PlatformWithConnectionDto {
  key: string;
  provider: string;
  name: string;
  logoUrl: string;
  enabled: boolean;
  isConnected: boolean;
}

/**
 * Outcome of a platform lookup. The caller decides how to present it; every
 * case carries a ready-to-display `message` so the modal and the settings tab
 * say the same thing.
 */
export type PlatformsResult =
  | { status: 'no-key'; message: string }
  | { status: 'ok'; connected: PlatformWithConnectionDto[]; message: string }
  | { status: 'unauthorized'; message: string }
  | { status: 'error'; message: string };

/**
 * Connection health for one platform, as `GET /api/integrations/pkm/status`
 * reports it.
 *
 * `unknown` is not a server value. It is what an unrecognised state degrades
 * to, so a server that grows a sixth state renders as "Unknown" in an older
 * plugin rather than being silently misfiled under a state it does not mean.
 */
export type IntegrationState =
  | 'connected'
  | 'expiring_soon'
  | 'expired'
  | 'error'
  | 'disconnected'
  | 'unknown';

const KNOWN_STATES: ReadonlySet<string> = new Set([
  'connected',
  'expiring_soon',
  'expired',
  'error',
  'disconnected',
]);

export interface IntegrationPlatformStatus {
  key: string;
  provider: string;
  name: string;
  state: IntegrationState;
  /** ISO timestamp, or null when the platform's credential does not expire. */
  tokenExpiresAt: string | null;
  /** ISO timestamp of the most recent successful publish, or null. */
  lastPublishedAt: string | null;
  failedJobCount: number;
}

export interface IntegrationStatus {
  /** When the server built the payload — what "last synced" should report. */
  generatedAt: string;
  platforms: IntegrationPlatformStatus[];
}

/** Same shape of outcome as `PlatformsResult`, carrying a displayable payload. */
export type IntegrationStatusResult =
  | { status: 'no-key'; message: string }
  | { status: 'ok'; data: IntegrationStatus; message: string }
  | { status: 'unauthorized'; message: string }
  | { status: 'error'; message: string };

/** Resolve the API base origin, trimming any trailing slash. */
export function apiBase(backendUrl: string): string {
  return (backendUrl || '').replace(/\/$/, '');
}

/**
 * Escape a field name or filename for a `Content-Disposition` header.
 *
 * The HTML form-submission rules percent-encode exactly three bytes in these
 * values — `"`, CR and LF — and leave the rest as raw UTF-8. A `"` in a note's
 * attachment name would otherwise close the quoted string and corrupt the
 * header, and `%` itself is deliberately not escaped, matching what a browser
 * sends.
 */
function escapeMultipartField(value: string): string {
  return value
    .replace(/"/g, '%22')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * Assemble a `multipart/form-data` body holding one file, byte for byte what
 * `FormData` produced before — the endpoint is unchanged, only the client is.
 *
 * `requestUrl` takes a string or an ArrayBuffer, never a `FormData`, so the
 * envelope is built here. The boundary is a parameter rather than generated
 * inside so the layout can be asserted in tests; callers pass a random one,
 * which is what keeps it from colliding with the file's own bytes.
 */
export function multipartFileBody(
  fieldName: string,
  filename: string,
  mime: string,
  bytes: ArrayBuffer,
  boundary: string
): ArrayBuffer {
  const encoder = new TextEncoder();

  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartField(
        fieldName
      )}"; filename="${escapeMultipartField(filename)}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(head.length + bytes.byteLength + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(bytes), head.length);
  body.set(tail, head.length + bytes.byteLength);

  return body.buffer;
}

/** A fresh multipart boundary, long enough that file bytes never match it. */
export function multipartBoundary(): string {
  return `----zettelcasting${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * One authenticated GET, with every failure already translated into the
 * wording the callers share.
 *
 * Extracted so a second endpoint cannot word "invalid key" differently from
 * the first — the same reason this module exists rather than one client per
 * caller. Never throws.
 */
async function requestJson(
  url: string,
  apiKey: string
): Promise<
  | { status: 'ok'; payload: unknown }
  | { status: 'unauthorized'; message: string }
  | { status: 'error'; message: string }
> {
  let resp: RequestUrlResponse;
  try {
    // `throw: false` so a 4xx/5xx comes back as a status to translate below
    // rather than an exception; only a genuine network failure throws here.
    resp = await requestUrl({
      url,
      headers: { 'X-API-Key': apiKey },
      throw: false,
    });
  } catch {
    return {
      status: 'error',
      message: 'Could not reach the ZettelCasting server. Please try again later.',
    };
  }

  if (resp.status === 401 || resp.status === 403) {
    return {
      status: 'unauthorized',
      message: 'Invalid API key — please check your key and try again.',
    };
  }

  if (resp.status < 200 || resp.status >= 300) {
    return {
      status: 'error',
      message: `Server error (${resp.status}) — please try again later.`,
    };
  }

  try {
    // A getter that parses on access, so a non-JSON body throws right here.
    return { status: 'ok', payload: resp.json };
  } catch {
    return {
      status: 'error',
      message: 'The server returned an unreadable response.',
    };
  }
}

/**
 * Fetch the platforms the authenticated user has actually connected.
 *
 * Never throws — a network failure comes back as an `error` result, because
 * every caller renders the outcome rather than propagating it.
 */
export async function fetchConnectedPlatforms(
  apiKey: string,
  backendUrl: string = BACKEND_URL
): Promise<PlatformsResult> {
  if (!apiKey) {
    return {
      status: 'no-key',
      message: 'Enter an API key to see your connected platforms.',
    };
  }

  const result = await requestJson(
    `${apiBase(backendUrl)}/api/integrations/pkm/platforms`,
    apiKey
  );
  if (result.status !== 'ok') return result;
  const { payload } = result;

  // Guard the shape: a malformed payload would otherwise fill the dropdown with
  // `undefined` keys and post to nothing.
  if (!Array.isArray(payload)) {
    return {
      status: 'error',
      message: 'The server returned an unexpected response.',
    };
  }

  const connected = (payload as PlatformWithConnectionDto[]).filter(
    (p) => p && p.isConnected && typeof p.key === 'string' && p.key
  );

  const count = connected.length;

  return {
    status: 'ok',
    connected,
    message:
      count === 0
        ? 'No platforms connected. Connect platforms in your ZettelCasting dashboard.'
        : `${count} platform${count === 1 ? '' : 's'} connected.`,
  };
}

/**
 * Coerce one platform entry from the status endpoint.
 *
 * Returns null for anything unusable rather than a half-filled object: a row
 * with no key cannot be matched against a block's `platforms:` filter, and one
 * with no name has nothing to render. A single bad row drops out; it does not
 * fail the panel.
 */
function toPlatformStatus(value: unknown): IntegrationPlatformStatus | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const key = typeof raw.key === 'string' ? raw.key : '';
  if (!key) return null;

  const state =
    typeof raw.state === 'string' && KNOWN_STATES.has(raw.state)
      ? (raw.state as IntegrationState)
      : 'unknown';

  // `failedJobCount` is a count, so a negative or fractional value is a bug
  // upstream; clamp rather than render "-1 failed".
  const failedRaw = Number(raw.failedJobCount);
  const failedJobCount = Number.isFinite(failedRaw)
    ? Math.max(0, Math.floor(failedRaw))
    : 0;

  const timestamp = (field: unknown): string | null =>
    typeof field === 'string' && !Number.isNaN(Date.parse(field)) ? field : null;

  return {
    key,
    provider: typeof raw.provider === 'string' ? raw.provider : key,
    name: typeof raw.name === 'string' && raw.name ? raw.name : key,
    state,
    tokenExpiresAt: timestamp(raw.tokenExpiresAt),
    lastPublishedAt: timestamp(raw.lastPublishedAt),
    failedJobCount,
  };
}

/**
 * Fetch per-platform connection health.
 *
 * Never throws, for the same reason as `fetchConnectedPlatforms`: the blocks
 * render the outcome, and a block that throws takes the note's whole preview
 * down with it.
 */
export async function fetchIntegrationStatus(
  apiKey: string,
  backendUrl: string = BACKEND_URL
): Promise<IntegrationStatusResult> {
  if (!apiKey) {
    return {
      status: 'no-key',
      message: 'Connect your ZettelCasting account in settings to see your platforms.',
    };
  }

  const result = await requestJson(
    `${apiBase(backendUrl)}/api/integrations/pkm/status`,
    apiKey
  );
  if (result.status !== 'ok') return result;

  const payload = result.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.platforms)) {
    return {
      status: 'error',
      message: 'The server returned an unexpected response.',
    };
  }

  const platforms = payload.platforms
    .map(toPlatformStatus)
    .filter((p): p is IntegrationPlatformStatus => p !== null);

  // Fall back to now if the server sent no usable stamp, so the "last synced"
  // line still has something to count from rather than reading "never".
  const generatedAt =
    typeof payload.generatedAt === 'string' &&
    !Number.isNaN(Date.parse(payload.generatedAt))
      ? payload.generatedAt
      : new Date().toISOString();

  const count = platforms.filter((p) => p.state !== 'disconnected').length;

  return {
    status: 'ok',
    data: { generatedAt, platforms },
    message:
      count === 0
        ? 'No platforms connected. Connect platforms in your ZettelCasting dashboard.'
        : `${count} platform${count === 1 ? '' : 's'} connected.`,
  };
}

/** Everything one publish needs, before it becomes a request body. */
export interface PublishPostInput {
  /** The baked, publish-ready text. */
  body: string;
  platform: string;
  scheduledFor: Date;
  media: string[];
  /**
   * Vault-relative path of the note this came from, and this vault's stable id.
   * Both omitted when frontmatter stamping is off or no vault id exists yet —
   * the post still publishes, it just carries no source mapping.
   */
  sourcePath?: string;
  sourceVaultId?: string;
}

/**
 * The request body, separated from the request so it can be asserted directly.
 *
 * `tags: ['scheduled']` is what this endpoint has always sent and is preserved
 * verbatim. The two source fields are omitted entirely rather than sent as
 * `undefined` — the server rejects unknown *and* malformed properties, so a
 * key with no value is not the same as no key.
 */
export function buildPublishPayload(
  input: PublishPostInput
): Record<string, unknown> {
  return {
    body: input.body,
    platform: input.platform,
    scheduledFor: input.scheduledFor,
    media: input.media,
    tags: ['scheduled'],
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.sourceVaultId ? { sourceVaultId: input.sourceVaultId } : {}),
  };
}

/**
 * Outcome of a publish. `postId` is the server's id for the new post, or null
 * when the response carried no usable one — which is not a failure: the post is
 * published either way, there is simply nothing to stamp into the note.
 */
export type PublishResult =
  | { status: 'ok'; postId: string | null }
  | { status: 'error'; message: string };

/**
 * Whether a 400 is the server telling us it does not know these fields.
 *
 * The API runs a whitelist validator that rejects unrecognised properties, so a
 * plugin that has been updated ahead of the server would fail *every* publish
 * rather than merely losing the source mapping. Detecting that case lets the
 * publish be retried without them, which decouples the two release cadences.
 */
function rejectsSourceFields(status: number, text: string): boolean {
  if (status !== 400) return false;
  return text.includes('sourcePath') || text.includes('sourceVaultId');
}

/** Read the post id out of a publish response, or null if it has none. */
function postIdFrom(resp: RequestUrlResponse): string | null {
  try {
    const payload = resp.json as { id?: unknown } | null;
    return payload && typeof payload.id === 'string' && payload.id
      ? payload.id
      : null;
  } catch {
    // A published post with an unreadable response body is still published.
    return null;
  }
}

/**
 * Publish (or schedule) one post.
 *
 * Never throws, like the fetchers above: the modal renders the outcome, and a
 * thrown error there would leave the button disabled with nothing said.
 */
export async function publishPost(
  input: PublishPostInput,
  apiKey: string,
  backendUrl: string = BACKEND_URL
): Promise<PublishResult> {
  const url = `${apiBase(backendUrl)}/api/integrations/pkm/posts`;

  const send = async (payload: Record<string, unknown>) =>
    // `requestUrl` rather than `fetch`: it goes out through Obsidian rather
    // than the renderer, so the request is not subject to CORS. `throw: false`
    // keeps the status check below as the single place a failure becomes a
    // message.
    requestUrl({
      url,
      method: 'POST',
      contentType: 'application/json',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify(payload),
      throw: false,
    });

  let resp: RequestUrlResponse;
  try {
    resp = await send(buildPublishPayload(input));

    if (rejectsSourceFields(resp.status, resp.text ?? '')) {
      // Older server. Publishing matters more than the mapping, so drop the
      // two fields and go again — once, never in a loop.
      resp = await send(
        buildPublishPayload({
          ...input,
          sourcePath: undefined,
          sourceVaultId: undefined,
        })
      );
    }
  } catch {
    return {
      status: 'error',
      message: 'Could not reach the ZettelCasting server. Please try again later.',
    };
  }

  if (resp.status < 200 || resp.status >= 300) {
    return {
      status: 'error',
      message: `Failed to schedule post (${resp.status})`,
    };
  }

  return { status: 'ok', postId: postIdFrom(resp) };
}
