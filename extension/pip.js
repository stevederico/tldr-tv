/**
 * PiP player: blog-image slideshow + audio, PlayerView-style chrome.
 * No generated images — page photos only (skipImages on create).
 */
import { getConfig } from './config.js';

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
 * Progress without image generation (analyze + tts only).
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
        step = `Generating audio (${j.chunksDone ?? 0}/${j.chunksTotal})`;
      } else {
        pct += s.weight * 0.2;
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

  const jobs = /** @type {Record<string, { status?: string, chunksDone?: number, chunksTotal?: number, error?: string } | undefined>} */ (
    g.jobs || {}
  );
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
  });
  audioEl?.addEventListener('pause', () => {
    root?.setAttribute('data-paused', 'true');
    iconPlay?.classList.remove('is-hidden');
    iconPause?.classList.add('is-hidden');
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
