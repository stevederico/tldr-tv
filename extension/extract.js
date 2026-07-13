/**
 * Article extraction for the Watch this article extension.
 * Pure functions — no Chrome APIs — so Node tests can drive them with jsdom.
 *
 * Policy: only visible/selectable page content. Never bypass paywalls.
 */

/** Minimum transcript length before we accept an extraction. */
export const MIN_TRANSCRIPT_CHARS = 80;

/** Prefer selection when it is at least this long. */
export const MIN_SELECTION_CHARS = 80;

/**
 * @typedef {object} ExtractedArticle
 * @property {string} title
 * @property {string} author
 * @property {string} transcript
 * @property {string} sourceUrl
 * @property {string} [date]
 * @property {string} [thumbnail]
 * @property {boolean} fromSelection
 */

/**
 * Read a meta content value by name or property.
 *
 * @param {Document} doc
 * @param {string} key - name= or property= value
 * @returns {string}
 */
export function metaContent(doc, key) {
  const el =
    doc.querySelector(`meta[property="${key}"]`) ||
    doc.querySelector(`meta[name="${key}"]`);
  const content = el?.getAttribute('content');
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * Best-effort title from og:title, h1, then document.title.
 *
 * @param {Document} doc
 * @returns {string}
 */
export function extractTitle(doc) {
  const og = metaContent(doc, 'og:title');
  if (og) return og.slice(0, 200);
  const h1 = doc.querySelector('h1')?.textContent?.trim();
  if (h1) return h1.slice(0, 200);
  const title = doc.title?.trim() || '';
  return (title || 'Untitled article').slice(0, 200);
}

/**
 * Best-effort author from common meta tags.
 *
 * @param {Document} doc
 * @returns {string}
 */
export function extractAuthor(doc) {
  return (
    metaContent(doc, 'author') ||
    metaContent(doc, 'article:author') ||
    metaContent(doc, 'og:article:author') ||
    ''
  ).slice(0, 200);
}

/**
 * Best-effort publication date string.
 *
 * @param {Document} doc
 * @returns {string}
 */
export function extractDate(doc) {
  return (
    metaContent(doc, 'article:published_time') ||
    metaContent(doc, 'date') ||
    metaContent(doc, 'og:article:published_time') ||
    doc.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ||
    ''
  ).slice(0, 80);
}

/**
 * Best-effort thumbnail URL (og/twitter image).
 *
 * @param {Document} doc
 * @returns {string}
 */
export function extractThumbnail(doc) {
  return (
    metaContent(doc, 'og:image') ||
    metaContent(doc, 'og:image:secure_url') ||
    metaContent(doc, 'twitter:image') ||
    metaContent(doc, 'twitter:image:src') ||
    ''
  );
}

/**
 * Strip non-content nodes from a cloned root element.
 *
 * @param {Element} root
 * @returns {void}
 */
export function stripChrome(root) {
  const kill =
    'script, style, noscript, iframe, svg, canvas, form, nav, aside, footer, header, [aria-hidden="true"], [role="navigation"], [role="banner"], [role="complementary"]';
  root.querySelectorAll(kill).forEach((el) => el.remove());
}

/**
 * Build transcript text from a content root.
 * Prefers paragraph joins; falls back to normalized innerText.
 *
 * @param {Element} root
 * @returns {string}
 */
export function textFromRoot(root) {
  const clone = root.cloneNode(true);
  // Avoid `instanceof Element` — not defined in Node when tests run outside a window.
  if (!clone || typeof clone.querySelectorAll !== 'function') return '';
  stripChrome(clone);

  const paras = [...clone.querySelectorAll('p')]
    .map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 40);

  if (paras.length >= 2) {
    return paras.join('\n\n').trim();
  }

  const raw = (clone.textContent || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return raw;
}

/**
 * Pick the best content root on the page.
 *
 * @param {Document} doc
 * @returns {Element}
 */
export function pickContentRoot(doc) {
  const candidates = [
    doc.querySelector('article'),
    doc.querySelector('[role="main"]'),
    doc.querySelector('main'),
    doc.querySelector('.post-content'),
    doc.querySelector('.article-body'),
    doc.querySelector('.entry-content'),
    doc.querySelector('#content'),
    doc.body,
  ];
  for (const el of candidates) {
    if (el) return el;
  }
  return doc.documentElement;
}

/**
 * Extract an article payload from a Document + optional selection.
 * Selection wins when long enough (paywall / hard pages).
 *
 * @param {Document} doc
 * @param {object} [opts]
 * @param {string} [opts.selection] - window selection text
 * @param {string} [opts.pageUrl] - page URL (defaults to doc.URL / location)
 * @returns {ExtractedArticle}
 * @throws {Error} when transcript is too short
 */
export function extractArticle(doc, opts = {}) {
  const selection = (opts.selection || '').trim();
  const sourceUrl =
    (opts.pageUrl || doc.URL || '').trim() ||
    (typeof location !== 'undefined' ? location.href : '');

  const title = extractTitle(doc);
  const author = extractAuthor(doc);
  const date = extractDate(doc);
  const thumbnail = extractThumbnail(doc);

  if (selection.length >= MIN_SELECTION_CHARS) {
    return {
      title,
      author,
      transcript: selection,
      sourceUrl,
      date: date || undefined,
      thumbnail: thumbnail || undefined,
      fromSelection: true,
    };
  }

  const root = pickContentRoot(doc);
  const transcript = textFromRoot(root);

  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    throw new Error(
      'Could not extract enough article text. Select the article body, then try again.'
    );
  }

  return {
    title,
    author,
    transcript,
    sourceUrl,
    date: date || undefined,
    thumbnail: thumbnail || undefined,
    fromSelection: false,
  };
}
