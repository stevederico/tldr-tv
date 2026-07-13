/**
 * Content script (classic): load extract helpers via dynamic import, then
 * answer EXTRACT_ARTICLE / PING messages.
 *
 * Classic (not type:module) so Chrome reliably injects it; extract.js stays ESM
 * for Node tests and is imported through chrome.runtime.getURL.
 */
(async () => {
  try {
    const { extractArticle } = await import(chrome.runtime.getURL('extract.js'));

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'PING') {
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type !== 'EXTRACT_ARTICLE') return false;

      try {
        const selection = window.getSelection()?.toString() || '';
        const article = extractArticle(document, {
          selection,
          pageUrl: location.href,
        });
        sendResponse({ ok: true, article });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    });
  } catch (err) {
    console.error('[Watch this article] content script failed to load', err);
  }
})();
