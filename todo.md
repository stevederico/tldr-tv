# Todo

Priority order: top = do next. Same engine for everything; shells and polish stack on it.

## P0 — TLDR this article (browser extension)

Wedge: open-web “Listen mode with pictures.” Extension first; widget is P5.

- [x] Chrome MV3: content script extracts readable article (title, author, body) from current page
- [x] Selection fallback on hard/paywalled sites — only what the user can already see/select
- [x] POST same payload as URL import → poll jobs → open `/app/:slug`
- [x] Toolbar action: "TLDR this article"
- [x] Never bypass paywalls / login walls
- [x] On-page PiP player (default) instead of redirecting away from the blog

## P1 — Make it feel like “watch” (not just listen)

Depends on solid player; unlocks the “video” story without requiring publisher deals.

- [ ] Move from 1 hero image per chapter to a timed sequence — multiple images that swap as the audio plays through the chapter
- [ ] Schema: `chapter.images: [{ src, time, caption?, alt? }]` (sorted by `time`); keep `realImage` / generated single-image as fallback
- [ ] Image generation: split chapter transcript into N beats (sentence clusters or every ~20s of audio), generate one image per beat via xAI Grok Imagine (`grok-imagine-image-quality`) with prompt = beat text + author/style anchor
- [ ] Real-image variant: run Unsplash/Pexels search per beat instead of per chapter
- [ ] PlayerView: pick current image by binary-searching `images[]` against `currentTime`; crossfade between images (`transition-opacity`, not `transition-all`)
- [ ] Caption overlay: optionally show `image.caption` when it changes (debounced so quick swaps don't flash text)
- [ ] Ken Burns / subtle zoom on the active image so static images don't feel dead — respect `prefers-reduced-motion`
- [ ] Storage layout: `/images/<slug>/beats/<chapter-idx>/<beat-idx>.webp` to keep chapter scoping intact
- [ ] Backend: extend `/api/guides/:slug/chapter-images` to accept `beatsPerChapter` or auto-derive from chapter duration; concurrency cap stays
- [ ] Cost guard: cap total images per guide (e.g. 60) so a long book doesn't blow the image budget; surface count in create flow
- [ ] export as video (mux illustrated audio → shareable MP4)
- [ ] slow scroller like a script next to a movie https://www.youtube.com/watch?v=kunUvYIJtHM
- [ ] Player hero + caption overlay: stack vertically on mobile, ensure hero image scales to viewport width without cropping the caption
- [ ] Test on iOS Safari — audio autoplay restrictions, range request streaming, background playback

## P2 — Hardening before open-web abuse

Do before (or in parallel with late) public extension traffic.

- [ ] Rate limiter on create / pipeline endpoints
- [ ] Add unit tests in `backend/server.test.ts` covering slug validation, duplicate handling, audio upload errors, transcript round-trips
- [ ] Move audio/images off local disk (persistent volume)
- [ ] Proper backup strategy for SQLite + assets

## P3 — More source types (EPUB)

Same payload shape as URL import; not on the critical path for Watch.

- [ ] New source type in create modal alongside URL / paste: "Upload EPUB" (`.epub` file picker)
- [ ] Backend: `POST /api/import/epub` accepts multipart upload, parses with a zero-dep approach (EPUB is a zip of XHTML + OPF manifest) — unzip, read `META-INF/container.xml` → `.opf` → spine order
- [ ] Extract metadata from OPF: `dc:title`, `dc:creator`, `dc:date`, `dc:language`, cover image (`<meta name="cover">` → manifest item)
- [ ] Walk spine in order, strip XHTML to plain text per item — each spine item becomes a candidate chapter
- [ ] Map EPUB nav (`toc.ncx` or EPUB3 `nav.xhtml`) to chapter titles; fall back to `<h1>`/`<h2>` from each spine item if no nav
- [ ] Build the same payload shape as URL import: `{ title, author, date, transcript, chapters: [{ time: 0, title, ... }], thumbnail }` so downstream pipeline (TTS → timings → images) is unchanged
- [ ] Chapter `time` stays 0 until TTS runs; TTS step needs to emit per-chapter start offsets so chapter markers line up
- [ ] Persist original EPUB to `backend/public/uploads/<slug>.epub` for re-imports / debugging
- [ ] Size + rate limits: cap upload at ~50MB, reject non-EPUB MIME, sanitize XHTML before storing (strip scripts)
- [ ] Stretch: detect DRM (Adobe ADEPT, Apple FairPlay) and surface a clear error — those can't be parsed

## P4 — Auth + per-user state

Only when multi-user / accounts matter (`noLogin: false`). Auth first; then Phase 4.

### Auth (blocks Phase 4)

- [ ] Gate write routes — `POST /api/guides`, `POST /api/guides/:slug/audio`, future `PUT`/`DELETE` — behind `authMiddleware` + `csrfProtection`
- [ ] Decide whether `GET /api/guides` and `GET /api/guides/:slug` should also require sign-in, or stay public
- [ ] Wrap the create button + modal in `LibraryView` so anonymous users see a sign-in prompt instead of an open form
- [ ] Surface auth failures from `apiRequest` as toasts in the modal

### Phase 4 — Per-user state (depends on auth)

- [ ] Schema: add `UserProgress(user_id, guide_slug, position_sec, updated_at)` and `UserLibrary(user_id, guide_slug, added_at)` tables + composite PKs in `backend/adapters/sqlite`
- [ ] Adapter methods + routes for progress and library (all auth + CSRF where mutating)
- [x] `PlayerView`: local progress saving (`pg.progress.${slug}`) as offline fallback
- [ ] `PlayerView`: on mount fetch saved position from server; throttle PUT every ~5s
- [ ] `LibraryView`: "Save to library" + filtering by personal library
- [ ] Graceful degradation for anonymous users

### Create flow gaps (when auth is on)

- [ ] No edit UI — `PUT /api/guides/:slug` + admin/owner edit modal
- [ ] (Other create improvements listed above should be done in dev mode first)

## P5 — Auto-generate + offer to publishers (B2B)

After extension proves the product. Idea: don’t wait for a click — **pre-generate Watch versions of pages and offer them to the site** (player embed and/or downloadable MP4).

### Auto pipeline for public pages

- [ ] Catalog / queue of target URLs (publisher sitemap, RSS, manual list, or trending open-web allowlist)
- [ ] Worker: fetch article → same create pipeline (TTS + timings + beat images → optional mux MP4)
- [ ] Dedupe by canonical URL / content hash so re-crawls don’t double-bill
- [ ] Cost guard: max pages/day, max minutes audio, max images per domain; kill switch per publisher
- [ ] Respect robots.txt, crawl-delay, and never bypass paywalls/login walls (same rules as extension)
- [ ] Store `source_url`, publisher domain, generation status, public player URL, MP4 URL on each guide

### Offer it to them automatically

- [ ] Publisher outreach surface: “We already made a Watch version of this article” (email / dashboard / claim link)
- [ ] Claim flow: domain verify (DNS TXT or meta tag) → attach guides to publisher account
- [ ] One-click **embed**: script tag or iframe “TLDR this article” (CNBC/Bloomberg Listen-style, but illustrated)
- [ ] One-click **MP4 download** / host on their CMS (optional watermark-free after claim)
- [ ] Optional auto-inject: if meta tag / partner script present, show Watch player without manual embed per post
- [ ] Same backend engine; branded shell + domain allowlist

### Product / legal guardrails

- [ ] Clear rights model: generate only for open public pages; claim = license to embed; takedown path
- [ ] Rate limits + auth on claim/embed token endpoints before any outbound “we made this for you”
- [ ] B2B pricing sketch: free embed with badge vs paid white-label + MP4

### Widget baseline (if offer path waits)

- [ ] Embeddable player; publishers pass article URL or inline body
- [ ] Script tag or iframe; optional domain allowlist

---

# DONE

## Complete-guide pipeline (replace stub endpoints)

Landed in 0.47.0 (orchestration + Grok + Kokoro wiring) and 0.55.0 (TTS coarticulation fix). Backend owns the whole pipeline; FE just polls `guide.jobs` from `GET /api/guides/:slug`.

### A. Cheap defaults at create time

- [x] Set visibility public on create
- [x] Set defaultViewMode generated on create
- [x] Auto-flip defaultViewMode to real once realImages exist (Section E)

### B. Source-page enrichment (extend `/api/fetch-url`)

- [x] Extract date via meta/time tags with Month YYYY fallback (extractDate)
- [x] Extract og:image / twitter:image as thumbnail (extractOgImage)
- [x] POST /api/guides/:slug/date re-scrapes stored source_url

### C. LLM-driven text (xAI Grok)

- [x] One combined analyzeTranscript call returns author + summary + chapterOutlines (backend/tts/analyze)
- [x] Uses grok-4.3 via https://api.x.ai/v1/chat/completions
- [x] Persisted to guide.summary (rendered in PlayerView Summary tab, default tab)
- [x] Known author domains recognized when meta tag missing (paulgraham.com → Paul Graham)

### D. TTS + word timing (Kokoro)

- [x] POST /api/guides/:slug/tts chunks by sentence (MAX_CHUNK_CHARS=380) in backend/tts/tts-pipeline
- [x] Whole-text phonemize per chunk (per-word phonemize broke coarticulation — fixed in 0.55.0)
- [x] Equal-power crossfade between WAV chunks via concatWav fadeMs=25
- [x] Recursive bisect fallback on "invalid expand shape" (510-token cap)
- [x] WAV-first to backend/public/audio/<slug>.wav, served with Range support
- [x] Background job via jobs_json column; FE polls; 202 response on start
- [x] POST /api/guides/:slug/chapter-timing matches chapter quotes to word offsets locally (no second AI call)

### E. Image generation (xAI Grok Imagine)

- [x] backend/utils/grokImagine with 90s timeout + exponential backoff (1s→2s→4s, 3 retries) + pLimit
- [x] POST /api/guides/:slug/thumbnail — skips if og:image already set
- [x] POST /api/guides/:slug/chapter-images — concurrency 3, prompt from quote/title
- [x] POST /api/guides/:slug/chapter-real-images — Unsplash search per chapter, flips defaultViewMode to real
- [x] Model grok-imagine-image-quality at https://api.x.ai/v1/images/generations

### F. Frontend orchestration (different shape than planned)

- [x] Backend orchestrates whole pipeline on POST /api/guides (per user: "no back and forth")
- [x] Modal closes immediately on submit; library grid shows pulsing yellow Processing badge with current step
- [x] Failed pipelines show red Failed: <error> badge
- [x] GuideProgress auto-polls when any job.status === running
- [x] PlayerView ?debug=1 shows GuideProgress in collapsed panel
- [x] Publish button appears when all phases complete
- [x] "Run all remaining" intentionally NOT added — backend orchestrates instead

### G. Schema + adapter touch-ups

- [x] source_url, summary, jobs_json columns on Guides (sqlite + postgres + mongodb)
- [x] db.updateGuideJob(slug, step, jobState) using BEGIN IMMEDIATE / COMMIT (Node DatabaseSync has no .transaction())
- [x] ALTER TABLE backfill guarded with try/catch for existing DBs

### H. Hardening (partial)

- [x] AbortController timeouts: 60s on Grok text, 90s per image, 10min on TTS
- [x] Cache-bust audio URL via ?v=updatedAt query

## Mobile formatting (responsive pass)

- [x] Audit `LibraryView` + `PlayerView` at 375px / 414px viewports — current split-pane and overlays assume desktop widths
- [x] Transcript pane: full-width below player on mobile (no side-by-side split), preserve word highlight + click-to-seek
- [x] Chapters menu + settings: open as bottom sheet (`<Sheet side="bottom">`) instead of side panel on `<md`
- [x] Timeline scrubber: enlarge touch target to 44px min, verify drag works under thumb without accidental seeks
- [x] Library cards: 1-column on mobile, 2 on `sm`, 3 on `md+`; thumbnail aspect ratio stays consistent
- [x] Create modal: full-screen on mobile (`<Dialog>` already supports — verify), URL input + paste flow usable one-handed
- [x] Header: collapse desktop nav into hamburger or simplified bar at `<sm`
- [x] Captions overlay: position above safe area on iOS (account for home indicator + notch)

## Pipeline outputs

- [x] images
- [x] chapters
- [x] audio wav
- [x] captions
- [x] thumbnail
- [x] summary
- [x] authorname
- [x] date

## Misc

- [x] Pin exact Kokoro version + tokenizer used for existing timing files (backend/tts/kokoro + vocab pin Kokoro-82M-v1.0-ONNX-timestamped)
- [x] Ensure prod SPA fallback works after removing backend/public/index.html (server reads index.html from staticDir)

## Create flow

- [x] Delete UI for guides (LibraryView pendingDelete confirm dialog + DELETE /api/guides/:slug)
