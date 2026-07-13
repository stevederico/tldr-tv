import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import GuideProgress from './GuideProgress';
import {
  fmt,
  resolveAsset,
  findChapterIndex,
  timeAtWordIndex,
  isGuidePlayable,
  isGuideBuilding,
  guideBuildError,
} from '../utils/playerUtils';
import type { Guide, Chapter } from '../utils/playerUtils';
import { useTranscript } from '../hooks/useTranscript';
import TranscriptView from './TranscriptView';
import type { NoteHighlightRange } from './TranscriptView';
import PlayerSettings from './PlayerSettings';
import type { SettingsPage, TranscriptSize } from './PlayerSettings';
import PlayerChaptersMenu from './PlayerChaptersMenu';
import PlayerInfoPanel from './PlayerInfoPanel';
import type { PanelTab } from './PlayerInfoPanel';
import { useTheme } from '@stevederico/skateboard-ui/ThemeProvider';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/sheet';
import { Skeleton } from '@stevederico/skateboard-ui/shadcn/ui/skeleton';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@stevederico/skateboard-ui/shadcn/ui/empty';
import CircleAlert from '@stevederico/skateboard-ui/icons/CircleAlert';

/** Transient play/pause feedback flash overlay state. */
interface Feedback {
  /** Which action was flashed. */
  kind: 'play' | 'pause';
  /** Unique id to re-trigger the animation. */
  id: number;
}

/** Bounding rect of the active text selection (for popup placement). */
interface SelectionRect {
  top: number;
  left: number;
  bottom: number;
  width: number;
  height: number;
}

/** Active drag-selection awaiting a note action. */
interface NoteSelection {
  /** Selected text. */
  text: string;
  /** Playback time of the selection start. */
  time: number;
  /** Selection bounding rect, or null. */
  rect: SelectionRect | null;
  /** First selected word index. */
  startWord: number;
  /** Last selected word index. */
  endWord: number;
}

/** A persisted note anchor used to re-highlight the original text. */
interface NoteAnchor {
  /** Playback time of the note. */
  time: number;
  /** First word index of the quote. */
  startWord: number;
  /** Last word index of the quote. */
  endWord: number;
  /** The selected quote text. */
  selectedText: string;
}

// Side transcript font-size class per user-chosen size. All three scale with
// viewport width via clamp() so the same setting reads well in a 1440 window
// and a 4K fullscreen — the min/max bounds differ per size tier.
const TRANSCRIPT_SIZE_CLS: Record<TranscriptSize, string> = {
  small: 'text-[clamp(0.95rem,1.1vw,1.25rem)]',
  medium: 'text-[clamp(1.2rem,1.9vw,2.1rem)]',
  large: 'text-[clamp(1.3rem,2.2vw,2.5rem)]',
};

/**
 * Skeleton shell shown while the guide JSON is loading (avoids a white flash).
 *
 * @returns Placeholder player layout
 */
function PlayerSkeleton() {
  return (
    <div className="max-w-full" aria-busy="true" aria-label="Loading player">
      <div className="relative w-full aspect-video max-h-[75vh] overflow-hidden m-0 bg-muted">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <Spinner className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading guide…</p>
        </div>
        <div className="absolute bottom-0 left-0 right-0 p-4 flex flex-col gap-2">
          <Skeleton className="h-1.5 w-full rounded-full" />
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16 ml-auto" />
          </div>
        </div>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

/**
 * Shown while TTS/images pipeline is still running after create/Watch.
 *
 * @param props - Guide + poll hook
 * @returns Preparing UI with progress
 */
function PlayerPreparing({
  slug,
  guide,
  onRefresh,
}: {
  slug: string;
  guide: Guide;
  onRefresh: () => Promise<Guide | null>;
}) {
  const thumb = resolveAsset(guide.thumbnail);
  const tts = guide.jobs?.tts;
  const stepHint =
    tts?.status === 'running'
      ? `Generating audio${tts.chunksTotal ? ` (${tts.chunksDone ?? 0}/${tts.chunksTotal})` : '…'}`
      : guide.jobs?.['chapter-images']?.status === 'running'
        ? 'Generating chapter images…'
        : guide.jobs?.analyze?.status === 'running'
          ? 'Analyzing article…'
          : 'Preparing your guide…';

  return (
    <div className="max-w-full" aria-busy="true" aria-live="polite">
      <div className="relative w-full aspect-video max-h-[75vh] overflow-hidden m-0 bg-black">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            className="absolute inset-0 w-full h-full object-cover opacity-40"
          />
        ) : null}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center bg-black/50">
          <Spinner className="size-8 text-white" />
          <p className="text-base font-medium text-white text-balance">{guide.title}</p>
          <p className="text-sm text-white/80">{stepHint}</p>
          <p className="text-xs text-white/60">
            Playback starts when audio is ready (usually under a minute).
          </p>
        </div>
      </div>
      <div className="p-4 border-b border-border">
        <GuideProgress slug={slug} guide={guide} onRefresh={() => { void onRefresh(); }} />
      </div>
    </div>
  );
}

/**
 * Full audiobook-style player: hero image, scrubbable timeline, captions,
 * split transcript, chapters menu, settings, and note-taking.
 *
 * @component
 * @returns The player view, skeleton while loading, or preparing UI while the pipeline runs.
 */
export default function PlayerView() {
  const { slug = 'the-brand-age' } = useParams();
  const [searchParams] = useSearchParams();
  const debugMode = searchParams.get('debug') === '1';
  const [guide, setGuide] = useState<Guide | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('main');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [panel, setPanel] = useState<PanelTab>('summary');
  const [captionsOn, setCaptionsOn] = useState(() => {
    try { return localStorage.getItem('pg.cc') !== '0'; } catch { return true; }
  });
  const [splitTranscript, setSplitTranscript] = useState(() => {
    try { return localStorage.getItem('pg.split') === '1'; } catch { return false; }
  });
  const [transcriptSize, setTranscriptSize] = useState<TranscriptSize>(() => {
    try {
      const v = localStorage.getItem('pg.transcriptSize');
      return v === 'small' || v === 'medium' || v === 'large' ? v : 'medium';
    } catch { return 'medium'; }
  });
  const changeTranscriptSize = (size: TranscriptSize) => {
    setTranscriptSize(size);
    try { localStorage.setItem('pg.transcriptSize', size); } catch {}
  };
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerInsideRef = useRef(false);
  const [chaptersMenuOpen, setChaptersMenuOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [noteSelection, setNoteSelection] = useState<NoteSelection | null>(null);
  const [noteCustomText, setNoteCustomText] = useState('');
  const [noteAnchors, setNoteAnchors] = useState<NoteAnchor[]>([]);
  const [noteHighlight, setNoteHighlight] = useState<NoteHighlightRange | null>(null);

  const { resolvedTheme, setTheme } = useTheme();
  const isDarkMode = resolvedTheme === 'dark';
  const isMobile = useIsMobile();
  function toggleTheme() {
    setTheme(isDarkMode ? 'light' : 'dark');
  }

  // Controls overlay visibility with inactivity auto-hide (YouTube-style).
  // Bound directly to pointer handlers, so `immediate` may receive the event
  // object — any truthy value selects the short (800ms) auto-hide delay.
  function showControls(immediate: unknown = false) {
    pointerInsideRef.current = true;
    // Sync DOM update for instant show on enter/move (before React re-render)
    if (heroRef.current) heroRef.current.dataset.controls = 'visible';
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    // Auto-hide only while actively playing and no menus/popups are open
    const hasOpenUI = menuOpen || chaptersMenuOpen || !!noteSelection;
    if (playing && !hasOpenUI) {
      const delay = immediate ? 800 : 2200;
      hideTimerRef.current = setTimeout(() => {
        setControlsVisible(false);
        if (heroRef.current) delete heroRef.current.dataset.controls;
      }, delay);
    }
  }
  function hideControls() {
    pointerInsideRef.current = false;
    // Drop focus inside the hero so :focus-within fallbacks don't keep controls visible
    if (heroRef.current && document.activeElement && heroRef.current.contains(document.activeElement)) {
      try {
        const el = document.activeElement;
        if (el instanceof HTMLElement) el.blur();
      } catch {}
    }
    // Sync DOM update for instant hide as soon as cursor leaves the player area
    if (heroRef.current) delete heroRef.current.dataset.controls;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setControlsVisible(false);
  }

  // Keep controls visible when paused or any menu/popup is open — but only while the pointer is inside the hero.
  useEffect(() => {
    if (!pointerInsideRef.current) return;
    if (!playing || menuOpen || chaptersMenuOpen || noteSelection) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (heroRef.current) heroRef.current.dataset.controls = 'visible';
      setControlsVisible(true);
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [playing, menuOpen, chaptersMenuOpen, noteSelection]);

  const menuRef = useRef<HTMLDivElement>(null);
  const chaptersMenuRef = useRef<HTMLDivElement>(null);
  const activeChapterItemRef = useRef<HTMLButtonElement>(null);
  const selectionPopupRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLSpanElement>(null);
  const sideTranscriptScrollRef = useRef<HTMLDivElement>(null);
  const sideActiveWordRef = useRef<HTMLSpanElement>(null);
  const userScrollUntilRef = useRef(0);
  const lastProgressSaveRef = useRef(0);
  const playheadRef = useRef(0);
  const durRef = useRef(0);
  const scrubbingRef = useRef(false);

  useEffect(() => {
    // Sheet handles outside-click + Esc on mobile via onOpenChange; don't double-fire.
    if (!menuOpen || isMobile) return;
    function onDoc(e: MouseEvent) {
      const target = e.target;
      if (menuRef.current && target instanceof Node && !menuRef.current.contains(target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen, isMobile]);

  useEffect(() => {
    if (!menuOpen) setSettingsPage('main');
  }, [menuOpen]);

  useEffect(() => {
    if (!chaptersMenuOpen || isMobile) return;
    function onDoc(e: MouseEvent) {
      const target = e.target;
      if (chaptersMenuRef.current && target instanceof Node && !chaptersMenuRef.current.contains(target)) setChaptersMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [chaptersMenuOpen, isMobile]);

  useEffect(() => {
    if (!chaptersMenuOpen) return;
    const el = activeChapterItemRef.current;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [chaptersMenuOpen]);

  // Close selection note popup on outside click (like other menus)
  useEffect(() => {
    if (!noteSelection) return;
    function onDoc(e: MouseEvent) {
      const target = e.target;
      if (selectionPopupRef.current && target instanceof Node && !selectionPopupRef.current.contains(target)) {
        setNoteSelection(null);
        setNoteCustomText('');
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [noteSelection]);

  // Escape key closes the popup and clears any leftover browser selection
  useEffect(() => {
    if (!noteSelection) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setNoteSelection(null);
        setNoteCustomText('');
        window.getSelection()?.removeAllRanges();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [noteSelection]);

  // Auto-focus the custom note textarea as soon as the popup appears
  useEffect(() => {
    if (noteSelection && noteInputRef.current) {
      const t = setTimeout(() => {
        noteInputRef.current?.focus();
        noteInputRef.current?.select?.();
      }, 60);
      return () => clearTimeout(t);
    }
  }, [noteSelection]);

  // Auto-clear the re-highlighted note text after a while
  useEffect(() => {
    if (!noteHighlight) return;
    const t = setTimeout(() => setNoteHighlight(null), 9000);
    return () => clearTimeout(t);
  }, [noteHighlight]);

  function changeRate(r: number) {
    if (audioRef.current) audioRef.current.playbackRate = r;
    setRate(r);
  }

  function toggleSplitTranscript() {
    setSplitTranscript(v => {
      const next = !v;
      try { localStorage.setItem('pg.split', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  useEffect(() => {
    try { setNotes(localStorage.getItem(`pg.notes.${slug}`) || ''); } catch { setNotes(''); }
    try {
      const raw = localStorage.getItem(`pg.noteAnchors.${slug}`);
      setNoteAnchors(raw ? JSON.parse(raw) : []);
    } catch {
      setNoteAnchors([]);
    }
    // Stale highlight/popup state from the previous guide would point at unrelated words
    setNoteHighlight(null);
    setNoteSelection(null);
    setNoteCustomText('');
  }, [slug]);

  function persistAnchors(next: NoteAnchor[]) {
    setNoteAnchors(next);
    try {
      localStorage.setItem(`pg.noteAnchors.${slug}`, JSON.stringify(next));
    } catch {}
  }

  // Notes textarea is the source of truth: when the user edits the textarea, drop any
  // anchor whose `[m:ss]` timestamp line no longer appears in the text.
  function updateNotes(v: string) {
    setNotes(v);
    try { localStorage.setItem(`pg.notes.${slug}`, v); } catch {}
    const surviving = noteAnchors.filter(a => v.includes(`[${fmt(a.time)}]`));
    if (surviving.length !== noteAnchors.length) {
      persistAnchors(surviving);
    }
  }

  function updateNoteAnchors(next: NoteAnchor[]) {
    persistAnchors(next);
  }

  const audioRef = useRef<HTMLAudioElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const refetchGuide = useCallback(async (): Promise<Guide | null> => {
    try {
      const r = await fetch(`/api/guides/${encodeURIComponent(slug)}`);
      if (!r.ok) return null;
      const g = (await r.json()) as Guide;
      setGuide(g);
      if (g.duration) setDuration(g.duration);
      setLoadError(null);
      return g;
    } catch (err) {
      console.error('Failed to refetch guide:', err);
      return null;
    }
  }, [slug]);

  // Initial load + reset when navigating between guides
  useEffect(() => {
    let cancelled = false;
    const previousTitle = document.title;
    setGuide(null);
    setLoadError(null);
    setDuration(0);
    setCurrent(0);
    setPlaying(false);

    fetch(`/api/guides/${encodeURIComponent(slug)}`)
      .then(r => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Guide not found' : `Failed to load (HTTP ${r.status})`);
        return r.json();
      })
      .then((g: Guide) => {
        if (cancelled) return;
        setGuide(g);
        setDuration(g.duration || 0);
        document.title = (g.title || 'Player') + ' — Visual Player';
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Failed to load guide:', err);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      document.title = previousTitle;
    };
  }, [slug]);

  // Poll while pipeline builds audio so extension deep-links become playable
  useEffect(() => {
    if (!guide || !isGuideBuilding(guide)) return;
    const id = setInterval(() => {
      void refetchGuide();
    }, 2000);
    return () => clearInterval(id);
  }, [guide, refetchGuide]);

  const {
    transcriptParas,
    totalWords,
    anchors,
    wordStartTimes,
    activeWord,
    activeCaption,
  } = useTranscript(guide, duration, current, captionsOn);

  // Stable identity so memoized children (e.g. PlayerChaptersMenu) don't re-render
  // on every parent tick.
  const chapters = useMemo<Chapter[]>(() => guide?.chapters || [], [guide]);

  useEffect(() => {
    if (!playing) return;
    let raf: number;
    const tick = () => {
      const a = audioRef.current;
      if (a) {
        const t = a.currentTime || 0;
        setCurrent(t);
        const i = findChapterIndex(chapters, t);
        setActiveIdx(prev => (prev === i ? prev : i));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, chapters]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const a = audioRef.current;
      if (!a) return;
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches && target.matches('input,select,textarea')) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        a.currentTime = Math.max(0, a.currentTime - 10);
      } else if (e.key === 'ArrowRight') {
        a.currentTime = Math.min(a.duration || 9999, a.currentTime + 10);
      } else if (e.key.toLowerCase() === 'f') {
        toggleFs();
      } else if (e.key.toLowerCase() === 'c') {
        toggleCaptions();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function toggleFs() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (heroRef.current?.requestFullscreen) {
      heroRef.current.requestFullscreen().catch(() => {});
    }
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    const wasPaused = a.paused;
    if (wasPaused) a.play().catch(() => {});
    else a.pause();
    flashFeedback(wasPaused ? 'play' : 'pause');
  }

  function flashFeedback(kind: Feedback['kind']) {
    setFeedback({ kind, id: Date.now() });
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 600);
  }

  function handleHeroClick(e: ReactMouseEvent<HTMLDivElement>) {
    // Don't toggle play when the click came from inside the controls overlay
    // (its own buttons handle their own actions; otherwise we'd double-toggle).
    const target = e.target;
    if (target instanceof Element && target.closest('[data-overlay]')) return;
    togglePlay();
  }

  // Note: transcriptParas, anchors, activeWord, etc. now come from useTranscript hook
  function toggleCaptions() {
    setCaptionsOn(v => {
      const next = !v;
      try { localStorage.setItem('pg.cc', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  useEffect(() => {
    const scroller = transcriptScrollRef.current;
    if (!scroller) return;
    function pauseAutoScroll() { userScrollUntilRef.current = Date.now() + 5000; }
    scroller.addEventListener('wheel', pauseAutoScroll, { passive: true });
    scroller.addEventListener('touchmove', pauseAutoScroll, { passive: true });
    return () => {
      scroller.removeEventListener('wheel', pauseAutoScroll);
      scroller.removeEventListener('touchmove', pauseAutoScroll);
    };
  }, [panel]);

  useEffect(() => {
    const scroller = sideTranscriptScrollRef.current;
    if (!scroller) return;
    function pauseAutoScroll() { userScrollUntilRef.current = Date.now() + 5000; }
    scroller.addEventListener('wheel', pauseAutoScroll, { passive: true });
    scroller.addEventListener('touchmove', pauseAutoScroll, { passive: true });
    return () => {
      scroller.removeEventListener('wheel', pauseAutoScroll);
      scroller.removeEventListener('touchmove', pauseAutoScroll);
    };
  }, [splitTranscript, transcriptParas]);

  // Keep live refs of playhead and duration so the side-scroll RAF can read
  // the latest values every frame without causing the effect to restart constantly.
  useEffect(() => { playheadRef.current = current; }, [current]);
  useEffect(() => { durRef.current = duration; }, [duration]);

  useEffect(() => {
    if (!playing) return;
    if (Date.now() < userScrollUntilRef.current) return;

    // Bottom transcript panel: keep the active word roughly centered.
    // Trigger when it drifts past ~55% down (or off-screen) and re-center at ~40%.
    const scroller = transcriptScrollRef.current;
    const el = activeWordRef.current;
    if (panel === 'transcript' && scroller && el) {
      const elRect = el.getBoundingClientRect();
      const sRect = scroller.getBoundingClientRect();
      const relTop = elRect.top - sRect.top;
      const h = sRect.height;
      if (relTop > h * 0.45 || elRect.bottom < sRect.top) {
        const target = scroller.scrollTop + relTop - h * 0.3;
        scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      }
    }
  }, [activeWord, panel, playing]);

  // Continuous damped scroll for the *side* transcript pane in split mode.
  // Pure time-based (current / duration) + reading line offset so the active
  // words sit in the middle of the pane (not jammed at the top) and the scroll
  // never stops during pauses — classic script-to-screen roll.
  useEffect(() => {
    if (!splitTranscript || !playing) return;
    const scroller = sideTranscriptScrollRef.current;
    if (!scroller) return;

    let rafId: number;

    const tick = () => {
      if (Date.now() < userScrollUntilRef.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const d = durRef.current || duration || 0;
      const t = playheadRef.current || current || 0;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;

      if (maxScroll <= 10 || d <= 0) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const frac = Math.min(1, Math.max(0, t / d));

      // Target the "current" moment ~40% down the visible pane (not at the very top).
      // This keeps the highlighted words in the comfortable middle/upper-middle area
      // with good lookahead below, like the script-to-screen videos.
      const paneH = scroller.clientHeight;
      const readingLine = paneH * 0.40;
      let target = frac * maxScroll - readingLine;
      const desired = Math.max(0, Math.min(maxScroll, target));

      const curr = scroller.scrollTop;
      const gap = Math.abs(desired - curr);

      if (gap > 90) {
        // Big jump (seek, chapter, word click) → snap instantly so the view matches
        scroller.scrollTop = desired;
      } else {
        // Normal playback: soft damped lerp for continuous slow roll
        const next = curr + (desired - curr) * 0.095;
        scroller.scrollTop = next;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [splitTranscript, playing]);

  function seekToWord(wIdx: number) {
    const a = audioRef.current;
    if (!a || !totalWords || !duration) return;
    let t: number;
    if (wordStartTimes && wordStartTimes[wIdx] != null) t = wordStartTimes[wIdx];
    else if (anchors) t = timeAtWordIndex(anchors, wIdx);
    else t = (wIdx / totalWords) * duration;
    a.currentTime = t;
    a.play().catch(() => {});
  }

  // Move the playhead without forcing playback — used when previewing a saved note
  // so the user isn't yanked into play (and their pg.progress.<slug> isn't overwritten).
  function seekToTime(t: number) {
    const a = audioRef.current;
    if (!a) return;
    const clamped = Math.max(0, Math.min(t, duration || 999999));
    a.currentTime = clamped;
  }

  // Called by TranscriptView instances when user finishes a drag selection.
  // We store the exact word range so we can re-highlight the original text when the user
  // later clicks the note marker on the progress bar.
  const handleTextSelected = useCallback((text: string, startIdx: number, endIdx?: number) => {
    if (!anchors) return;
    const t = timeAtWordIndex(anchors, startIdx);
    const sel = window.getSelection();
    let rect: SelectionRect | null = null;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      rect = { top: r.top, left: r.left, bottom: r.bottom, width: r.width, height: r.height };
    }
    setNoteSelection({
      text,
      time: t,
      rect,
      startWord: startIdx,
      endWord: endIdx ?? startIdx,
    });
    setNoteCustomText('');
  }, [anchors]);

  function handleSaveNoteSelection() {
    if (!noteSelection) return;

    const quotePart = `[${fmt(noteSelection.time)}] "${noteSelection.text}"`;
    const extra = noteCustomText.trim();
    const entry = extra
      ? `\n\n${quotePart}\n${extra}`
      : `\n\n${quotePart}`;
    const base = (notes || '').trimEnd();
    updateNotes(base + entry);

    // Persist structured anchor so we can re-highlight the exact text later
    if (noteSelection.startWord != null && noteSelection.endWord != null) {
      const newAnchor: NoteAnchor = {
        time: noteSelection.time,
        startWord: noteSelection.startWord,
        endWord: noteSelection.endWord,
        selectedText: noteSelection.text,
      };
      // Avoid exact duplicates by time+range
      const exists = noteAnchors.some(a =>
        Math.abs(a.time - newAnchor.time) < 1 &&
        a.startWord === newAnchor.startWord &&
        a.endWord === newAnchor.endWord
      );
      if (!exists) {
        updateNoteAnchors([...noteAnchors, newAnchor]);
      }
    }

    setPanel('notes');
    window.getSelection()?.removeAllRanges();
    setNoteSelection(null);
    setNoteCustomText('');
  }

  const jumpToChapter = useCallback((ch: Chapter, idx: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = ch.time || 0;
    a.play().catch(() => {});
    setActiveIdx(idx);
  }, []);

  // --- Timeline scrubbing (click + drag) ---
  function seekFromPointer(e: PointerEvent) {
    const a = audioRef.current;
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!a || !rect || !rect.width) return;

    // PointerEvent has clientX for both mouse and touch (normalized)
    const x = e.clientX;
    if (x == null) return;

    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    const targetTime = pct * (a.duration || duration || 0);
    a.currentTime = targetTime;

    // Immediately reflect in UI state so thumb/progress follow the drag live
    setCurrent(targetTime);
  }

  function handleTimelinePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    scrubbingRef.current = true;

    seekFromPointer(e.nativeEvent);

    const onMove = (ev: PointerEvent) => {
      if (scrubbingRef.current) {
        seekFromPointer(ev);
      }
    };

    const onUp = () => {
      scrubbingRef.current = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };

    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp, { passive: true });
    document.addEventListener('pointercancel', onUp, { passive: true });
  }

  if (!guide && loadError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CircleAlert size={24} /></EmptyMedia>
            <EmptyTitle>Couldn&apos;t open guide</EmptyTitle>
            <EmptyDescription>{loadError}</EmptyDescription>
          </EmptyHeader>
          <Button type="button" onClick={() => { void refetchGuide(); setLoadError(null); }}>
            Try again
          </Button>
        </Empty>
      </div>
    );
  }

  if (!guide) return <PlayerSkeleton />;

  const buildErr = guideBuildError(guide);
  if (buildErr) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CircleAlert size={24} /></EmptyMedia>
            <EmptyTitle>Generation failed</EmptyTitle>
            <EmptyDescription>{buildErr}</EmptyDescription>
          </EmptyHeader>
          <Button type="button" onClick={() => { void refetchGuide(); }}>
            Check again
          </Button>
        </Empty>
      </div>
    );
  }

  if (!isGuidePlayable(guide)) {
    return (
      <PlayerPreparing
        slug={slug}
        guide={guide}
        onRefresh={refetchGuide}
      />
    );
  }

  const ch = chapters[activeIdx] || chapters[0] || {};
  // Chapters can have a generated image, a real image, or both. When both are
  // present, rotate between them every IMAGE_SWAP_SECONDS so the visual changes
  // through the chapter; otherwise just show whichever one exists.
  const IMAGE_SWAP_SECONDS = 10;
  const chapterImages: string[] = [];
  const generated = ch.image?.generated;
  if (typeof generated === 'string' && generated) chapterImages.push(generated);
  if (typeof ch.realImage === 'string' && ch.realImage) chapterImages.push(ch.realImage);
  const chapterStart = typeof ch.time === 'number' && Number.isFinite(ch.time) ? ch.time : 0;
  const secondsInChapter = Math.max(0, current - chapterStart);
  const heroIdx = chapterImages.length > 0
    ? Math.floor(secondsInChapter / IMAGE_SWAP_SECONDS) % chapterImages.length
    : 0;
  const heroSrc = resolveAsset(chapterImages[heroIdx] || '');
  // Force split off on mobile — the side transcript pane is desktop-only;
  // mobile gets the full-width transcript tab in PlayerInfoPanel instead.
  const showSplit = splitTranscript && !!transcriptParas && !isMobile;
  const dur = duration || guide.duration || 1;
  const pct = Math.max(0, Math.min(100, (current / dur) * 100));

  return (
    <>
      {debugMode && guide && (
        <details className="player-debug" style={{ padding: '12px 16px', background: 'var(--color-card, #1a1a1a)', borderBottom: '1px solid var(--color-border, #333)' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Guide pipeline (debug)</summary>
          <div style={{ marginTop: 12 }}>
            <GuideProgress slug={slug} guide={guide} onRefresh={refetchGuide} />
          </div>
        </details>
      )}
      <div className="max-w-full">
        <div>
          <div
            ref={heroRef}
            onPointerEnter={showControls}
            onPointerMove={showControls}
            onPointerLeave={hideControls}
            onClick={handleHeroClick}
            data-paused={!playing || undefined}
            data-split={showSplit || undefined}
            data-controls={controlsVisible ? 'visible' : undefined}
            className="group/hero relative w-full aspect-video max-h-[75vh] overflow-hidden m-0 bg-black cursor-pointer"
          >
            {showSplit ? (
              <div className="grid grid-cols-[1.25fr_1fr] gap-px w-full h-full relative z-[1]">
                <div className="relative w-full h-full overflow-hidden bg-black">
                  {heroSrc && (
                    <div
                      aria-hidden="true"
                      style={{ backgroundImage: `url(${heroSrc})` }}
                      className="absolute inset-0 bg-cover bg-center bg-no-repeat blur-[48px] saturate-[1.3] scale-[1.2] opacity-65 z-0 pointer-events-none"
                    />
                  )}
                  {heroSrc && (
                    <img
                      alt="Current illustration"
                      src={heroSrc}
                      className="relative z-[1] w-full h-full object-contain object-top block"
                    />
                  )}
                </div>
                <div
                  ref={sideTranscriptScrollRef}
                  onClick={e => e.stopPropagation()}
                  className={`relative w-full h-full overflow-y-auto bg-[var(--hero-transcript-bg)] py-10 px-[clamp(24px,6vw,56px)] pb-[60vh] font-['Literata',Charter,Georgia,serif] ${TRANSCRIPT_SIZE_CLS[transcriptSize]} leading-[1.55] text-foreground text-left cursor-default scrollbar-thin`}
                >
                  <TranscriptView
                    paras={transcriptParas}
                    activeWord={activeWord}
                    onWordClick={seekToWord}
                    activeRef={sideActiveWordRef}
                    onTextSelected={handleTextSelected}
                    highlightedNoteRange={noteHighlight}
                  />
                </div>
              </div>
            ) : (
              heroSrc && (
                <>
                  <div
                    aria-hidden="true"
                    style={{ backgroundImage: `url(${heroSrc})` }}
                    className="absolute inset-0 bg-cover bg-center bg-no-repeat blur-[48px] saturate-[1.3] scale-[1.2] opacity-65 z-0 pointer-events-none"
                  />
                  <img
                    id="main-img"
                    alt="Current illustration"
                    src={heroSrc}
                    className="relative z-[1] w-full h-full object-contain block"
                  />
                </>
              )
            )}

            <div data-overlay className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent pt-12 text-foreground pointer-events-none opacity-0 transition-opacity duration-200 z-[5] group-hover/hero:opacity-100 group-data-[controls=visible]/hero:opacity-100">
              <div
                ref={timelineRef}
                onPointerDown={handleTimelinePointerDown}
                onClick={e => e.stopPropagation()}
                className="relative w-full h-[3px] bg-[var(--timeline-bg)] cursor-pointer z-10 mb-2 transition-[height] duration-150 pointer-events-none group-hover/hero:pointer-events-auto group-data-[controls=visible]/hero:pointer-events-auto group-focus-within/hero:pointer-events-auto group-data-[paused]/hero:pointer-events-auto group-hover/hero:h-1.5 group-data-[controls=visible]/hero:h-1.5 group-data-[paused]/hero:h-1.5"
              >
                <div
                  style={{ width: pct + '%' }}
                  className="absolute left-0 top-0 h-full bg-[var(--accent)] shadow-[0_0_8px_rgba(var(--accent-glow),0.5)]"
                />
                <div className="absolute top-0 left-0 right-0 h-full pointer-events-none z-[11]">
                  {chapters.map((c, i) => (
                    <div
                      key={i}
                      data-active={i === activeIdx || undefined}
                      style={{ left: (((c.time ?? 0) / dur) * 100) + '%' }}
                      title={c.title}
                      onClick={e => { e.stopPropagation(); jumpToChapter(c, i); }}
                      className="absolute w-0.5 h-full bg-[var(--marker-bg)] top-0 -translate-x-1/2 cursor-pointer pointer-events-auto opacity-0 transition-[opacity,width,background-color] duration-150 group-hover/hero:opacity-100 group-data-[controls=visible]/hero:opacity-100 hover:bg-[var(--marker-active)] hover:w-[3px] data-[active]:bg-[var(--marker-active)]"
                    />
                  ))}
                </div>
                <div className="absolute -top-[5px] left-0 right-0 h-3 pointer-events-none z-[13]">
                  {duration > 0 && noteAnchors.map((anchor, i) => (
                    <div
                      key={`note-${i}`}
                      style={{ left: `${(anchor.time / duration) * 100}%` }}
                      onClick={e => {
                        e.stopPropagation();
                        seekToTime(anchor.time);
                        setPanel('transcript');
                        setNoteHighlight({ start: anchor.startWord, end: anchor.endWord });
                      }}
                      title={`Note: ${anchor.selectedText?.slice(0, 60)}${anchor.selectedText?.length > 60 ? '…' : ''}`}
                      className="absolute -top-[3px] w-3 h-3.5 -translate-x-1/2 cursor-pointer pointer-events-none opacity-0 transition-[opacity,transform] duration-150 flex items-center justify-center z-[13] group-hover/hero:opacity-100 group-hover/hero:pointer-events-auto group-data-[paused]/hero:opacity-100 group-data-[paused]/hero:pointer-events-auto group-focus-within/hero:opacity-100 group-focus-within/hero:pointer-events-auto hover:scale-125 hover:z-[14]"
                    >
                      <svg width="10" height="12" viewBox="0 0 10 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="transition-transform duration-100 hover:scale-110">
                        <path d="M1.5 1H8.5V11L5 8.2L1.5 11V1Z" fill="#fbbf24" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  ))}
                </div>
                <div
                  style={{ left: pct + '%' }}
                  className="absolute top-1/2 size-3.5 bg-[var(--accent)] border-none rounded-full -translate-x-1/2 -translate-y-1/2 scale-0 shadow-[0_0_0_3px_rgba(var(--accent-glow),0.25)] opacity-0 transition-[opacity,transform] duration-150 pointer-events-none z-[12] group-hover/hero:opacity-100 group-hover/hero:scale-100 group-data-[controls=visible]/hero:opacity-100 group-data-[controls=visible]/hero:scale-100 pointer-coarse:opacity-100 pointer-coarse:scale-100 pointer-coarse:size-4"
                />
              </div>
              <div className="px-4 pb-[max(14px,env(safe-area-inset-bottom))] pointer-events-none group-hover/hero:pointer-events-auto group-data-[controls=visible]/hero:pointer-events-auto">
                <div className="flex items-center gap-2 text-white">
                  <button
                    type="button"
                    title="Play/Pause (Space)"
                    aria-label={playing ? 'Pause' : 'Play'}
                    onClick={togglePlay}
                    className="bg-transparent border-none text-white cursor-pointer p-1.5 opacity-90 inline-flex items-center transition-[opacity,color,transform] duration-150 hover:opacity-100 hover:text-[var(--accent-hot)] hover:scale-105"
                  >
                    {playing ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                    )}
                  </button>

                  <div className="inline-flex items-center gap-1.5 text-white text-[0.82rem] tabular-nums [text-shadow:0_1px_4px_rgba(0,0,0,0.6)]">
                    <span>{fmt(current / rate)}</span>
                    <span className="opacity-60">/</span>
                    <span>{fmt(dur / rate)}</span>
                  </div>

                  <PlayerChaptersMenu
                    ref={chaptersMenuRef}
                    chapters={chapters}
                    activeIdx={activeIdx}
                    chaptersMenuOpen={chaptersMenuOpen}
                    setChaptersMenuOpen={setChaptersMenuOpen}
                    jumpToChapter={jumpToChapter}
                    activeChapterItemRef={activeChapterItemRef}
                  />

                  <div className="flex items-center gap-1.5 ml-auto text-muted-foreground max-md:hidden" title="Volume">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-white opacity-90 block">
                      <path d="M11 5 6 9H2v6h4l5 4z" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                    <input
                      type="range"
                      min="0" max="1" step="0.05" defaultValue="1"
                      onInput={e => { if (audioRef.current) audioRef.current.volume = parseFloat(e.currentTarget.value); }}
                      className="w-[78px] accent-[var(--accent)]"
                    />
                  </div>
                  <div ref={menuRef} className="relative inline-flex items-center">
                    <button
                      type="button"
                      title="Settings"
                      aria-label="Settings"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      onClick={() => setMenuOpen(o => !o)}
                      className="bg-transparent border-none text-white cursor-pointer p-1.5 opacity-85 inline-flex items-center transition-[opacity,color,transform] duration-150 hover:opacity-100 hover:text-[var(--accent-hot)] hover:scale-105"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </button>
                    {isMobile ? (
                      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                        <SheetContent
                          side="bottom"
                          showCloseButton={false}
                          className="max-h-[80dvh] bg-card border-border p-0 gap-0 rounded-t-2xl overflow-hidden"
                        >
                          <SheetHeader className="p-0">
                            <SheetTitle className="sr-only">Settings</SheetTitle>
                          </SheetHeader>
                          <div className="overflow-y-auto scrollbar-thin">
                            <PlayerSettings
                              setMenuOpen={setMenuOpen}
                              splitTranscript={splitTranscript}
                              isMobile={isMobile}
                              toggleSplitTranscript={toggleSplitTranscript}
                              captionsOn={captionsOn}
                              toggleCaptions={toggleCaptions}
                              isDarkMode={isDarkMode}
                              toggleTheme={toggleTheme}
                              rate={rate}
                              changeRate={changeRate}
                              settingsPage={settingsPage}
                              setSettingsPage={setSettingsPage}
                              transcriptParas={transcriptParas}
                              transcriptSize={transcriptSize}
                              changeTranscriptSize={changeTranscriptSize}
                            />
                          </div>
                        </SheetContent>
                      </Sheet>
                    ) : menuOpen ? (
                      <PlayerSettings
                        setMenuOpen={setMenuOpen}
                        splitTranscript={splitTranscript}
                        isMobile={isMobile}
                        toggleSplitTranscript={toggleSplitTranscript}
                        captionsOn={captionsOn}
                        toggleCaptions={toggleCaptions}
                        isDarkMode={isDarkMode}
                        toggleTheme={toggleTheme}
                        rate={rate}
                        changeRate={changeRate}
                        settingsPage={settingsPage}
                        setSettingsPage={setSettingsPage}
                        transcriptParas={transcriptParas}
                        transcriptSize={transcriptSize}
                        changeTranscriptSize={changeTranscriptSize}
                      />
                    ) : null}
                  </div>
                  <button
                    type="button"
                    title={captionsOn ? 'Captions on (c)' : 'Captions off (c)'}
                    aria-label={captionsOn ? 'Turn captions off' : 'Turn captions on'}
                    aria-pressed={captionsOn}
                    onClick={toggleCaptions}
                    data-active={captionsOn || undefined}
                    className="relative bg-transparent border-none text-white cursor-pointer p-1.5 opacity-85 inline-flex items-center transition-[opacity,color,transform] duration-150 hover:opacity-100 hover:text-[var(--accent-hot)] hover:scale-105 data-[active]:text-[var(--accent-hot)] data-[active]:opacity-100 data-[active]:after:content-[''] data-[active]:after:absolute data-[active]:after:left-1.5 data-[active]:after:right-1.5 data-[active]:after:-bottom-0.5 data-[active]:after:h-0.5 data-[active]:after:bg-current data-[active]:after:rounded-[1px]"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M19 4H5a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3zM11 11.5H9.5v-.5h-2v2h2v-.5H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v2h2v-.5H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    title="Fullscreen (f)"
                    onClick={toggleFs}
                    className="bg-transparent border-none text-white text-lg cursor-pointer px-1.5 py-0.5 opacity-85 transition-[opacity,color,transform] duration-150 hover:opacity-100 hover:text-[var(--accent-hot)] hover:scale-110"
                  >⛶</button>
                </div>
              </div>
            </div>

            {activeCaption && (
              <div
                aria-live="polite"
                data-split={showSplit || undefined}
                className="absolute left-1/2 bottom-[max(56px,calc(56px+env(safe-area-inset-bottom)))] -translate-x-1/2 max-w-[min(85%,900px)] max-sm:max-w-[calc(100%-24px)] py-1.5 px-3.5 bg-black/80 rounded text-white text-[clamp(16px,2.2vw,22px)] max-sm:text-[15px] leading-[1.35] font-medium text-center pointer-events-none z-[4] text-balance group-hover/hero:bottom-[max(96px,calc(96px+env(safe-area-inset-bottom)))] group-data-[controls=visible]/hero:bottom-[max(96px,calc(96px+env(safe-area-inset-bottom)))] group-focus-within/hero:bottom-[max(96px,calc(96px+env(safe-area-inset-bottom)))] data-[split]:left-[27.78%] data-[split]:max-w-[min(47%,500px)]"
              >
                <span>{activeCaption.text}</span>
              </div>
            )}

            {feedback && (
              <div key={feedback.id} aria-hidden="true" className="absolute inset-0 flex items-center justify-center z-[25] pointer-events-none">
                <div className="size-[72px] bg-black/60 rounded-full flex items-center justify-center text-white animate-[feedback-pop_600ms_ease-out_forwards]">
                  {feedback.kind === 'play' ? (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  ) : (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                  )}
                </div>
              </div>
            )}

          </div>

          <audio
            ref={audioRef}
            src={guide.audio ? `${resolveAsset(guide.audio)}${guide.updatedAt ? `?v=${guide.updatedAt}` : ''}` : undefined}
            style={{ display: 'none' }}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              const a = audioRef.current;
              if (a) {
                try { localStorage.setItem(`pg.progress.${slug}`, String(a.currentTime)); } catch {}
              }
            }}
            onEnded={() => {
              setPlaying(false);
              try { localStorage.removeItem(`pg.progress.${slug}`); } catch {}
            }}
            onLoadedMetadata={e => {
              setDuration(e.currentTarget.duration || guide.duration || 0);
              // Restore last position from localStorage (no auth path)
              const saved = parseFloat(localStorage.getItem(`pg.progress.${slug}`) || '0');
              const dur = e.currentTarget.duration || guide.duration || 0;
              if (saved > 1 && saved < dur - 5) {
                e.currentTarget.currentTime = saved;
              }
            }}
            onTimeUpdate={e => {
              const t = e.currentTarget.currentTime || 0;
              setCurrent(t);
              const i = findChapterIndex(chapters, t);
              if (i !== activeIdx) setActiveIdx(i);

              // Throttle progress save to localStorage (~every 5s)
              const now = Date.now();
              if (now - lastProgressSaveRef.current > 5000) {
                lastProgressSaveRef.current = now;
                try { localStorage.setItem(`pg.progress.${slug}`, String(t)); } catch {}
              }
            }}
          />
        </div>
      </div>

      <div className="my-2 mx-auto mb-6 bg-transparent border-none rounded-none py-0 px-2 max-w-[1280px]">
        <div className="flex flex-col gap-1 pb-2.5 pl-2">
          <h1 className="font-['Bricolage_Grotesque',system-ui,sans-serif] text-[1.6rem] font-extrabold tracking-[-0.03em] m-0 text-foreground [font-variation-settings:'opsz'_48]">
            {guide.title || ''}
          </h1>
          <div className="flex gap-2.5 items-start">
            <div
              aria-hidden="true"
              className="size-9 rounded-full bg-gradient-to-br from-[var(--accent)] to-[#b6291f] flex items-center justify-center text-white font-extrabold font-['Bricolage_Grotesque'] text-[0.95rem] shrink-0"
            >
              {(guide.author || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase()}
            </div>
            <div className="min-w-0">
              {guide.author && <div className="text-[0.82rem] leading-snug font-medium text-foreground mb-0.5">{guide.author}</div>}
              {(guide.date || guide.publishedAt) && (
                <div className="text-[0.82rem] leading-snug font-medium text-muted-foreground">{guide.date || guide.publishedAt}</div>
              )}
            </div>
          </div>
        </div>

        <PlayerInfoPanel
          panel={panel}
          setPanel={setPanel}
          chapters={chapters}
          transcriptParas={transcriptParas}
          guide={guide}
          notes={notes}
          updateNotes={updateNotes}
          activeIdx={activeIdx}
          jumpToChapter={jumpToChapter}
          activeWord={activeWord}
          onWordClick={seekToWord}
          activeWordRef={activeWordRef}
          transcriptScrollRef={transcriptScrollRef}
          fmt={fmt}
          onTextSelected={handleTextSelected}
          highlightedNoteRange={noteHighlight}
        />
      </div>

      {/* Floating note popup — input field shown immediately on drag select.
          Type your own note in the textarea (or leave blank to save just the quote + timestamp). */}
      {noteSelection && (
        <div
          ref={selectionPopupRef}
          style={{
            top: `${Math.max(8, (noteSelection.rect?.top || 120) - 110)}px`,
            left: `${Math.max(8, Math.min(noteSelection.rect?.left || 100, (typeof window !== 'undefined' ? window.innerWidth : 900) - 300))}px`,
          }}
          className="fixed z-[300] bg-card border border-border rounded-lg shadow-[0_6px_20px_rgba(0,0,0,0.45)] py-2 px-2.5 flex flex-col items-stretch gap-1.5 max-w-[360px] text-xs leading-tight pointer-events-auto"
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 flex-1 min-w-0 pr-1">
              <span className="font-['Geist_Mono',ui-monospace,monospace] text-[#60a5fa] font-semibold text-[11px] shrink-0 tracking-[-0.5px]">
                [{fmt(noteSelection.time)}]
              </span>
              <span title={noteSelection.text} className="text-muted-foreground text-xs leading-snug italic block">
                “{noteSelection.text.length > 80 ? noteSelection.text.slice(0, 77) + '…' : noteSelection.text}”
              </span>
            </div>
            <textarea
              ref={noteInputRef}
              placeholder="Add your own note, insight, or reaction…"
              value={noteCustomText}
              onChange={e => setNoteCustomText(e.target.value)}
              rows={3}
              className="w-full min-h-[58px] resize-y bg-muted text-foreground border border-border rounded p-1.5 text-xs leading-[1.35] font-['Manrope',system-ui,sans-serif] outline-none focus:border-[#3b82f6]"
            />
            <div className="flex gap-1.5 justify-end mt-0.5">
              <button
                type="button"
                onClick={handleSaveNoteSelection}
                className="bg-[var(--accent)] text-white border-none rounded px-2.5 py-px text-[11px] font-semibold cursor-pointer leading-[1.7] transition-[filter] duration-100 hover:brightness-110"
              >
                Save note
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
