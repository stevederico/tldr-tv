import { getCSRFToken } from '@stevederico/skateboard-ui/Utilities';

/**
 * Headers for a state-changing fetch.
 *
 * Adds `Content-Type: application/json` when `json` is true, and the CSRF
 * token from the shell when the browser has one. Anonymous requests with no
 * cookie send no token.
 *
 * @param json - When true, set a JSON content type.
 * @returns Header map safe to pass to `fetch`.
 */
export function mutationHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getCSRFToken();
  if (token) {
    headers['X-CSRF-Token'] = token;
  }
  return headers;
}
