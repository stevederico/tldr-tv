/**
 * Content script: extract article (or selection) on demand from the page.
 * Module entry — imports pure helpers from extract.js.
 */
import { extractArticle } from './extract.js';

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
