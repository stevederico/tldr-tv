/**
 * Service worker: create guide via API; open full tab only on request.
 * Default UX is on-page PiP (content script), not a redirect.
 */
import { getConfig } from './config.js';

/**
 * @typedef {import('./extract.js').ExtractedArticle} ExtractedArticle
 */

/**
 * POST extracted article to the book-player API and return the new slug.
 *
 * @param {ExtractedArticle} article
 * @returns {Promise<{ slug: string }>}
 */
async function createGuide(article) {
  const { apiBase } = await getConfig();
  const res = await fetch(`${apiBase}/api/guides`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: article.title,
      author: article.author || null,
      transcript: article.transcript,
      sourceUrl: article.sourceUrl || null,
      date: article.date || null,
      thumbnail: article.thumbnail || null,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (typeof body.error === 'string' && body.error) ||
      `Create failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  if (typeof body.slug !== 'string' || !body.slug) {
    throw new Error('Create succeeded but no slug returned');
  }
  return { slug: body.slug };
}

/**
 * Open the full web player in a new tab.
 *
 * @param {string} slug
 * @returns {Promise<void>}
 */
async function openFullPlayer(slug) {
  const { appBase } = await getConfig();
  await chrome.tabs.create({
    url: `${appBase}/app/${encodeURIComponent(slug)}`,
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'CREATE_GUIDE') {
    (async () => {
      try {
        const article = message.article;
        if (!article || typeof article.transcript !== 'string') {
          throw new Error('Missing article payload');
        }
        const { slug } = await createGuide(article);
        sendResponse({ ok: true, slug });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  if (message?.type === 'OPEN_FULL_PLAYER') {
    (async () => {
      try {
        const slug = typeof message.slug === 'string' ? message.slug : '';
        if (!slug) throw new Error('Missing slug');
        await openFullPlayer(slug);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  return false;
});
