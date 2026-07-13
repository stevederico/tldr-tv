/**
 * PiP player: blog-image slideshow + audio, PlayerView-style chrome.
 * No generated images — page photos only (skipImages on create).
 */
import { getConfig } from './config.js';
import {
  parseTranscript,
  alignTimings,
  buildAnchors,
  buildCaptionChunks,
  wordIndexFromTimes,
  wordIndexAtTime,
  chunkIndexAtWord,
} from './transcript.js';

const params = new URLSearchParams(location.search);
const slug = params.get('slug') || '';

const root = document.getElementById('root');
const heroEl = document.getElementById('hero');
const coverEl = document.getElementById('cover');
const blurEl = document.getElementById('blur');
const buildEl = document.getElementById('build');
const buildTitle = document.getElementById('buildTitle');
const buildStep = document.getElementById('buildStep');
const buildBar = document.getElementById('buildBar');
const buildBarWrap = document.getElementById('buildBarWrap');
const buildPct = document.getElementById('buildPct');
const playBtn = document.getElementById('play');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const openBtn = document.getElementById('openBtn');
const fsBtn = document.getElementById('fsBtn');
const iconExpand = document.getElementById('iconExpand');
const iconCompress = document.getElementById('iconCompress');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');
const captionEl = document.getElementById('caption');
const ccToggle = document.getElementById('ccToggle');
const hlToggle = document.getElementById('hlToggle');

/** @type {string} */
let appBase = 'http://localhost:5173';
const timeEl = document.getElementById('time');
const fillEl = document.getElementById('fill');
const thumbEl = document.getElementById('thumb');
const timelineEl = document.getElementById('timeline');
const audioEl = document.getElementById('audio');

/** @type {string} */
let apiBase = 'http://localhost:8000';
// appBase set in init()
/** @type {string[]} */
let pageImages = [];
let galleryIdx = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let pollId = null;
/** @type {ReturnType<typeof setInterval> | null} */
let galleryTimer = null;
let autoplayAttempted = false;
let scrubbing = false;
let rate = 1;

// --- Captions + word highlighting (ported from the web PlayerView) ---
/** Lead the highlight so the word lights as it is heard, not after. */
const HIGHLIGHT_LEAD = 0.27;
/** @type {import('./transcript.js').CaptionChunk[] | null} */
let captionChunks = null;
/** @type {number[] | null} */
let wordStartTimes = null;
/** @type {import('./transcript.js').Anchor[] | null} */
let anchors = null;
let totalWords = 0;
let timingOffset = 0;
let transcriptReady = false;
let captionsOn = safeGet('pip.cc') !== '0';
let highlightOn = safeGet('pip.hl') !== '0';
let lastCaptionKey = '';
/** @type {number | null} */
let captionRaf = null;

/**
 * localStorage getter that never throws (private mode / disabled storage).
 *
 * @param {string} k
 * @returns {string | null}
 */
function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/**
 * @param {string} k
 * @param {string} v
 */
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/**
 * Escape text for safe insertion into caption innerHTML.
 *
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/**
 * @param {number} sec
 * @returns {string}
 */
function fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * @param {string} path
 * @returns {string}
 */
function assetUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith('../') ? `/${path.slice(3)}` : path.startsWith('/') ? path : `/${path}`;
  return `${apiBase}${p}`;
}

/**
 * @param {string} url
 */
function setHero(url) {
  if (!url) return;
  if (coverEl instanceof HTMLImageElement) {
    coverEl.src = url;
    coverEl.hidden = false;
  }
  if (blurEl instanceof HTMLElement) {
    blurEl.style.backgroundImage = `url("${String(url).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
  }
}

function startSlideshow() {
  if (galleryTimer) clearInterval(galleryTimer);
  if (pageImages.length === 0) return;
  setHero(pageImages[galleryIdx % pageImages.length]);
  if (pageImages.length < 2) return;
  galleryTimer = setInterval(() => {
    galleryIdx = (galleryIdx + 1) % pageImages.length;
    setHero(pageImages[galleryIdx]);
  }, 8000);
}

/**
 * Progress without image generation (analyze + tts only). analyze and tts run
 * in parallel on the backend, so we SUM each stage's weighted completion rather
 * than stopping at the first in-flight stage — otherwise the bar sticks at ~5%
 * while analyze runs even though tts has already finished.
 *
 * @param {Record<string, { status?: string, chunksDone?: number, chunksTotal?: number, error?: string } | undefined>} jobs
 */
function buildProgress(jobs) {
  const stages = [
    { key: 'analyze', weight: 25, label: 'Analyzing article…' },
    { key: 'tts', weight: 75, label: 'Generating audio…' },
  ];
  let pct = 0;
  let step = 'Starting…';
  let runningLabel = '';
  for (const s of stages) {
    const j = jobs[s.key];
    if (!j) continue;
    if (j.status === 'done') {
      pct += s.weight;
    } else if (j.status === 'running') {
      if (j.chunksTotal && j.chunksTotal > 0) {
        const frac = Math.min(1, (j.chunksDone ?? 0) / j.chunksTotal);
        pct += s.weight * frac;
        runningLabel = `Generating audio (${j.chunksDone ?? 0}/${j.chunksTotal})`;
      } else {
        // No sub-progress: credit a slice so the bar advances and reads as active.
        pct += s.weight * 0.2;
        runningLabel = s.label;
      }
    } else if (j.status === 'failed') {
      step = j.error || `${s.key} failed`;
    }
  }
  if (runningLabel) step = runningLabel;
  if (jobs.pipeline?.status === 'done') {
    pct = 100;
    step = 'Ready';
  }
  if (jobs.pipeline?.status === 'failed') {
    step = jobs.pipeline.error || 'Generation failed';
  }
  return { pct: Math.round(Math.min(100, pct)), step };
}

/**
 * Parse transcript + timing into caption chunks and per-word start times.
 * Idempotent — runs once as soon as the transcript is present.
 *
 * @param {Record<string, unknown>} g - Guide payload.
 */
function buildTranscriptData(g) {
  if (transcriptReady) return;
  const transcript = typeof g.transcript === 'string' ? g.transcript : '';
  if (!transcript) return;
  const paras = parseTranscript(transcript);
  totalWords = paras.reduce((n, p) => n + p.words.length, 0);
  captionChunks = buildCaptionChunks(paras);
  timingOffset = Number(g.timingOffset) || 0;

  const t = g.timing;
  const timingWords = Array.isArray(t)
    ? t
    : t && typeof t === 'object' && Array.isArray(/** @type {{ words?: unknown[] }} */ (t).words)
      ? /** @type {import('./transcript.js').TimingWord[]} */ (/** @type {{ words: unknown[] }} */ (t).words)
      : null;
  wordStartTimes = alignTimings(paras, timingWords);
  // Fallback: interpolate from chapter quotes when no word timings exist.
  if (!wordStartTimes) {
    const chapters = Array.isArray(g.chapters) ? /** @type {Array<{ time?: number, quote?: string }>} */ (g.chapters) : undefined;
    anchors = buildAnchors(paras, chapters, Number(g.duration) || 0);
  }
  transcriptReady = true;
}

/**
 * Render the current caption line (with karaoke word highlight when enabled)
 * from the audio playhead. No-op when captions are off or data is missing.
 */
function renderCaption() {
  if (!(captionEl instanceof HTMLElement)) return;
  if (!captionsOn || !captionChunks?.length || !(audioEl instanceof HTMLAudioElement)) {
    if (!captionEl.hidden) {
      captionEl.hidden = true;
      captionEl.textContent = '';
      lastCaptionKey = '';
    }
    return;
  }
  const t = (audioEl.currentTime || 0) - timingOffset + HIGHLIGHT_LEAD;
  const w = Math.max(
    0,
    Math.min(totalWords - 1, wordStartTimes ? wordIndexFromTimes(wordStartTimes, t) : wordIndexAtTime(anchors, t))
  );
  const ci = chunkIndexAtWord(captionChunks, w);
  const chunk = captionChunks[ci];
  if (!chunk) {
    if (!captionEl.hidden) {
      captionEl.hidden = true;
      lastCaptionKey = '';
    }
    return;
  }
  const key = `${ci}:${highlightOn ? w : 'x'}`;
  if (key === lastCaptionKey) {
    captionEl.hidden = false;
    return;
  }
  lastCaptionKey = key;
  captionEl.hidden = false;
  if (highlightOn) {
    const words = chunk.text.split(' ');
    captionEl.innerHTML = words
      .map((word, i) => {
        const cls = chunk.start + i === w ? 'cc-word is-active' : 'cc-word';
        return `<span class="${cls}">${esc(word)}</span>`;
      })
      .join(' ');
  } else {
    captionEl.textContent = chunk.text;
  }
}

/** Smoothly drive caption/word highlight while audio plays. */
function startCaptionLoop() {
  if (captionRaf != null) return;
  const tick = () => {
    renderCaption();
    captionRaf = requestAnimationFrame(tick);
  };
  captionRaf = requestAnimationFrame(tick);
}

function stopCaptionLoop() {
  if (captionRaf != null) {
    cancelAnimationFrame(captionRaf);
    captionRaf = null;
  }
}

/**
 * Toggle a settings checkbox item and persist the preference.
 *
 * @param {'cc' | 'hl'} which
 */
function toggleSetting(which) {
  if (which === 'cc') {
    captionsOn = !captionsOn;
    safeSet('pip.cc', captionsOn ? '1' : '0');
    ccToggle?.setAttribute('aria-checked', captionsOn ? 'true' : 'false');
  } else {
    highlightOn = !highlightOn;
    safeSet('pip.hl', highlightOn ? '1' : '0');
    hlToggle?.setAttribute('aria-checked', highlightOn ? 'true' : 'false');
  }
  lastCaptionKey = '';
  renderCaption();
}

function togglePlay() {
  if (!(audioEl instanceof HTMLAudioElement)) return;
  if (!audioEl.src || (playBtn instanceof HTMLButtonElement && playBtn.disabled)) return;
  if (audioEl.paused) void audioEl.play();
  else audioEl.pause();
}

/**
 * @param {unknown} guide
 */
function applyGuide(guide) {
  if (!guide || typeof guide !== 'object') return;
  const g = /** @type {Record<string, unknown>} */ (guide);

  if (typeof g.title === 'string' && buildTitle) {
    buildTitle.textContent = g.title;
  }

  // Prefer blog images; fall back to og thumbnail from guide if storage empty
  if (pageImages.length === 0 && typeof g.thumbnail === 'string' && g.thumbnail) {
    pageImages = [g.thumbnail];
    startSlideshow();
  }

  buildTranscriptData(g);

  const jobs = /** @type {Record<string, { status?: string, chunksDone?: number, chunksTotal?: number, error?: string } | undefined>} */ (
    g.jobs || {}
  );
  const { pct, step } = buildProgress(jobs);
  if (buildBar instanceof HTMLElement) {
    buildBar.style.width = `${pct}%`;
    buildBar.classList.toggle('is-active', pct < 100);
  }
  if (buildBarWrap) buildBarWrap.setAttribute('aria-valuenow', String(pct));
  if (buildPct) buildPct.textContent = `${pct}%`;
  if (buildStep) buildStep.textContent = step;

  const audioPath = typeof g.audio === 'string' ? g.audio.trim() : '';
  const duration = Number(g.duration);
  const playable = audioPath.length > 0 && Number.isFinite(duration) && duration > 0;

  if (playable && audioEl instanceof HTMLAudioElement) {
    const src = assetUrl(audioPath);
    if (audioEl.dataset.src !== src) {
      audioEl.dataset.src = src;
      audioEl.src = src;
      audioEl.playbackRate = rate;
    }
    if (playBtn instanceof HTMLButtonElement) playBtn.disabled = false;
    if (buildEl) buildEl.classList.add('is-hidden');

    if (!autoplayAttempted) {
      autoplayAttempted = true;
      void audioEl.play().catch(() => {});
    }

    if (pollId && (jobs.pipeline?.status === 'done' || jobs.tts?.status === 'done')) {
      // Keep a short poll until pipeline done, then stop
      if (jobs.pipeline?.status === 'done') {
        clearInterval(pollId);
        pollId = null;
      }
    }
  } else if (buildEl) {
    buildEl.classList.remove('is-hidden');
  }
}

function tickTime() {
  if (!(audioEl instanceof HTMLAudioElement)) return;
  const cur = audioEl.currentTime || 0;
  const dur = audioEl.duration || 0;
  if (timeEl) timeEl.textContent = `${fmt(cur)} / ${fmt(dur || 0)}`;
  const pct = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
  if (fillEl instanceof HTMLElement) fillEl.style.width = `${pct}%`;
  if (thumbEl instanceof HTMLElement) thumbEl.style.left = `${pct}%`;
  // Keep captions in sync on seek / metadata / paused ticks (the rAF loop only
  // runs while playing).
  renderCaption();
}

/**
 * @param {number} clientX
 */
function seekFromClientX(clientX) {
  if (!(audioEl instanceof HTMLAudioElement) || !timelineEl) return;
  const track = timelineEl.querySelector('.timeline-track');
  if (!(track instanceof HTMLElement)) return;
  const rect = track.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const dur = audioEl.duration || 0;
  if (dur > 0) {
    audioEl.currentTime = ratio * dur;
    tickTime();
  }
}

function setSettingsOpen(open) {
  if (!(settingsMenu instanceof HTMLElement) || !(settingsBtn instanceof HTMLButtonElement)) return;
  settingsMenu.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function syncRateMenu() {
  document.querySelectorAll('.menu-item[data-rate]').forEach((btn) => {
    if (!(btn instanceof HTMLElement)) return;
    const r = Number(btn.getAttribute('data-rate'));
    btn.classList.toggle('is-active', r === rate);
  });
}

async function loadPipContext() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PIP_CONTEXT', slug });
    if (res?.ok && Array.isArray(res.pageImages)) {
      pageImages = res.pageImages.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
      startSlideshow();
    }
  } catch {
    /* optional */
  }
}

function updateFsIcons() {
  const fs = !!document.fullscreenElement;
  iconExpand?.classList.toggle('is-hidden', fs);
  iconCompress?.classList.toggle('is-hidden', !fs);
  if (fsBtn) {
    fsBtn.setAttribute('aria-label', fs ? 'Exit full screen' : 'Full screen');
    fsBtn.title = fs ? 'Exit full screen' : 'Full screen';
  }
}

async function init() {
  if (!slug) {
    if (buildStep) buildStep.textContent = 'Missing guide slug';
    return;
  }

  const cfg = await getConfig();
  apiBase = cfg.apiBase;
  appBase = cfg.appBase;

  await loadPipContext();
  iconPause?.classList.add('is-hidden');
  iconCompress?.classList.add('is-hidden');

  try {
    const res = await fetch(`${apiBase}/api/guides/${encodeURIComponent(slug)}`);
    applyGuide(await res.json());
  } catch (err) {
    if (buildStep) buildStep.textContent = err instanceof Error ? err.message : String(err);
  }

  pollId = setInterval(() => {
    void fetch(`${apiBase}/api/guides/${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then(applyGuide)
      .catch(() => {});
  }, 1500);

  // Click anywhere on hero toggles play (except controls / settings)
  heroEl?.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('[data-overlay]')) return;
    if (t.closest('.menu')) return;
    togglePlay();
  });

  playBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });

  audioEl?.addEventListener('play', () => {
    root?.setAttribute('data-paused', 'false');
    iconPlay?.classList.add('is-hidden');
    iconPause?.classList.remove('is-hidden');
    if (playBtn) playBtn.setAttribute('aria-label', 'Pause');
    startCaptionLoop();
  });
  audioEl?.addEventListener('pause', () => {
    root?.setAttribute('data-paused', 'true');
    iconPlay?.classList.remove('is-hidden');
    iconPause?.classList.add('is-hidden');
    if (playBtn) playBtn.setAttribute('aria-label', 'Play');
    stopCaptionLoop();
    renderCaption();
  });
  audioEl?.addEventListener('timeupdate', tickTime);
  audioEl?.addEventListener('loadedmetadata', () => {
    tickTime();
    if (autoplayAttempted && audioEl instanceof HTMLAudioElement && audioEl.paused) {
      void audioEl.play().catch(() => {});
    }
  });

  timelineEl?.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    scrubbing = true;
    seekFromClientX(e.clientX);
    const onMove = (ev) => seekFromClientX(ev.clientX);
    const onUp = () => {
      scrubbing = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  // Settings (speed) — same control surface as PlayerView gear
  settingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = settingsMenu?.hidden !== false;
    setSettingsOpen(open);
    syncRateMenu();
  });

  settingsMenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const r = Number(t.getAttribute('data-rate'));
    if (!Number.isFinite(r)) return;
    rate = r;
    if (audioEl instanceof HTMLAudioElement) audioEl.playbackRate = rate;
    syncRateMenu();
    setSettingsOpen(false);
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('.menu-wrap')) return;
    setSettingsOpen(false);
  });

  // Caption + word-highlight toggles (persisted). Keep the menu open on toggle.
  ccToggle?.setAttribute('aria-checked', captionsOn ? 'true' : 'false');
  hlToggle?.setAttribute('aria-checked', highlightOn ? 'true' : 'false');
  ccToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSetting('cc');
  });
  hlToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSetting('hl');
  });

  // External-link icon → full web player in a new tab
  openBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.open(`${appBase}/app/${encodeURIComponent(slug)}`, '_blank', 'noopener,noreferrer');
  });

  // Fullscreen corners icon → fullscreen this PiP only
  fsBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // allowfullscreen on iframe required
    }
    updateFsIcons();
  });
  document.addEventListener('fullscreenchange', updateFsIcons);
  syncRateMenu();
  updateFsIcons();
}

void init();
