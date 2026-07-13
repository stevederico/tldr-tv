/**
 * Extension runtime config (API + app origins).
 * Defaults target local dev; override via chrome.storage.sync keys `apiBase` / `appBase`.
 */

/** @type {{ apiBase: string, appBase: string }} */
export const DEFAULT_CONFIG = {
  apiBase: 'http://localhost:8000',
  appBase: 'http://localhost:5173',
};

/**
 * Load config from chrome.storage.sync, falling back to defaults.
 *
 * @returns {Promise<{ apiBase: string, appBase: string }>}
 */
export async function getConfig() {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) {
    return { ...DEFAULT_CONFIG };
  }
  const stored = await chrome.storage.sync.get(['apiBase', 'appBase']);
  return {
    apiBase: typeof stored.apiBase === 'string' && stored.apiBase.trim()
      ? stored.apiBase.trim().replace(/\/$/, '')
      : DEFAULT_CONFIG.apiBase,
    appBase: typeof stored.appBase === 'string' && stored.appBase.trim()
      ? stored.appBase.trim().replace(/\/$/, '')
      : DEFAULT_CONFIG.appBase,
  };
}
