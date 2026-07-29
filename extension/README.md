# TLDR this article (Chrome extension)

Chrome MV3 extension for TLDR-TV. On any open article: extract text → `POST /api/guides` → open the player. Pipeline (TTS, images, chapters) stays on the backend.

## Load unpacked (dev)

1. Run the app: `bun run start` (API `:8000`, app `:5173`)
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked**
3. Select this `extension/` folder
4. Open a free article (blog, Substack, etc.) → click the extension → **TLDR this article**
5. A **floating PiP** appears on the blog page (no redirect). Captions + word highlight and playback speed live in the gear menu; the external-link icon opens the **Full** player; hover the top-right **×** to close.
6. After reloading the extension, reload the article tab if the content script was stale

## Config

Defaults (local):

| Key | Default |
|-----|---------|
| `apiBase` | `http://localhost:8000` |
| `appBase` | `http://localhost:5173` |

Override in the service worker console or via `chrome.storage.sync`:

```js
chrome.storage.sync.set({
  apiBase: 'https://your-api.example.com',
  appBase: 'https://your-app.example.com',
});
```

Add matching `host_permissions` in `manifest.json` for non-local hosts.

## Behavior

- **Page extract** — `article` / `main` / common content selectors; strips nav/aside/scripts
- **Selection fallback** — if you select ≥80 chars first, that text is used (paywalled pages you can already read)
- **No paywall bypass** — only visible/selected DOM text
- **Create** — same payload shape as the library Create modal
- **PiP (default)** — large resizable floating player on the blog (YouTube-style chrome)
- **Blog images first** — page/og images while Grok art generates; then both rotate
- **Captions + word highlight** — karaoke-style captions synced to the audio, live even while streaming: the backend streams per-chunk word timings alongside the audio, so captions track the rendered portion as it plays. Toggle both in the settings (gear) menu, persisted in `localStorage` (`pip.cc` / `pip.hl`)
- **Preparing state** — animated spinner + progress bar (analyze + TTS, summed so it never sticks)
- **Streaming start** — attaches `GET /api/guides/:slug/stream.mp3` once a few TTS chunks have flushed to disk, then autoplays only after ~12s of browser buffer (avoids early stall/skip); falls back to the canonical file once it exists
- **Autoplay** when audio is ready
- **Full** — open `/app/:slug` from the PiP

## Tests

```bash
node --test extension/extract.test.js
```

## Layout

```
extension/
  manifest.json
  background.js   # CREATE_GUIDE → API + open tab
  content.js      # EXTRACT_ARTICLE on page
  extract.js      # pure extract helpers
  popup.*         # toolbar UI
  config.js       # api/app bases
  icons/
```
