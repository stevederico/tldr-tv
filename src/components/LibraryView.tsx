import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import GuideProgress from './GuideProgress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/dialog';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import Plus from '@stevederico/skateboard-ui/icons/Plus';
import X from '@stevederico/skateboard-ui/icons/X';
import Trash2 from '@stevederico/skateboard-ui/icons/Trash2';
import { toast } from '../toast';
import type { Guide } from '../utils/playerUtils';

/** Which source the create form is reading from. */
type SourceMode = 'url' | 'text';

/** Data collected from a URL fetch or pasted text, used to create a guide. */
interface SourceData {
  title: string;
  author: string;
  transcript: string;
  sourceUrl?: string;
  date?: string;
  thumbnail?: string;
  /** Internal: last auto-derived title, so user edits aren't clobbered. */
  _derivedTitle?: string;
}

/** The guide a delete confirmation is pending for. */
interface PendingDelete {
  slug: string;
  title: string;
}

/**
 * Format a duration in seconds as `h:mm:ss` or `m:ss`.
 *
 * @param sec - Duration in seconds.
 * @returns Formatted duration, or '' for falsy input.
 */
function fmtDuration(sec: number | undefined): string {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const THUMB_PREFIX_RX = /^\.\.\//;

/** Resolve a stored thumbnail path (`../x` -> `/x`) for browser use. */
function resolveThumb(p: string | undefined): string {
  if (!p) return '';
  return p.replace(THUMB_PREFIX_RX, '/');
}

/**
 * Deep, editorial book-cover gradients used for the typographic fallback cover
 * (no external images fetched — matches the mockup's CSS-only covers).
 */
const COVER_GRADIENTS = [
  'linear-gradient(150deg,#3a2b34,#7a1f2b 130%)',
  'linear-gradient(150deg,#243b3a,#0f5c50)',
  'linear-gradient(150deg,#4a3320,#8a5a1f)',
  'linear-gradient(150deg,#2b2f42,#4a2f6a)',
  'linear-gradient(150deg,#20303f,#1f5c74)',
  'linear-gradient(150deg,#3a2330,#7a2f5a)',
];

/** Pick a stable cover gradient for a guide from its slug. */
function coverGradient(slug: string): string {
  let h = 0;
  for (const ch of slug) h = (h + ch.charCodeAt(0)) % COVER_GRADIENTS.length;
  return COVER_GRADIENTS[h];
}

/** First letter of a title, uppercased, for the decorative cover glyph. */
function coverGlyph(title: string): string {
  return title.trim().charAt(0).toUpperCase() || '·';
}

/**
 * Library home view: searchable grid of guides plus a create-guide modal that
 * accepts a URL or pasted text, kicks off the backend pipeline, and shows
 * progress before opening the player.
 *
 * @component
 * @returns The library view.
 */
export default function LibraryView() {
  const navigate = useNavigate();
  const [guides, setGuides] = useState<Guide[]>([]);
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('url');
  const [sourceUrl, setSourceUrl] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [fetching, setFetching] = useState(false);

  // Data collected from URL or pasted text
  const [sourceData, setSourceData] = useState<SourceData>({ title: '', author: '', transcript: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitLabel, setSubmitLabel] = useState('Create guide');

  // After create, the modal flips into "progress" mode showing the GuideProgress stepper
  // so the user can kick off the remaining enrichment jobs (TTS, chapters, images, etc.)
  // before opening the player.
  const [createdGuide, setCreatedGuide] = useState<Guide | null>(null); // full guide payload returned by GET /:slug

  // Delete confirmation state — when set, a modal asks the user to confirm.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  const urlInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);

  async function load() {
    const res = await fetch('/api/guides');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setGuides(await res.json());
  }

  /**
   * Confirm deletion via the modal. Optimistically removes the card from the
   * grid and rolls back the change if the request fails.
   */
  async function confirmDelete() {
    if (!pendingDelete) return;
    const { slug } = pendingDelete;
    const prev = guides;
    setDeletingSlug(slug);
    setGuides(gs => gs.filter(x => x.slug !== slug));
    try {
      const res = await fetch(`/api/guides/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setPendingDelete(null);
    } catch (err) {
      console.error('Delete guide failed', err);
      setGuides(prev);
      toast.error((err instanceof Error ? err.message : String(err)) || 'Could not delete that guide.');
    } finally {
      setDeletingSlug(null);
    }
  }

  useEffect(() => { load(); }, []);

  // Backend orchestrates the create-guide pipeline in the background. While any
  // guide in the library is still running, poll the list every 3s so cards flip
  // from "processing" to ready (or error) without a refresh.
  useEffect(() => {
    const hasRunning = guides.some(g => g.jobs?.pipeline?.status === 'running');
    if (!hasRunning) return;
    const id = setInterval(() => { load().catch(() => {}); }, 3000);
    return () => clearInterval(id);
  }, [guides]);

  // Dialog handles Escape + outside click internally via onOpenChange.

  // Auto-focus the correct input when modal opens or when switching between URL/Text mode
  useEffect(() => {
    if (!modalOpen) return;

    const timer = setTimeout(() => {
      if (sourceMode === 'url' && urlInputRef.current) {
        urlInputRef.current.focus();
        urlInputRef.current.select?.();
      } else if (sourceMode === 'text' && textInputRef.current) {
        textInputRef.current.focus();
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [modalOpen, sourceMode]);

  // In text mode, keep sourceData.transcript synced with the textarea and derive a default
  // title from the first long line (only when the title field is still empty / unedited).
  useEffect(() => {
    if (sourceMode !== 'text') return;
    const trimmed = pastedText.trim();
    if (!trimmed) {
      setSourceData(d => (d.transcript ? { title: '', author: '', transcript: '' } : d));
      return;
    }
    setSourceData(d => {
      const firstLine = pastedText.split('\n').find(l => l.trim().length > 12) || 'Untitled Guide';
      const derivedTitle = firstLine.trim().slice(0, 140);
      // Preserve any title the user has edited (different from the previously-derived value)
      const title = d.title && d.title !== d._derivedTitle ? d.title : derivedTitle;
      return { ...d, title, transcript: trimmed, _derivedTitle: derivedTitle };
    });
  }, [pastedText, sourceMode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return guides;
    return guides.filter(g =>
      g.title.toLowerCase().includes(q) || (g.author || '').toLowerCase().includes(q)
    );
  }, [guides, query]);

  function resetCreateForm() {
    setSourceMode('url');
    setSourceUrl('');
    setPastedText('');
    setFetching(false);
    setSourceData({ title: '', author: '', transcript: '' });
    setCreatedGuide(null);
    setSubmitLabel('Create guide');
  }

  // Refetch the full guide payload so the GuideProgress component sees newly-produced
  // fields (audio, timing, chapters, etc.) after each enrichment step.
  async function refreshCreatedGuide() {
    if (!createdGuide?.slug) return;
    try {
      const res = await fetch(`/api/guides/${encodeURIComponent(createdGuide.slug)}`);
      if (!res.ok) return;
      const g = await res.json();
      setCreatedGuide(g);
    } catch {}
  }

  // Backend orchestrates the whole pipeline on create — poll the guide while
  // jobs.pipeline is running so the GuideProgress UI updates without any
  // per-step button clicks.
  useEffect(() => {
    if (!createdGuide?.slug) return;
    const status = createdGuide.jobs?.pipeline?.status;
    if (status && status !== 'running') return; // pipeline finished
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/guides/${encodeURIComponent(createdGuide.slug)}`);
        if (!res.ok) return;
        const g = await res.json();
        setCreatedGuide(g);
      } catch {}
    }, 2500);
    return () => clearInterval(id);
  }, [createdGuide?.slug, createdGuide?.jobs?.pipeline?.status]);

  // === New source-first create flow ===

  // Reusable fetch that returns data (now calls our backend for reliable extraction)
  async function fetchFromUrl(url: string): Promise<SourceData> {
    const res = await fetch('/api/fetch-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim() }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(json.error || 'Failed to fetch the page');
    }

    return {
      title: json.title || 'Untitled Guide',
      author: json.author || '',
      transcript: json.transcript || '',
      sourceUrl: json.sourceUrl || url.trim(),
      date: json.date || '',
      thumbnail: json.thumbnail || '',
    };
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    setSubmitting(true);

    try {
      let data: SourceData = { ...sourceData };

      // Auto-fetch for URL mode inside the Create button
      if (sourceMode === 'url' && sourceUrl.trim() && !data.transcript) {
        setSubmitLabel('Fetching content…');
        data = await fetchFromUrl(sourceUrl);
        setSourceData(data);
      }

      // Auto-prepare from pasted text
      if (sourceMode === 'text' && pastedText.trim() && !data.transcript) {
        const firstLine = pastedText.split('\n').find(l => l.trim().length > 12) || 'Untitled Guide';
        data = {
          title: firstLine.trim().slice(0, 140),
          author: '',
          transcript: pastedText.trim(),
        };
        setSourceData(data);
      }

      if (!data.transcript) {
        throw new Error('Please enter a URL or paste some text');
      }

      setSubmitLabel('Creating…');

      const metadata = {
        title: data.title || 'Untitled Guide',
        author: data.author || null,
        transcript: data.transcript,
        sourceUrl: data.sourceUrl || (sourceMode === 'url' ? sourceUrl.trim() : null),
        date: data.date || null,
        thumbnail: data.thumbnail || null,
      };

      const createRes = await fetch('/api/guides', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(metadata),
      });
      const createBody = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        const msg = createBody?.error || `Failed (HTTP ${createRes.status})`;
        throw new Error(msg);
      }

      // Backend orchestrates the rest. Close the modal immediately and let the
      // library grid show the new guide as "processing" until the pipeline finishes.
      await load();
      setModalOpen(false);
      resetCreateForm();
    } catch (err) {
      console.error('Create guide failed', err);
      toast.error((err instanceof Error ? err.message : String(err)) || 'Something went wrong');
      setSubmitLabel('Create guide');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="mx-auto w-full max-w-[1120px] px-6 md:px-10">
        <header className="flex flex-col gap-5 pt-8 sm:pt-12">
          <div className="flex items-center gap-3 text-[0.8rem] font-semibold tracking-wide text-muted-foreground motion-safe:animate-[fade-in_0.6s_ease-out_both]">
            <span aria-hidden="true" className="h-px w-9 bg-[var(--brand)]" />
            <span className="font-[family-name:var(--font-mono)] uppercase tracking-[0.18em] text-[0.72rem]">Read to you, beautifully</span>
          </div>
          <h1 className="font-[family-name:var(--font-serif)] font-semibold leading-[0.95] tracking-[-0.02em] text-foreground text-[clamp(2.75rem,10vw,5.25rem)] text-balance motion-safe:animate-[pop-in_0.6s_cubic-bezier(0.2,0.7,0.2,1)_both]">
            Watch <span className="italic text-[var(--brand)]">It</span>
          </h1>

          <div className="flex flex-wrap items-center gap-3 pt-1 motion-safe:animate-[fade-in_0.6s_ease-out_0.1s_both]">
            <label htmlFor="library-search" className="relative flex-1 min-w-[220px]">
              <span className="sr-only">Search guides</span>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                className="pointer-events-none absolute left-4 top-1/2 size-[17px] -translate-y-1/2 text-muted-foreground"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                id="library-search"
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search guides"
                autoComplete="off"
                className="w-full rounded-xl border border-[var(--rule-strong,var(--line))] bg-card py-3.5 pl-11 pr-4 text-[0.95rem] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-[var(--brand)] focus:shadow-[0_0_0_3px_rgba(var(--brand-glow),0.18)]"
              />
            </label>
            <button
              onClick={() => { resetCreateForm(); setModalOpen(true); }}
              aria-label="Create new guide"
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--brand)] bg-[var(--brand)] px-5 py-3.5 text-[0.95rem] font-bold text-white shadow-[0_8px_20px_-12px_rgba(var(--brand-glow),0.9)] transition-[transform,filter] duration-150 hover:-translate-y-px hover:brightness-[1.06] active:translate-y-0"
            >
              <Plus size={17} strokeWidth={2.4} aria-hidden="true" />
              <span>Watch article</span>
            </button>
          </div>
        </header>

        {filtered.length === 0 ? (
          <div className="py-24 text-center motion-safe:animate-[fade-in_0.6s_ease-out_both]">
            <div className="font-[family-name:var(--font-serif)] text-[1.6rem] font-semibold tracking-[-0.01em] text-foreground text-balance">No guides yet.</div>
            <div className="mt-2 text-muted-foreground">Tap <strong className="font-semibold text-foreground">Watch article</strong> to add one.</div>
          </div>
        ) : (
        <main className="grid grid-cols-1 gap-x-6 gap-y-8 pt-9 pb-16 sm:grid-cols-2 min-[920px]:grid-cols-3 xl:grid-cols-4">
          {filtered.map((g, i) => {
            const pipe = g.jobs?.pipeline;
            const processing = pipe?.status === 'running';
            const failed = pipe?.status === 'failed';
            const stepLabels: Record<string, string> = {
              analyze: 'Analyzing transcript',
              thumbnail: 'Generating cover',
              tts: 'Synthesizing audio',
              'chapter-timing': 'Timing chapters',
              'chapter-images': 'Generating chapter images',
              'chapter-real-images': 'Finding chapter photos',
            };
            let processingLabel = 'Processing…';
            if (processing && g.jobs) {
              for (const key of ['chapter-real-images','chapter-images','chapter-timing','tts','thumbnail','analyze']) {
                if (g.jobs[key]?.status === 'running') { processingLabel = stepLabels[key]; break; }
              }
            }
            const cardProps = processing
              ? { onClick: (e: MouseEvent) => e.preventDefault(), tabIndex: -1, 'aria-disabled': true }
              : {};
            // Stagger the load-in reveal; cap the delay so long lists don't lag.
            const revealDelay = `${Math.min(i, 12) * 0.05 + 0.15}s`;
            return (
            <a
              key={g.slug}
              href={`/app/${encodeURIComponent(g.slug)}`}
              target="_blank"
              rel="noopener noreferrer"
              {...cardProps}
              data-processing={processing || undefined}
              style={{ animationDelay: revealDelay }}
              className="group/card flex flex-col gap-3.5 border-none bg-transparent text-left text-inherit no-underline transition-transform duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)] hover:-translate-y-1 data-[processing]:opacity-85 [content-visibility:auto] [contain-intrinsic-size:0_360px] motion-safe:animate-[pop-in_0.6s_cubic-bezier(0.2,0.7,0.2,1)_both]"
            >
              <div className="relative flex aspect-[3/4] flex-col justify-between overflow-hidden rounded-xl border border-[var(--line)] p-5 text-[#f6efe4] shadow-[0_1px_2px_rgba(0,0,0,0.05),0_18px_36px_-22px_rgba(0,0,0,0.55)] group-data-[processing]/card:pointer-events-none">
                {g.thumbnail ? (
                  <>
                    <img
                      loading="lazy"
                      alt=""
                      src={resolveThumb(g.thumbnail)}
                      className="absolute inset-0 size-full object-cover transition-transform duration-[350ms] group-hover/card:scale-[1.04]"
                    />
                    <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
                  </>
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      className="absolute inset-0"
                      style={{ backgroundImage: coverGradient(g.slug) }}
                    />
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 opacity-50 mix-blend-overlay"
                      style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,.10) 1px, transparent 1px)', backgroundSize: '9px 9px' }}
                    />
                    <span className="relative z-[1] font-[family-name:var(--font-mono)] text-[0.68rem] font-bold uppercase tracking-[0.18em] text-white/90 line-clamp-1">
                      {g.author || 'Guide'}
                    </span>
                    <span aria-hidden="true" className="relative z-[1] self-end font-[family-name:var(--font-serif)] text-[3.75rem] italic leading-none opacity-40">
                      {coverGlyph(g.title)}
                    </span>
                    <span className="relative z-[1] font-[family-name:var(--font-serif)] text-[1.35rem] font-semibold leading-[1.08] tracking-[-0.01em] [text-shadow:0_1px_12px_rgba(0,0,0,0.25)] line-clamp-3">
                      {g.title}
                    </span>
                  </>
                )}
                {processing && (
                  <span
                    role="status"
                    aria-live="polite"
                    className="absolute inset-x-2.5 bottom-2.5 z-[3] rounded-md bg-black/65 px-2.5 py-1.5 text-center text-[0.72rem] font-semibold text-white backdrop-blur-[6px] before:mr-2 before:inline-block before:size-2.5 before:animate-[status-pulse_1.4s_ease-out_infinite] before:rounded-full before:bg-[#facc15] before:align-middle before:content-['']"
                  >
                    {processingLabel}
                  </span>
                )}
                {failed && (
                  <span role="alert" className="absolute inset-x-2.5 bottom-2.5 z-[3] rounded-md bg-red-900/95 px-2.5 py-1.5 text-center text-[0.72rem] font-semibold text-white backdrop-blur-[6px]">
                    Failed: {pipe?.error || 'unknown error'}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Delete ${g.title}`}
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setPendingDelete({ slug: g.slug, title: g.title });
                  }}
                  className="absolute right-2 top-2 z-[4] inline-flex size-8 -translate-y-0.5 items-center justify-center rounded-lg border-none bg-black/70 text-white opacity-0 backdrop-blur-[6px] transition-[opacity,transform,background-color] duration-150 hover:bg-red-800/95 focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white group-hover/card:translate-y-0 group-hover/card:opacity-100"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="font-[family-name:var(--font-serif)] text-[1.15rem] font-semibold leading-[1.2] tracking-[-0.01em] text-foreground line-clamp-2">{g.title}</h3>
                {g.author && <div className="text-[0.85rem] font-medium text-muted-foreground">{g.author}</div>}
                {(g.duration || g.date) && (
                  <div className="mt-0.5 inline-flex items-center gap-2 text-[0.75rem] font-semibold tracking-[0.04em] text-muted-foreground">
                    <span aria-hidden="true" className="size-[5px] rounded-full bg-[var(--brand)]" />
                    <span className="tabular-nums">
                      {[fmtDuration(g.duration), g.date].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                )}
              </div>
            </a>
            );
          })}
        </main>
        )}
      </div>

      <Dialog
        open={modalOpen}
        onOpenChange={open => { if (!open) { setModalOpen(false); resetCreateForm(); } }}
      >
        <DialogContent
          showCloseButton={false}
          className="bg-card border-border p-0 gap-0 overflow-hidden sm:max-w-[560px] sm:rounded-2xl max-sm:!w-screen max-sm:!max-w-none max-sm:!h-[100dvh] max-sm:!rounded-none max-sm:!border-0 max-sm:!top-0 max-sm:!left-0 max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!ring-0 max-sm:flex max-sm:flex-col"
        >
          <form autoComplete="off" onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 max-sm:h-full">
            <DialogHeader className="flex-row items-center justify-between py-4 px-5 border-b border-border gap-0">
              <DialogTitle className="font-[family-name:var(--font-serif)] font-semibold text-[1.3rem] tracking-[-0.01em] m-0">
                {createdGuide ? 'Guide created' : 'New guide'}
              </DialogTitle>
              <button
                type="button"
                onClick={() => { setModalOpen(false); resetCreateForm(); }}
                aria-label="Close"
                className="bg-transparent border-none text-muted-foreground cursor-pointer p-1 rounded-md transition-colors hover:text-foreground hover:bg-muted"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </DialogHeader>
            <div className="px-5 py-4 flex flex-col gap-3.5 sm:max-h-[70vh] flex-1 overflow-y-auto">
              {createdGuide ? (
                <GuideProgress
                  slug={createdGuide.slug}
                  guide={createdGuide}
                  onRefresh={refreshCreatedGuide}
                />
              ) : (
              <>
              {/* Pure URL or Text flow — nothing else */}
              <div className="flex bg-secondary rounded-full p-[3px] mb-4 border border-border">
                {([
                  { mode: 'url' as const,  label: 'From URL' },
                  { mode: 'text' as const, label: 'Paste Text' },
                ]).map(({ mode, label }: { mode: SourceMode; label: string }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSourceMode(mode)}
                    data-active={sourceMode === mode || undefined}
                    className="flex-1 py-2 px-4 font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[0.14em] rounded-full border-none bg-transparent text-secondary-foreground/70 cursor-pointer transition-colors hover:text-foreground data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm"
                  >
                    {label}
                  </button>
                ))}
              </div>

              {sourceMode === 'url' ? (
                <div className="mb-4">
                  <input
                    ref={urlInputRef}
                    type="url"
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    value={sourceUrl}
                    onChange={e => setSourceUrl(e.target.value)}
                    placeholder="https://example.com/article"
                    className="w-full border border-border bg-background text-foreground rounded-lg p-3 text-[15px] outline-none transition-colors focus:border-[var(--brand)]"
                  />
                </div>
              ) : (
                <div className="mb-4">
                  <textarea
                    ref={textInputRef}
                    value={pastedText}
                    onChange={e => setPastedText(e.target.value)}
                    rows={10}
                    placeholder="Paste the full article or essay text here..."
                    className="w-full border border-border bg-background text-foreground rounded-lg p-3 text-[15px] outline-none transition-colors focus:border-[var(--brand)] min-h-[180px] resize-y leading-normal"
                  />
                </div>
              )}

              </>
              )}
            </div>
            <DialogFooter className="flex-row justify-end gap-2.5 pt-3.5 pb-4 px-5 border-t border-border bg-background">
              {createdGuide ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setModalOpen(false); resetCreateForm(); }}
                    className="font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-transparent text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const slug = createdGuide.slug;
                      setModalOpen(false);
                      resetCreateForm();
                      navigate(`/app/${encodeURIComponent(slug)}`);
                    }}
                    className="font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-[var(--brand)] text-white shadow-[0_6px_20px_rgba(var(--brand-glow),0.35)] transition-colors hover:bg-[var(--brand-hot)] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    Open player
                  </button>
                </>
              ) : (
                <button
                  type="submit"
                  disabled={submitting || (sourceMode === 'url' ? !sourceUrl.trim() : !pastedText.trim())}
                  className="inline-flex items-center gap-2 font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-[var(--brand)] text-white shadow-[0_6px_20px_rgba(var(--brand-glow),0.35)] transition-colors hover:bg-[var(--brand-hot)] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitting && <Spinner className="size-4 text-white" />}
                  {submitLabel}
                </button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingDelete}
        onOpenChange={open => { if (!open && !deletingSlug) setPendingDelete(null); }}
      >
        <DialogContent
          showCloseButton={false}
          className="bg-card border-border p-0 gap-0 overflow-hidden sm:max-w-[460px] sm:rounded-2xl"
        >
          <DialogHeader className="flex-row items-center justify-between py-4 px-5 border-b border-border gap-0">
            <DialogTitle className="font-[family-name:var(--font-serif)] font-semibold text-[1.3rem] tracking-[-0.01em] m-0">
              Delete guide?
            </DialogTitle>
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              aria-label="Close"
              disabled={!!deletingSlug}
              className="bg-transparent border-none text-muted-foreground cursor-pointer p-1 rounded-md transition-colors hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </DialogHeader>
          <div className="px-5 py-4 flex flex-col gap-3.5">
            <DialogDescription className="m-0 text-foreground text-sm">
              <strong>{pendingDelete?.title}</strong> will be permanently removed. This can't be undone.
            </DialogDescription>
          </div>
          <DialogFooter className="flex-row justify-end gap-2.5 pt-3.5 pb-4 px-5 border-t border-border bg-background">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              disabled={!!deletingSlug}
              className="font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={!!deletingSlug}
              className="inline-flex items-center gap-2 font-bold text-[0.88rem] py-2.5 px-4 rounded-full cursor-pointer border-none bg-[#b91c1c] text-white transition-colors hover:bg-[#991b1b] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {deletingSlug && <Spinner className="size-4 text-white" />}
              {deletingSlug ? 'Deleting…' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
