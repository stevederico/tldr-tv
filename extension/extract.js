/**
 * Article extraction for the TLDR this article extension.
 * Pure functions — no Chrome APIs — so Node tests can drive them with jsdom.
 *
 * Policy: only visible/selectable page content. Never bypass paywalls.
 */

/** Minimum transcript length before we accept an extraction. */
export const MIN_TRANSCRIPT_CHARS = 80;

/** Prefer selection when it is at least this long. */
export const MIN_SELECTION_CHARS = 80;

/**
 * Nodes to strip: chrome UI + comments (sites like MLBTR wrap each comment in
 * `<article class="comment-body">`, which used to beat the real post).
 */
const STRIP_SELECTOR = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'form',
  'nav',
  'aside',
  'footer',
  'header',
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '#comments',
  '#respond',
  '.comments-area',
  '.comment-list',
  '.comment-body',
  '.comment-content',
  '.comment-meta',
  '.comment-respond',
  '.comments',
  '[id^="comments"]',
  '[id^="comment-"]',
  '[class*="comment-list"]',
  '[class*="comments-area"]',
  '.related-posts',
  '.sharedaddy',
  '.jp-relatedposts',
  '.social-share',
  '.fv_sharing_clear',
  '.fvfacebook_share',
  '.fvretweet',
  '.fvemail',
].join(', ');

/**
 * Prefer these roots, scored by cleaned text length.
 * `.entry-content` before bare `article` so WordPress comments lose.
 */
const ROOT_SELECTORS = [
  '.entry-content',
  '.post-content',
  '.article-body',
  '.article-content',
  '.post-body',
  '[itemprop="articleBody"]',
  'article.post',
  'article.type-post',
  'main article',
  'main .content',
  'main',
  '[role="main"]',
  '#content',
  'article',
];

/**
 * @typedef {object} ExtractedArticle
 * @property {string} title
 * @property {string} author
 * @property {string} transcript
 * @property {string} sourceUrl
 * @property {string} [date]
 * @property {string} [thumbnail]
 * @property {string[]} pageImages - Blog images for PiP while generated art loads
 * @property {boolean} fromSelection
 */

/** Cap how many page images we keep for the PiP carousel. */
export const MAX_PAGE_IMAGES = 12;

/**
 * Minimum width AND height (px) for a page image to qualify. Article/hero photos
 * are large in both dimensions; share buttons, avatars, emoji, and icons are
 * small, and decorative banners/nav strips are large in one dimension but tiny
 * in the other. We only reject when a real size is known — an unmeasurable image
 * (lazy, no attrs) is kept rather than risk dropping the main photo.
 */
export const MIN_IMAGE_DIM = 200;

/**
 * Max width:height (or height:width) ratio. Rejects banners, rules, and vertical
 * nav strips (e.g. Paul Graham's site chrome) that pass a single-dimension check
 * but are clearly not content photos.
 */
export const MAX_IMAGE_ASPECT = 3;

/**
 * Known pixel dimensions of an <img>, or 0 when unknown. Tries, in order:
 * natural pixels (loaded images), width/height attributes, then the rendered
 * box. A width-only srcset descriptor is returned as a square (aspect unknown,
 * so it isn't rejected on ratio).
 *
 * @param {Element} img
 * @returns {{ w: number, h: number }}
 */
export function imageDims(img) {
  let w = Number(img.naturalWidth) || 0;
  let h = Number(img.naturalHeight) || 0;
  if (!w) w = parseInt(img.getAttribute('width') || '0', 10) || 0;
  if (!h) h = parseInt(img.getAttribute('height') || '0', 10) || 0;
  if (!w && !h) {
    let maxW = 0;
    for (const part of (img.getAttribute('srcset') || '').split(',')) {
      const m = part.trim().match(/\s(\d+)w$/);
      if (m) maxW = Math.max(maxW, parseInt(m[1], 10));
    }
    if (maxW > 0) return { w: maxW, h: maxW };
  }
  if (!w && !h) {
    try {
      const r = img.getBoundingClientRect();
      w = Math.round(r.width) || 0;
      h = Math.round(r.height) || 0;
    } catch {
      /* detached */
    }
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * True if an image is large enough and not banner/strip-shaped to be a real
 * content photo. Unknown size (both 0) passes — the URL blocklist still applies,
 * and we'd rather keep a lazy hero than drop it.
 *
 * @param {{ w: number, h: number }} dims
 * @returns {boolean}
 */
export function isQualityImage({ w, h }) {
  if (!w && !h) return true; // unmeasurable → allow
  if (w && h) {
    if (w < MIN_IMAGE_DIM || h < MIN_IMAGE_DIM) return false;
    const ar = w / h;
    return ar <= MAX_IMAGE_ASPECT && ar >= 1 / MAX_IMAGE_ASPECT;
  }
  return Math.max(w, h) >= MIN_IMAGE_DIM; // only one dim known
}

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
  const h1 = doc.querySelector('h1.entry-title, h1')?.textContent?.trim();
  if (h1) return h1.slice(0, 200);
  const title = doc.title?.trim() || '';
  return (title || 'Untitled article').slice(0, 200);
}

/**
 * Best-effort author from common meta tags / JSON-LD Person.
 *
 * @param {Document} doc
 * @returns {string}
 */
export function extractAuthor(doc) {
  const meta =
    metaContent(doc, 'author') ||
    metaContent(doc, 'article:author') ||
    metaContent(doc, 'og:article:author');
  if (meta) return meta.slice(0, 200);

  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || '');
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const author = node?.author;
        if (typeof author === 'string' && author.trim()) return author.trim().slice(0, 200);
        if (author && typeof author === 'object' && typeof author.name === 'string') {
          return author.name.trim().slice(0, 200);
        }
        if (Array.isArray(author) && author[0]?.name) {
          return String(author[0].name).trim().slice(0, 200);
        }
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }
  return '';
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
 * Collect usable article images from the page (absolute http(s) URLs).
 * Used as PiP artwork while Grok images generate (and kept as extras).
 *
 * @param {Document} doc
 * @param {object} [opts]
 * @param {string} [opts.pageUrl]
 * @returns {string[]}
 */
export function extractPageImages(doc, opts = {}) {
  const base =
    (opts.pageUrl || doc.URL || '').trim() ||
    (typeof location !== 'undefined' ? location.href : 'https://example.com/');

  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * @param {string} raw
   */
  function push(raw) {
    if (!raw || raw.startsWith('data:')) return;
    let abs = raw.trim();
    try {
      abs = new URL(abs, base).toString();
    } catch {
      return;
    }
    if (!/^https?:\/\//i.test(abs)) return;
    // Skip obvious icons / avatars / share buttons / trackers by URL.
    if (/\b(sprite|icon|logo|avatar|gravatar|emoji|share|social|profile|author|widget|1x1|pixel|badge|button|spacer|blank)\b/i.test(abs)) return;
    if (/gravatar\.com|\/emoji\//i.test(abs)) return;
    // GIFs on article pages are almost always decorative (site chrome, spacers,
    // banners) — not high-quality content photos.
    if (/\.gif(\?|#|$)/i.test(abs)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  }

  push(extractThumbnail(doc));

  const root = pickContentRoot(doc);
  const scope = root || doc.body;
  if (scope && typeof scope.querySelectorAll === 'function') {
    for (const img of scope.querySelectorAll('img[src], img[data-src], img[srcset]')) {
      if (isInsideComments(img)) continue;
      // Reject small images (avatars, share buttons, icons) and banner/strip
      // shapes (site chrome) by measured size + aspect. Unknown size is allowed.
      if (!isQualityImage(imageDims(img))) continue;
      const src =
        img.getAttribute('src') ||
        img.getAttribute('data-src') ||
        img.getAttribute('data-lazy-src') ||
        '';
      if (src) push(src);
      // Prefer the highest-resolution candidate in srcset ("url 320w, url 1024w"
      // or "url 1x, url 2x") rather than whichever happens to be last.
      let bestUrl = '';
      let bestScore = -1;
      for (const part of (img.getAttribute('srcset') || '').split(',')) {
        const [u, desc = ''] = part.trim().split(/\s+/);
        if (!u) continue;
        const m = desc.match(/^(\d+(?:\.\d+)?)(w|x)$/);
        const score = m ? Number(m[1]) * (m[2] === 'x' ? 1000 : 1) : 0;
        if (score > bestScore) {
          bestScore = score;
          bestUrl = u;
        }
      }
      if (bestUrl) push(bestUrl);
      if (out.length >= MAX_PAGE_IMAGES) break;
    }
  }

  return out.slice(0, MAX_PAGE_IMAGES);
}

/**
 * True if an element lives inside a comments region.
 *
 * @param {Element | null} el
 * @returns {boolean}
 */
export function isInsideComments(el) {
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(
    el.closest(
      '#comments, #respond, .comments-area, .comment-list, .comment-body, .comment-content, [id^="comment-"]'
    )
  );
}

/**
 * Strip non-content nodes from a cloned root element.
 *
 * @param {Element} root
 * @returns {void}
 */
export function stripChrome(root) {
  root.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
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
    .filter((t) => t.length >= 40)
    .filter((t) => !/^(reply|share|repost|log\s*in|sign\s*in)\b/i.test(t));

  if (paras.length >= 1) {
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
 * Pick the best content root on the page by cleaned text length.
 *
 * @param {Document} doc
 * @returns {Element}
 */
export function pickContentRoot(doc) {
  /** @type {Element | null} */
  let best = null;
  let bestLen = 0;

  for (const sel of ROOT_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (isInsideComments(el)) continue;
      const text = textFromRoot(el);
      if (text.length > bestLen) {
        best = el;
        bestLen = text.length;
      }
    }
  }

  if (best) return best;
  return doc.body || doc.documentElement;
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
  const pageImages = extractPageImages(doc, { pageUrl: sourceUrl });

  if (selection.length >= MIN_SELECTION_CHARS) {
    return {
      title,
      author,
      transcript: selection,
      sourceUrl,
      date: date || undefined,
      thumbnail: thumbnail || undefined,
      pageImages,
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
    pageImages,
    fromSelection: false,
  };
}
