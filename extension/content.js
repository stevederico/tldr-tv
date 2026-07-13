/**
 * Content script (classic): extract helpers + on-page PiP shell.
 *
 * Classic (not type:module) so Chrome reliably injects it; extract.js stays ESM
 * and is imported through chrome.runtime.getURL.
 */
(async () => {
  const HOST_ID = 'watch-this-article-pip-host';

  /**
   * Remove the floating PiP host if present.
   * @returns {void}
   */
  function closePip() {
    document.getElementById(HOST_ID)?.remove();
  }

  /**
   * Mount a draggable PiP frame on the blog page (extension-origin iframe).
   *
   * @param {string} slug
   * @returns {void}
   */
  function showPip(slug) {
    closePip();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-watch-pip', '1');
    Object.assign(host.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      width: '340px',
      height: '320px',
      zIndex: '2147483646',
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.08)',
      background: '#0a0a0a',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    });

    const bar = document.createElement('div');
    Object.assign(bar.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 8px',
      background: '#141414',
      color: '#fafafa',
      cursor: 'grab',
      userSelect: 'none',
      flexShrink: '0',
    });
    bar.setAttribute('data-pip-drag', '1');

    const label = document.createElement('span');
    label.textContent = 'Watch this article';
    Object.assign(label.style, {
      fontSize: '11px',
      fontWeight: '600',
      flex: '1',
      opacity: '0.9',
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close player');
    Object.assign(closeBtn.style, {
      appearance: 'none',
      border: '0',
      background: 'transparent',
      color: '#fafafa',
      fontSize: '18px',
      lineHeight: '1',
      cursor: 'pointer',
      padding: '0 4px',
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePip();
    });

    bar.append(label, closeBtn);

    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL(`pip.html?slug=${encodeURIComponent(slug)}`);
    frame.title = 'Watch this article player';
    frame.allow = 'autoplay';
    Object.assign(frame.style, {
      border: '0',
      width: '100%',
      flex: '1',
      background: '#0a0a0a',
    });

    // Drag via title bar
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    bar.addEventListener('pointerdown', (e) => {
      if (e.target === closeBtn) return;
      dragging = true;
      bar.style.cursor = 'grabbing';
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = `${origLeft}px`;
      host.style.top = `${origTop}px`;
      bar.setPointerCapture(e.pointerId);
    });

    bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      host.style.left = `${Math.max(8, origLeft + dx)}px`;
      host.style.top = `${Math.max(8, origTop + dy)}px`;
    });

    bar.addEventListener('pointerup', (e) => {
      dragging = false;
      bar.style.cursor = 'grab';
      try {
        bar.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    });

    host.append(bar, frame);
    document.documentElement.appendChild(host);
  }

  try {
    const { extractArticle } = await import(chrome.runtime.getURL('extract.js'));

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'PING') {
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === 'SHOW_PIP') {
        try {
          const slug = typeof message.slug === 'string' ? message.slug : '';
          if (!slug) throw new Error('Missing slug');
          showPip(slug);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return false;
      }

      if (message?.type === 'CLOSE_PIP') {
        closePip();
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
