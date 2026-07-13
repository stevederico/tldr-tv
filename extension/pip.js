/**
 * In-page PiP player (extension origin) — polls guide API, plays audio when ready.
 * Runs inside chrome-extension:// so HTTPS blogs don't block localhost media.
 */
import { getConfig } from './config.js';

const params = new URLSearchParams(location.search);
const slug = params.get('slug') || '';

const coverEl = document.getElementById('cover');
const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('sub');
const playBtn = document.getElementById('play');
const openBtn = document.getElementById('open');
const timeEl = document.getElementById('time');
const seekEl = document.getElementById('seek');
const audioEl = document.getElementById('audio');

/** @type {string} */
let appBase = 'http://localhost:5173';
/** @type {string} */
let apiBase = 'http://localhost:8000';
/** @type {ReturnType<typeof setInterval> | null} */
let pollId = null;

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
 * @param {unknown} guide
 */
function applyGuide(guide) {
  if (!guide || typeof guide !== 'object') return;
  const g = /** @type {Record<string, unknown>} */ (guide);

  if (typeof g.title === 'string' && titleEl) titleEl.textContent = g.title;

  const jobs = /** @type {Record<string, { status?: string, chunksDone?: number, chunksTotal?: number }> | undefined} */ (
    g.jobs
  );
  const tts = jobs?.tts;
  const images = jobs?.['chapter-images'];
  const pipeline = jobs?.pipeline;

  const chapters = Array.isArray(g.chapters) ? g.chapters : [];
  const first = chapters[0] && typeof chapters[0] === 'object'
    ? /** @type {Record<string, unknown>} */ (chapters[0])
    : null;
  const gen =
    first && first.image && typeof first.image === 'object'
      ? /** @type {Record<string, unknown>} */ (first.image).generated
      : null;
  const coverPath =
    (typeof gen === 'string' && gen) ||
    (typeof g.thumbnail === 'string' && g.thumbnail) ||
    '';

  if (coverPath && coverEl instanceof HTMLImageElement) {
    coverEl.src = assetUrl(coverPath);
    coverEl.hidden = false;
  }

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
    if (seekEl instanceof HTMLInputElement) {
      seekEl.disabled = false;
      seekEl.max = String(duration);
    }
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.classList.add('is-ready');
    }
    if (subEl) {
      subEl.textContent = pipeline?.status === 'done' ? 'Ready' : 'Audio ready — images may still load';
    }
    if (pollId && pipeline?.status === 'done') {
      clearInterval(pollId);
      pollId = null;
    }
  } else {
    let hint = 'Preparing…';
    if (tts?.status === 'running') {
      hint = tts.chunksTotal
        ? `Generating audio (${tts.chunksDone ?? 0}/${tts.chunksTotal})`
        : 'Generating audio…';
    } else if (images?.status === 'running') {
      hint = 'Generating images…';
    } else if (jobs?.analyze?.status === 'running') {
      hint = 'Analyzing article…';
    } else if (pipeline?.status === 'failed') {
      hint = pipeline.error || 'Generation failed';
    }
    if (statusEl) {
      statusEl.textContent = hint;
      statusEl.classList.remove('is-ready');
    }
    if (subEl) subEl.textContent = hint;
  }
}

async function fetchGuide() {
  if (!slug) throw new Error('Missing slug');
  const res = await fetch(`${apiBase}/api/guides/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`Guide fetch failed (HTTP ${res.status})`);
  return res.json();
}

function tickTime() {
  if (!(audioEl instanceof HTMLAudioElement)) return;
  if (!(timeEl instanceof HTMLElement)) return;
  if (!(seekEl instanceof HTMLInputElement)) return;
  const cur = audioEl.currentTime || 0;
  const dur = audioEl.duration || Number(seekEl.max) || 0;
  timeEl.textContent = `${fmt(cur)} / ${fmt(dur)}`;
  if (!seekEl.matches(':active')) seekEl.value = String(cur);
}

async function init() {
  if (!slug) {
    if (statusEl) statusEl.textContent = 'Missing guide slug';
    return;
  }

  const cfg = await getConfig();
  apiBase = cfg.apiBase;
  appBase = cfg.appBase;

  try {
    applyGuide(await fetchGuide());
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  pollId = setInterval(() => {
    void fetchGuide()
      .then(applyGuide)
      .catch(() => {});
  }, 2000);

  playBtn?.addEventListener('click', () => {
    if (!(audioEl instanceof HTMLAudioElement)) return;
    if (audioEl.paused) void audioEl.play();
    else audioEl.pause();
  });

  audioEl?.addEventListener('play', () => {
    if (playBtn) playBtn.textContent = 'Pause';
  });
  audioEl?.addEventListener('pause', () => {
    if (playBtn) playBtn.textContent = 'Play';
  });
  audioEl?.addEventListener('timeupdate', tickTime);
  audioEl?.addEventListener('loadedmetadata', tickTime);

  seekEl?.addEventListener('input', () => {
    if (!(audioEl instanceof HTMLAudioElement) || !(seekEl instanceof HTMLInputElement)) return;
    audioEl.currentTime = Number(seekEl.value);
    tickTime();
  });

  openBtn?.addEventListener('click', () => {
    const url = `${appBase}/app/${encodeURIComponent(slug)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });
}

void init();
