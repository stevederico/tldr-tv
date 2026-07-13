/**
 * Popup UI: extract article from active tab → create guide → open player.
 */

const watchBtn = document.getElementById('watch');
const statusEl = document.getElementById('status');

/**
 * @param {string} text
 * @param {'idle' | 'ok' | 'error'} kind
 */
function setStatus(text, kind = 'idle') {
  if (!(statusEl instanceof HTMLElement)) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', kind === 'error');
  statusEl.classList.toggle('is-ok', kind === 'ok');
}

/**
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active tab');
  return tab;
}

/**
 * Ask the content script for an article payload.
 *
 * @param {number} tabId
 * @returns {Promise<import('./extract.js').ExtractedArticle>}
 */
async function extractFromTab(tabId) {
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_ARTICLE' });
  } catch {
    throw new Error(
      'Cannot read this page. Open a normal http(s) article and try again.'
    );
  }
  if (!res?.ok) {
    throw new Error(res?.error || 'Extraction failed');
  }
  return res.article;
}

/**
 * @param {import('./extract.js').ExtractedArticle} article
 * @returns {Promise<{ slug: string }>}
 */
async function createViaBackground(article) {
  const res = await chrome.runtime.sendMessage({
    type: 'CREATE_GUIDE',
    article,
  });
  if (!res?.ok) {
    throw new Error(res?.error || 'Create failed');
  }
  return { slug: res.slug };
}

async function handleWatch() {
  if (!(watchBtn instanceof HTMLButtonElement)) return;
  watchBtn.disabled = true;
  setStatus('Reading page…');

  try {
    const tab = await getActiveTab();
    if (tab.url && /^(chrome|chrome-extension|edge|about|devtools):/i.test(tab.url)) {
      throw new Error('Open a normal web article first (not a browser page).');
    }

    const article = await extractFromTab(tab.id);
    const mode = article.fromSelection ? 'selection' : 'page';
    setStatus(`Creating guide from ${mode}…`);

    const { slug } = await createViaBackground(article);
    setStatus(`Opening player: ${slug}`, 'ok');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    watchBtn.disabled = false;
  }
}

watchBtn?.addEventListener('click', () => {
  void handleWatch();
});
