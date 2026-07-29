<div align="center">
  <h1 align="center" style="border-bottom: none; margin-bottom: 0;">TLDR-TV</h1>
  <h3 align="center" style="margin-top: 0; font-weight: normal;">
    a visual audio player for essays and books — chapters, synced transcripts, live captions
  </h3>
</div>

<br />

## ✨ What It Does

- **Audio + synced transcript** — every spoken word is highlighted as it's read; click any word to seek
- **Chapters with hero images** — each section gets a title, quote, image, and caption
- **Live captions** — YouTube-style overlay driven by per-word timestamps, sentence-aware chunking
- **Library + player** — catalog all your guides at `/app/home`, play one at `/app/:slug`
- **Real backend** — content lives in SQLite, audio + images served by Hono with range-request streaming

<br />

## 🚀 Quick Start

```bash
npm run install-all     # installs root + backend workspace deps
npm run start           # backend on :8000, Vite on :5173
```

Open <http://localhost:5173/app/home> (root `/` redirects there). The library shows every guide in the DB; click one to open the player.

<br />

## 📚 How Content Loads

Guides live in the `Guides` table in SQLite (`backend/databases/App.db`). Audio + images sit on disk under `backend/public/{audio,images}/` and are served by Hono with proper range requests.

The frontend talks to three endpoints:

| Route | What you get |
|---|---|
| `GET /api/guides` | Library summaries: slug, title, author, duration, thumbnail, chapter count |
| `GET /api/guides/:slug` | Full payload: chapters, transcript, word timings, audio URL |
| `GET /audio/...` `GET /images/...` | Static asset streams from `backend/public/` |

In dev, Vite proxies all three to the backend on port 8000.

<br />

## ➕ Add a New Guide

1. **Drop the assets in place**
   - `backend/public/audio/<your-file>.mp3`
   - `backend/public/images/<slug>/...` (any hero/chapter images you reference)
2. **Write a manifest** at `backend/scripts/seeds/<slug>.json` (or anywhere you like) with this shape:
   ```json
   {
     "slug": "your-slug",
     "title": "Your Title",
     "author": "Author",
     "date": "Month YYYY",
     "duration": 1234,
     "audio": "/audio/YourFile.mp3",
     "thumbnail": "/images/your-slug/hero.jpg",
     "timingOffset": 0,
     "defaultViewMode": "real",
     "transcript": "Full essay text…",
     "chapters": [
       { "time": 0, "title": "Chapter 1", "quote": "Opening line", "realImage": "/images/your-slug/01.webp", "caption": "…" }
     ],
     "timing": { "words": [{ "w": "first", "t": 0.12 }, { "w": "second", "t": 0.41 }] }
   }
   ```
3. **Insert** by calling `db.upsertGuide(payload)` (see `backend/adapters/sqlite.js`) or by extending `backend/scripts/migrate-guides.js`.

Word-timing files are produced from the audio + transcript by [`koko`](https://github.com/dottyio/koko) (Kokoro-82M ONNX). The migration script handles `{words: [...]}` and bare arrays.

<br />

## 🏗️ Project Layout

```
tldr-tv/
├── src/
│   ├── components/
│   │   ├── LibraryView.jsx     # /app/home — catalog of guides
│   │   └── PlayerView.jsx      # /app/:slug — audio + transcript player
│   ├── assets/
│   │   ├── styles.css
│   │   └── pg.css              # player styles
│   ├── main.jsx                # routes
│   └── constants.json
├── backend/
│   ├── server.js               # Hono server, /api/* and static mounts
│   ├── adapters/sqlite.js      # Guides + Users + Auths schema and CRUD
│   ├── scripts/migrate-guides.js
│   ├── databases/App.db
│   └── public/
│       ├── audio/              # MP3s, served with Range requests
│       └── images/             # hero + chapter images
└── public/                     # only PWA icons / robots / sitemap now
```

<br />

## 🏗️ Tech Stack

| Technology | Purpose |
|---|---|
| **React 19 + Vite 7** | Frontend |
| **react-router-dom v7** | Routing |
| **Tailwind v4** | Styling |
| **Hono** | Backend HTTP |
| **SQLite** (Node built-in) | Content + auth storage |
| **skateboard-ui** | Shell, auth, shadcn primitives |
| **JWT + bcrypt** | Auth (catalog reads are public; writes require sign-in) |

<br />

## 🛠️ Development

```bash
npm run front          # Vite dev server only (port 5173)
npm run server         # Hono backend only (port 8000)
npm run test           # vitest run
npm run build          # production build → dist/
```

The backend serves the built SPA from `dist/` in production along with `/api/*`, `/audio/*`, `/images/*`.

<br />

## 📄 License

MIT — see [LICENSE](LICENSE).

<br />

---

<div align="center">
  <p>
    Made with <a href="https://github.com/stevederico/skateboard">Skateboard</a> — a React boilerplate with auth and payments
  </p>
</div>
