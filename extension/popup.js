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
 * @param {number} tabId
 * @param {unknown} message
 * @returns {Promise<unknown>}
 */
function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

/**
 * Inject content script if missing (pages open before install, or failed auto-inject).
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await sendTabMessage(tabId, { type: 'PING' });
    if (pong?.ok) return;
  } catch {
    // not injected yet
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });

  // content.js loads extract async — brief retry for listener registration
  let lastErr = new Error('Content script did not become ready');
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      const pong = await sendTabMessage(tabId, { type: 'PING' });
      if (pong?.ok) return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr;
}

/**
 * @param {number} tabId
 * @returns {Promise<import('./extract.js').ExtractedArticle>}
 */
async function extractFromTab(tabId) {
  await ensureContentScript(tabId);

  let res;
  try {
    res = await sendTabMessage(tabId, { type: 'EXTRACT_ARTICLE' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot read this page (${detail}). Reload the tab and try again.`
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
    const url = tab.url || '';
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('Open a normal http(s) article first (not a browser page).');
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
