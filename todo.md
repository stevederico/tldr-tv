# Todo

- export as video

## Watch this article

Open-web "Listen mode with pictures" — same pipeline (extract → TTS → images → player); two shells.

### Browser extension (first)

- Chrome MV3: content script extracts readable article (title, author, body) from current page
- Selection fallback on hard/paywalled sites — only what the user can already see/select
- POST same payload as URL import → poll jobs → open `/app/player/:slug`
- Toolbar action: "Watch this article"
- Never bypass paywalls / login walls

### Publisher widget (later)

- Embeddable "Watch this article" player (CNBC/Bloomberg Listen-style, but video/illustrated)
- Script tag or iframe; publishers pass article URL or inline body
- Same backend engine; branded shell + optional domain allowlist
- B2B path after extension proves the product

## Import EPUB

- New source type in create modal alongside URL / paste: "Upload EPUB" (`.epub` file picker)
- Backend: `POST /api/import/epub` accepts multipart upload, parses with a zero-dep approach (EPUB is a zip of XHTML + OPF manifest) — unzip, read `META-INF/container.xml` → `.opf` → spine order
- Extract metadata from OPF: `dc:title`, `dc:creator`, `dc:date`, `dc:language`, cover image (`<meta name="cover">` → manifest item)
- Walk spine in order, strip XHTML to plain text per item — each spine item becomes a candidate chapter
- Map EPUB nav (`toc.ncx` or EPUB3 `nav.xhtml`) to chapter titles; fall back to `<h1>`/`<h2>` from each spine item if no nav
- Build the same payload shape as URL import: `{ title, author, date, transcript, chapters: [{ time: 0, title, ... }], thumbnail }` so downstream pipeline (TTS → timings → images) is unchanged
- Chapter `time` stays 0 until TTS runs; TTS step needs to emit per-chapter start offsets so chapter markers line up
- Persist original EPUB to `backend/public/uploads/<slug>.epub` for re-imports / debugging
- Size + rate limits: cap upload at ~50MB, reject non-EPUB MIME, sanitize XHTML before storing (strip scripts)
- Stretch: detect DRM (Adobe ADEPT, Apple FairPlay) and surface a clear error — those can't be parsed

## More visuals per chapter

- Move from 1 hero image per chapter to a timed sequence — multiple images that swap as the audio plays through the chapter
- Schema: `chapter.images: [{ src, time, caption?, alt? }]` (sorted by `time`); keep `realImage` / generated single-image as fallback
- Image generation: split chapter transcript into N beats (sentence clusters or every ~20s of audio), generate one image per beat via xAI Grok Imagine (`grok-imagine-image-quality`) with prompt = beat text + author/style anchor
- Real-image variant: run Unsplash/Pexels search per beat instead of per chapter
- PlayerView: pick current image by binary-searching `images[]` against `currentTime`; crossfade between images (`transition-opacity`, not `transition-all`)
- Caption overlay: optionally show `image.caption` when it changes (debounced so quick swaps don't flash text)
- Ken Burns / subtle zoom on the active image so static images don't feel dead — respect `prefers-reduced-motion`
- Storage layout: `/images/<slug>/beats/<chapter-idx>/<beat-idx>.webp` to keep chapter scoping intact
- Backend: extend `/api/guides/:slug/chapter-images` to accept `beatsPerChapter` or auto-derive from chapter duration; concurrency cap stays
- Cost guard: cap total images per guide (e.g. 60) so a long book doesn't blow the image budget; surface count in create flow

## Mobile formatting

- Player hero + caption overlay: stack vertically on mobile, ensure hero image scales to viewport width without cropping the caption
- Test on iOS Safari — audio autoplay restrictions, range request streaming, background playback

## Future — Auth + Per-user State

Everything below only becomes relevant once auth is enabled (`noLogin: false`, real user accounts, write gating).

## Auth (do first — blocks Phase 4)

- Gate write routes — `POST /api/guides`, `POST /api/guides/:slug/audio`, future `PUT`/`DELETE` — behind `authMiddleware` + `csrfProtection`
- Decide whether `GET /api/guides` and `GET /api/guides/:slug` should also require sign-in, or stay public
- Wrap the create button + modal in `LibraryView.jsx:92` so anonymous users see a sign-in prompt instead of an open form
- Surface auth failures from `apiRequest` as toasts in the modal

## Phase 4 — Per-user state (depends on auth)

- Schema: add `UserProgress(user_id, guide_slug, position_sec, updated_at)` and `UserLibrary(user_id, guide_slug, added_at)` tables + composite PKs in `backend/adapters/sqlite.js`
- Adapter methods + routes for progress and library (all auth + CSRF where mutating)
- `PlayerView`: on mount fetch saved position from server (localStorage already done as fallback); throttle PUT every ~5s
- `LibraryView`: "Save to library" + filtering by personal library
- Graceful degradation for anonymous users

## Create flow gaps (when auth is on)

- No edit UI — `PUT /api/guides/:slug` + admin/owner edit modal
- (Other create improvements listed above should be done in dev mode first)

## Backend hardening

- Add unit tests in `backend/server.test.js` covering slug validation, duplicate handling, audio upload errors, transcript round-trips
- Rate limiter on create endpoints (can be done now)

## Production storage

- Move audio/images off local disk (persistent volume)
- Proper backup strategy for SQLite + assets

## Misc

# DONE


**Note**: Local progress saving (`pg.progress.${slug}`) has already been implemented as the offline fallback. Many "Phase 4" items can be partially delivered today using localStorage only.


slow scroller like a script next to a movie https://www.youtube.com/watch?v=kunUvYIJtHM

## Complete-guide pipeline (replace stub endpoints) — DONE

Landed in 0.47.0 (orchestration + Grok + Kokoro wiring) and 0.55.0 (TTS coarticulation fix). Backend owns the whole pipeline; FE just polls `guide.jobs` from `GET /api/guides/:slug`.

### A. Cheap defaults at create time — DONE
  Set visibility public on create
  Set defaultViewMode generated on create
  Auto-flip defaultViewMode to real once realImages exist (Section E)

### B. Source-page enrichment (extend `/api/fetch-url`) — DONE
  Extract date via meta/time tags with Month YYYY fallback (extractDate in server.js)
  Extract og:image / twitter:image as thumbnail (extractOgImage)
  POST /api/guides/:slug/date re-scrapes stored source_url

### C. LLM-driven text (xAI Grok) — DONE
  One combined analyzeTranscript call returns author + summary + chapterOutlines (backend/tts/analyze.js)
  Uses grok-4.3 via https://api.x.ai/v1/chat/completions
  Persisted to guide.summary (rendered in PlayerView Summary tab, default tab)
  Known author domains recognized when meta tag missing (paulgraham.com → Paul Graham)

### D. TTS + word timing (Kokoro) — DONE
  POST /api/guides/:slug/tts chunks by sentence (MAX_CHUNK_CHARS=380) in backend/tts/tts-pipeline.js
  Whole-text phonemize per chunk (per-word phonemize broke coarticulation — fixed in 0.55.0)
  Equal-power crossfade between WAV chunks via concatWav fadeMs=25
  Recursive bisect fallback on "invalid expand shape" (510-token cap)
  WAV-first to backend/public/audio/<slug>.wav, served with Range support
  Background job via jobs_json column; FE polls; 202 response on start
  POST /api/guides/:slug/chapter-timing matches chapter quotes to word offsets locally (no second AI call)

### E. Image generation (xAI Grok Imagine) — DONE
  backend/lib/grokImagine.js with 90s timeout + exponential backoff (1s→2s→4s, 3 retries) + pLimit
  POST /api/guides/:slug/thumbnail — skips if og:image already set
  POST /api/guides/:slug/chapter-images — concurrency 3, prompt from quote/title
  POST /api/guides/:slug/chapter-real-images — Unsplash search per chapter, flips defaultViewMode to real
  Model grok-imagine-image-quality at https://api.x.ai/v1/images/generations

### F. Frontend orchestration — DONE (different shape than planned)
  Backend orchestrates whole pipeline on POST /api/guides (per user: "no back and forth")
  Modal closes immediately on submit; library grid shows pulsing yellow Processing badge with current step
  Failed pipelines show red Failed: <error> badge
  GuideProgress auto-polls when any job.status === running
  PlayerView ?debug=1 shows GuideProgress in collapsed panel
  Publish button appears when all phases complete
  "Run all remaining" intentionally NOT added — backend orchestrates instead

### G. Schema + adapter touch-ups — DONE
  source_url, summary, jobs_json columns on Guides (sqlite.js + postgres.js + mongodb.js)
  db.updateGuideJob(slug, step, jobState) using BEGIN IMMEDIATE / COMMIT (Node DatabaseSync has no .transaction())
  ALTER TABLE backfill guarded with try/catch for existing DBs

### H. Hardening — PARTIAL (rate limit + tests skipped per user direction)
  AbortController timeouts: 60s on Grok text, 90s per image, 10min on TTS
  Cache-bust audio URL via ?v=updatedAt query
  Rate limiting deferred — user explicitly said "no rate limiter we are in development!"
  Endpoint tests deferred

## Mobile formatting — DONE

Audit `LibraryView` + `PlayerView` at 375px / 414px viewports — current split-pane and overlays assume desktop widths
Transcript pane: full-width below player on mobile (no side-by-side split), preserve word highlight + click-to-seek
Chapters menu + settings: open as bottom sheet (`<Sheet side="bottom">`) instead of side panel on `<md`
Timeline scrubber: enlarge touch target to 44px min, verify drag works under thumb without accidental seeks
Library cards: 1-column on mobile, 2 on `sm`, 3 on `md+`; thumbnail aspect ratio stays consistent
Create modal: full-screen on mobile (`<Dialog>` already supports — verify), URL input + paste flow usable one-handed
Header: collapse desktop nav into hamburger or simplified bar at `<sm`
Captions overlay: position above safe area on iOS (account for home indicator + notch)

## Pipeline outputs — DONE

images
chapters
audio wav
captions
thumbnail
summary
authorname
date

## Misc — DONE

Pin exact Kokoro version + tokenizer used for existing timing files (backend/tts/kokoro.js + backend/tts/vocab.js pin Kokoro-82M-v1.0-ONNX-timestamped)
Ensure prod SPA fallback works after removing backend/public/index.html (backend/server.js:2483 reads index.html from staticDir)

## Create flow — DONE

Delete UI for guides (LibraryView pendingDelete confirm dialog + DELETE /api/guides/:slug at server.js:1224)
