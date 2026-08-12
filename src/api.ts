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

  let resp: RequestUrlResponse;
  try {
    // `throw: false` so a 4xx/5xx comes back as a status to translate below
    // rather than an exception; only a genuine network failure throws here.
    resp = await requestUrl({
      url: `${apiBase(backendUrl)}/api/integrations/pkm/platforms`,
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

  let payload: unknown;
  try {
    // A getter that parses on access, so a non-JSON body throws right here.
    payload = resp.json;
  } catch {
    return {
      status: 'error',
      message: 'The server returned an unreadable response.',
    };
  }

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
