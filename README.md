<div align="center">
  <img src="public/icons/favicon.svg" width="60" alt="TLDR-TV" />
  <h1 align="center" style="border-bottom: none; margin-bottom: 0;">TLDR-TV</h1>
  <h3 align="center" style="margin-top: 0; font-weight: normal;">
    a react audio player with kokoro tts, word-synced transcripts, and sqlite
  </h3>
  <p>
    <a href="docs/API.md">Docs</a>
    ·
    <a href="docs/ARCHITECTURE.md">Architecture</a>
    ·
    <a href="extension/README.md">Extension</a>
  </p>
</div>

<br />

## 🚀 Quick Start

Node 24 or newer.

```bash
git clone https://github.com/stevederico/tldr-tv.git
cd tldr-tv
npm install
npm run start
```

In another terminal:

```bash
cd backend && cargo run
```

Open <http://localhost:5173/app/home>. Vite is on `:5173` and proxies `/api`, `/audio`, and `/images` to the Rust API on `:8000`.

On first boot the server copies `backend/.env.example` to `backend/.env` if that file is missing. Replace `JWT_SECRET` before you turn sign-in on.

<br />

## ✨ What's Included

Listen to an essay while the transcript tracks every word.

### 🎧 **Player**
- **Word-level sync** highlights each spoken word and seeks when you click one
- **Live captions** sit over the audio in sentence-sized chunks
- **Chapter visuals** pair a title, quote, image, and caption with each section
- **Progressive audio** starts from `GET /api/guides/:slug/stream.mp3` while speech is still rendering

### 📚 **Library**
- **Catalog** lists every guide: title, author, duration, thumbnail, chapter count
- **Create** a video from a URL or pasted text at `/app/home`
- **Play** one guide at `/app/:slug`

### 🗣️ **Speech**
- **Local Kokoro** (ONNX Kokoro-82M) speaks the transcript. Speech does not call a remote model
- **Title first** — audio, captions, and the reader open on the guide title
- **Article analysis** uses Grok for summary, chapters, and images. Set `XAI_API_KEY` for that step only

### 🧩 **Chrome extension**
- **TLDR this article** extracts visible page text, creates a guide, and plays it in a floating player
- **No paywall bypass** — only text already in the page, or a selection you highlighted
- Load it from [extension/README.md](extension/README.md)

### 🛠️ **Developer experience**
- **TypeScript strict** with `npm run typecheck` before build and test
- **Node test runner** for scripts and player helpers (`npm test`)
- **cargo test --locked** for the Rust API
- **Vite** proxies `/api`, `/audio`, and `/images` to the backend in dev

<br />

## 📖 Configuration

### Frontend

Edit `src/constants.json`. `noLogin` is `true`, so the library stays open without an account.

```json
{
  "appName": "TLDR-TV",
  "tagline": "Essays and books with live word-synced transcripts and chapter visuals",
  "cta": "Browse Library",
  "noLogin": true
}
```

### Backend

`backend/config.json` picks the database. SQLite is the default.

```json
{
  "staticDir": "../dist",
  "database": {
    "db": "App",
    "dbType": "sqlite",
    "connectionString": "./databases/App.db"
  }
}
```

`backend/.env` (gitignored) holds secrets. Start from `backend/.env.example`:

```bash
JWT_SECRET=change-me-to-a-long-random-string
STRIPE_KEY=
STRIPE_ENDPOINT_SECRET=
XAI_API_KEY=
FREE_USAGE_LIMIT=20
```

Stripe keys are optional. This app does not sell a subscription (`stripeProducts` is empty). `XAI_API_KEY` is only for article analysis and images.

<br />

## 🏗️ Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| **React** | 19.2 | UI |
| **Vite** | 8.0 | Dev server and production build |
| **TypeScript** | 7.0 | Strict types, no emit step |
| **Tailwind CSS** | 4.3 | Styling |
| **react-router** | 7.18 | Routing |
| **skateboard-ui** | 5.1 | Shell, auth, shadcn primitives |
| **Rust** | zero-crate | HTTP API, auth, and static audio |
| **Node.js** | 24+ | Vite, and the Kokoro speech helper |
| **SQLite** | libsqlite3 | Guides, users, auth |
| **Kokoro** | 82M ONNX | Local text-to-speech |

<br />

## 🗺️ Architecture

Three parts. **skateboard-ui** owns routing, auth, and theme. **This repo** owns the library, the player, and speech. **`constants.json`** owns names, nav, and whether login is on.

Guides live in the SQLite `Guides` table, not in static JSON. MP3s and images sit under `backend/public/{audio,images}/`. The Rust server sends them with `Range` support so playback can seek. In production the same process serves the built SPA from `dist/`.

```tsx
createSkateboardApp({
  constants,
  appRoutes: [
    { path: 'home', element: <LibraryView /> },
    { path: ':slug', element: <PlayerView /> },
  ],
  overrides: { layout: MinimalLayout },
});
```

Content shape, endpoints, and the speech pipeline: [docs/SCHEMA.md](docs/SCHEMA.md), [docs/API.md](docs/API.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

<br />

## 🚢 Deployment

See [docs/DEPLOY.md](docs/DEPLOY.md). The Dockerfile in this repo builds a single image that serves the SPA and the API.

<br />

## 🤝 Contributing

```bash
git clone https://github.com/stevederico/tldr-tv.git
cd tldr-tv
npm install
npm run start
cd backend && cargo run
npm test
cd backend && cargo test --locked
```

<br />

## 📬 Community & Support

- **X**: [@stevederico](https://x.com/stevederico)
- **Issues**: [GitHub Issues](https://github.com/stevederico/tldr-tv/issues)

<br />

## 🙏 Acknowledgements

- [React](https://react.dev) — UI
- [Vite](https://vite.dev) — dev server and build
- [Tailwind CSS](https://tailwindcss.com) — styling
- Rust — HTTP API, with SQLite and libcurl as system libraries
- [Kokoro](https://github.com/hexgrad/kokoro) — local speech model
- [skateboard-ui](https://github.com/stevederico/skateboard-ui) — app shell and shadcn primitives
- [shadcn/ui](https://ui.shadcn.com) — component design
- [Lucide](https://lucide.dev) — icons

<br />

## 🎪 Related Projects

- [skateboard](https://github.com/stevederico/skateboard) — React boilerplate with auth and payments
- [skateboard-ui](https://github.com/stevederico/skateboard-ui) — shell, theme, and components

<br />

## 🚀 Ready to listen?

```bash
npm run install-all && npm run start
```

<br />

## 📄 License

MIT License — see [LICENSE](LICENSE).

<br />

---

<div align="center">
  <p>
    Made with <a href="https://github.com/stevederico/skateboard">Skateboard</a> — a React boilerplate with auth and payments
  </p>
  <p>Built by <a href="https://x.com/stevederico">Steve Derico</a></p>
  <p>
    <a href="https://github.com/stevederico/tldr-tv">Star TLDR-TV on GitHub</a>
  </p>
</div>
