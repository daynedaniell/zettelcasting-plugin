/**
 * ZettelCasting backend access.
 *
 * Kept free of Obsidian imports so the request/response handling can be tested
 * directly, and so the modal and the settings tab share one implementation
 * rather than two drifting copies.
 */

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

  let resp: Response;
  try {
    resp = await fetch(`${apiBase(backendUrl)}/api/integrations/pkm/platforms`, {
      headers: { 'X-API-Key': apiKey },
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

  if (!resp.ok) {
    return {
      status: 'error',
      message: `Server error (${resp.status}) — please try again later.`,
    };
  }

  let payload: unknown;
  try {
    payload = await resp.json();
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
