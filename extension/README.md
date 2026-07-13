# Watch this article (Chrome extension)

Chrome MV3 extension for Book Player. On any open article: extract text → `POST /api/guides` → open the player. Pipeline (TTS, images, chapters) stays on the backend.

## Load unpacked (dev)

1. Run the app: `bun run start` (API `:8000`, app `:5173`)
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked**
3. Select this `extension/` folder
4. Open a free article (blog, Substack, etc.) → click the extension → **Watch this article**

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
- **Player** — opens `/app/player/:slug` (pipeline may still be running)

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
