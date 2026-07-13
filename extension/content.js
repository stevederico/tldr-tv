/**
 * Content script: extract + resizable on-page PiP shell (extension-origin iframe).
 */
(async () => {
  const HOST_ID = 'watch-this-article-pip-host';
  const DEFAULT_W = 560;
  const DEFAULT_H = 360;
  const MIN_W = 360;
  const MIN_H = 240;

  function closePip() {
    document.getElementById(HOST_ID)?.remove();
  }

  /**
   * @param {string} slug
   */
  function showPip(slug) {
    closePip();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-watch-pip', '1');
    Object.assign(host.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      width: `${DEFAULT_W}px`,
      height: `${DEFAULT_H + 32}px`,
      zIndex: '2147483646',
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
      background: '#000',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      minWidth: `${MIN_W}px`,
      minHeight: `${MIN_H + 32}px`,
      maxWidth: 'min(920px, 96vw)',
      maxHeight: 'min(720px, 92vh)',
    });

    const bar = document.createElement('div');
    Object.assign(bar.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '7px 10px',
      background: 'rgba(20,20,20,0.98)',
      color: '#fafafa',
      cursor: 'grab',
      userSelect: 'none',
      flexShrink: '0',
      height: '32px',
      boxSizing: 'border-box',
    });

    const label = document.createElement('span');
    label.textContent = 'Watch this article';
    Object.assign(label.style, {
      fontSize: '11px',
      fontWeight: '600',
      flex: '1',
      opacity: '0.9',
      letterSpacing: '-0.01em',
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
      background: '#000',
      minHeight: '0',
    });

    // Drag
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
      host.style.left = `${Math.max(8, origLeft + e.clientX - startX)}px`;
      host.style.top = `${Math.max(8, origTop + e.clientY - startY)}px`;
    });
    bar.addEventListener('pointerup', (e) => {
      dragging = false;
      bar.style.cursor = 'grab';
      try {
        bar.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });

    // Resize handle (bottom-right)
    const handle = document.createElement('div');
    handle.setAttribute('aria-label', 'Resize player');
    handle.title = 'Resize';
    Object.assign(handle.style, {
      position: 'absolute',
      right: '0',
      bottom: '0',
      width: '18px',
      height: '18px',
      cursor: 'nwse-resize',
      zIndex: '2',
      background:
        'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.35) 50%)',
    });

    let resizing = false;
    let rStartX = 0;
    let rStartY = 0;
    let rW = DEFAULT_W;
    let rH = DEFAULT_H + 32;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      rStartX = e.clientX;
      rStartY = e.clientY;
      const rect = host.getBoundingClientRect();
      rW = rect.width;
      rH = rect.height;
      // pin top-left while resizing from SE
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const nw = Math.max(MIN_W, rW + (e.clientX - rStartX));
      const nh = Math.max(MIN_H + 32, rH + (e.clientY - rStartY));
      host.style.width = `${nw}px`;
      host.style.height = `${nh}px`;
    });
    handle.addEventListener('pointerup', (e) => {
      resizing = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });

    host.style.position = 'fixed';
    host.append(bar, frame, handle);
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
