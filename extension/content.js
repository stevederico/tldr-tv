/**
 * Content script: extract + borderless resizable on-page PiP shell.
 * No title bar — hover close (×) only; drag from a thin top edge.
 */
(async () => {
  const HOST_ID = 'watch-this-article-pip-host';
  const DEFAULT_W = 560;
  const DEFAULT_H = 360;
  const MIN_W = 320;
  const MIN_H = 220;

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
      height: `${DEFAULT_H}px`,
      zIndex: '2147483646',
      borderRadius: '12px',
      overflow: 'hidden',
      resize: 'both',
      boxShadow: '0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
      background: '#000',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      minWidth: `${MIN_W}px`,
      minHeight: `${MIN_H}px`,
      maxWidth: '96vw',
      maxHeight: '92vh',
      boxSizing: 'border-box',
    });

    // Inject hover styles once
    if (!document.getElementById('watch-pip-hover-css')) {
      const style = document.createElement('style');
      style.id = 'watch-pip-hover-css';
      style.textContent = `
        #${HOST_ID} .watch-pip-close {
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.15s ease;
        }
        #${HOST_ID}:hover .watch-pip-close,
        #${HOST_ID}:focus-within .watch-pip-close {
          opacity: 1;
          pointer-events: auto;
        }
      `;
      document.documentElement.appendChild(style);
    }

    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL(`pip.html?slug=${encodeURIComponent(slug)}`);
    frame.title = 'TLDR this article player';
    frame.allow = 'autoplay; fullscreen';
    frame.setAttribute('allowfullscreen', 'true');
    Object.assign(frame.style, {
      border: '0',
      width: '100%',
      height: '100%',
      display: 'block',
      background: '#000',
    });

    // Invisible top strip for dragging (no visible bar)
    const dragStrip = document.createElement('div');
    dragStrip.setAttribute('aria-hidden', 'true');
    Object.assign(dragStrip.style, {
      position: 'absolute',
      left: '0',
      right: '40px',
      top: '0',
      height: '28px',
      cursor: 'grab',
      zIndex: '11',
      touchAction: 'none',
    });

    // Hover-only close button (top-right)
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'watch-pip-close';
    closeBtn.setAttribute('aria-label', 'Close player');
    closeBtn.title = 'Close';
    closeBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      top: '8px',
      right: '8px',
      zIndex: '12',
      width: '28px',
      height: '28px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      appearance: 'none',
      border: '0',
      borderRadius: '999px',
      background: 'rgba(0,0,0,0.55)',
      color: '#fff',
      cursor: 'pointer',
      padding: '0',
      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePip();
    });

    // Resize grip (SE)
    const handle = document.createElement('div');
    handle.setAttribute('aria-label', 'Resize player');
    handle.title = 'Drag to resize';
    Object.assign(handle.style, {
      position: 'absolute',
      right: '0',
      bottom: '0',
      width: '28px',
      height: '28px',
      cursor: 'nwse-resize',
      zIndex: '12',
      touchAction: 'none',
      background:
        'linear-gradient(135deg, transparent 0 48%, rgba(255,255,255,0.25) 48% 52%, transparent 52% 62%, rgba(255,255,255,0.45) 62% 66%, transparent 66% 76%, rgba(255,255,255,0.7) 76% 80%, transparent 80%)',
    });

    // Drag
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    dragStrip.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStrip.style.cursor = 'grabbing';
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = `${origLeft}px`;
      host.style.top = `${origTop}px`;
      dragStrip.setPointerCapture(e.pointerId);
    });
    dragStrip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      host.style.left = `${Math.max(0, origLeft + e.clientX - startX)}px`;
      host.style.top = `${Math.max(0, origTop + e.clientY - startY)}px`;
    });
    dragStrip.addEventListener('pointerup', (e) => {
      dragging = false;
      dragStrip.style.cursor = 'grab';
      try {
        dragStrip.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });

    // Resize
    let resizing = false;
    let rStartX = 0;
    let rStartY = 0;
    let rW = DEFAULT_W;
    let rH = DEFAULT_H;

    /**
     * @param {number} nw
     * @param {number} nh
     */
    function applySize(nw, nh) {
      const maxW = window.innerWidth - 8;
      const maxH = window.innerHeight - 8;
      host.style.width = `${Math.min(maxW, Math.max(MIN_W, nw))}px`;
      host.style.height = `${Math.min(maxH, Math.max(MIN_H, nh))}px`;
    }

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      rStartX = e.clientX;
      rStartY = e.clientY;
      const rect = host.getBoundingClientRect();
      rW = rect.width;
      rH = rect.height;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      e.preventDefault();
      applySize(rW + (e.clientX - rStartX), rH + (e.clientY - rStartY));
    });
    handle.addEventListener('pointerup', (e) => {
      resizing = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    handle.addEventListener('pointercancel', () => {
      resizing = false;
    });

    host.append(frame, dragStrip, closeBtn, handle);
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
    console.error('[TLDR this article] content script failed to load', err);
  }
})();
