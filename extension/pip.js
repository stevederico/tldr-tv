/**
 * PiP video-style player — matches the in-app hero chrome as closely as a
 * lightweight extension page can (no React bundle).
 *
 * - Blog page images first, then generated chapter art
 * - Autoplay when audio is ready
 * - Progress bar while audio / images generate
 */
import { getConfig } from './config.js';

const params = new URLSearchParams(location.search);
const slug = params.get('slug') || '';

const root = document.getElementById('root');
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
const openBtn = document.getElementById('open');
const timeEl = document.getElementById('time');
const fillEl = document.getElementById('fill');
const thumbEl = document.getElementById('thumb');
const timelineEl = document.getElementById('timeline');
const audioEl = document.getElementById('audio');

/** @type {string} */
let appBase = 'http://localhost:5173';
/** @type {string} */
let apiBase = 'http://localhost:8000';
/** @type {string[]} */
let pageImages = [];
/** @type {string[]} */
let generatedImages = [];
/** @type {string[]} */
let gallery = [];
let galleryIdx = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let pollId = null;
/** @type {ReturnType<typeof setInterval> | null} */
let galleryTimer = null;
let autoplayAttempted = false;
let scrubbing = false;

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

function rebuildGallery() {
  /** @type {string[]} */
  const next = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const u of [...generatedImages, ...pageImages]) {
    const abs = assetUrl(u);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    next.push(abs);
  }
  gallery = next;
  if (gallery.length && !gallery.includes(coverEl instanceof HTMLImageElement ? coverEl.src : '')) {
    galleryIdx = 0;
    setHero(gallery[0]);
  } else if (gallery.length && coverEl instanceof HTMLImageElement && !coverEl.src) {
    setHero(gallery[0]);
  }
}

function startGalleryRotation() {
  if (galleryTimer) clearInterval(galleryTimer);
  if (gallery.length < 2) return;
  galleryTimer = setInterval(() => {
    if (scrubbing) return;
    galleryIdx = (galleryIdx + 1) % gallery.length;
    setHero(gallery[galleryIdx]);
  }, 10000);
}

/**
 * Weighted build progress: analyze 10%, tts 55%, chapter-images 35%.
 *
 * @param {Record<string, { status?: string, chunksDone?: number, chunksTotal?: number, error?: string } | undefined>} jobs
 * @returns {{ pct: number, step: string }}
 */
function buildProgress(jobs) {
  const stages = [
    { key: 'analyze', weight: 10, label: 'Analyzing article…' },
    { key: 'tts', weight: 55, label: 'Generating audio…' },
    { key: 'chapter-images', weight: 35, label: 'Generating images…' },
  ];
  let pct = 0;
  let step = 'Starting…';
  for (const s of stages) {
    const j = jobs[s.key];
    if (!j) continue;
    if (j.status === 'done') {
      pct += s.weight;
      continue;
    }
    if (j.status === 'running') {
      step = s.label;
      if (j.chunksTotal && j.chunksTotal > 0) {
        const frac = Math.min(1, (j.chunksDone ?? 0) / j.chunksTotal);
        pct += s.weight * frac;
        step = `${s.label.replace('…', '')} (${j.chunksDone ?? 0}/${j.chunksTotal})`;
      } else {
        pct += s.weight * 0.15;
      }
      break;
    }
    if (j.status === 'failed') {
      step = j.error || `${s.key} failed`;
      break;
    }
  }
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
 * @param {unknown} guide
 */
function applyGuide(guide) {
  if (!guide || typeof guide !== 'object') return;
  const g = /** @type {Record<string, unknown>} */ (guide);

  if (typeof g.title === 'string' && buildTitle) {
    buildTitle.textContent = g.title;
  }

  const jobs = /** @type {Record<string, { status?: string, chunksDone?: number, chunksTotal?: number, error?: string } | undefined>} */ (
    g.jobs || {}
  );

  // Generated chapter images
  generatedImages = [];
  if (Array.isArray(g.chapters)) {
    for (const ch of g.chapters) {
      if (!ch || typeof ch !== 'object') continue;
      const img = /** @type {Record<string, unknown>} */ (ch).image;
      if (img && typeof img === 'object') {
        const gen = /** @type {Record<string, unknown>} */ (img).generated;
        if (typeof gen === 'string' && gen) generatedImages.push(gen);
      }
      const real = /** @type {Record<string, unknown>} */ (ch).realImage;
      if (typeof real === 'string' && real) generatedImages.push(real);
    }
  }
  if (typeof g.thumbnail === 'string' && g.thumbnail) {
    pageImages = [g.thumbnail, ...pageImages.filter((u) => u !== g.thumbnail)];
  }
  rebuildGallery();
  startGalleryRotation();

  const { pct, step } = buildProgress(jobs);
  if (buildBar instanceof HTMLElement) buildBar.style.width = `${pct}%`;
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
    }
    if (playBtn instanceof HTMLButtonElement) playBtn.disabled = false;

    // Hide build overlay once audio can play (images may still stream in)
    if (buildEl) buildEl.classList.add('is-hidden');

    if (!autoplayAttempted) {
      autoplayAttempted = true;
      void audioEl.play().catch(() => {
        // Autoplay blocked until user gesture — controls stay visible via data-paused
      });
    }

    if (pollId && jobs.pipeline?.status === 'done') {
      clearInterval(pollId);
      pollId = null;
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

async function loadPipContext() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PIP_CONTEXT', slug });
    if (res?.ok && Array.isArray(res.pageImages)) {
      pageImages = res.pageImages.filter((u) => typeof u === 'string');
      rebuildGallery();
      if (gallery[0]) setHero(gallery[0]);
      startGalleryRotation();
    }
  } catch {
    // storage optional
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

  try {
    applyGuide(await (await fetch(`${apiBase}/api/guides/${encodeURIComponent(slug)}`)).json());
  } catch (err) {
    if (buildStep) {
      buildStep.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  pollId = setInterval(() => {
    void fetch(`${apiBase}/api/guides/${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then(applyGuide)
      .catch(() => {});
  }, 1500);

  playBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!(audioEl instanceof HTMLAudioElement) || playBtn instanceof HTMLButtonElement && playBtn.disabled) return;
    if (audioEl.paused) void audioEl.play();
    else audioEl.pause();
  });

  // Click hero toggles play (like main player)
  document.getElementById('hero')?.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('[data-overlay]')) return;
    if (t instanceof Element && t.closest('.build') && !buildEl?.classList.contains('is-hidden')) return;
    playBtn?.click();
  });

  audioEl?.addEventListener('play', () => {
    root?.setAttribute('data-paused', 'false');
    iconPlay && (iconPlay.hidden = true);
    iconPause && (iconPause.hidden = false);
    if (playBtn) playBtn.setAttribute('aria-label', 'Pause');
  });
  audioEl?.addEventListener('pause', () => {
    root?.setAttribute('data-paused', 'true');
    iconPlay && (iconPlay.hidden = false);
    iconPause && (iconPause.hidden = true);
    if (playBtn) playBtn.setAttribute('aria-label', 'Play');
  });
  audioEl?.addEventListener('timeupdate', tickTime);
  audioEl?.addEventListener('loadedmetadata', () => {
    tickTime();
    if (autoplayAttempted && audioEl instanceof HTMLAudioElement && audioEl.paused) {
      void audioEl.play().catch(() => {});
    }
  });

  timelineEl?.addEventListener('pointerdown', (e) => {
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

  openBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.open(`${appBase}/app/${encodeURIComponent(slug)}`, '_blank', 'noopener,noreferrer');
  });
}

void init();
